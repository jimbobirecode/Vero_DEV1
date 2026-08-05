-- Events as their own department.
--
-- Event feedback deliberately stays out of CHI, SSI and OHI: those are
-- benchmarked from what members say about an outlet they visited, and an
-- event is a different operation with a different template and a different
-- team. It gets its own NPS and CSAT instead.
--
-- Within it, golf events are distinguishable from the rest — separate scores
-- when you want them, both rolling up into Events overall.
--
-- Safe to run on any database, as many times as you like.

-- ---------------------------------------------------------------------------
-- 1. Event category
-- ---------------------------------------------------------------------------
-- 'general' covers everything that is not golf: dinners, weddings, member
-- nights. Add to the constraint if you grow more categories — the application
-- reads whatever is here rather than assuming two.
alter table events add column if not exists category text not null default 'general';

alter table events drop constraint if exists events_category_check;
alter table events add constraint events_category_check
  check (category in ('general', 'golf'));

create index if not exists events_category_idx on events (category, event_date desc);

-- ---------------------------------------------------------------------------
-- 2. Per-event survey template
-- ---------------------------------------------------------------------------
-- A golf event is asked about the course, a wine dinner about the wine. The
-- event nominates its own template; when it doesn't, the live 'events'
-- template is used, exactly as outlets already work.
alter table events add column if not exists template_id uuid references survey_templates(template_id);

-- ---------------------------------------------------------------------------
-- 3. Per-event AI insight
-- ---------------------------------------------------------------------------
-- Kept apart from ai_insights, which is keyed on an outlet and a week. An
-- event is one occasion on one date, so its analysis is stored against the
-- event and regenerated on demand rather than weekly.
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

-- ---------------------------------------------------------------------------
-- 4. A starting template for golf events
-- ---------------------------------------------------------------------------
-- Type is 'events', not 'golf': it belongs to the events module and is picked
-- per event, while the 'golf' type remains the tee-sheet survey sent after a
-- round. Only inserted when it isn't already there, so re-running never
-- overwrites wording you have edited.
insert into survey_templates (name, survey_type, questions, active)
select 'Golf Event Feedback', 'events', '[
  {"key":"q1","title":"How likely are you to recommend this event to a fellow member?","hint":"0 = Not at all likely, 10 = Extremely likely","type":"nps","required":true,"index":null,"explainer":"The event NPS."},
  {"key":"q2","title":"How would you rate the event overall?","hint":"1 = Poor, 5 = Excellent","type":"stars","required":true,"index":null,"explainer":"The event CSAT."},
  {"key":"q3","title":"How would you rate the course conditions on the day?","hint":"1 = Poor, 5 = Excellent","type":"stars","required":true,"index":null,"explainer":"Course presentation for the event."},
  {"key":"q4","title":"How would you rate the format, pace and organisation?","hint":"1 = Poor, 5 = Excellent · optional","type":"stars","required":false,"index":null,"explainer":"How the day itself was run."},
  {"key":"q5","title":"Anything you would like us to know?","hint":"Optional — 500 characters max","type":"text","required":false,"index":null,"explainer":"Feeds the event AI insight."}
]'::jsonb, true
where not exists (select 1 from survey_templates where name = 'Golf Event Feedback');


-- ---------------------------------------------------------------------------
-- 5. Untag event templates from the club indices
-- ---------------------------------------------------------------------------
-- The seeded Events template carried CHI, OHI and SSI tags, and lib/scoring.js
-- reads those tags off any submitted response. That meant every event answer
-- was moving all three club indices — the exact thing events are supposed to
-- stay out of. The application now excludes them by query as well, but the
-- tags are cleared so the Builder shows what is true: an event question is
-- scored in the Events department, not against the club.
update survey_templates
set questions = (
  select jsonb_agg(jsonb_set(q, '{index}', 'null'::jsonb) order by ord)
  from jsonb_array_elements(questions) with ordinality as t(q, ord)
)
where survey_type = 'events'
  and questions @? '$[*] ? (@.index == "CHI" || @.index == "SSI" || @.index == "OHI")';

-- ---------------------------------------------------------------------------
-- Confirm the result
-- ---------------------------------------------------------------------------
select category, count(*) as events from events group by category order by category;

select name, survey_type, active, jsonb_array_length(questions) as questions
from survey_templates where survey_type = 'events' order by created_at;
