-- Demo data for the Reports screen.
--
-- Populates every section a report can show — headline figures with a real
-- previous-period comparison, the three club indices, month-on-month, outlets,
-- servers, case alerts and SMS credit usage — so the screen and both exports
-- can be seen with something in them.
--
-- ---------------------------------------------------------------------------
-- THIS IS DEMO DATA. It writes fictional members, visits and survey responses
-- into the same tables real ones live in. Run it on a demo or staging project,
-- not on a database carrying a club's actual results — a seeded NPS mixed into
-- genuine responses is very hard to unpick afterwards.
--
-- Every row it creates is tagged, and the last section of this file removes
-- them again. Read that before running this anywhere you care about.
-- ---------------------------------------------------------------------------
--
-- Safe to run more than once: it deletes its own previous output first.
--
-- Dates are relative to now(), so the last 30 days always has data and the
-- preceding 30 always has slightly worse data for the comparison to move
-- against. Re-run it in three months and the report still populates.

begin;

-- ------------------------------------------------------------- clean up ----
-- Seeded rows are identifiable by their member_id and server_name prefixes, so
-- this only ever removes its own work.

delete from case_alerts where response_id in (
  select response_id from survey_responses where survey_token like 'seed-%');
delete from survey_responses where survey_token like 'seed-%';
delete from visits where member_id like 'SEED%' or server_name like 'Demo %';
delete from members where member_id like 'SEED%';
delete from sms_credit_ledger where idempotency_key like 'seed:%';

-- -------------------------------------------------------------- outlets ----
-- Reuses the club's real outlets if they exist; creates the three Aronimink
-- ones only if the table is empty, so this never invents a fourth outlet
-- alongside a club's own.

insert into outlets (name, min_spend_threshold, frequency_limit_days)
select * from (values
  ('Golf Patio', 75.00, 30),
  ('Belmont Dining Room', 75.00, 30),
  ('Belmont Poolside', 20.00, 30)
) as v(name, min_spend_threshold, frequency_limit_days)
where not exists (select 1 from outlets);

-- -------------------------------------------------------------- members ----

insert into members (member_id, first_name, last_name, phone_number, email_address, comm_preference, opt_out)
select
  'SEED' || lpad(i::text, 4, '0'),
  (array['James','Sarah','Michael','Emily','David','Laura','Robert','Anna','Thomas','Grace',
         'William','Claire','Henry','Sophie','Charles','Alice','George','Rachel','Edward','Nina'])[1 + (i % 20)],
  (array['Whitfield','Carrington','Ellison','Bramley','Thornton','Ashford','Pemberton','Hollis',
         'Radcliffe','Sinclair'])[1 + (i % 10)],
  '+1610' || lpad((5550000 + i)::text, 7, '0'),
  'seed' || i || '@example.invalid',
  case when i % 3 = 0 then 'email' else 'sms' end,
  false
from generate_series(1, 120) as i;

-- --------------------------------------------------------------- visits ----
--
-- Two windows, because the report's headline compares this period against the
-- one immediately before it. The current window is seeded a little better than
-- the previous one, so every delta has a direction to show rather than reading
-- "no change" everywhere.
--
-- Spread across the full 60 days so month-on-month has more than one point —
-- a trend chart needs at least two months to be a trend.

insert into visits (member_id, outlet_id, visit_date, spend_amount, server_name, visitor_type, qualifies, survey_sent_at, created_at)
select
  'SEED' || lpad((1 + (i % 120))::text, 4, '0'),
  o.outlet_id,
  (now() - (day.n || ' days')::interval)::date,
  40 + (i % 9) * 17.5,
  -- Five servers, deliberately named so the cleanup at the bottom can find
  -- them and so nobody mistakes them for real staff.
  'Demo ' || (array['Jessica M','Marcus R','Priya S','Daniel O','Erin T'])[1 + (i % 5)],
  'member',
  true,
  now() - (day.n || ' days')::interval,
  now() - (day.n || ' days')::interval
from generate_series(1, 600) as i
cross join lateral (
  -- Weighted toward the recent window, so response volume has somewhere to
  -- move between periods instead of reading "no change" on every re-run.
  select case when i % 10 < 6 then i % 30 else 30 + (i % 30) end as n
) as day
cross join lateral (
  select outlet_id from outlets order by md5(outlet_id::text || i::text) limit 1
) as o;

-- ----------------------------------------------------- survey responses ----
--
-- One row per survey SENT, with roughly 46% of them answered — about what a
-- club with a working survey actually sees.
--
-- Scores are drawn from the visit so they are stable across re-runs, and the
-- current window sits a little higher than the previous one. Nothing here is
-- random: a report whose numbers change every time you reload is impossible to
-- check against an export.
--
-- q1 feeds CHI, q2 feeds SSI, q3 and q4 feed OHI — see LEGACY_INDEX_MAP in
-- lib/scoring.js. Seeding the four columns is enough to move all three indices
-- without needing templates.

insert into survey_responses (visit_id, survey_token, q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, q5_comment, submitted_at, is_complete, created_at)
select
  v.visit_id,
  'seed-' || v.visit_id,
  case when answered then least(10, greatest(0, base.nps + recent)) end,
  case when answered then least(5, greatest(1, base.stars + recent)) end,
  case when answered then least(5, greatest(1, base.food)) end,
  case when answered then least(5, greatest(1, base.service)) end,
  case when not answered then null
       when base.nps <= 5 then 'Service was slow and nobody checked back on us.'
       when base.nps >= 9 then 'Excellent as always — the team were a credit to the club.'
       else null end,
  case when answered then v.visit_date + interval '1 day' end,
  answered,
  v.visit_date
from visits v
cross join lateral (
  select
    -- Banded rather than uniform. A floor of 5 meant the seed never produced
    -- a detractor, so 'high' and 'medium' case alerts never fired and the
    -- severity chart had one bar. Roughly 55% promoters, 27% passives, 18%
    -- detractors spread across 2-6 — which is a believable club, and gives
    -- every severity something to raise.
    case
      when (('x' || substr(md5(v.visit_id::text), 1, 4))::bit(16)::int % 100) < 55
        then 9 + (('x' || substr(md5(v.visit_id::text || 'p'), 1, 4))::bit(16)::int % 2)
      when (('x' || substr(md5(v.visit_id::text), 1, 4))::bit(16)::int % 100) < 82
        then 7 + (('x' || substr(md5(v.visit_id::text || 'p'), 1, 4))::bit(16)::int % 2)
      else 2 + (('x' || substr(md5(v.visit_id::text || 'p'), 1, 4))::bit(16)::int % 5)
    end as nps,
    2 + (('x' || substr(md5(v.visit_id::text || 's'), 1, 4))::bit(16)::int % 4) as stars,
    3 + (('x' || substr(md5(v.visit_id::text || 'f'), 1, 4))::bit(16)::int % 3) as food,
    3 + (('x' || substr(md5(v.visit_id::text || 'v'), 1, 4))::bit(16)::int % 3) as service
) as base
cross join lateral (
  -- A modest, partial improvement in the recent window.
  --
  -- Lifting every recent response by a point moved NPS forty points between
  -- periods, which no club does in a month and which makes a demo read as
  -- fabricated. Applying it to about a third of them gives a few points of
  -- genuine-looking movement instead.
  select case
    when v.visit_date > (now() - interval '30 days')::date
     and (('x' || substr(md5(v.visit_id::text || 'b'), 1, 4))::bit(16)::int % 100) < 34
    then 1 else 0 end as recent
) as w
cross join lateral (
  -- A row is created for every survey SENT; only ~46% carry an answer. The
  -- report's response rate is responded/sent over this table, so seeding only
  -- the answers would report 100% — a number nobody who knows the business
  -- would believe, and the first thing to make a demo look fake.
  select (('x' || substr(md5(v.visit_id::text || 'r'), 1, 4))::bit(16)::int % 100) < 46 as answered
) as a
where v.member_id like 'SEED%';

-- --------------------------------------------------------- case alerts ----
--
-- Raised from the responses that would genuinely have triggered one: NPS 0-6
-- or two stars and under. Some are resolved and some are still open, so the
-- report's "raised / resolved / still open" columns each carry a number.

insert into case_alerts (response_id, outlet_id, severity, status, created_at, resolved_at)
select
  r.response_id,
  v.outlet_id,
  case when r.q1_nps <= 3 or r.q2_overall_stars = 1 then 'high'
       when r.q1_nps <= 5 then 'medium'
       else 'low' end,
  -- Older alerts have mostly been dealt with; recent ones are still open,
  -- which is what a real queue looks like.
  case when v.visit_date < (now() - interval '14 days')::date then 'resolved' else 'open' end,
  r.submitted_at,
  case when v.visit_date < (now() - interval '14 days')::date then r.submitted_at + interval '2 days' else null end
from survey_responses r
join visits v on v.visit_id = r.visit_id
where r.survey_token like 'seed-%'
  and (r.q1_nps <= 6 or r.q2_overall_stars <= 2);

-- ------------------------------------------------------------ sms credit ---
--
-- Only if the credit tables exist — this file is useful on a database that has
-- not run migrations/sms-credit.sql, and a hard reference would stop it dead.

do $$
declare v_bal numeric := 0;
begin
  if to_regclass('public.sms_credit_ledger') is null then
    raise notice 'sms_credit tables not present — skipping the credit section of the seed';
    return;
  end if;

  insert into sms_credit_accounts (club_id, balance_cents)
  values (null, 0)
  on conflict do nothing;

  -- Two top-ups against 45 days of sending.
  --
  -- The first draft had one $250 top-up and 45 days of spend, which is $370
  -- going out against $250 coming in — the balance went negative and the
  -- non-negative constraint refused the whole thing. That is the constraint
  -- doing its job, and it is why the club tops up more than once in a period,
  -- which is also what makes the payments list worth looking at.
  insert into sms_credit_ledger (club_id, entry_type, amount_cents, balance_after_cents, idempotency_key, description, created_at)
  values (null, 'topup', 30000, 30000, 'seed:topup:1', 'Top-up', now() - interval '46 days');
  v_bal := 30000;

  for d in reverse 44..0 loop
    -- A second top-up partway through, before the balance runs down.
    if d = 18 then
      v_bal := v_bal + 25000;
      insert into sms_credit_ledger (club_id, entry_type, amount_cents, balance_after_cents, idempotency_key, description, created_at)
      values (null, 'topup', 25000, v_bal, 'seed:topup:2', 'Top-up', now() - (d || ' days')::interval);
    end if;

    -- Quiet on Mondays, which is what gives the daily-spend chart a shape
    -- rather than a straight line.
    if extract(dow from (now() - (d || ' days')::interval)) <> 1 then
      v_bal := v_bal - 824;
      insert into sms_credit_ledger (club_id, entry_type, amount_cents, balance_after_cents, kind, idempotency_key, description, created_at)
      values (null, 'debit', -824, v_bal, 'survey', 'seed:debit:' || d, 'SMS send', now() - (d || ' days')::interval);
    end if;
  end loop;

  update sms_credit_accounts set balance_cents = v_bal where club_id is null;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- What this created, and how to take it back out.
--
-- Every seeded row carries a marker: members and visits use a SEED / 'Demo '
-- prefix, survey tokens start 'seed-', ledger keys start 'seed:'. Nothing else
-- in the database is touched.
--
-- To remove all of it:
--
--   delete from case_alerts where response_id in (
--     select response_id from survey_responses where survey_token like 'seed-%');
--   delete from survey_responses where survey_token like 'seed-%';
--   delete from visits where member_id like 'SEED%' or server_name like 'Demo %';
--   delete from members where member_id like 'SEED%';
--   delete from sms_credit_ledger where idempotency_key like 'seed:%';
--   update sms_credit_accounts set balance_cents = 0 where club_id is null;
--
-- The outlets are deliberately NOT removed: this file only creates them when
-- the table was empty, and deleting them blind would take a club's real ones
-- with it.
-- ---------------------------------------------------------------------------
