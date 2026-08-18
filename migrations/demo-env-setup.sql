-- ===========================================================================
-- VERO — demo environment setup
--
-- Run this in the Supabase SQL editor of the DEMO project only
-- (Walpole CC - Demo Env). Safe to run more than once.
--
-- It does four things:
--   1. Repairs the schema bits that make "Log a call" fail.
--   2. Puts every open alert into a state where "Resolve" works.
--   3. Seeds ten training plans across your outlets.
--   4. Seeds AI insights, one per outlet, for the current week.
--
-- Paste the whole file in and hit Run. Section 0 at the bottom is an optional
-- probe you can run on its own if anything still errors.
-- ===========================================================================


-- ===========================================================================
-- 1. SCHEMA REPAIR — why "Log a call" errors
-- ===========================================================================
-- Logging a call writes a row to alert_outreach and then moves the alert to
-- status 'contacted'. Both halves need the service-recovery migration to have
-- run. If any piece is missing the insert throws and the modal shows the raw
-- database error. Everything below is idempotent.

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

-- --- case_alerts: the recovery clock -------------------------------------
alter table case_alerts add column if not exists ai_summary           text;
alter table case_alerts add column if not exists assigned_to_staff_id uuid;
alter table case_alerts add column if not exists contact_due_at       timestamptz;
alter table case_alerts add column if not exists first_contact_at     timestamptz;
alter table case_alerts add column if not exists first_reached_at     timestamptz;
alter table case_alerts add column if not exists outreach_count       integer not null default 0;
alter table case_alerts add column if not exists no_contact_reason    text;
alter table case_alerts add column if not exists recovery_token       text;
alter table case_alerts add column if not exists escalated_stage      text;
alter table case_alerts add column if not exists escalated_at         timestamptz;

-- 'contacted' sits between assigned and resolved. Without it in the check
-- constraint, logging a call writes the outreach row and then fails to move
-- the alert on — which is the most common cause of the error you are seeing.
alter table case_alerts drop constraint if exists case_alerts_status_check;
alter table case_alerts add  constraint case_alerts_status_check
  check (status in ('open','assigned','contacted','resolved'));

alter table case_alerts drop constraint if exists case_alerts_escalated_stage_check;
alter table case_alerts add  constraint case_alerts_escalated_stage_check
  check (escalated_stage is null or escalated_stage in ('half','final','breached'));

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'case_alerts_recovery_token_key') then
    alter table case_alerts add constraint case_alerts_recovery_token_key unique (recovery_token);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'case_alerts_assigned_to_staff_id_fkey') then
    alter table case_alerts add constraint case_alerts_assigned_to_staff_id_fkey
      foreign key (assigned_to_staff_id) references staff(staff_id) on delete set null;
  end if;
end $$;

create index if not exists case_alerts_due_idx on case_alerts (contact_due_at)
  where first_contact_at is null;

-- --- alert_outreach: the row "Log a call" writes --------------------------
create table if not exists alert_outreach (
  outreach_id      uuid primary key default uuid_generate_v4(),
  alert_id         uuid not null references case_alerts(alert_id) on delete cascade,
  member_id        text references members(member_id),
  channel          text not null,
  outcome          text not null,
  member_sentiment text,
  notes            text,
  occurred_at      timestamptz not null default now(),
  logged_by        uuid,
  logged_by_name   text,
  logged_via       text not null default 'dashboard',
  created_at       timestamptz not null default now()
);

-- Repairs a table that exists but was created from an older migration.
alter table alert_outreach add column if not exists member_id        text;
alter table alert_outreach add column if not exists member_sentiment text;
alter table alert_outreach add column if not exists notes            text;
alter table alert_outreach add column if not exists occurred_at      timestamptz not null default now();
alter table alert_outreach add column if not exists logged_by        uuid;
alter table alert_outreach add column if not exists logged_by_name   text;
alter table alert_outreach add column if not exists logged_via       text not null default 'dashboard';
alter table alert_outreach add column if not exists created_at       timestamptz not null default now();

-- The five channels and five outcomes the dashboard offers. If the constraint
-- is narrower than the dropdown, picking "In person" or "Wrong number" errors.
alter table alert_outreach drop constraint if exists alert_outreach_channel_check;
alter table alert_outreach add  constraint alert_outreach_channel_check
  check (channel in ('phone','in_person','sms','email','letter'));

alter table alert_outreach drop constraint if exists alert_outreach_outcome_check;
alter table alert_outreach add  constraint alert_outreach_outcome_check
  check (outcome in ('reached','left_message','no_answer','declined','wrong_number'));

alter table alert_outreach drop constraint if exists alert_outreach_member_sentiment_check;
alter table alert_outreach add  constraint alert_outreach_member_sentiment_check
  check (member_sentiment is null or member_sentiment in ('recovered','neutral','still_unhappy'));

alter table alert_outreach drop constraint if exists alert_outreach_logged_via_check;
alter table alert_outreach add  constraint alert_outreach_logged_via_check
  check (logged_via in ('dashboard','one_tap','api'));

alter table alert_outreach drop constraint if exists alert_outreach_notes_check;
alter table alert_outreach add  constraint alert_outreach_notes_check
  check (notes is null or char_length(notes) <= 2000);

-- Staff who have since been removed must not block a call being logged.
-- Tolerant of historic rows that name somebody no longer on the team: the
-- constraint is skipped rather than failing the whole script.
do $$
begin
  alter table alert_outreach drop constraint if exists alert_outreach_logged_by_fkey;
  alter table alert_outreach add  constraint alert_outreach_logged_by_fkey
    foreign key (logged_by) references staff(staff_id) on delete set null;
exception when others then
  raise notice 'Skipped alert_outreach.logged_by FK: %', sqlerrm;
end $$;

create index if not exists alert_outreach_alert_idx  on alert_outreach (alert_id, occurred_at);
create index if not exists alert_outreach_member_idx on alert_outreach (member_id, occurred_at);

-- --- case_resolutions: what "Resolve" writes ------------------------------
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
  notes             text check (char_length(notes) <= 2000),
  goodwill_type     text check (goodwill_type in (
    'none','comped_item','comped_visit','account_credit','gift','other')),
  goodwill_amount   numeric(10,2) check (goodwill_amount >= 0),
  contacted_member  boolean not null default false,
  no_contact_reason text,
  resolved_by       uuid references staff(staff_id),
  resolved_by_name  text,
  resolved_at       timestamptz not null default now(),
  superseded_at     timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists case_resolutions_alert_idx on case_resolutions (alert_id, resolved_at desc);
create index if not exists case_resolutions_current_idx on case_resolutions (resolved_at)
  where superseded_at is null;
create unique index if not exists case_resolutions_one_current_idx
  on case_resolutions (alert_id) where superseded_at is null;

-- --- training_plans: the owner columns the screen reads -------------------
alter table training_plans add column if not exists owner_staff_id uuid;
alter table training_plans add column if not exists owner_name     text;
alter table training_plans add column if not exists assigned_at    timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'training_plans_owner_staff_id_fkey') then
    alter table training_plans add constraint training_plans_owner_staff_id_fkey
      foreign key (owner_staff_id) references staff(staff_id) on delete set null;
  end if;
end $$;

-- --- the call-back windows the recovery queue sorts on --------------------
insert into club_settings (key, value) values
  ('recovery_sla_high_minutes',   '1440'),
  ('recovery_sla_medium_minutes', '4320'),
  ('recovery_sla_low_minutes',    '10080')
on conflict (key) do nothing;

-- PostgREST caches the schema. Without this the API can keep 500ing on the
-- columns you just added until the project restarts.
notify pgrst, 'reload schema';


-- ===========================================================================
-- 2. ALERTS — make the demo run cleanly end to end
-- ===========================================================================
-- Why "Resolve" shows an empty first dropdown:
--
-- When an alert has no logged contact, the Resolve modal adds a first question
-- — "Nobody spoke to <member> — why?" — and the dashboard has no options list
-- to fill it with, so it renders empty and the save is blocked. That is a bug
-- in vero-dashboard.html, not in the data. The reliable demo workaround is to
-- make sure every alert you might resolve already has a contact logged against
-- it: the empty question is then never asked and Resolve works normally.
--
-- This block gives every open alert a call-back clock and a recovery token,
-- logs a call against all but the two newest, and leaves those two clean so
-- you can demo "Log a call" live.

do $alerts$
declare
  v_staff_id   uuid;
  v_staff_name text;
  v_left_open  int;
begin
  select staff_id, name into v_staff_id, v_staff_name
    from staff where coalesce(active, true) order by name limit 1;

  -- Everyone gets a due date, so the recovery queue can sort them.
  update case_alerts
     set contact_due_at = created_at + (case severity
           when 'high'   then interval '1440 minutes'
           when 'medium' then interval '4320 minutes'
           else               interval '10080 minutes' end)
   where contact_due_at is null
     and status <> 'resolved';

  -- One-tap logging links in the escalation emails.
  update case_alerts set recovery_token = gen_random_uuid()::text
   where recovery_token is null;

  -- Log a call against every open alert except the two most recent.
  create temp table _demo_contact on commit drop as
    select alert_id
      from case_alerts
     where status <> 'resolved'
       and first_contact_at is null
     order by created_at desc
    offset 2;

  insert into alert_outreach
    (alert_id, member_id, channel, outcome, member_sentiment, notes,
     occurred_at, logged_by, logged_by_name, logged_via)
  select ca.alert_id,
         v.member_id,
         'phone',
         'reached',
         'recovered',
         'Rang them the next morning. Apologised, they were happy to leave it there.',
         ca.created_at + interval '14 hours',
         v_staff_id,
         v_staff_name,
         'dashboard'
    from case_alerts ca
    join _demo_contact d on d.alert_id = ca.alert_id
    left join survey_responses sr on sr.response_id = ca.response_id
    left join visits v on v.visit_id = sr.visit_id;

  update case_alerts ca
     set first_contact_at = ca.created_at + interval '14 hours',
         first_reached_at = ca.created_at + interval '14 hours',
         outreach_count   = greatest(ca.outreach_count, 1),
         status           = case when ca.status = 'open' then 'contacted' else ca.status end
    from _demo_contact d
   where d.alert_id = ca.alert_id;

  select count(*) into v_left_open
    from case_alerts where status <> 'resolved' and first_contact_at is null;

  raise notice 'Alerts ready. % left uncontacted for the Log-a-call demo.', v_left_open;
end
$alerts$;


-- ===========================================================================
-- 3. TRAINING PLANS
-- ===========================================================================
-- Ten plans spread over your real outlets and the last three weeks, with a
-- mix of owned/unowned and part-completed steps so the screen has something
-- to show. Re-running replaces only the last six weeks of plans; anything
-- older is left alone.

do $training$
declare
  v_outlets int;
  v_staff   int;
begin
  create temp table _t_outlets on commit drop as
    select row_number() over (order by name) as slot, outlet_id, name
      from outlets where coalesce(active, true);
  select count(*) into v_outlets from _t_outlets;
  if v_outlets = 0 then
    raise exception 'No active outlets. Add your outlets in Settings first.';
  end if;

  create temp table _t_staff on commit drop as
    select row_number() over (order by name) as slot, staff_id, name
      from staff where coalesce(active, true);
  select count(*) into v_staff from _t_staff;

  delete from training_plans
   where week_start >= (date_trunc('week', now())::date - 42);

  insert into training_plans
    (outlet_id, week_start, steps, basis_summary, generated_at,
     owner_staff_id, owner_name, assigned_at)
  select o.outlet_id,
         (date_trunc('week', now())::date - (p.weeks_ago * 7)),
         p.steps,
         p.basis,
         (date_trunc('week', now()) - (p.weeks_ago * interval '7 days') + interval '4 days 7 hours'),
         s.staff_id,
         s.name,
         case when s.staff_id is null then null
              else (date_trunc('week', now()) - (p.weeks_ago * interval '7 days') + interval '4 days 9 hours') end
    from (values
      (1, 0, 'Based on 14 comments · 118 responses',
       '[{"text":"Second server on the floor Thursday to Saturday from 6pm — every slow-service comment this week landed in that window.","priority":"Immediate","done":true},
         {"text":"Brief the team on the 10-minute drinks rule: no table waits longer than that for a first order.","priority":"Immediate","done":true},
         {"text":"Walk the room at 7:30pm and again at 8:30pm. Two touches per table, minimum.","priority":"This week","done":false},
         {"text":"Review the Friday rota against covers each Monday rather than reusing last week''s.","priority":"Ongoing","done":false}]'::jsonb, 1),

      (2, 0, 'Based on 9 comments · 76 responses',
       '[{"text":"Replace the two wobbling tables by the window — named in three separate comments.","priority":"Immediate","done":true},
         {"text":"Reset the terrace heaters before 5pm service, not when the first member asks.","priority":"This week","done":false},
         {"text":"Add a mid-service cleanliness sweep of the bar top and rails.","priority":"Ongoing","done":false}]'::jsonb, 2),

      (3, 0, 'Based on 11 comments · 94 responses',
       '[{"text":"Stop running out of the special by 8pm — increase prep by 30% on Fridays.","priority":"Immediate","done":false},
         {"text":"Kitchen to flag 86''d items to the floor as they go, not at the pass.","priority":"This week","done":false},
         {"text":"Taste-check the soup and the sauces at the start of each service.","priority":"Ongoing","done":false},
         {"text":"Weekly menu review with the chef on Monday mornings.","priority":"Ongoing","done":false}]'::jsonb, 0),

      (4, 0, 'Based on 6 comments · 52 responses',
       '[{"text":"Greet every arrival within 30 seconds — two members mentioned standing unnoticed.","priority":"Immediate","done":false},
         {"text":"Retrain the team on the booking system so double-bookings stop.","priority":"This week","done":false},
         {"text":"Confirm large bookings by phone the day before.","priority":"Ongoing","done":false}]'::jsonb, 3),

      (1, 1, 'Based on 12 comments · 105 responses',
       '[{"text":"Coach the two newest servers on order accuracy — four wrong-order comments.","priority":"Immediate","done":true},
         {"text":"Repeat the order back at the table, every time.","priority":"This week","done":true},
         {"text":"Spot-check tickets against tables during the Saturday rush.","priority":"Ongoing","done":true}]'::jsonb, 1),

      (2, 1, 'Based on 8 comments · 68 responses',
       '[{"text":"Fix the card reader that has failed twice at the bar.","priority":"Immediate","done":true},
         {"text":"Keep a spare reader charged behind the bar.","priority":"This week","done":true},
         {"text":"Check the till float and reader at open, on the checklist.","priority":"Ongoing","done":false}]'::jsonb, 2),

      (3, 1, 'Based on 10 comments · 88 responses',
       '[{"text":"Portion sizes have drifted — re-weigh the mains against spec.","priority":"Immediate","done":true},
         {"text":"Photograph the plated spec and pin it at the pass.","priority":"This week","done":false},
         {"text":"Monthly plate-spec audit with the chef.","priority":"Ongoing","done":false}]'::jsonb, 0),

      (4, 1, 'Based on 5 comments · 41 responses',
       '[{"text":"Open the second till at the halfway house on weekend mornings.","priority":"Immediate","done":true},
         {"text":"Pre-stock the buggies before the 8am tee times.","priority":"This week","done":true},
         {"text":"Check starter sheet against the pro shop diary daily.","priority":"Ongoing","done":true}]'::jsonb, 3),

      (1, 2, 'Based on 13 comments · 112 responses',
       '[{"text":"Noise in the main room at peak — move the large parties to the private side.","priority":"Immediate","done":true},
         {"text":"Soft-close the bar shutters during dinner service.","priority":"This week","done":true},
         {"text":"Review table layout for parties over eight.","priority":"Ongoing","done":true}]'::jsonb, 1),

      (2, 2, 'Based on 7 comments · 61 responses',
       '[{"text":"Wine list is out of date — three members ordered something unavailable.","priority":"Immediate","done":true},
         {"text":"Reprint the list and check stock against it weekly.","priority":"This week","done":true},
         {"text":"Sommelier briefing for the floor team each Thursday.","priority":"Ongoing","done":false}]'::jsonb, 2)
    ) as p(slot, weeks_ago, basis, steps, owner_slot)
    join _t_outlets o on o.slot = ((p.slot - 1) % v_outlets) + 1
    left join _t_staff s on v_staff > 0
                        and p.owner_slot > 0
                        and s.slot = ((p.owner_slot - 1) % greatest(v_staff, 1)) + 1;

  raise notice 'Training plans seeded across % outlet(s).', v_outlets;
end
$training$;


-- ===========================================================================
-- 4. AI INSIGHTS
-- ===========================================================================
-- One insight per outlet for the current week, with theme clusters so the
-- Insights screen renders its cards rather than the empty state. Re-running
-- replaces only the last six weeks.

do $insights$
declare
  v_outlets int;
begin
  create temp table _i_outlets on commit drop as
    select row_number() over (order by name) as slot, outlet_id, name
      from outlets where coalesce(active, true);
  select count(*) into v_outlets from _i_outlets;
  if v_outlets = 0 then
    raise exception 'No active outlets. Add your outlets in Settings first.';
  end if;

  delete from ai_insights
   where week_start >= (date_trunc('week', now())::date - 42);

  insert into ai_insights
    (outlet_id, week_start, urgency, headline, themes, response_count, created_at)
  select o.outlet_id,
         date_trunc('week', now())::date,
         i.urgency,
         i.headline,
         i.themes,
         i.response_count,
         date_trunc('week', now()) + interval '4 days 7 hours'
    from (values
      (1, 'critical',
       'Service speed on Thursday to Saturday evenings is the single thing dragging this outlet down — nine of the fourteen comments name the wait, and four of them came from members who scored 6 or below.',
       '[{"keyword":"wait for drinks","trend":"rising","count":9,"sentiment":"negative","example_quote":"Lovely evening but we waited twenty minutes before anyone took a drinks order."},
         {"keyword":"food quality","trend":"stable","count":6,"sentiment":"positive","example_quote":"The lamb was as good as anything we have had here."},
         {"keyword":"staff friendliness","trend":"rising","count":5,"sentiment":"positive","example_quote":"The young lad on the bar could not have been more helpful."},
         {"keyword":"noise at peak","trend":"rising","count":3,"sentiment":"negative","example_quote":"Hard to hold a conversation once the room filled up."}]'::jsonb,
       118),

      (2, 'watch',
       'Nothing is badly wrong here, but the same two complaints keep recurring: the terrace not being ready at open, and small maintenance jobs that members notice before we do.',
       '[{"keyword":"terrace readiness","trend":"rising","count":5,"sentiment":"negative","example_quote":"Heaters were off and the tables had not been wiped down at five."},
         {"keyword":"wobbly tables","trend":"stable","count":3,"sentiment":"negative","example_quote":"Third time on the same table by the window."},
         {"keyword":"bar service","trend":"falling","count":7,"sentiment":"positive","example_quote":"Quick, cheerful, exactly what you want after eighteen holes."}]'::jsonb,
       76),

      (3, 'watch',
       'Availability, not quality, is the theme. Members rate the food highly and then tell us it had run out — that combination costs more goodwill than a mediocre dish would.',
       '[{"keyword":"ran out of special","trend":"rising","count":6,"sentiment":"negative","example_quote":"Came specifically for the special and it had gone by eight."},
         {"keyword":"portion size","trend":"rising","count":4,"sentiment":"negative","example_quote":"Smaller than it used to be for the same money."},
         {"keyword":"chef''s cooking","trend":"stable","count":8,"sentiment":"positive","example_quote":"Best kitchen we have had in years, when they have got it."}]'::jsonb,
       94),

      (4, 'maintain',
       'Steady week. The one thing worth watching is arrivals going ungreeted at busy periods — it is a small number of comments but it is the first impression every time.',
       '[{"keyword":"welcome on arrival","trend":"rising","count":3,"sentiment":"negative","example_quote":"Stood at the desk a good few minutes before anyone looked up."},
         {"keyword":"pace of play","trend":"stable","count":4,"sentiment":"positive","example_quote":"Round finished in under four hours, which is rare and appreciated."},
         {"keyword":"course condition","trend":"stable","count":6,"sentiment":"positive","example_quote":"Greens are running beautifully."}]'::jsonb,
       52)
    ) as i(slot, urgency, headline, themes, response_count)
    -- Every outlet gets one, cycling through the four write-ups if the club
    -- has more outlets than that.
    join _i_outlets o on i.slot = ((o.slot - 1) % 4) + 1;

  raise notice 'AI insights seeded for % outlet(s).', v_outlets;
end
$insights$;


-- ===========================================================================
-- WHAT YOU SHOULD SEE
-- ===========================================================================
select 'training plans'  as what, count(*) as row_count from training_plans
union all select 'ai insights',     count(*) from ai_insights
union all select 'alerts total',    count(*) from case_alerts
union all select 'alerts contacted',count(*) from case_alerts where first_contact_at is not null
union all select 'alerts to call',  count(*) from case_alerts
       where status <> 'resolved' and first_contact_at is null
union all select 'outreach logged', count(*) from alert_outreach;


-- ===========================================================================
-- 0. OPTIONAL PROBE — run this on its own if "Log a call" still errors
-- ===========================================================================
-- Does exactly what the dashboard does, against a real alert, then deliberately
-- aborts so nothing is written. If it raises "PROBE OK" the database is fine
-- and the problem is elsewhere. Any other error message is the real cause —
-- send it over.
--
-- do $probe$
-- declare
--   v_alert_id  uuid;
--   v_member_id text;
-- begin
--   select ca.alert_id, v.member_id into v_alert_id, v_member_id
--     from case_alerts ca
--     left join survey_responses sr on sr.response_id = ca.response_id
--     left join visits v on v.visit_id = sr.visit_id
--    where ca.status <> 'resolved'
--    order by ca.created_at desc
--    limit 1;
--
--   if v_alert_id is null then
--     raise exception 'No unresolved alert to probe against.';
--   end if;
--
--   insert into alert_outreach
--     (alert_id, member_id, channel, outcome, member_sentiment, notes, logged_via)
--   values (v_alert_id, v_member_id, 'phone', 'reached', 'recovered', 'probe', 'dashboard');
--
--   update case_alerts
--      set status = 'contacted', first_contact_at = now(),
--          first_reached_at = now(), outreach_count = outreach_count + 1
--    where alert_id = v_alert_id;
--
--   raise exception 'PROBE OK — logging a call would succeed. Nothing was written.';
-- end
-- $probe$;
