-- Vero MVP schema — Supabase (Postgres)
-- Six core objects: members, outlets, visits, survey_responses, training_plans, case_alerts

create extension if not exists "uuid-ossp";

-- 1. Members (from CRM/POS export)
create table members (
  member_id        text primary key,           -- must match POS member_id exactly
  first_name       text not null,
  last_name        text not null,
  phone_number     text,                        -- E.164 format, e.g. +14155551234
  email_address    text,
  comm_preference  text not null default 'sms' check (comm_preference in ('sms','email')),
  opt_out          boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- 2. Outlets. NOTE: for Aronimink Golf Club specifically, the real outlet
-- names from the 06/28/2026 POS export are "Golf Patio", "Belmont Dining
-- Room", and "Belmont Poolside" — seed this table with those, not placeholder
-- names. Thresholds below are inferred from typical check size in that
-- export and need confirming with the F&B Director before going live.
-- Configured once by the club admin via the Survey Builder screen (brief: "Backend
-- logic scans daily upload, filters transactions above spend_threshold, cross-
-- references member ID against membership database, checks the member hasn't
-- already been surveyed within the frequency window").
create table outlets (
  outlet_id            uuid primary key default uuid_generate_v4(),
  name                 text not null,
  min_spend_threshold  numeric(10,2) not null default 0,   -- e.g. 75.00 triggers a survey
  frequency_limit_days integer not null default 30,        -- don't re-survey the same member inside this window
  active               boolean not null default true
);

insert into outlets (name, min_spend_threshold, frequency_limit_days) values
  ('Belmont Dining Room', 75.00, 30),
  ('Golf Patio', 15.00, 30),
  ('Belmont Poolside', 20.00, 14);

-- 3. Visits (parsed from the daily end-of-shift POS export, or added manually)
-- member_id is nullable: guests, commercial visitors, and walk-ins won't have
-- one. When member_id is null, guest_name + at least one of guest_phone /
-- guest_email identify the visitor for survey delivery.
create table visits (
  visit_id         uuid primary key default uuid_generate_v4(),
  member_id        text references members(member_id),
  outlet_id        uuid references outlets(outlet_id),
  visit_date       date not null,
  spend_amount     numeric(10,2) not null,
  server_name      text,
  visitor_type     text not null default 'member' check (visitor_type in ('member','visitor','commercial','other','golf')),
  guest_name       text,              -- used when member_id is null
  guest_phone      text,              -- E.164, used for SMS survey delivery to non-members
  guest_email      text,              -- used for email survey delivery to non-members
  qualifies        boolean not null default false,
  survey_sent_at   timestamptz,
  reminder_sent_at timestamptz,
  created_at       timestamptz not null default now()
);
create index on visits (member_id);
create index on visits (outlet_id, visit_date);

-- 4. Survey responses — exactly 5 questions, in the order the guest sees them.
-- Q1 (NPS) and Q2/Q3 (overall, food) are required; Q4 (atmosphere) is the one
-- the brief's own partial-completion example shows as skippable; Q5 is always
-- optional and is the field the weekly AI analysis reads.
create table survey_responses (
  response_id       uuid primary key default uuid_generate_v4(),
  visit_id          uuid references visits(visit_id) unique,
  survey_token      text not null unique,           -- unique link token, no login
  q1_nps            smallint check (q1_nps between 0 and 10),        -- required
  q2_overall_stars  smallint check (q2_overall_stars between 1 and 5), -- required
  q3_food_stars     smallint check (q3_food_stars between 1 and 5),    -- required
  q4_service_stars  smallint check (q4_service_stars between 1 and 5), -- skippable
  q5_comment        text check (char_length(q5_comment) <= 500),       -- optional, feeds AI analysis
  submitted_at      timestamptz,
  is_complete       boolean not null default false,
  created_at        timestamptz not null default now()
);

-- 5. Training action plans (AI-generated, weekly, per outlet)
create table training_plans (
  plan_id          uuid primary key default uuid_generate_v4(),
  outlet_id        uuid references outlets(outlet_id),
  week_start       date not null,
  steps            jsonb not null,                -- ordered array of prioritised action strings
  basis_summary    text,                          -- e.g. "Based on 14 comments · 118 responses"
  generated_at     timestamptz not null default now()
);

-- 6. Case alerts (any low-score response, flagged same day)
create table case_alerts (
  alert_id         uuid primary key default uuid_generate_v4(),
  response_id      uuid references survey_responses(response_id),
  outlet_id        uuid references outlets(outlet_id),
  severity         text not null check (severity in ('low','medium','high')),
  status           text not null default 'open' check (status in ('open','assigned','resolved')),
  assigned_to      text,
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz
);

-- A response scoring 1-2 on q2_overall_stars, or q1_nps 0-6, auto-creates a case alert.
-- Enforced in the edge function (receive_response), not as a DB trigger, so the
-- alert can carry AI-derived context (see analyze_weekly.ts) rather than just the raw score.

-- 7. Survey templates — different question sets for Food & Bev, Golf, Events
create table survey_templates (
  template_id      uuid primary key default uuid_generate_v4(),
  name             text not null,
  survey_type      text not null check (survey_type in ('food_bev', 'golf', 'events')),
  questions        jsonb not null,   -- array of {key, title, hint, type, required}
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);

-- Seed default templates
-- Each rated question declares the benchmarked index it feeds:
--   CHI = Club Health, SSI = Service Satisfaction,
--   OHI = Operational Health (operational effectiveness).
-- index:null means the question is collected but excluded from benchmarks.
insert into survey_templates (name, survey_type, questions) values
  ('Food & Beverage', 'food_bev', '[
    {"key":"q1","title":"How likely are you to recommend us to a friend or colleague?","hint":"0 = Not at all likely, 10 = Extremely likely","type":"nps","required":true,"index":"CHI","explainer":"Tracks overall loyalty to the club."},
    {"key":"q2","title":"How would you rate the service today?","hint":"1 = Poor, 5 = Excellent","type":"stars","required":true,"index":"SSI","explainer":"Measures how well our team looked after you."},
    {"key":"q3","title":"How would you rate the food quality?","hint":"1 = Poor, 5 = Excellent","type":"stars","required":true,"index":"OHI","explainer":"Operational: kitchen execution."},
    {"key":"q4","title":"How would you rate the overall atmosphere?","hint":"1 = Poor, 5 = Excellent · optional","type":"stars","required":false,"index":"OHI","explainer":"Operational: outlet readiness and upkeep."},
    {"key":"q5","title":"Anything you''d like us to know?","hint":"Optional — 500 characters max","type":"text","required":false,"index":null,"explainer":"Read by the management team each week."}
  ]'),
  ('Golf Experience', 'golf', '[
    {"key":"q1","title":"How likely are you to recommend our golf facilities to a friend?","hint":"0 = Not at all likely, 10 = Extremely likely","type":"nps","required":true,"index":"CHI","explainer":"Tracks overall loyalty to the club."},
    {"key":"q2","title":"How would you rate the course conditions today?","hint":"1 = Poor, 5 = Excellent","type":"stars","required":true,"index":"OHI","explainer":"Operational: course presentation and maintenance."},
    {"key":"q3","title":"How would you rate the pace of play?","hint":"1 = Very slow, 5 = Excellent pace","type":"stars","required":true,"index":"OHI","explainer":"Operational: pace of play and starter management."},
    {"key":"q4","title":"How would you rate the pro shop and staff?","hint":"1 = Poor, 5 = Excellent · optional","type":"stars","required":false,"index":"SSI","explainer":"Measures how well our team looked after you."},
    {"key":"q5","title":"Any suggestions for improving the golf experience?","hint":"Optional — 500 characters max","type":"text","required":false,"index":null,"explainer":"Read by the golf team each week."}
  ]'),
  -- Events are their own department: index is null throughout, so an event
  -- never moves CHI, SSI or OHI. They are scored on their own NPS and CSAT —
  -- see lib/event-scores.js and migrations/events-module.sql.
  ('Event Feedback', 'events', '[
    {"key":"q1","title":"How likely are you to attend a similar event in the future?","hint":"0 = Not at all likely, 10 = Extremely likely","type":"nps","required":true,"index":null,"explainer":"The event NPS."},
    {"key":"q2","title":"How would you rate the overall event experience?","hint":"1 = Poor, 5 = Excellent","type":"stars","required":true,"index":null,"explainer":"The event CSAT."},
    {"key":"q3","title":"How would you rate the food and drinks?","hint":"1 = Poor, 5 = Excellent","type":"stars","required":true,"index":null,"explainer":"Catering execution on the day."},
    {"key":"q4","title":"How would you rate the organization and venue?","hint":"1 = Poor, 5 = Excellent · optional","type":"stars","required":false,"index":null,"explainer":"How the event itself was run."},
    {"key":"q5","title":"What could we do to make the next event even better?","hint":"Optional — 500 characters max","type":"text","required":false,"index":null,"explainer":"Read by the events team each week."}
  ]');

-- Add template reference to survey_responses
-- (q1-q5 columns kept for backward compatibility; new surveys also store in answers JSONB)
alter table survey_responses add column template_id uuid references survey_templates(template_id);

-- An outlet may nominate its own survey template. Without this every non-golf
-- outlet asks the same food & beverage questions, which is wrong for a tennis
-- centre or a lesson. Null means "use the default for the visit's type".
alter table outlets add column template_id uuid references survey_templates(template_id);
alter table survey_responses add column answers jsonb;
alter table survey_responses add column ai_tags jsonb;

alter table case_alerts add column ai_summary text;

-- 8. AI Insights — full weekly analysis stored per outlet for the Insights screen
create table ai_insights (
  insight_id       uuid primary key default uuid_generate_v4(),
  outlet_id        uuid references outlets(outlet_id),
  week_start       date not null,
  urgency          text not null default 'maintain' check (urgency in ('critical', 'watch', 'maintain')),
  headline         text not null default '',
  themes           jsonb not null default '[]',
  response_count   integer not null default 0,
  created_at       timestamptz not null default now()
);

-- 9. Staff — users who can be assigned case alerts and manage the system
create table staff (
  staff_id         uuid primary key default uuid_generate_v4(),
  name             text not null,
  email            text,
  role             text not null check (role in ('super_admin', 'general_manager', 'fb_director', 'dept_head', 'shift_manager', 'golf_shift_manager')),
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);

-- Seed staff (matches the hardcoded user-roles table in the dashboard)
insert into staff (name, email, role) values
  ('Sarah Kim',   'skim@aronimink.com',   'general_manager'),
  ('Tom Reyes',   'treyes@aronimink.com',  'fb_director'),
  ('Priya Anand', 'panand@aronimink.com',  'dept_head');

-- 10. Servers — front-line waitstaff / servers assigned to visits.
-- Separate from the `staff` table which holds management roles only.
-- Front-line servers credited with sales. Deliberately NOT linked to `staff`:
-- that is who signs in to the dashboard, this is who is credited with a
-- cheque, scored on the leaderboard and sent a shift survey. They used to
-- carry a staff_id and be created from each other, which put managers in the
-- Server dropdown and put every waiter in Team members holding dashboard
-- access. Somebody who is genuinely both is on both lists, by choice.
create table servers (
  server_id        uuid primary key default uuid_generate_v4(),
  name             text not null,
  phone            text,
  email            text,
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);

-- Link visits to servers via FK (coexists with legacy server_name text column)
alter table visits add column server_id uuid references servers(server_id);
create index on visits (server_id);

-- Link server_tasks to servers via FK (coexists with legacy server_name text column)
alter table server_tasks add column server_id uuid references servers(server_id);

-- Migration notes for existing databases:
-- CREATE TABLE servers ( ... );   -- run the CREATE TABLE above
-- ALTER TABLE visits ADD COLUMN server_id uuid REFERENCES servers(server_id);
-- CREATE INDEX ON visits (server_id);
-- ALTER TABLE server_tasks ADD COLUMN server_id uuid REFERENCES servers(server_id);

-- 11. Integration credentials — Sendly/SendGrid, entered via the Settings screen.
-- Secrets (API keys) are NEVER stored in plain columns. They go into
-- Supabase Vault (`select vault.create_secret(value, name)`), and this table
-- holds only the returned UUID reference. Non-secret fields (from number,
-- from email) are stored directly — there's nothing to protect there.
-- Requires the `supabase_vault` extension, enabled by default on new projects.
create table club_integrations (
  club_id                 uuid primary key default uuid_generate_v4(),
  sendly_api_key_secret_id    uuid,        -- references vault.secrets.id
  sendly_from_number      text,
  sendgrid_api_key_secret_id  uuid,        -- references vault.secrets.id
  sendgrid_from_email     text,
  updated_at              timestamptz not null default now()
);

-- Reading a secret back (server-side only, e.g. inside send_surveys.ts):
--   select decrypted_secret from vault.decrypted_secrets where id = :secret_id;
-- This view requires the service-role key — never exposed to the browser.

-- 8. Message log — every SMS/email the system sends is recorded here.
create table message_log (
  log_id           uuid primary key default uuid_generate_v4(),
  member_id        text references members(member_id),
  channel          text not null check (channel in ('sms','email')),
  recipient        text not null,              -- phone number or email address
  subject          text,                       -- email subject line (null for SMS)
  body             text not null,
  status           text not null default 'sent' check (status in ('sent','failed')),
  error_message    text,
  created_at       timestamptz not null default now()
);
create index on message_log (member_id);
create index on message_log (created_at);

-- Migration: add 'golf' to the visitor_type constraint on visits
-- Run this on the live database if the table already exists:
--   ALTER TABLE visits DROP CONSTRAINT visits_visitor_type_check;
--   ALTER TABLE visits ADD CONSTRAINT visits_visitor_type_check CHECK (visitor_type IN ('member','visitor','commercial','other','golf'));

-- 9. Events — club events (July 4th dinner, wine tasting, etc.) that need
-- post-event feedback surveys sent to all attendees.
create table events (
  event_id         uuid primary key default uuid_generate_v4(),
  name             text not null,
  event_date       date not null,
  description      text,
  -- Golf events are scored apart from the rest and roll up together into
  -- Events overall. Events never feed the club indices.
  category         text not null default 'general' check (category in ('general','golf')),
  -- An event may nominate its own questions; null uses the live Events template.
  template_id      uuid references survey_templates(template_id),
  created_at       timestamptz not null default now()
);
create index on events (category, event_date desc);

-- AI analysis of a single event. Kept apart from ai_insights, which is keyed
-- on an outlet and a week; an event is one occasion on one date.
create table event_insights (
  insight_id     uuid primary key default uuid_generate_v4(),
  event_id       uuid not null references events(event_id) on delete cascade,
  urgency        text not null default 'maintain' check (urgency in ('critical','watch','maintain')),
  headline       text not null default '',
  themes         jsonb not null default '[]',
  what_worked    jsonb not null default '[]',
  response_count integer not null default 0,
  nps            numeric,
  csat           numeric,
  generated_at   timestamptz not null default now()
);
create index on event_insights (event_id, generated_at desc);

-- 10. Event attendees — links members or guests to events for survey delivery.
-- survey_response_id is populated when a survey is sent; the response row is
-- created with visit_id = null (event surveys aren't tied to a specific visit).
-- member_id is nullable — guest attendees have name + phone/email instead.
create table event_attendees (
  attendee_id        uuid primary key default uuid_generate_v4(),
  event_id           uuid not null references events(event_id) on delete cascade,
  member_id          text references members(member_id),
  guest_name         text,
  guest_phone        text,
  guest_email        text,
  survey_response_id uuid references survey_responses(response_id),
  survey_sent_at     timestamptz,
  created_at         timestamptz not null default now(),
  unique (event_id, member_id)
);
create index on event_attendees (event_id);
create index on event_attendees (member_id);

-- Migration: add guest columns to event_attendees on existing databases
-- ALTER TABLE event_attendees ALTER COLUMN member_id DROP NOT NULL;
-- ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS guest_name text;
-- ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS guest_phone text;
-- ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS guest_email text;

-- 11. Server tasks — AI-generated monthly training & recognition tasks tied to server performance
create table server_tasks (
  task_id          uuid primary key default uuid_generate_v4(),
  server_name      text not null,
  month            text not null,                -- 'YYYY-MM' format
  category         text not null check (category in ('training','recognition')),
  title            text not null,
  description      text not null default '',
  key_metric       text,
  assigned_to      uuid references staff(staff_id),
  completed        boolean not null default false,
  completed_at     timestamptz,
  created_at       timestamptz not null default now()
);
create index on server_tasks (month);
create index on server_tasks (server_name);

-- Manager approval workflow for completed tasks
alter table server_tasks add column approved_by uuid references staff(staff_id);
alter table server_tasks add column approved_at timestamptz;
alter table server_tasks add column due_by date;

-- Proper FK for alert assignment (keeps text assigned_to for display)
alter table case_alerts add column assigned_to_staff_id uuid references staff(staff_id);

-- 12. Club settings — key/value store for admin-configurable options
create table club_settings (
  key              text primary key,
  value            text not null,
  updated_at       timestamptz not null default now()
);

-- Default: send surveys at 9:30 AM Eastern
insert into club_settings (key, value) values
  ('survey_send_time', '09:30');

-- 13. Audit log — who accessed personal data and who changed access.
-- Append-only from the application's side: there is no update or delete route.
-- Entries are retained for 12 months, then removed by the daily
-- /api/cron/purge-audit-log job (see render.yaml).
create table audit_log (
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
create index on audit_log (created_at desc);
create index on audit_log (action);
create index on audit_log (actor_staff_id);

-- 14. Staff workday surveys — the member survey asks how the visit went; this
-- asks the people who worked that shift how their day went. Same mechanic: a
-- one-use tokenised link over SMS/email, since servers have no dashboard login.
create table staff_survey_responses (
  staff_response_id uuid primary key default uuid_generate_v4(),
  server_id         uuid references servers(server_id),
  shift_date        date not null,
  survey_token      text not null unique,
  q1_shift_rating   smallint check (q1_shift_rating between 1 and 5),  -- required
  q2_support        smallint check (q2_support      between 1 and 5),  -- required
  q3_workload       smallint check (q3_workload     between 1 and 5),  -- required
  q4_tools          smallint check (q4_tools        between 1 and 5),  -- skippable
  q5_comment        text check (char_length(q5_comment) <= 1000),      -- optional
  answers           jsonb,
  submitted_at      timestamptz,
  is_complete       boolean not null default false,
  sent_at           timestamptz,
  created_at        timestamptz not null default now()
);

-- One survey per person per shift. The send path upserts against this rather
-- than checking-then-inserting, so a retry cannot mint two links for a day.
create unique index staff_survey_responses_server_shift_idx
  on staff_survey_responses (server_id, shift_date);
create index staff_survey_responses_shift_date_idx on staff_survey_responses (shift_date desc);

-- Staff surveys go out after service rather than at the member send time.
insert into club_settings (key, value) values
  ('staff_survey_send_time', '20:30'),
  ('staff_survey_enabled', 'false');

-- ============================================================
-- SEED DATA — demo records for the dashboard
-- ============================================================

-- Seed members (from the 06/28/2026 Aronimink POS export)
insert into members (member_id, first_name, last_name, phone_number, email_address, comm_preference) values
  ('R272', 'Michael', 'Halloran',  '+16105551001', 'mhalloran@email.com', 'sms'),
  ('R100', 'Robert',  'Petrakis',  '+16105551002', 'rpetrakis@email.com', 'email'),
  ('R405', 'Susan',   'Chen',      '+16105551003', 'schen@email.com',     'sms'),
  ('R112', 'David',   'Thompson',  '+16105551004', 'dthompson@email.com', 'sms'),
  ('R330', 'Karen',   'Walsh',     '+16105551005', 'kwalsh@email.com',    'email')
on conflict (member_id) do nothing;

-- Seed visits
insert into visits (member_id, outlet_id, visit_date, spend_amount, server_name, qualifies, survey_sent_at) values
  ('R272', (select outlet_id from outlets where name='Belmont Dining Room'), '2026-06-27', 145.00, 'James',   true, now() - interval '6 hours'),
  ('R100', (select outlet_id from outlets where name='Belmont Dining Room'), '2026-06-26', 98.50,  'Maria',   true, now() - interval '1 day'),
  ('R405', (select outlet_id from outlets where name='Belmont Poolside'),    '2026-06-25', 42.00,  'Alex',    true, now() - interval '2 days'),
  ('R112', (select outlet_id from outlets where name='Golf Patio'),          '2026-06-28', 28.50,  'Chris',   true, null),
  ('R330', (select outlet_id from outlets where name='Belmont Dining Room'), '2026-06-28', 220.00, 'James',   true, null);

-- Seed survey responses for the three visits that got surveys
insert into survey_responses (visit_id, survey_token, q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, q5_comment, submitted_at, is_complete) values
  ((select visit_id from visits where member_id='R272' and visit_date='2026-06-27'), 'seed-token-1', 2, 1, 1, 2, 'Food came out cold twice. Asked for it to be redone and it happened again.', now() - interval '5 hours', true),
  ((select visit_id from visits where member_id='R100' and visit_date='2026-06-26'), 'seed-token-2', 4, 2, 3, 1, 'Service was very slow, table waited 20 minutes for drinks.', now() - interval '20 hours', true),
  ((select visit_id from visits where member_id='R405' and visit_date='2026-06-25'), 'seed-token-3', 5, 2, 3, 2, 'Wrong order twice, kitchen seemed overwhelmed.', now() - interval '44 hours', true);

-- Seed case alerts (auto-created by survey-response.js when scores are low)
insert into case_alerts (response_id, outlet_id, severity, status, assigned_to, resolved_at) values
  ((select response_id from survey_responses where survey_token='seed-token-1'),
   (select outlet_id from outlets where name='Belmont Dining Room'),
   'high', 'open', null, null),
  ((select response_id from survey_responses where survey_token='seed-token-2'),
   (select outlet_id from outlets where name='Belmont Dining Room'),
   'medium', 'open', null, null),
  ((select response_id from survey_responses where survey_token='seed-token-3'),
   (select outlet_id from outlets where name='Belmont Poolside'),
   'low', 'resolved', 'Tom Reyes', now() - interval '1 day');

-- Seed training plans (AI-generated weekly)
insert into training_plans (outlet_id, week_start, steps, basis_summary) values
  ((select outlet_id from outlets where name='Belmont Dining Room'),
   '2026-06-23',
   '[{"text":"Line-check hold times at the pass — three separate mentions of cold plates this week, all dinner service.","priority":"Immediate","done":false},{"text":"Re-brief expo on firing sequence for tables of 6+, where the delay pattern concentrates.","priority":"This week","done":false},{"text":"Follow up personally with the two guests who reported repeat issues before their next visit.","priority":"Immediate","done":false},{"text":"Re-evaluate pass-through placement if temperature complaints continue past next week.","priority":"Ongoing","done":false}]',
   'Based on 14 comments · 118 responses · generated Fri 6:02am'),
  ((select outlet_id from outlets where name='Belmont Poolside'),
   '2026-06-23',
   '[{"text":"Add a second bartender for Sat–Sun 12–3pm — every wait-time complaint this week falls in that window.","priority":"This week","done":false},{"text":"Pre-batch the three most-ordered cocktails ahead of the lunch rush.","priority":"Ongoing","done":false}]',
   'Based on 6 comments · 71 responses · generated Fri 6:02am');
