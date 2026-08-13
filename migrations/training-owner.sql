-- Somebody's name against every training plan.
--
-- A plan is generated on a Friday morning, lands on the Training Actions
-- screen with four steps on it, and belongs to nobody. Everyone who reads it
-- assumes somebody else is doing it, which is how a plan sits at 0/4 for a
-- month while the outlet that earned it carries on as it was. Case alerts
-- solved this with an owner and a notification; plans never got the same
-- treatment, and they are the slower, more expensive half of the work.
--
-- Three columns, all nullable: a plan with no owner behaves exactly as it does
-- today rather than becoming invalid the moment this runs.
--
-- Safe to run on any database, as many times as you like.

-- ---------------------------------------------------------------------------
-- 1. The owner
-- ---------------------------------------------------------------------------
-- The id is the truth; the name is kept alongside it so a plan still reads
-- correctly after somebody leaves the club. Removing a person from the team
-- must not silently blank the history of who was responsible for what — the
-- FK is ON DELETE SET NULL and owner_name survives it, so the screen can say
-- "was Priya Anand" rather than showing an unexplained gap.
alter table training_plans add column if not exists owner_staff_id uuid;
alter table training_plans add column if not exists owner_name     text;
alter table training_plans add column if not exists assigned_at    timestamptz;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'training_plans_owner_staff_id_fkey'
      and table_name = 'training_plans'
  ) then
    alter table training_plans
      add constraint training_plans_owner_staff_id_fkey
      foreign key (owner_staff_id) references staff(staff_id) on delete set null;
  end if;
end $$;

-- Finding a person's open work is the query the screen runs most, and it is
-- the one a GM runs on a Monday morning: what is outstanding, and whose.
create index if not exists training_plans_owner_idx
  on training_plans (owner_staff_id);

-- ---------------------------------------------------------------------------
-- 2. Backfill from the outlet
-- ---------------------------------------------------------------------------
-- An outlet that already nominates somebody for its case alerts has answered
-- this question once. Asking it again, plan by plan, for people who have
-- already told us, is how a good feature gets abandoned in week two.
--
-- Only plans with steps still outstanding are backfilled. Assigning a finished
-- plan to somebody would put completed work on their list, which teaches them
-- the list is wrong.
--
-- Guarded: a database that has not run outlet-alert-owner.sql has no column to
-- read from, and this should skip rather than fail.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'outlets' and column_name = 'owner_staff_id'
  ) then
    update training_plans p
       set owner_staff_id = o.owner_staff_id,
           owner_name     = s.name,
           assigned_at    = coalesce(p.generated_at, now())
      from outlets o
      join staff   s on s.staff_id = o.owner_staff_id
     where p.outlet_id = o.outlet_id
       and p.owner_staff_id is null
       and o.owner_staff_id is not null
       -- Something still to do on it.
       and exists (
         select 1 from jsonb_array_elements(p.steps) step
          where coalesce((step->>'done')::boolean, false) = false
       );
  end if;
end $$;

-- Supabase serves the API through PostgREST, which caches the schema. Until it
-- reloads, selecting the new columns fails even though they exist.
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- What you have to work with
-- ---------------------------------------------------------------------------
select count(*)                                        as plans,
       count(owner_staff_id)                           as with_an_owner,
       count(*) - count(owner_staff_id)                as unassigned
from training_plans;
