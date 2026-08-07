-- SMS back charging.
--
-- Records what each SMS actually cost, at the price in force when it was sent,
-- so a club can be invoiced for its own usage and the invoice can be defended
-- line by line months later.
--
-- Safe to run more than once.

-- 1. Per-message meter readings on the existing message log.
--
-- Every column here is a snapshot taken at send time and never recomputed. That
-- is the point: if the rate card changes in September, August's invoice must
-- still add up to what August's invoice said. Storing a foreign key to a rate
-- table instead would quietly rewrite history the first time anyone edited a
-- price.
alter table message_log add column if not exists segments        integer;
alter table message_log add column if not exists encoding        text;
alter table message_log add column if not exists unit_price_cents numeric(12,6);
alter table message_log add column if not exists billable_cents   numeric(14,6);

-- What the message was for. An invoice that says "4,812 segments" invites
-- exactly one question, and this column answers it: surveys, reminders, event
-- invitations, staff shift surveys, integration tests. Nullable, because rows
-- written before this shipped genuinely do not know; the statement reports
-- those as "unattributed" rather than guessing.
alter table message_log add column if not exists kind            text;

-- Which club is being charged. The pilot is single-club and this is the value
-- of the CLUB_ID env var on every row, but back charging is the feature that
-- stops making sense the moment a second club shares a deployment, so the
-- column exists now and the statement filters on it when it is set.
alter table message_log add column if not exists club_id         uuid;

alter table message_log drop constraint if exists message_log_encoding_check;
alter table message_log add  constraint message_log_encoding_check
  check (encoding is null or encoding in ('gsm7','ucs2'));

-- Segment counts are never negative and a null means "not metered", which the
-- statement handles explicitly. Guarding it here keeps a bad backfill from
-- producing a credit note nobody intended.
alter table message_log drop constraint if exists message_log_segments_check;
alter table message_log add  constraint message_log_segments_check
  check (segments is null or segments >= 0);

-- The statement always filters by channel, status and a date range, in that
-- order of selectivity.
create index if not exists message_log_billing_idx
  on message_log (channel, status, created_at desc);
create index if not exists message_log_club_idx
  on message_log (club_id, created_at desc);

-- 2. Closed billing periods.
--
-- An open period is computed live from message_log. A closed one is frozen: the
-- totals below are the numbers that were invoiced, stored rather than recomputed
-- so a late-arriving row, a repriced message or an edited rate card cannot
-- silently change a figure a club has already been billed for. Reconciliation
-- against a live recompute is then possible precisely because both exist.
create table if not exists sms_billing_periods (
  period_id        uuid primary key default uuid_generate_v4(),
  club_id          uuid,
  -- 'YYYY-MM'. One row per club per month.
  period           text not null,
  period_start     timestamptz not null,
  period_end       timestamptz not null,
  status           text not null default 'closed' check (status in ('closed','invoiced','void')),

  -- The frozen figures.
  messages_sent    integer not null default 0,
  messages_failed  integer not null default 0,
  segments_sent    integer not null default 0,
  segments_included integer not null default 0,
  segments_charged integer not null default 0,
  amount_cents     numeric(14,6) not null default 0,
  currency         text not null default 'USD',

  -- The rate card as it stood at close, so the arithmetic can be re-derived
  -- from the row alone without consulting club_settings.
  rate_cents_per_segment numeric(12,6),
  markup_pct       numeric(8,4),

  -- The full statement body, including the per-kind and per-encoding
  -- breakdowns, exactly as it was presented.
  statement        jsonb,

  closed_at        timestamptz not null default now(),
  closed_by_email  text,
  invoice_ref      text,
  notes            text
);

-- One closed period per club per month. The partial unique index treats a
-- null club_id (single-club pilot) as its own key rather than as "distinct
-- from everything", which is what a plain unique constraint would do and which
-- would let the same month be closed repeatedly.
create unique index if not exists sms_billing_periods_unique_idx
  on sms_billing_periods (coalesce(club_id, '00000000-0000-0000-0000-000000000000'::uuid), period)
  where status <> 'void';

create index if not exists sms_billing_periods_lookup_idx
  on sms_billing_periods (period desc);

-- 3. Rate card defaults.
--
-- Deliberately zero. A made-up per-segment price would produce invoices that
-- look right and are not, and a plausible wrong number is far harder to catch
-- than an obviously missing one. Metering runs regardless — segments are
-- counted from day one — so once the real Sendly rate is known, the reprice
-- endpoint applies it to everything already logged.
--
-- Set sms_rate_cents_per_segment to the carrier's price per segment in cents
-- (e.g. 0.79 for $0.0079). sms_markup_pct is Vero's margin on top, kept
-- separate so the pass-through cost is never lost.
insert into club_settings (key, value) values
  ('sms_rate_cents_per_segment', '0'),
  ('sms_markup_pct', '0'),
  ('sms_included_segments_per_period', '0'),
  ('sms_billing_currency', 'USD')
on conflict (key) do nothing;
