-- Demo seed for Member health, and for Golf & dining crossover.
--
-- Run AFTER schema.sql (or bring-up-to-date.sql). Needs nothing else — both
-- panels read the visits table only.
--
-- A year of attendance for 36 members, ending now, so both panels have
-- something to say the moment it finishes. Separate from the service-recovery
-- seed and safe to run alongside it: these members are prefixed MH_ and that
-- seed's teardown only touches DEMO_.
--
-- The shape is deliberate. The club is BUSIER in the recent window than in
-- the baseline — which is what a golf club in August looks like against a
-- baseline that includes winter. That makes the seasonal adjustment do
-- visible work: a member merely holding flat is slipping, because everybody
-- else went up. Without a seasonal shape in the data the panel demos as a
-- plain "hasn't been in a while" list, which is the thing it is not.
--
-- Every seeded visit is stamped as already surveyed, so this does not dump
-- seven hundred rows into the Survey Queue.
--
-- Idempotent, works against whatever outlets the club has, and one statement.
-- Prints a NOTICE saying what it built.
--
-- Verified on Postgres 16 against a club whose outlets share no name with
-- this file, run twice.

do $mh$
declare
  v_outlets      int;
  v_golf_outlet  uuid;
  v_golf_slot    int;
  v_dine_outlets int;
  v_visits       int;
  v_members      int;
begin

-- ------------------------------------------------------------------ outlets --
create temp table mh_outlets on commit drop as
  select row_number() over (order by name) as slot, outlet_id, name
    from outlets
   where coalesce(active, true)
   order by name
   limit 4;

select count(*) into v_outlets from mh_outlets;
if v_outlets = 0 then
  raise exception 'No active outlets found. Add your outlets in Settings first — the demo visits have to belong to one.';
end if;

-- Rounds want a golf outlet if the club has one; otherwise they sit on the
-- first outlet, which still lets both panels work.
select outlet_id into v_golf_outlet from mh_outlets where name ilike '%golf%' limit 1;
if v_golf_outlet is null then
  select outlet_id into v_golf_outlet from mh_outlets where slot = 1;
end if;
-- Golfers who stay to eat mostly eat at whatever sits by the course, so the
-- "where golfers eat" panel has a leader rather than equal bars. The other
-- rooms are held in their own numbered set — picking them by arithmetic off
-- the same slots kept landing back on the golf outlet, because it happens to
-- sort first, and the panel showed it taking 100% of the crossover.
select slot into v_golf_slot from mh_outlets where outlet_id = v_golf_outlet;

create temp table mh_dine_outlets on commit drop as
  select row_number() over (order by name) as slot, outlet_id
    from mh_outlets where outlet_id <> v_golf_outlet;
select count(*) into v_dine_outlets from mh_dine_outlets;

-- ---------------------------------------------------------------- teardown --
delete from survey_responses where visit_id in (select visit_id from visits where member_id like 'MH_%');
delete from visits  where member_id like 'MH_%';
delete from members where member_id like 'MH_%';

-- ------------------------------------------------------------------- plan ---
--   baseline_n  visits in the 275 days before the recent window
--   recent_n    visits in the last 90 days
--   spend       typical cheque, so the ranking by value at risk has a spread
--   plays_golf  rounds as well as meals
--   dines_after the share of rounds after which they stay to eat
create temp table mh_plan (
  member_id text, first_name text, last_name text, cohort text,
  baseline_n int, recent_n int, spend numeric(10,2),
  plays_golf boolean, dines_after int
) on commit drop;

insert into mh_plan values
-- ===== THE MIDDLE — twelve members moving with the season ==================
-- These are what makes the panel honest: without a steady majority there is
-- no season to measure anybody against, and the whole club reads as at risk.
('MH_2001','Eleanor','Bramwell','steady',   14, 6,  92.00, true,  65),
('MH_2002','Douglas','Fairhurst','steady',  13, 6,  78.00, true,  55),
('MH_2003','Miriam','Coyle','steady',       15, 7,  64.00, false,  0),
('MH_2004','Alistair','Deng','steady',      14, 6, 110.00, true,  70),
('MH_2005','Rosalind','Whitmore','steady',  12, 5,  88.00, false,  0),
('MH_2006','Hugh','Pemberton','steady',     14, 6,  71.00, true,  45),
('MH_2007','Frances','Okafor','steady',     13, 6, 124.00, true,  60),
('MH_2008','Malcolm','Reeve','steady',      15, 6,  59.00, false,  0),
('MH_2009','Beatrice','Lang','steady',      14, 7,  96.00, true,  50),
('MH_2010','Gordon','Achebe','steady',      12, 5,  83.00, true,  40),
('MH_2011','Winifred','Kaur','steady',      14, 6, 105.00, false,  0),
('MH_2012','Cedric','Vaughan','steady',     13, 6,  67.00, true,  35),

-- ===== GONE — a real baseline, and nothing at all since ===================
-- Ranked first because they are worth the most, not because the drop is
-- steepest. That ordering is the point of the panel.
('MH_3001','Theodore','Ashworth','lapsed',  22, 0, 168.00, true,  75),
('MH_3002','Sylvia','Marchetti','lapsed',   19, 0, 142.00, false,  0),
('MH_3003','Rupert','Blackwood','lapsed',   16, 0,  74.00, true,  30),

-- ===== GOING — still coming, far less than the season predicts ============
('MH_4001','Cordelia','Nakamura','at_risk', 18, 2, 156.00, true,  65),
('MH_4002','Ambrose','Ferreira','at_risk',  17, 2, 133.00, true,  55),
('MH_4003','Harriet','Sandoval','at_risk',  16, 2,  61.00, false,  0),
('MH_4004','Lionel','Truscott','at_risk',   15, 2,  47.00, true,  25),

-- ===== SLIPPING — worth watching, not worth a call yet ====================
('MH_5001','Verity','Osei','slipping',      14, 4,  99.00, true,  50),
('MH_5002','Rowan','Castellanos','slipping',13, 4,  81.00, false,  0),
('MH_5003','Imogen','Halvorsen','slipping', 14, 4,  72.00, true,  45),
('MH_5004','Barnaby','Ruiz','slipping',     15, 4,  58.00, true,  20),
('MH_5005','Ottoline','Mbeki','slipping',   13, 4, 115.00, false,  0),

-- ===== COMING MORE ========================================================
('MH_6001','Clementine','Adeyemi','growing', 8, 9, 102.00, true,  70),
('MH_6002','Percival','Lindgren','growing',  7, 8,  76.00, true,  55),
('MH_6003','Arabella','Nwosu','growing',     8, 9,  91.00, false,  0),

-- ===== PLAY OFTEN, NEVER STAY =============================================
-- The list at the foot of the crossover panel. Without these the club looks
-- like it converts everybody, which no club does.
('MH_9001','Wilhelmina','Achterberg','steady', 16, 7, 0.00, true, 0),
('MH_9002','Fitzgerald','Okonkwo','steady',    14, 6, 0.00, true, 0),
('MH_9003','Cassandra','Bellweather','steady', 15, 6, 0.00, true, 0),

-- ===== TOO NEW TO JUDGE ===================================================
-- Set aside rather than scored as healthy. A club three months in is mostly
-- this, and the footnote under the list is what says so.
('MH_7001','Jasper','Almeida','new',         0, 6,  88.00, true,  60),
('MH_7002','Seraphina','Wu','new',           0, 5,  94.00, false,  0),
('MH_7003','Fitzwilliam','Boateng','new',    0, 7,  70.00, true,  50),
('MH_7004','Perpetua','Sorensen','new',      0, 4, 112.00, false,  0),
('MH_7005','Ignatius','Varga','new',         0, 5,  66.00, true,  35),

-- ===== TOO INFREQUENT TO JUDGE ============================================
('MH_8001','Millicent','Dube','infrequent',  2, 1,  54.00, false,  0),
('MH_8002','Horatio','Fenwick','infrequent', 3, 1,  62.00, true,  30),
('MH_8003','Georgiana','Salazar','infrequent',2,0,  49.00, false,  0),
('MH_8004','Leopold','Ivanova','infrequent', 3, 2,  57.00, true,  40);

-- ---------------------------------------------------------------- members ---
insert into members (member_id, first_name, last_name, phone_number, email_address, comm_preference, opt_out)
select p.member_id, p.first_name, p.last_name,
       '+1610555' || lpad((1000 + row_number() over (order by p.member_id))::text, 4, '0'),
       lower(left(p.first_name, 1) || '.' || p.last_name) || '@example.com',
       case when row_number() over (order by p.member_id) % 2 = 0 then 'email' else 'sms' end,
       false
  from mh_plan p;

-- ------------------------------------------------------------------- days ---
-- One row per member per day they were at the club. Visits hang off these, so
-- a golfer who stays to eat is two visits on one day — which is one occasion
-- to member health and one crossover day to the golf panel.
create temp table mh_days on commit drop as
  select p.member_id, i.seq,
         (360 - round((i.seq - 1) * 265.0 / greatest(p.baseline_n - 1, 1)))::int as days_ago
    from mh_plan p, lateral generate_series(1, p.baseline_n) as i(seq)
   where p.baseline_n > 0
  union all
  select p.member_id, 1000 + i.seq,
         (88 - round((i.seq - 1) * 86.0 / greatest(p.recent_n - 1, 1)))::int
    from mh_plan p, lateral generate_series(1, p.recent_n) as i(seq)
   where p.recent_n > 0;

-- ------------------------------------------------------------------ meals ---
-- Non-golfers eat every time they come. Golfers eat after their round on the
-- share of days their dines_after says — deterministic rather than random, so
-- re-running the seed produces the same demo.
insert into visits (member_id, outlet_id, visit_date, spend_amount, server_name, visitor_type, qualifies, survey_sent_at)
select d.member_id,
       o.outlet_id,
       (now() - make_interval(days => d.days_ago))::date,
       round((p.spend * (0.75 + (d.seq % 7) * 0.08))::numeric, 2),
       (array['Ava Del Viscio','Sabrina Swope','Priyanka','Patrick McDermott'])[1 + (d.seq % 4)],
       'member', true,
       now() - make_interval(days => d.days_ago - 1)
  from mh_days d
  join mh_plan p on p.member_id = d.member_id
  join lateral (
    select case
      -- A golfer eats by the course about three times in five; the rest of
      -- the time they walk up to one of the other rooms.
      when p.plays_golf and (d.seq % 5) < 3 then v_golf_outlet
      when p.plays_golf and v_dine_outlets > 0 then
        (select outlet_id from mh_dine_outlets where slot = 1 + (d.seq % v_dine_outlets))
      else (select outlet_id from mh_outlets where slot = 1 + (d.seq % v_outlets))
    end as outlet_id
  ) o on true
 where not p.plays_golf
    or ((d.seq * 37) % 100) < p.dines_after;

-- ----------------------------------------------------------------- rounds ---
insert into visits (member_id, outlet_id, visit_date, spend_amount, visitor_type, qualifies, survey_sent_at)
select d.member_id,
       v_golf_outlet,
       (now() - make_interval(days => d.days_ago))::date,
       0, 'golf', true,
       now() - make_interval(days => d.days_ago - 1)
  from mh_days d
  join mh_plan p on p.member_id = d.member_id
 where p.plays_golf;

select count(*) into v_visits from visits where member_id like 'MH_%';
select count(*) into v_members from members where member_id like 'MH_%';

raise notice 'Seeded % visits for % members across % outlet(s). Member health: Members screen. Crossover: Golf screen.',
  v_visits, v_members, v_outlets;

end
$mh$;

-- ------------------------------------------------------------------ check --
-- Roughly what the two panels should now show. The bands here are computed
-- the same way the app does, so if these look right the panels will.
with windows as (
  select member_id,
         count(*) filter (where visit_date >= (now() - interval '90 days')::date)  as recent_days,
         count(*) filter (where visit_date <  (now() - interval '90 days')::date)  as baseline_days
    from (select distinct member_id, visit_date from visits where member_id like 'MH_%') d
   group by member_id
),
rates as (
  select member_id, recent_days, baseline_days,
         (recent_days / 90.0) / nullif(baseline_days / 275.0, 0) as ratio
    from windows
),
season as (
  select percentile_cont(0.5) within group (order by ratio) as median_ratio
    from rates where baseline_days >= 4
)
select
  count(*) filter (where r.baseline_days < 4)                                   as not_scored,
  count(*) filter (where r.baseline_days >= 4 and r.recent_days = 0)            as lapsed,
  count(*) filter (where r.baseline_days >= 4 and r.recent_days > 0
                     and r.ratio < s.median_ratio * 0.4)                        as at_risk,
  count(*) filter (where r.baseline_days >= 4 and r.recent_days > 0
                     and r.ratio >= s.median_ratio * 0.4
                     and r.ratio <  s.median_ratio * 0.7)                       as slipping,
  count(*) filter (where r.baseline_days >= 4
                     and r.ratio >= s.median_ratio * 1.2)                       as growing,
  round(s.median_ratio::numeric, 2)                                            as club_season
  from rates r cross join season s
 group by s.median_ratio;
