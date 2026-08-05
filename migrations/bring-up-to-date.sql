-- Bring an existing Vero database up to date with the current application.
--
-- Safe to run on any database, as many times as you like: every statement is
-- guarded, so anything already present is left alone. Run the whole file in
-- the Supabase SQL Editor.
--
-- Fixes the "column ... does not exist" errors that appear when the app has
-- moved on but the database has not.

-- ---------------------------------------------------------------------------
-- 1. Survey templates and per-response answers
-- ---------------------------------------------------------------------------
create table if not exists survey_templates (
  template_id      uuid primary key default uuid_generate_v4(),
  name             text not null,
  survey_type      text not null check (survey_type in ('food_bev', 'golf', 'events')),
  questions        jsonb not null,
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);

alter table survey_responses add column if not exists template_id uuid references survey_templates(template_id);
alter table survey_responses add column if not exists answers jsonb;
alter table survey_responses add column if not exists ai_tags jsonb;   -- AI comment tagging

-- An outlet may nominate its own question set (a racquets centre or a lesson
-- should not be asked about food). Null means "use the default for the type".
alter table outlets add column if not exists template_id uuid references survey_templates(template_id);

-- ---------------------------------------------------------------------------
-- 2. Case alerts
-- ---------------------------------------------------------------------------
alter table case_alerts add column if not exists ai_summary text;
alter table case_alerts add column if not exists assigned_to_staff_id uuid references staff(staff_id);

-- ---------------------------------------------------------------------------
-- 3. Staff roles — the two upload-only shift manager roles
-- ---------------------------------------------------------------------------
alter table staff drop constraint if exists staff_role_check;
alter table staff add constraint staff_role_check
  check (role in ('super_admin','general_manager','fb_director','dept_head','shift_manager','golf_shift_manager'));

-- ---------------------------------------------------------------------------
-- 4. Server performance
-- ---------------------------------------------------------------------------
alter table visits       add column if not exists server_id   uuid references servers(server_id);
alter table server_tasks add column if not exists server_id   uuid references servers(server_id);
alter table server_tasks add column if not exists approved_by uuid references staff(staff_id);
alter table server_tasks add column if not exists approved_at timestamptz;
alter table server_tasks add column if not exists due_by      date;

-- ---------------------------------------------------------------------------
-- 5. Club settings — survey send time and scheduler state
-- ---------------------------------------------------------------------------
create table if not exists club_settings (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

insert into club_settings (key, value) values ('survey_send_time', '09:30')
  on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 6. Audit log — who accessed member data, retained 12 months
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 7. Event attendees — guest columns and send tracking
--    Without survey_sent_at the app cannot tell who has already been sent an
--    event survey: everyone shows as Pending forever and the send itself
--    fails. Guests are members without a member_id, so that column has to be
--    nullable and the name/phone/email columns have to exist.
-- ---------------------------------------------------------------------------
alter table event_attendees add column if not exists guest_name         text;
alter table event_attendees add column if not exists guest_phone        text;
alter table event_attendees add column if not exists guest_email        text;
alter table event_attendees add column if not exists survey_sent_at     timestamptz;
alter table event_attendees add column if not exists survey_response_id uuid references survey_responses(response_id);
alter table event_attendees alter column member_id drop not null;

-- ---------------------------------------------------------------------------
-- 8. Tag the default templates so they feed the benchmarked indices.
--    CHI = Club Health, SSI = Service Satisfaction, OHI = Operational Health.
--    Only applied where a template has no tags yet, so your edits are kept.
-- ---------------------------------------------------------------------------
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

-- Events are not tagged. They are their own department with their own NPS and
-- CSAT (see migrations/events-module.sql); tagging them would have an event
-- move Club Health, Service Satisfaction and Operational Health, which are
-- benchmarked from what a member said about an outlet they visited.

-- ---------------------------------------------------------------------------
-- Confirm the result
-- ---------------------------------------------------------------------------
select 'survey_responses' as table_name,
       count(*) filter (where column_name = 'ai_tags')     as ai_tags,
       count(*) filter (where column_name = 'answers')     as answers,
       count(*) filter (where column_name = 'template_id') as template_id
from information_schema.columns where table_name = 'survey_responses'
union all
select 'outlets',
       0, 0, count(*) filter (where column_name = 'template_id')
from information_schema.columns where table_name = 'outlets'
union all
select 'event_attendees',
       count(*) filter (where column_name = 'guest_name'),
       count(*) filter (where column_name = 'survey_response_id'),
       count(*) filter (where column_name = 'survey_sent_at')
from information_schema.columns where table_name = 'event_attendees';

select table_name from information_schema.tables
where table_name in ('club_settings','audit_log','survey_templates')
order by table_name;
