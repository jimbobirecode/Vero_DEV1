-- ===========================================================================
-- Club Vero — one migration to bring a database fully up to date.
-- ===========================================================================
--
-- Run this once, on each club's database, in the Supabase SQL editor.
-- Paste the whole file and press Run. It takes a second or two.
--
-- It replaces every migration in this folder. You do not need to work out
-- which ones you have already applied, or in what order — this file checks
-- before it changes anything, so running it on a database that is already
-- up to date does nothing at all. Running it twice is also fine.
--
-- What it covers, in the order it has to happen:
--
--   1. Foundations      survey templates, club settings, the audit log
--   2. Service recovery  outreach logging, resolutions, the contact clock
--   3. Staff surveys     the shift feedback loop and its template
--   4. Events            events as their own department, with AI insight
--   5. People            member types matching visit types
--   6. Servers           servers separated from team members
--   7. Alert routing     outlets nominate who their alerts go to
--   8. SMS credit        prepaid balance, Stripe top-ups, the ledger
--   9. Reload + report   tell the API about the new columns, then show
--                        you what the database now looks like
--
-- Nothing here deletes member, visit, survey or alert data. The only DROPs
-- are of a table that never held anything a club entered (sms_billing_periods,
-- from the abandoned post-pay billing) and of the servers.staff_id column,
-- which is explained in section 6.
--
-- The final SELECTs are a report, not a change. Read them to confirm the
-- run did what you expected.
--
-- Expect a lot of "NOTICE: ... already exists, skipping" messages. Those are
-- not errors or warnings — they are this file finding something already in
-- place and leaving it alone, which is most of what it does on a database
-- that is partly up to date. The only thing to act on is a line saying
-- ERROR.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------
-- uuid_generate_v4() comes from uuid-ossp and gen_random_uuid() from pgcrypto.
-- Both are used below, and both are available on Supabase by default — this
-- just makes the file safe to run on a database where one was never enabled.
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";


-- ===========================================================================
-- 1. FOUNDATIONS
-- ===========================================================================

-- Survey templates. Everything else that references a template needs this to
-- exist first, which is why it leads.
create table if not exists survey_templates (
  template_id      uuid primary key default uuid_generate_v4(),
  name             text not null,
  survey_type      text not null,
  questions        jsonb not null,
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);

-- The set of survey types has grown — 'staff' was added with the shift
-- feedback loop. Stated once, here, rather than being edited in three places.
alter table survey_templates drop constraint if exists survey_templates_survey_type_check;
alter table survey_templates add  constraint survey_templates_survey_type_check
  check (survey_type in ('food_bev', 'golf', 'events', 'staff'));

alter table survey_responses add column if not exists template_id uuid references survey_templates(template_id);
alter table survey_responses add column if not exists answers     jsonb;
alter table survey_responses add column if not exists ai_tags     jsonb;
alter table outlets          add column if not exists template_id uuid references survey_templates(template_id);

alter table case_alerts add column if not exists ai_summary           text;
alter table case_alerts add column if not exists assigned_to_staff_id uuid references staff(staff_id);

-- The role list, including the two shift-manager roles.
alter table staff drop constraint if exists staff_role_check;
alter table staff add  constraint staff_role_check
  check (role in ('super_admin','general_manager','fb_director','dept_head','shift_manager','golf_shift_manager'));

alter table visits       add column if not exists server_id   uuid references servers(server_id);
alter table server_tasks add column if not exists server_id   uuid references servers(server_id);
alter table server_tasks add column if not exists approved_by uuid references staff(staff_id);
alter table server_tasks add column if not exists approved_at timestamptz;
alter table server_tasks add column if not exists due_by      date;

create table if not exists club_settings (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

create table if not exists audit_log (
  audit_id         uuid primary key default uuid_generate_v4(),
  action           text not null,
  actor_staff_id   uuid references staff(staff_id),
  actor_email      text,
  actor_role       text,
  ip_address       text,
  user_agent       text,
  details          jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists audit_log_created_at_idx on audit_log (created_at desc);
create index if not exists audit_log_action_idx     on audit_log (action);
create index if not exists audit_log_actor_idx      on audit_log (actor_staff_id);

-- Guests at events are not always members, so an attendee row has to be able
-- to stand on its own contact details.
alter table event_attendees add column if not exists guest_name         text;
alter table event_attendees add column if not exists guest_phone        text;
alter table event_attendees add column if not exists guest_email        text;
alter table event_attendees add column if not exists survey_sent_at     timestamptz;
alter table event_attendees add column if not exists survey_response_id uuid references survey_responses(response_id);
alter table event_attendees alter column member_id drop not null;

-- Index tags on the seeded templates, so CHI/SSI/OHI have something to score.
-- Only applied where no tags exist yet, so a club that has since edited its
-- questions in the Builder keeps its own choices.
update survey_templates set questions = jsonb_set(jsonb_set(jsonb_set(jsonb_set(
    questions, '{0,index}', '"CHI"'), '{1,index}', '"SSI"'), '{2,index}', '"OHI"'), '{3,index}', '"OHI"')
where survey_type = 'food_bev'
  and jsonb_array_length(questions) >= 4
  and not (questions -> 0 ? 'index');

update survey_templates set questions = jsonb_set(jsonb_set(jsonb_set(jsonb_set(
    questions, '{0,index}', '"CHI"'), '{1,index}', '"OHI"'), '{2,index}', '"OHI"'), '{3,index}', '"SSI"')
where survey_type = 'golf'
  and jsonb_array_length(questions) >= 4
  and not (questions -> 0 ? 'index');

insert into club_settings (key, value) values ('survey_send_time', '09:30')
  on conflict (key) do nothing;


-- ===========================================================================
-- 2. SERVICE RECOVERY
-- ===========================================================================
-- Who was called about a complaint, when, and what came of it.

create table if not exists alert_outreach (
  outreach_id      uuid primary key default uuid_generate_v4(),
  alert_id         uuid not null references case_alerts(alert_id) on delete cascade,
  member_id        text references members(member_id),
  channel          text not null check (channel in ('phone','in_person','sms','email','letter')),
  outcome          text not null check (outcome in ('reached','left_message','no_answer','declined','wrong_number')),
  member_sentiment text check (member_sentiment in ('recovered','neutral','still_unhappy')),
  notes            text check (char_length(notes) <= 2000),
  occurred_at      timestamptz not null default now(),
  logged_by        uuid references staff(staff_id),
  logged_by_name   text,                 -- kept for history if the staff row is later removed
  logged_via       text not null default 'dashboard' check (logged_via in ('dashboard','one_tap','api')),
  created_at       timestamptz not null default now()
);
create index if not exists alert_outreach_alert_idx  on alert_outreach (alert_id, occurred_at);
create index if not exists alert_outreach_member_idx on alert_outreach (member_id, occurred_at);

-- The contact clock. It runs from the member's complaint, not from whenever a
-- manager next opens the dashboard.
alter table case_alerts add column if not exists contact_due_at    timestamptz;
alter table case_alerts add column if not exists first_contact_at  timestamptz;
alter table case_alerts add column if not exists first_reached_at  timestamptz;
alter table case_alerts add column if not exists outreach_count    integer not null default 0;
alter table case_alerts add column if not exists no_contact_reason text;
alter table case_alerts add column if not exists recovery_token    text unique;
alter table case_alerts add column if not exists escalated_stage   text
  check (escalated_stage is null or escalated_stage in ('half','final','breached'));
alter table case_alerts add column if not exists escalated_at      timestamptz;

create index if not exists case_alerts_due_idx on case_alerts (contact_due_at)
  where first_contact_at is null;

-- 'assigned' and 'contacted' are states an alert can now be in.
alter table case_alerts drop constraint if exists case_alerts_status_check;
alter table case_alerts add  constraint case_alerts_status_check
  check (status in ('open','assigned','contacted','resolved'));

-- What actually caused it and what was done about it.
create table if not exists case_resolutions (
  resolution_id   uuid primary key default gen_random_uuid(),
  alert_id        uuid not null references case_alerts(alert_id) on delete cascade,
  root_cause      text not null check (root_cause in (
    'service_speed','service_attitude','food_quality','food_availability',
    'cleanliness','booking_error','billing_error','facility','staffing_level',
    'member_expectation','other')),
  action_taken    text not null check (action_taken in (
    'coached_staff','staffing_changed','process_changed','supplier_or_stock',
    'facility_fixed','billing_corrected','goodwill_only','explained_only','no_action')),
  notes           text check (char_length(notes) <= 2000),
  goodwill_type   text check (goodwill_type in (
    'none','comped_item','comped_visit','account_credit','gift','other')),
  goodwill_amount numeric(10,2) check (goodwill_amount >= 0),
  contacted_member  boolean not null default false,
  no_contact_reason text,
  resolved_by      uuid references staff(staff_id),
  resolved_by_name text,                       -- kept if the staff row is later removed
  resolved_at      timestamptz not null default now(),
  superseded_at    timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists case_resolutions_alert_idx   on case_resolutions (alert_id, resolved_at desc);
create index if not exists case_resolutions_current_idx on case_resolutions (resolved_at)
  where superseded_at is null;
-- One live resolution per alert. A correction supersedes rather than stacks.
create unique index if not exists case_resolutions_one_current_idx
  on case_resolutions (alert_id) where superseded_at is null;

insert into club_settings (key, value) values
  ('recovery_sla_high_minutes',   '1440'),   -- 24 hours
  ('recovery_sla_medium_minutes', '4320'),   -- 3 days
  ('recovery_sla_low_minutes',    '10080')   -- 7 days
on conflict (key) do nothing;

-- Give open alerts that predate the clock a due date, so they appear in the
-- sweep instead of sitting invisible forever.
update case_alerts
   set contact_due_at = created_at + (
         case severity
           when 'high'   then interval '1440 minutes'
           when 'medium' then interval '4320 minutes'
           else               interval '10080 minutes'
         end)
 where contact_due_at is null
   and status <> 'resolved';


-- ===========================================================================
-- 3. STAFF SURVEYS — the shift feedback loop
-- ===========================================================================

create table if not exists staff_survey_responses (
  staff_response_id uuid primary key default uuid_generate_v4(),
  server_id         uuid references servers(server_id),
  shift_date        date not null,
  survey_token      text not null unique,
  q1_shift_rating   smallint check (q1_shift_rating   between 1 and 5),  -- required
  q2_support        smallint check (q2_support        between 1 and 5),  -- required
  q3_workload       smallint check (q3_workload       between 1 and 5),  -- required
  q4_tools          smallint check (q4_tools          between 1 and 5),  -- skippable
  q5_comment        text check (char_length(q5_comment) <= 1000),        -- optional
  answers           jsonb,
  submitted_at      timestamptz,
  is_complete       boolean not null default false,
  sent_at           timestamptz,
  created_at        timestamptz not null default now()
);
-- One survey per person per shift, enforced by the database rather than by
-- remembering to check.
create unique index if not exists staff_survey_responses_server_shift_idx
  on staff_survey_responses (server_id, shift_date);
create index if not exists staff_survey_responses_shift_date_idx
  on staff_survey_responses (shift_date desc);
create index if not exists staff_survey_responses_submitted_idx
  on staff_survey_responses (submitted_at desc)
  where submitted_at is not null;

-- Off by default. Turning it on is a decision for the club, made in Settings.
insert into club_settings (key, value) values
  ('staff_survey_send_time', '20:30'),
  ('staff_survey_enabled',   'false')
on conflict (key) do nothing;

-- The shift survey itself, so it appears in Survey Builder with the others.
insert into survey_templates (name, survey_type, questions, active)
select 'Staff Shift Feedback', 'staff', '[
  {"key":"q1_shift_rating","title":"How did your shift go overall?","hint":"1 = Rough, 5 = Great","type":"stars","required":true,"index":null,"explainer":"The headline read on how the day went for the team."},
  {"key":"q2_support","title":"Did you feel supported by management today?","hint":"1 = Not at all, 5 = Fully supported","type":"stars","required":true,"index":null,"explainer":"Whether the floor had the leadership it needed."},
  {"key":"q3_workload","title":"Was your workload manageable?","hint":"1 = Overwhelming, 5 = Comfortable","type":"stars","required":true,"index":null,"explainer":"Whether the shift was staffed to the covers it took."},
  {"key":"q4_tools","title":"Did you have the stock and equipment you needed?","hint":"1 = Not at all, 5 = Everything · optional","type":"stars","required":false,"index":null,"explainer":"Whether the operation set them up to do the job."},
  {"key":"q5_comment","title":"Anything management should know?","hint":"Optional — 1000 characters max","type":"text","required":false,"index":null,"explainer":"Read by the management team."}
]'::jsonb, true
where not exists (select 1 from survey_templates where survey_type = 'staff');


-- ===========================================================================
-- 4. EVENTS — a department of its own
-- ===========================================================================
-- Events carry their own NPS and CSAT and deliberately do NOT feed the outlet
-- indices. A wedding is not a Tuesday lunch, and averaging them together
-- flatters or damns the dining rooms for something they did not do.

alter table events add column if not exists category text not null default 'general';
alter table events drop constraint if exists events_category_check;
alter table events add  constraint events_category_check
  check (category in ('general', 'golf'));
create index if not exists events_category_idx on events (category, event_date desc);

-- An event can nominate its own survey — a golf day asks about course
-- conditions, a wedding does not.
alter table events add column if not exists template_id uuid references survey_templates(template_id);

create table if not exists event_insights (
  insight_id     uuid primary key default uuid_generate_v4(),
  event_id       uuid not null references events(event_id) on delete cascade,
  urgency        text not null default 'maintain' check (urgency in ('critical', 'watch', 'maintain')),
  headline       text not null default '',
  themes         jsonb not null default '[]',
  what_worked    jsonb not null default '[]',
  response_count integer not null default 0,
  nps            numeric,
  csat           numeric,
  generated_at   timestamptz not null default now()
);
create index if not exists event_insights_event_idx on event_insights (event_id, generated_at desc);

insert into survey_templates (name, survey_type, questions, active)
select 'Golf Event Feedback', 'events', '[
  {"key":"q1","title":"How likely are you to recommend this event to a fellow member?","hint":"0 = Not at all likely, 10 = Extremely likely","type":"nps","required":true,"index":null,"explainer":"The event NPS."},
  {"key":"q2","title":"How would you rate the event overall?","hint":"1 = Poor, 5 = Excellent","type":"stars","required":true,"index":null,"explainer":"The event CSAT."},
  {"key":"q3","title":"How would you rate the course conditions on the day?","hint":"1 = Poor, 5 = Excellent","type":"stars","required":true,"index":null,"explainer":"Course presentation for the event."},
  {"key":"q4","title":"How would you rate the format, pace and organisation?","hint":"1 = Poor, 5 = Excellent · optional","type":"stars","required":false,"index":null,"explainer":"How the day itself was run."},
  {"key":"q5","title":"Anything you would like us to know?","hint":"Optional — 500 characters max","type":"text","required":false,"index":null,"explainer":"Feeds the event AI insight."}
]'::jsonb, true
where not exists (select 1 from survey_templates where name = 'Golf Event Feedback');

-- Strip index tags from event templates. If an events question is tagged CHI
-- or SSI, event scores leak into the club indices through the back door — the
-- exact thing section 4 exists to prevent.
update survey_templates
set questions = (
  select jsonb_agg(jsonb_set(q, '{index}', 'null'::jsonb) order by ord)
  from jsonb_array_elements(questions) with ordinality as t(q, ord)
)
where survey_type = 'events'
  and questions @? '$[*] ? (@.index == "CHI" || @.index == "SSI" || @.index == "OHI")';


-- ===========================================================================
-- 5. PEOPLE — the same vocabulary as visits
-- ===========================================================================
-- A visit has always known whether it was a member, a visitor, a corporate
-- booking or a golf round. The People list could only hold members, so a
-- regular guest had to be retyped into every visit instead of existing as a
-- record. Both now use one list.
--
-- 'golf' is a valid stored value that no form offers: a golf visit is created
-- by the tee sheet importer, never typed in by hand.

alter table members add column if not exists member_type text not null default 'member';
update members set member_type = 'member' where member_type is null;

alter table members drop constraint if exists members_member_type_check;
alter table members add  constraint members_member_type_check
  check (member_type in ('member','visitor','commercial','other','golf'));
create index if not exists members_member_type_idx on members (member_type);

alter table visits drop constraint if exists visits_visitor_type_check;
alter table visits add  constraint visits_visitor_type_check
  check (visitor_type in ('member','visitor','commercial','other','golf'));


-- ===========================================================================
-- 6. SERVERS ARE NOT TEAM MEMBERS
-- ===========================================================================
-- Two different lists that had become tangled. `servers` are the people
-- credited on a visit — they do not log in and have no role. `staff` are the
-- team members who do log in. Linking them meant adding a server silently
-- created a login-capable staff row.
--
-- Dropping the column is what stops them re-coupling. It removes a link, not
-- a person: every server and every team member is left exactly as it is, and
-- no visit loses the server credited on it.
alter table servers drop column if exists staff_id;


-- ===========================================================================
-- 7. ALERT ROUTING — outlets know who answers for them
-- ===========================================================================
-- An alert already knows which outlet the visit was to. Until now it sat
-- unassigned until somebody noticed it in the digest — which on a weekend
-- meant nobody. Naming an owner means the alert is assigned the moment it is
-- raised, and that person is emailed directly.
--
-- Nullable on purpose: an outlet with no owner behaves exactly as before,
-- notifying the managers. Switch it on outlet by outlet.
--
-- ON DELETE SET NULL, because removing somebody from the team must not take
-- the outlet's alerting with it. It falls back to notifying managers, which is
-- noisier than the right person but never silent.
alter table outlets add column if not exists owner_staff_id uuid;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'outlets_owner_staff_id_fkey'
  ) then
    alter table outlets
      add constraint outlets_owner_staff_id_fkey
      foreign key (owner_staff_id) references staff(staff_id) on delete set null;
  end if;
end $$;

create index if not exists outlets_owner_idx on outlets (owner_staff_id);

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'case_alerts_assigned_to_staff_id_fkey'
  ) then
    alter table case_alerts
      add constraint case_alerts_assigned_to_staff_id_fkey
      foreign key (assigned_to_staff_id) references staff(staff_id) on delete set null;
  end if;
end $$;

create index if not exists case_alerts_assigned_idx on case_alerts (assigned_to_staff_id)
  where assigned_to_staff_id is not null;


-- ===========================================================================
-- 8. SMS CREDIT — prepaid balance and Stripe top-ups
-- ===========================================================================

-- What each message actually cost, recorded on the message itself.
alter table message_log add column if not exists segments         integer;
alter table message_log add column if not exists encoding         text;
alter table message_log add column if not exists unit_price_cents numeric(12,6);
alter table message_log add column if not exists billable_cents   numeric(14,6);
alter table message_log add column if not exists kind             text;
alter table message_log add column if not exists club_id          uuid;

alter table message_log drop constraint if exists message_log_encoding_check;
alter table message_log add  constraint message_log_encoding_check
  check (encoding is null or encoding in ('gsm7','ucs2'));

alter table message_log drop constraint if exists message_log_segments_check;
alter table message_log add  constraint message_log_segments_check
  check (segments is null or segments >= 0);

-- 'blocked' — the send was refused for want of credit. Distinct from 'failed',
-- which means it was attempted and the provider rejected it.
alter table message_log drop constraint if exists message_log_status_check;
alter table message_log add  constraint message_log_status_check
  check (status in ('sent','failed','blocked'));

create index if not exists message_log_billing_idx on message_log (channel, status, created_at desc);
create index if not exists message_log_club_idx    on message_log (club_id, created_at desc);

create table if not exists sms_credit_accounts (
  account_id                 uuid primary key default uuid_generate_v4(),
  club_id                    uuid,
  balance_cents              numeric(14,4) not null default 0,
  currency                   text not null default 'USD',
  low_balance_cents          numeric(14,4) not null default 2000,
  critical_balance_cents     numeric(14,4) not null default 500,
  low_balance_notified_at    timestamptz,
  auto_topup_enabled         boolean not null default false,
  auto_topup_threshold_cents numeric(14,4) not null default 1000,
  auto_topup_amount_cents    numeric(14,4) not null default 5000,
  stripe_customer_id         text,
  stripe_payment_method_id   text,
  topup_in_flight_at         timestamptz,
  last_topup_error           text,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

-- One account per club, including the single-club case where club_id is null —
-- which a plain unique index would not catch, since null is never equal to null.
create unique index if not exists sms_credit_accounts_club_idx
  on sms_credit_accounts (coalesce(club_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- A balance cannot go below zero. The application checks before it sends; this
-- is the guarantee that holds even if it ever forgets.
alter table sms_credit_accounts drop constraint if exists sms_credit_balance_non_negative;
alter table sms_credit_accounts add  constraint sms_credit_balance_non_negative
  check (balance_cents >= 0);

create table if not exists sms_credit_ledger (
  entry_id            uuid primary key default uuid_generate_v4(),
  club_id             uuid,
  entry_type          text not null check (entry_type in ('topup','debit','refund','adjustment','reversal')),
  amount_cents        numeric(14,4) not null,
  balance_after_cents numeric(14,4) not null,
  message_log_id      uuid references message_log(log_id),
  kind                text,
  description         text,
  stripe_payment_intent_id text,
  stripe_session_id        text,
  idempotency_key     text not null,
  actor_email         text,
  created_at          timestamptz not null default now()
);

-- The idempotency key is what makes a retried webhook safe. Stripe will resend
-- the same event on any doubt, and without this a club is credited twice.
create unique index if not exists sms_credit_ledger_idem_idx on sms_credit_ledger (idempotency_key);
create index if not exists sms_credit_ledger_club_idx on sms_credit_ledger (club_id, created_at desc);
create index if not exists sms_credit_ledger_type_idx on sms_credit_ledger (entry_type, created_at desc);

-- Debit and credit as single statements, so the balance and the ledger entry
-- cannot disagree — two concurrent sends can never both pass a "do we have
-- enough?" check and take the balance negative between them.
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

  insert into sms_credit_accounts (club_id, balance_cents)
  values (p_club_id, 0)
  on conflict do nothing;

  update sms_credit_accounts
     set balance_cents = balance_cents + p_amount_cents,
         updated_at = now(),
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

-- $0.02 per segment, no markup. Off until a club is ready to switch it on.
insert into club_settings (key, value) values
  ('sms_rate_cents_per_segment', '2'),
  ('sms_markup_pct',             '0'),
  ('sms_billing_currency',       'USD'),
  ('sms_credit_enabled',         'false')
on conflict (key) do nothing;

-- The abandoned post-pay billing. Nothing a club entered by hand ever lived
-- here — periods were generated from the message log, which is untouched.
drop table if exists sms_billing_periods;
delete from club_settings where key = 'sms_included_segments_per_period';


-- ===========================================================================
-- 9. TELL THE API ABOUT ALL OF THIS
-- ===========================================================================
-- Supabase serves the API through PostgREST, which caches the schema. Until it
-- reloads, saving a new field fails with "Could not find the '...' column in
-- the schema cache" even though the column plainly exists. Supabase reloads on
-- its own eventually; this asks for it now.
notify pgrst, 'reload schema';


-- ===========================================================================
-- REPORT — nothing below this line changes anything
-- ===========================================================================

-- Every table this file is responsible for. All nine should say "present".
select 'tables' as report, t.name,
       case when to_regclass('public.' || t.name) is not null then 'present' else 'MISSING' end as state
from (values ('survey_templates'),('club_settings'),('audit_log'),
             ('alert_outreach'),('case_resolutions'),('staff_survey_responses'),
             ('event_insights'),('sms_credit_accounts'),('sms_credit_ledger')) as t(name)
order by state, t.name;

-- The columns that each caused a visible failure when they were missing.
select 'columns' as report, c.tbl || '.' || c.col as column_name,
       case when exists (
         select 1 from information_schema.columns
          where table_name = c.tbl and column_name = c.col
       ) then 'present' else 'MISSING' end as state
from (values ('outlets','owner_staff_id'),
             ('case_alerts','assigned_to_staff_id'),
             ('case_alerts','contact_due_at'),
             ('members','member_type'),
             ('events','category'),
             ('event_attendees','survey_sent_at'),
             ('message_log','billable_cents'),
             ('message_log','club_id')) as c(tbl, col)
order by state, column_name;

-- servers.staff_id should be gone. Anything else means section 6 did not run.
select 'servers.staff_id' as report,
       case when exists (
         select 1 from information_schema.columns
          where table_name = 'servers' and column_name = 'staff_id'
       ) then 'STILL PRESENT — servers and team members are still coupled'
       else 'removed — servers and team members are separate' end as state;

-- The templates the Builder should now be showing.
select 'templates' as report, survey_type, name, active,
       jsonb_array_length(questions) as questions
from survey_templates order by survey_type, created_at;

-- Who alerts go to. Nothing is assigned automatically — who runs which outlet
-- is a decision, not something to infer. This is the list to fill in.
select 'alert routing' as report, o.name as outlet,
       coalesce(s.name, '— nobody yet, alerts go to the managers —') as alerts_go_to
from outlets o
left join staff s on s.staff_id = o.owner_staff_id
where o.active
order by (o.owner_staff_id is not null), o.name;

-- The two people lists, which should now be independent of each other.
select 'people' as report, 'team members (can log in)' as list, count(*) as active from staff   where active
union all
select 'people', 'servers (credited on visits)',              count(*)           from servers where active;
