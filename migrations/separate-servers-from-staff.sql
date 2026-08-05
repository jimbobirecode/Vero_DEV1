-- Servers are servers. Team members are team members.
--
-- These were wired together in both directions. Adding a team member created
-- a servers row; adding a server created a staff row at role dept_head. So
-- managers appeared in the Server dropdown, and every waiter appeared under
-- Team members holding dashboard access.
--
-- The application no longer writes either direction, and this file removes
-- the column that let it — servers.staff_id — so it cannot come back.
--
-- Run the SELECT in each section, read the list, then run the DELETE under
-- it. Nothing here guesses on your behalf.
--
-- If you ran an earlier version of this file: it deleted servers rows and it
-- may have inserted some. Section 1 and section 2 below will show you what is
-- actually in each table now, which is the thing to go on.

-- ###########################################################################
-- SECTION 1 — Who is in Team members without a dashboard login
-- ###########################################################################
-- A team member is someone who signs in. Anyone in `staff` with no login is
-- either a server that the old code created automatically, or a manager whose
-- login has not been made yet.
--
-- Read this list. The servers in it are the ones you want gone.
select
  st.staff_id,
  st.name,
  st.email,
  st.role,
  case when exists (select 1 from servers s where lower(btrim(s.name)) = lower(btrim(st.name)))
       then 'also on the server roster' else '' end as note
from staff st
where st.active
  and (to_regclass('auth.users') is null
       or not exists (select 1 from auth.users u where lower(u.email) = lower(coalesce(st.email, ''))))
order by st.role, st.name;

-- Remove them. Edit the list of names to match what you decided above —
-- anything you want to KEEP as a team member, add to the `not in` list.
--
-- delete from staff
-- where active
--   and name not in ('Name To Keep', 'Another To Keep')
--   and (to_regclass('auth.users') is null
--        or not exists (select 1 from auth.users u where lower(u.email) = lower(coalesce(staff.email, ''))));

-- ###########################################################################
-- SECTION 2 — Who is on the server roster
-- ###########################################################################
-- This is the list the Server dropdown offers when you log a visit, and who
-- receives a shift survey. `credited` is how many visits name them: anyone at
-- 0 who is obviously a manager can go.
select
  s.server_id,
  s.name,
  s.phone,
  s.email,
  (select count(*) from visits v where v.server_id = s.server_id) as credited_visits
from servers s
where s.active
order by credited_visits desc, s.name;

-- Remove the managers. Name them explicitly — a server with 0 visits so far
-- is a new starter, not a mistake, so this must not be done by rule.
--
-- delete from servers
-- where name in ('General Manager Name', 'F&B Director Name')
--   and not exists (select 1 from visits       v where v.server_id = servers.server_id)
--   and not exists (select 1 from server_tasks t where t.server_id = servers.server_id);

-- ###########################################################################
-- SECTION 3 — Cut the link for good
-- ###########################################################################
-- servers.staff_id is what the old code used to keep the two tables in step.
-- Nothing reads it any more. Dropping it means no future change can quietly
-- re-couple them: to be both a server and a team member you are now simply
-- on both lists, which is what those lists mean.
alter table servers drop column if exists staff_id;

-- ###########################################################################
-- Confirm
-- ###########################################################################
select 'team members' as list, count(*) as active from staff   where active
union all
select 'servers',            count(*)           from servers where active;
