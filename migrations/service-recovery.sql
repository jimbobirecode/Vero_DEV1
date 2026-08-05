-- Service recovery: closing the loop back to the member.
--
-- Case alerts ran open -> assigned -> resolved, and every one of those states
-- describes what staff did internally. Nothing recorded whether anybody
-- actually spoke to the member, which is the only part of the loop the member
-- experiences. A club could resolve every alert it ever raised and no member
-- would know they had been heard.
--
-- What this adds is deliberately NOT an automated apology. The valuable act is
-- a manager picking up the phone within a day; an auto-sent "we're sorry"
-- email is worse than silence, because it tells the member the club noticed
-- and handed it to software. So the schema records and times human contact
-- rather than replacing it.

-- 1. Every attempt to reach a member about an alert.
--
-- One alert can have several: a missed call on the night, a voicemail the next
-- morning, then a conversation. Keeping them all is what makes "median time to
-- first contact" and "how many attempts did recovery take" answerable.
create table if not exists alert_outreach (
  outreach_id      uuid primary key default uuid_generate_v4(),
  alert_id         uuid not null references case_alerts(alert_id) on delete cascade,
  member_id        text references members(member_id),

  channel          text not null check (channel in ('phone','in_person','sms','email','letter')),
  outcome          text not null check (outcome in ('reached','left_message','no_answer','declined','wrong_number')),

  -- How the member sounded, recorded by whoever spoke to them. Only meaningful
  -- when outcome = 'reached'; null otherwise.
  member_sentiment text check (member_sentiment in ('recovered','neutral','still_unhappy')),

  notes            text check (char_length(notes) <= 2000),

  occurred_at      timestamptz not null default now(),
  logged_by        uuid references staff(staff_id),
  logged_by_name   text,                 -- kept for history if the staff row is later removed
  logged_via       text not null default 'dashboard' check (logged_via in ('dashboard','one_tap','api')),
  created_at       timestamptz not null default now()
);

create index if not exists alert_outreach_alert_idx  on alert_outreach (alert_id, occurred_at);
create index if not exists alert_outreach_member_idx on alert_outreach (member_id, occurred_at);

-- 2. The clock, denormalised onto the alert so the queue can be sorted and
--    filtered without a join per row.
alter table case_alerts add column if not exists contact_due_at    timestamptz;
alter table case_alerts add column if not exists first_contact_at  timestamptz;
alter table case_alerts add column if not exists first_reached_at  timestamptz;
alter table case_alerts add column if not exists outreach_count    integer not null default 0;

-- Resolving without ever contacting the member is sometimes legitimate — the
-- complaint was about a closed outlet, the member is deceased, they asked not
-- to be contacted. It must be a deliberate, recorded choice rather than the
-- silent default it is today.
alter table case_alerts add column if not exists no_contact_reason text;

-- One-tap logging from the escalation email. Minted per alert, single purpose:
-- the worst anyone can do with a guessed token is record a call on somebody
-- else's alert, and every logged outreach names who logged it and how.
alter table case_alerts add column if not exists recovery_token    text unique;

-- Escalation bookkeeping, so the hourly sweep doesn't re-send the same nudge.
alter table case_alerts add column if not exists escalated_stage   text
  check (escalated_stage is null or escalated_stage in ('half','final','breached'));
alter table case_alerts add column if not exists escalated_at      timestamptz;

create index if not exists case_alerts_due_idx on case_alerts (contact_due_at)
  where first_contact_at is null;

-- 3. 'contacted' sits between assigned and resolved: somebody has spoken to
--    the member, the internal fix may still be outstanding.
alter table case_alerts drop constraint if exists case_alerts_status_check;
alter table case_alerts add constraint case_alerts_status_check
  check (status in ('open','assigned','contacted','resolved'));

-- 4. How long the club has to make contact, by severity. Minutes, so a club
--    that wants "within the hour" for a high-severity alert can have it.
insert into club_settings (key, value) values
  ('recovery_sla_high_minutes',   '1440'),   -- 24 hours
  ('recovery_sla_medium_minutes', '4320'),   -- 3 days
  ('recovery_sla_low_minutes',    '10080')   -- 7 days
on conflict (key) do nothing;

-- 5. Backfill the clock for alerts raised before this shipped, so the queue is
--    not empty on the day it goes live. Anything already resolved is left
--    alone — inventing a due date for closed history would corrupt the very
--    metric this exists to report.
update case_alerts
   set contact_due_at = created_at + (
         case severity
           when 'high'   then interval '1440 minutes'
           when 'medium' then interval '4320 minutes'
           else               interval '10080 minutes'
         end)
 where contact_due_at is null
   and status <> 'resolved';
