-- Route case alerts to whoever runs the outlet.
--
-- An alert is raised the moment a poor response is submitted, and it already
-- knows which outlet the visit was to. Until now it sat unassigned until a
-- manager noticed it in the daily digest and picked somebody — which on a
-- weekend meant nobody, because the person who could act on it was never told.
--
-- Giving an outlet an owner closes that: the alert is assigned on creation and
-- the owner is emailed directly. The outlet already nominates its own survey
-- template, so one row in Settings now answers both questions about a
-- location — what we ask there, and who answers for it.
--
-- Safe to run on any database, as many times as you like.

-- ---------------------------------------------------------------------------
-- 1. The owner
-- ---------------------------------------------------------------------------
-- Nullable on purpose. An outlet with no owner behaves exactly as before —
-- the alert is created unassigned and the managers are notified — so this is
-- something you switch on outlet by outlet rather than all at once.
--
-- ON DELETE SET NULL, because removing somebody from the team must not take
-- the outlet's alerting with it. The outlet falls back to notifying managers,
-- which is noisier than the right person but never silent.
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

-- ---------------------------------------------------------------------------
-- 2. The column alerts are actually assigned through
-- ---------------------------------------------------------------------------
-- The original table carried `assigned_to text` — a name typed in, which
-- nothing could join on. The application has used assigned_to_staff_id for a
-- while; this makes sure it exists on databases that predate it.
alter table case_alerts add column if not exists assigned_to_staff_id uuid;

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

-- ---------------------------------------------------------------------------
-- 3. Suggested starting point
-- ---------------------------------------------------------------------------
-- Nothing is assigned automatically here — who runs which outlet is a
-- decision, not something to infer. This just lists what you have to work
-- with so the Settings screen is quicker to fill in.
select o.name as outlet,
       coalesce(s.name, '— nobody yet —') as alerts_go_to,
       (select count(*) from case_alerts c
         where c.outlet_id = o.outlet_id and c.status = 'open') as open_alerts
from outlets o
left join staff s on s.staff_id = o.owner_staff_id
where o.active
order by open_alerts desc, o.name;
