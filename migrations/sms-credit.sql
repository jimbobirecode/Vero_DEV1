-- Pay-as-you-go SMS credit.
--
-- The club buys credit up front through Stripe; every SMS debits it; at zero,
-- sending stops until they top up.
--
-- This is the only SMS billing migration. An earlier post-pay version
-- (sms-back-charge.sql) invoiced monthly in arrears; it was replaced before any
-- club was billed from it, and section 8 removes its table if it was ever run.
--
-- Safe to run more than once.

-- 1. Per-message meter readings on the message log.
--
-- Prepaid still has to know what each message cost: a two-segment message must
-- debit twice what a one-segment message does. These columns are a snapshot
-- taken at send time and never recomputed, so a charge a club queries in six
-- months still reconciles against what was actually deducted.
alter table message_log add column if not exists segments         integer;
alter table message_log add column if not exists encoding         text;
alter table message_log add column if not exists unit_price_cents numeric(12,6);
alter table message_log add column if not exists billable_cents   numeric(14,6);

-- What the message was for — surveys, reminders, event invitations, staff shift
-- surveys, integration tests. This is what turns "$3.25 on 6 August" into
-- something a club can recognise. Nullable, because rows written before this
-- shipped genuinely do not know.
alter table message_log add column if not exists kind             text;

-- Which club is being charged. The pilot is single-club and this is the CLUB_ID
-- env var on every row, but billing is the feature that stops making sense the
-- moment a second club shares a deployment.
alter table message_log add column if not exists club_id          uuid;

alter table message_log drop constraint if exists message_log_encoding_check;
alter table message_log add  constraint message_log_encoding_check
  check (encoding is null or encoding in ('gsm7','ucs2'));

alter table message_log drop constraint if exists message_log_segments_check;
alter table message_log add  constraint message_log_segments_check
  check (segments is null or segments >= 0);

create index if not exists message_log_billing_idx
  on message_log (channel, status, created_at desc);
create index if not exists message_log_club_idx
  on message_log (club_id, created_at desc);

-- 2. One credit account per club.
--
-- The balance lives in a single column and is only ever changed by the two
-- functions below. Nothing else may write it — an UPDATE from application code
-- that reads a balance and then writes it back is a lost update waiting for two
-- concurrent sends, and this is money.
-- club_id is nullable, and the primary key is a surrogate.
--
-- The first cut made club_id the primary key, which is implicitly NOT NULL —
-- and a single-club deployment that never sets the CLUB_ID env var passes null.
-- The account row could then never be created, and because the insert failed
-- the screen reported "the credit tables are not set up", sending everyone off
-- to re-run a migration that had worked perfectly. Everything else in the app
-- (message_log.club_id, the ledger) already tolerates a null club, so the
-- schema now does too.
create table if not exists sms_credit_accounts (
  account_id                 uuid primary key default uuid_generate_v4(),
  club_id                    uuid,
  balance_cents              numeric(14,4) not null default 0,
  currency                   text not null default 'USD',

  -- Warn-before-you-stop. Two thresholds because one is never enough: the first
  -- is "sort this out this week", the second is "you are about to stop sending".
  low_balance_cents          numeric(14,4) not null default 2000,
  critical_balance_cents     numeric(14,4) not null default 500,
  low_balance_notified_at    timestamptz,

  -- Auto top-up. Off until a card is saved through Stripe Checkout in setup
  -- mode — we never see or store the card itself, only Stripe's reference.
  auto_topup_enabled         boolean not null default false,
  auto_topup_threshold_cents numeric(14,4) not null default 1000,
  auto_topup_amount_cents    numeric(14,4) not null default 5000,

  stripe_customer_id         text,
  stripe_payment_method_id   text,

  -- Guards against a nightly batch firing one auto top-up per message. Set
  -- when a charge starts, cleared when it settles or fails. See
  -- lib/sms-credit-store.js for why a timestamp rather than a boolean.
  topup_in_flight_at         timestamptz,
  last_topup_error           text,

  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

-- Repair a table created by the first cut of this migration, where club_id was
-- the primary key and therefore NOT NULL. `create table if not exists` above
-- leaves such a table untouched, so re-running the file would otherwise fix
-- nothing. Each step is guarded, so this is a no-op on a table already correct.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_name = 'sms_credit_accounts' and column_name = 'account_id'
  ) then
    alter table sms_credit_accounts add column account_id uuid not null default uuid_generate_v4();
    alter table sms_credit_accounts drop constraint if exists sms_credit_accounts_pkey;
    alter table sms_credit_accounts add primary key (account_id);
    alter table sms_credit_accounts alter column club_id drop not null;
  end if;
end $$;

-- One account per club, with a null club treated as its own key rather than as
-- "distinct from everything" — which is what a plain unique constraint would do
-- and which would let a single-club deployment accumulate a new account row on
-- every top-up.
create unique index if not exists sms_credit_accounts_club_idx
  on sms_credit_accounts (coalesce(club_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- A balance must never go negative. The debit function already refuses, but a
-- constraint is what makes that true regardless of how the row is reached —
-- including a hand-written UPDATE in the SQL editor at 2am.
alter table sms_credit_accounts drop constraint if exists sms_credit_balance_non_negative;
alter table sms_credit_accounts add  constraint sms_credit_balance_non_negative
  check (balance_cents >= 0);

-- 3. The ledger — append-only, and the actual source of truth.
--
-- balance_cents on the account is a running cache of this table. Keeping both
-- is what lets a disputed charge be answered: the balance says what is left,
-- the ledger says how it got there, and the two can be reconciled by summing.
create table if not exists sms_credit_ledger (
  entry_id           uuid primary key default uuid_generate_v4(),
  club_id            uuid,
  entry_type         text not null check (entry_type in ('topup','debit','refund','adjustment','reversal')),

  -- Signed: credits positive, debits negative. Summing the column reproduces
  -- the balance, which is the whole point of storing it this way.
  amount_cents       numeric(14,4) not null,
  balance_after_cents numeric(14,4) not null,

  -- What the entry was for.
  message_log_id     uuid references message_log(log_id),
  kind               text,
  description        text,

  -- Stripe's references, for reconciling against their dashboard.
  stripe_payment_intent_id text,
  stripe_session_id        text,

  -- The idempotency guard. Stripe retries webhooks — sometimes for days — and
  -- a retry that credits the account a second time is money given away. Every
  -- write goes through a key derived from the event, and the unique index makes
  -- a double-apply impossible rather than unlikely.
  idempotency_key    text not null,

  actor_email        text,
  created_at         timestamptz not null default now()
);

create unique index if not exists sms_credit_ledger_idem_idx
  on sms_credit_ledger (idempotency_key);
create index if not exists sms_credit_ledger_club_idx
  on sms_credit_ledger (club_id, created_at desc);
create index if not exists sms_credit_ledger_type_idx
  on sms_credit_ledger (entry_type, created_at desc);

-- 4. Debit — atomic, and the hard stop.
--
-- The conditional UPDATE is the whole mechanism. `balance_cents >= p_amount`
-- inside the WHERE means the check and the decrement are one statement against
-- one locked row: two sends racing for the last cent cannot both win, because
-- the second one's WHERE no longer matches. Doing this as SELECT-then-UPDATE in
-- application code would overdraw under exactly the load a nightly batch
-- creates, and would do it silently.
create or replace function debit_sms_credit(
  p_club_id         uuid,
  p_amount_cents    numeric,
  p_message_log_id  uuid,
  p_kind            text,
  p_idempotency_key text
) returns table (ok boolean, balance_after numeric, reason text)
language plpgsql as $$
declare
  v_balance numeric;
  v_prior   numeric;
begin
  -- Replaying a key that already applied returns the original outcome rather
  -- than charging again. A retried send must not cost twice.
  select balance_after_cents into v_prior
    from sms_credit_ledger where idempotency_key = p_idempotency_key;
  if found then
    return query select true, v_prior, 'already_applied'::text;
    return;
  end if;

  update sms_credit_accounts
     set balance_cents = balance_cents - p_amount_cents,
         updated_at = now()
   where club_id is not distinct from p_club_id
     and balance_cents >= p_amount_cents
  returning balance_cents into v_balance;

  if not found then
    select balance_cents into v_balance
      from sms_credit_accounts where club_id is not distinct from p_club_id;
    if not found then
      return query select false, 0::numeric, 'no_account'::text;
    else
      return query select false, v_balance, 'insufficient_credit'::text;
    end if;
    return;
  end if;

  insert into sms_credit_ledger
    (club_id, entry_type, amount_cents, balance_after_cents, message_log_id, kind, idempotency_key, description)
  values
    (p_club_id, 'debit', -p_amount_cents, v_balance, p_message_log_id, p_kind, p_idempotency_key, 'SMS send');

  return query select true, v_balance, 'ok'::text;
end;
$$;

-- 5. Credit — top-ups, refunds, reversals, manual adjustments.
--
-- Same idempotency guard, and it matters more here: this is the direction that
-- creates money. A Stripe webhook delivered three times must credit once.
create or replace function credit_sms_account(
  p_club_id         uuid,
  p_amount_cents    numeric,
  p_entry_type      text,
  p_idempotency_key text,
  p_description     text,
  p_payment_intent  text,
  p_session_id      text,
  p_message_log_id  uuid,
  p_actor_email     text
) returns table (ok boolean, balance_after numeric, reason text)
language plpgsql as $$
declare
  v_balance numeric;
  v_prior   numeric;
begin
  select balance_after_cents into v_prior
    from sms_credit_ledger where idempotency_key = p_idempotency_key;
  if found then
    return query select true, v_prior, 'already_applied'::text;
    return;
  end if;

  -- Creates the account on first credit, so a club that has never been set up
  -- gets one the moment it pays rather than erroring at the till.
  -- Untargeted ON CONFLICT: the uniqueness is enforced by an expression index
  -- on coalesce(club_id, …), which cannot be named as a conflict target.
  insert into sms_credit_accounts (club_id, balance_cents)
  values (p_club_id, 0)
  on conflict do nothing;

  update sms_credit_accounts
     set balance_cents = balance_cents + p_amount_cents,
         updated_at = now(),
         -- A top-up re-arms the low-balance warning, so the next time they run
         -- down they are told again rather than sailing past in silence.
         low_balance_notified_at = case when p_amount_cents > 0 then null else low_balance_notified_at end
   where club_id is not distinct from p_club_id
  returning balance_cents into v_balance;

  if not found then
    return query select false, 0::numeric, 'no_account'::text;
    return;
  end if;

  insert into sms_credit_ledger
    (club_id, entry_type, amount_cents, balance_after_cents, idempotency_key,
     description, stripe_payment_intent_id, stripe_session_id, message_log_id, actor_email)
  values
    (p_club_id, p_entry_type, p_amount_cents, v_balance, p_idempotency_key,
     p_description, p_payment_intent, p_session_id, p_message_log_id, p_actor_email);

  return query select true, v_balance, 'ok'::text;
end;
$$;

-- 6. A message can now be stopped before it is sent.
--
-- 'blocked' is kept distinct from 'failed' on purpose. A failure is the carrier
-- refusing a message; a block is us refusing it for want of credit. They need
-- different responses — one is a delivery problem, the other is an invoice —
-- and collapsing them into 'failed' would hide a stopped club inside a column
-- everyone reads as "Sendly being flaky".
alter table message_log drop constraint if exists message_log_status_check;
alter table message_log add  constraint message_log_status_check
  check (status in ('sent','failed','blocked'));

-- 7. Settings.
--
-- sms_rate_cents_per_segment is what a message costs the club, in CENTS per
-- segment. The confirmed price is $0.02 per segment, so the value is 2 — not
-- 0.02, which would be two hundredths of a cent and undercharge by 100x. The
-- unit is the one thing to get right here: a one-segment message deducts
-- 2 cents, and 1,000 of them cost the club $20.00.
--
-- No margin is applied, so sms_markup_pct stays at 0 and the club pays the
-- rate above exactly. Markup remains a separate setting rather than being
-- folded into the rate, so the pass-through cost is never lost if one is added
-- later.
--
-- The code itself still defaults to 0 when the setting is absent — see
-- rateCard() in lib/sms-billing.js. That is deliberate: a missing setting must
-- read as obviously unconfigured rather than silently falling back to a price
-- nobody chose. The value below is a real, confirmed figure, not a guess.
--
-- sms_credit_enabled is the hard stop, and starts off. Enforcement is opt-in
-- because a deployment upgrading to this migration must not suddenly stop
-- sending surveys before anyone has bought credit. Turn it on once the first
-- top-up has landed.
--
-- None of these appear on the club's screen — this is Vero's pricing, not a
-- setting the club adjusts. Change them with PUT /api/settings/:key.
--
-- Note the ON CONFLICT: re-running this migration will NOT overwrite a value
-- that already exists. To change the price on a database where these rows are
-- already present, update it explicitly:
--   update club_settings set value = '2' where key = 'sms_rate_cents_per_segment';
insert into club_settings (key, value) values
  ('sms_rate_cents_per_segment', '2'),
  ('sms_markup_pct', '0'),
  ('sms_billing_currency', 'USD'),
  ('sms_credit_enabled', 'false')
on conflict (key) do nothing;

-- 8. Remove what the post-pay model left behind.
--
-- Superseded by the ledger above. Two billing models on one deployment is where
-- reconciliation bugs live, and this table was never invoiced against — it
-- shipped and was replaced before a club ever saw a statement from it.
drop table if exists sms_billing_periods;

-- The monthly included-segment allowance went with it. An allowance is a
-- post-pay idea: prepaid credit either covers a message or it does not.
delete from club_settings where key = 'sms_included_segments_per_period';
