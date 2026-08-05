-- What was actually done about each case.
--
-- Run AFTER migrations/service-recovery.sql.
--
-- Resolving a case recorded a timestamp and nothing else. A club could work
-- through a year of alerts and afterwards answer none of the questions that
-- make the work worth doing: what keeps going wrong, what we keep doing about
-- it, and what that costs us.
--
-- This is an event table rather than a set of columns on case_alerts, for the
-- same reason alert_outreach is: a case can be resolved, reopened because the
-- fix did not hold, and resolved again. Overwriting would erase the first
-- attempt — which is precisely the record you want when something recurs.

create table if not exists case_resolutions (
  resolution_id   uuid primary key default gen_random_uuid(),
  alert_id        uuid not null references case_alerts(alert_id) on delete cascade,

  -- What went wrong, and what was done. Closed lists, because the point is to
  -- count them — a free-text box would answer the question for one case and
  -- for no others. Kept as text with a check rather than an enum so a club can
  -- be given a new option without a type migration.
  root_cause      text not null check (root_cause in (
    'service_speed','service_attitude','food_quality','food_availability',
    'cleanliness','booking_error','billing_error','facility','staffing_level',
    'member_expectation','other')),
  action_taken    text not null check (action_taken in (
    'coached_staff','staffing_changed','process_changed','supplier_or_stock',
    'facility_fixed','billing_corrected','goodwill_only','explained_only','no_action')),

  notes           text check (char_length(notes) <= 2000),

  -- What the recovery cost. Null where it cost nothing, which is most of them.
  goodwill_type   text check (goodwill_type in (
    'none','comped_item','comped_visit','account_credit','gift','other')),
  goodwill_amount numeric(10,2) check (goodwill_amount >= 0),

  -- Whether the loop was closed with the member at the point of resolution,
  -- and if not, why. Snapshotted here so the record stays true even if the
  -- alert is reopened and contacted later.
  contacted_member  boolean not null default false,
  no_contact_reason text,

  resolved_by      uuid references staff(staff_id),
  resolved_by_name text,                       -- kept if the staff row is later removed
  resolved_at      timestamptz not null default now(),

  -- Set when the alert is reopened: this resolution did not hold. The current
  -- resolution for a case is the one row where this is null.
  superseded_at    timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists case_resolutions_alert_idx on case_resolutions (alert_id, resolved_at desc);
-- The reporting query: current resolutions in a period, by cause.
create index if not exists case_resolutions_current_idx on case_resolutions (resolved_at)
  where superseded_at is null;

-- One live resolution per case. A second one can only exist once the first has
-- been superseded, which is what reopening does.
create unique index if not exists case_resolutions_one_current_idx
  on case_resolutions (alert_id) where superseded_at is null;
