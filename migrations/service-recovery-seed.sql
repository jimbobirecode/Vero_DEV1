-- Demo seed for service recovery.
--
-- Run AFTER: schema.sql (or bring-up-to-date.sql), then service-recovery.sql.
-- Needs case_alerts.ai_summary and .assigned_to_staff_id, which come from
-- bring-up-to-date.sql, and the recovery columns from service-recovery.sql.
--
-- Every timestamp is relative to now(), so this reads as live whenever it is
-- run rather than going stale a week after it was written. The alerts land
-- across the whole span of the feature on purpose: one already overdue, one
-- with minutes left, several called back in time, one voicemail, one called
-- back too late, two closed with a stated reason, and one member nobody can
-- ring at all.
--
-- Idempotent: re-running deletes everything it previously inserted and starts
-- again. It only ever touches rows it created, identified by the DEMO_ member
-- ids and the demo-recovery- survey tokens. Teardown is at the bottom.

-- Staging tables are REAL, not temporary. Supabase's SQL editor commits each
-- statement on its own, which drops an ON COMMIT DROP temp table before the
-- next statement can read it — and a transaction-pooled connection can put
-- each statement on a different session, where a temp table does not exist at
-- all. These are dropped explicitly at the end.
drop table if exists demo_recovery_alerts;
drop table if exists demo_recovery_cases;

-- ---------------------------------------------------------------- teardown --
delete from alert_outreach where alert_id in (
  select ca.alert_id from case_alerts ca
    join survey_responses sr on sr.response_id = ca.response_id
   where sr.survey_token like 'demo-recovery-%');

delete from case_alerts where response_id in (
  select response_id from survey_responses where survey_token like 'demo-recovery-%');

delete from survey_responses where survey_token like 'demo-recovery-%';
delete from visits  where member_id like 'DEMO_%';
delete from members where member_id like 'DEMO_%';

-- ----------------------------------------------------------------- members --
insert into members (member_id, first_name, last_name, phone_number, email_address, comm_preference, opt_out) values
  ('DEMO_1042', 'Karl',     'Krietsch',  '+16105550142', 'k.krietsch@example.com', 'sms',   false),
  ('DEMO_0876', 'Robert',   'Norton',    '+16105550198', 'r.norton@example.com',   'sms',   false),
  ('DEMO_1155', 'Cynthia',  'Pettit',    null,           'c.pettit@example.com',   'email', false),
  -- No phone, no email: cannot be rung however urgent the alert is.
  ('DEMO_W135', 'Keith',    'Wilson',    null,           null,                     'sms',   false),
  ('DEMO_2201', 'Margaret', 'Ellery',    '+16105550210', 'm.ellery@example.com',   'email', false),
  ('DEMO_2318', 'David',    'Okonjo',    '+16105550233', 'd.okonjo@example.com',   'sms',   false),
  ('DEMO_2456', 'Helen',    'Vasquez',   '+16105550266', 'h.vasquez@example.com',  'email', false),
  ('DEMO_2519', 'Peter',    'Lindqvist', '+16105550271', 'p.lind@example.com',     'sms',   false),
  ('DEMO_2604', 'Anne',     'Whitcombe', '+16105550288', 'a.whit@example.com',     'email', false),
  ('DEMO_2733', 'James',    'Fairbairn', '+16105550294', 'j.fair@example.com',     'sms',   false);

-- ------------------------------------------------------------- the stories --
-- One row per case. Everything else is generated from this, so the demo lives
-- in one readable place.
--
--   hours_ago       when the member complained — this starts the clock
--   contact_hours   hours later that somebody rang; null = nobody has
--   reached         true = spoke to them, false = voicemail only
--   prior_attempt   a failed try before that call. Always 'wrong_number',
--                   because that is the one outcome the app does NOT treat as
--                   contact — anything else would stop the clock and the seed
--                   would contradict the rules the dashboard applies.
--   follow_up_nps   their score on a later visit; null = not been back yet
--   no_contact      a stated reason for closing without ever contacting them
create table demo_recovery_cases (
  member_id text, outlet_name text, severity text, hours_ago numeric,
  nps smallint, overall smallint, food smallint, service smallint, comment text,
  assigned_to text, contact_hours numeric, reached boolean, sentiment text,
  call_note text, prior_attempt boolean, follow_up_nps smallint,
  no_contact text, resolved boolean
);

insert into demo_recovery_cases values
-- ===== LIVE QUEUE — what the GM is looking at right now ====================
-- Overdue: the window closed six hours ago and nobody has rung him.
('DEMO_1042','Belmont Dining Room','high',   30, 2,1,1,2,
 'Waited fifty minutes for a main that came out cold. Nobody checked on us all night.',
 'Sarah Kim',   null, null, null, null, false, null, null, false),
-- Two hours left. One try already made — wrong number on file, so the clock
-- is still running, which is exactly the case the rule exists for.
('DEMO_0876','Golf Patio','high',            22, 3,2,3,1,
 'Bar staff were short with my guests. Embarrassing in front of clients.',
 'Tom Reyes',   null, null, null, null, true,  null, null, false),
-- Past halfway through a 72-hour window.
('DEMO_1155','Belmont Poolside','medium',    40, 5,2,3,3,
 'Course was fine but the halfway house was unstaffed for over an hour.',
 'Priya Anand', null, null, null, null, false, null, null, false),
-- Fresh, and nobody can ring him: no phone, no email.
('DEMO_W135','Belmont Dining Room','medium',  9, 4,2,2,2,
 'Our booking was lost. We ended up eating in the bar.',
 null,          null, null, null, null, false, null, null, false),

-- ===== RECOVERED — called back fast, came back happier =====================
('DEMO_2201','Belmont Dining Room','high',  38*24, 2,1,2,1,
 'The lamb was inedible and the waiter argued with me about it.',
 'Sarah Kim',    2.5, true,  'recovered',    'Apologised, comped the meal, invited her back as my guest.', false,  9, null, true),
('DEMO_2318','Golf Patio','high',           31*24, 3,2,2,2,
 'Third time this month the patio has run out of the house red.',
 'Tom Reyes',    4.0, true,  'recovered',    'Explained the supplier issue, put a case aside for him.',    false, 10, null, true),
('DEMO_2456','Belmont Poolside','medium',   24*24, 5,2,3,3,
 'Towels were not restocked and the loungers were filthy by midday.',
 'Priya Anand',  6.5, true,  'neutral',      'Heard her out. Poolside rota changed from Monday.',          false,  8, null, true),
-- Two attempts before he answered, and still angry on the call — recovery is
-- not automatic, and the record should show that.
('DEMO_2519','Belmont Dining Room','high',  19*24, 1,1,1,1,
 'Sent back twice. Nobody apologised. We left without eating.',
 'Sarah Kim',    1.5, true,  'still_unhappy','Long call. Still angry. Offered dinner with the chef.',      true,   7, null, true),
('DEMO_2604','Golf Patio','medium',         14*24, 4,2,3,2,
 'Slow service at the turn, we missed our tee time.',
 'Tom Reyes',    9.0, true,  'recovered',    'Starter now holds tee times when the turn backs up.',        false,  9, null, true),

-- ===== CALLED BACK, BUT NOT RECOVERED =====================================
-- Rang him quickly, he still rated the club lower next visit. The metric has
-- to be able to show this or nobody will believe the good numbers.
('DEMO_2733','Belmont Dining Room','medium', 11*24, 4,2,2,3,
 'Music far too loud to hold a conversation.',
 'Priya Anand',  3.0, true,  'neutral',      'Took the point. Volume policy reviewed.',                    false,  3, null, true),

-- ===== VOICEMAIL ONLY — clock stopped, but this is not recovery ============
('DEMO_2201','Golf Patio','medium',          8*24, 5,3,3,3,
 'Burger was dry and the chips were cold.',
 'Tom Reyes',    5.0, false, null,           'Left a voicemail asking her to call back.',                  true,  null, null, false),

-- ===== CALLED BACK TOO LATE ===============================================
-- Counts as contacted, but not as contacted in time. Has to be high severity
-- to tell that story: a medium alert has a 72-hour window, so a call at 38
-- hours would be comfortably inside it.
('DEMO_2318','Belmont Poolside','high',     16*24, 4,2,2,2,
 'Pool bar closed early with no notice, twice in a week.',
 'Priya Anand', 38.0, true,  'neutral',      'Late call. Fair about it, but he had already told friends.', false,  6, null, true),

-- ===== CLOSED WITHOUT CONTACT, WITH A STATED REASON =======================
-- These leave the denominator: they neither flatter nor punish the number.
('DEMO_2456','Golf Patio','low',            26*24, 6,3,3,3,
 'Car park was full at 8am on a Saturday.',
 'Tom Reyes',   null, null, null, null, false, null, 'not_member_specific', true),
('DEMO_2519','Belmont Poolside','low',      21*24, 6,3,4,3,
 'Nothing wrong exactly, just not what it used to be.',
 'Sarah Kim',   null, null, null, null, false, null, 'member_declined',     true);

-- ------------------------------------------------- resolved once, reused ---
-- The clock, the contact time and the escalation stage are worked out once
-- here so nothing downstream can compute them differently. The stage in
-- particular has to come from the alert's own window, not from a raw hour
-- count: a medium alert 40 hours old is halfway through a 72-hour window, not
-- overdue.
create table demo_recovery_alerts as
select c.*,
       o.outlet_id,
       (now() - make_interval(hours => c.hours_ago::int)) as created_at,
       (now() - make_interval(hours => c.hours_ago::int))::date as visit_date,
       (now() - make_interval(hours => c.hours_ago::int))
         + make_interval(mins => coalesce(
             (select value::int from club_settings
               where key = 'recovery_sla_' || c.severity || '_minutes'),
             case c.severity when 'high' then 1440 when 'medium' then 4320 else 10080 end)) as due_at,
       case when c.contact_hours is not null
            then now() - make_interval(hours => (c.hours_ago - c.contact_hours)::int) end as contact_at
  from demo_recovery_cases c
  join outlets o on lower(o.name) = lower(c.outlet_name);

alter table demo_recovery_alerts add column stage text;
update demo_recovery_alerts set stage =
  case when contact_at is null and no_contact is null and not resolved then
    case when now() >  due_at                                        then 'breached'
         when now() >= created_at + (due_at - created_at) * 0.9      then 'final'
         when now() >= created_at + (due_at - created_at) * 0.5      then 'half'
    end
  end;

-- ------------------------------------------------------------------ visits --
insert into visits (member_id, outlet_id, visit_date, spend_amount, server_name, visitor_type, qualifies, survey_sent_at)
select a.member_id, a.outlet_id, a.visit_date,
       (60 + (random() * 90))::numeric(10,2),
       (array['Ava Del Viscio','Sabrina Swope','Priyanka','Patrick McDermott'])[1 + floor(random() * 4)::int],
       'member', true, a.created_at - interval '2 hours'
  from demo_recovery_alerts a;

-- --------------------------------------------------------------- responses --
insert into survey_responses (visit_id, survey_token, q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, q5_comment, submitted_at, is_complete)
select v.visit_id, 'demo-recovery-' || v.visit_id,
       a.nps, a.overall, a.food, a.service, a.comment, a.created_at, true
  from demo_recovery_alerts a
  join visits v on v.member_id = a.member_id
               and v.outlet_id = a.outlet_id
               and v.visit_date = a.visit_date
 where not exists (select 1 from survey_responses s where s.visit_id = v.visit_id);

-- ------------------------------------------------------------------ alerts --
insert into case_alerts (
  response_id, outlet_id, severity, status, assigned_to, assigned_to_staff_id,
  created_at, resolved_at, contact_due_at, first_contact_at, first_reached_at,
  outreach_count, no_contact_reason, ai_summary, escalated_stage, escalated_at)
select sr.response_id, a.outlet_id, a.severity,
       case when a.resolved             then 'resolved'
            when a.contact_at is not null then 'contacted'
            when a.assigned_to is not null then 'assigned'
            else 'open' end,
       a.assigned_to, st.staff_id,
       a.created_at,
       case when a.resolved then a.contact_at + interval '2 days' end,
       a.due_at,
       a.contact_at,                                        -- first attempt that counted
       case when a.reached then a.contact_at end,           -- the actual conversation
       (case when a.prior_attempt then 1 else 0 end) + (case when a.contact_at is not null then 1 else 0 end),
       a.no_contact,
       left(a.comment, 90),                                 -- stands in for the AI summary
       a.stage,
       case when a.stage is not null then now() - interval '1 hour' end
  from demo_recovery_alerts a
  join visits v on v.member_id = a.member_id and v.outlet_id = a.outlet_id and v.visit_date = a.visit_date
  join survey_responses sr on sr.visit_id = v.visit_id
  left join staff st on st.name = a.assigned_to;

-- ---------------------------------------------------------------- outreach --
-- The failed try before the successful call. Always a wrong number: it is the
-- only outcome that does not stop the clock, so an alert can show an attempt
-- and still legitimately be waiting on a call-back.
insert into alert_outreach (alert_id, member_id, channel, outcome, occurred_at, logged_by_name, logged_via)
select ca.alert_id, a.member_id, 'phone', 'wrong_number',
       a.created_at + interval '40 minutes',
       coalesce(a.assigned_to, 'Sarah Kim'), 'dashboard'
  from demo_recovery_alerts a
  join visits v on v.member_id = a.member_id and v.outlet_id = a.outlet_id and v.visit_date = a.visit_date
  join survey_responses sr on sr.visit_id = v.visit_id
  join case_alerts ca on ca.response_id = sr.response_id
 where a.prior_attempt;

-- The call that stopped the clock. Logged through whichever door is plausible:
-- a fast call came from the one-tap link in the escalation email.
insert into alert_outreach (alert_id, member_id, channel, outcome, member_sentiment, notes, occurred_at, logged_by, logged_by_name, logged_via)
select ca.alert_id, a.member_id, 'phone',
       case when a.reached then 'reached' else 'left_message' end,
       a.sentiment, a.call_note, a.contact_at,
       st.staff_id, coalesce(a.assigned_to, 'Sarah Kim'),
       case when a.contact_hours < 6 then 'one_tap' else 'dashboard' end
  from demo_recovery_alerts a
  join visits v on v.member_id = a.member_id and v.outlet_id = a.outlet_id and v.visit_date = a.visit_date
  join survey_responses sr on sr.visit_id = v.visit_id
  join case_alerts ca on ca.response_id = sr.response_id
  left join staff st on st.name = a.assigned_to
 where a.contact_at is not null;

-- ------------------------------------------------------- the return visit --
-- The proof behind "rated us higher after". Dated a week AFTER the call, never
-- before it — a response submitted before the call is the one that raised the
-- alert, and must never be read as evidence of recovery.
insert into visits (member_id, outlet_id, visit_date, spend_amount, visitor_type, qualifies, survey_sent_at)
select a.member_id, a.outlet_id,
       (a.contact_at + interval '7 days')::date,
       (70 + (random() * 80))::numeric(10,2), 'member', true,
       a.contact_at + interval '7 days'
  from demo_recovery_alerts a
 where a.follow_up_nps is not null
   and a.contact_at + interval '7 days' < now();

insert into survey_responses (visit_id, survey_token, q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, q5_comment, submitted_at, is_complete)
select v.visit_id, 'demo-recovery-followup-' || v.visit_id,
       a.follow_up_nps,
       greatest(1, least(5, (a.follow_up_nps / 2))),
       greatest(1, least(5, (a.follow_up_nps / 2))),
       greatest(1, least(5, (a.follow_up_nps / 2))),
       case when a.follow_up_nps >= 8
            then 'Much better this time — thank you for calling me personally.'
            else 'Better, but still not quite there.' end,
       a.contact_at + interval '7 days 3 hours', true
  from demo_recovery_alerts a
  join visits v on v.member_id = a.member_id
               and v.outlet_id = a.outlet_id
               and v.visit_date = (a.contact_at + interval '7 days')::date
 where a.follow_up_nps is not null
   and a.contact_at + interval '7 days' < now()
   and not exists (select 1 from survey_responses s where s.visit_id = v.visit_id);

-- Staging tables have done their job.
drop table demo_recovery_alerts;
drop table demo_recovery_cases;

-- ------------------------------------------------------------------ check --
-- Run this after seeding. It should show 4 awaiting a call, 1 breached,
-- 9 contacted, 8 of those in time, and 2 closed with a reason.
select
  count(*) filter (where ca.first_contact_at is null and ca.no_contact_reason is null
                     and ca.status <> 'resolved')                  as awaiting_call,
  count(*) filter (where ca.first_contact_at is null and ca.no_contact_reason is null
                     and now() > ca.contact_due_at)                as breached,
  count(*) filter (where ca.first_contact_at is not null)          as contacted,
  count(*) filter (where ca.first_contact_at is not null
                     and ca.first_contact_at <= ca.contact_due_at) as contacted_in_time,
  count(*) filter (where ca.no_contact_reason is not null)         as closed_with_reason,
  round(avg(extract(epoch from (ca.first_contact_at - ca.created_at)) / 3600)
        filter (where ca.first_contact_at is not null)::numeric, 1) as avg_hours_to_call
  from case_alerts ca
  join survey_responses sr on sr.response_id = ca.response_id
 where sr.survey_token like 'demo-recovery-%';

-- ---------------------------------------------------------------- teardown --
-- Removes every row this file created, and nothing else.
--
--   delete from alert_outreach where alert_id in (
--     select ca.alert_id from case_alerts ca
--       join survey_responses sr on sr.response_id = ca.response_id
--      where sr.survey_token like 'demo-recovery-%');
--   delete from case_alerts where response_id in (
--     select response_id from survey_responses where survey_token like 'demo-recovery-%');
--   delete from survey_responses where survey_token like 'demo-recovery-%';
--   delete from visits  where member_id like 'DEMO_%';
--   delete from members where member_id like 'DEMO_%';
