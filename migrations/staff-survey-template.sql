-- Make the staff shift survey a real template, so it appears in Survey Builder
-- alongside the member surveys and is edited the same way.
--
-- Its questions were hardcoded in staff-survey-page.html, which meant the one
-- survey nobody could see was the one going to your own team. Moving them into
-- survey_templates makes the Builder the single source: what it shows is what
-- staff receive, rather than a copy that can drift out of step.
--
-- Safe to run on any database, as many times as you like. Run
-- migrations/staff-surveys.sql first — this needs the tables it creates.

-- ---------------------------------------------------------------------------
-- 1. Allow the new survey type
-- ---------------------------------------------------------------------------
alter table survey_templates drop constraint if exists survey_templates_survey_type_check;
alter table survey_templates add constraint survey_templates_survey_type_check
  check (survey_type in ('food_bev', 'golf', 'events', 'staff'));

-- ---------------------------------------------------------------------------
-- 2. Seed the template, exactly as the page has been asking it
-- ---------------------------------------------------------------------------
-- index is null throughout on purpose. CHI, SSI and OHI are benchmarked from
-- member responses; folding staff answers into them would move a member-facing
-- score on the strength of how a shift felt. The Builder will show these as
-- "not benchmarked", which is the truth.
--
-- Only inserted when no staff template exists, so re-running never overwrites
-- wording you have since edited.
insert into survey_templates (name, survey_type, questions, active)
select 'Staff Shift Feedback', 'staff', '[
  {"key":"q1_shift_rating","title":"How did your shift go overall?","hint":"1 = Rough, 5 = Great","type":"stars","required":true,"index":null,"explainer":"The headline read on how the day went for the team."},
  {"key":"q2_support","title":"Did you feel supported by management today?","hint":"1 = Not at all, 5 = Fully supported","type":"stars","required":true,"index":null,"explainer":"Whether the floor had the leadership it needed."},
  {"key":"q3_workload","title":"Was your workload manageable?","hint":"1 = Overwhelming, 5 = Comfortable","type":"stars","required":true,"index":null,"explainer":"Whether the shift was staffed to the covers it took."},
  {"key":"q4_tools","title":"Did you have the stock and equipment you needed?","hint":"1 = Not at all, 5 = Everything · optional","type":"stars","required":false,"index":null,"explainer":"Whether the operation set them up to do the job."},
  {"key":"q5_comment","title":"Anything management should know?","hint":"Optional — 1000 characters max","type":"text","required":false,"index":null,"explainer":"Read by the management team."}
]'::jsonb, true
where not exists (select 1 from survey_templates where survey_type = 'staff');

-- ---------------------------------------------------------------------------
-- Confirm the result
-- ---------------------------------------------------------------------------
select survey_type, name, active, jsonb_array_length(questions) as questions
from survey_templates
order by survey_type, created_at;
