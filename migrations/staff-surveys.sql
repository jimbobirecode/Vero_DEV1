-- Staff workday surveys.
--
-- The member survey asks how the visit went; this asks the people who worked
-- that shift how the day went for them. Same mechanic — a one-use tokenised
-- link over SMS/email, no login — because servers have no dashboard account.
--
-- Safe to run on any database, as many times as you like.

create table if not exists staff_survey_responses (
  staff_response_id uuid primary key default uuid_generate_v4(),
  server_id         uuid references servers(server_id),
  shift_date        date not null,
  survey_token      text not null unique,

  -- Ratings mirror the member survey's 1–5 scale so the two read alike on a
  -- dashboard. Nullable until submitted; the check still holds once set.
  q1_shift_rating   smallint check (q1_shift_rating   between 1 and 5),  -- required
  q2_support        smallint check (q2_support        between 1 and 5),  -- required
  q3_workload       smallint check (q3_workload       between 1 and 5),  -- required
  q4_tools          smallint check (q4_tools          between 1 and 5),  -- skippable
  q5_comment        text check (char_length(q5_comment) <= 1000),        -- optional

  answers           jsonb,
  submitted_at      timestamptz,
  is_complete       boolean not null default false,
  sent_at           timestamptz,
  created_at        timestamptz not null default now()
);

-- One survey per person per shift. The send path relies on this: it upserts
-- against the constraint rather than checking-then-inserting, so a retry or a
-- double tick cannot produce two links for the same day.
create unique index if not exists staff_survey_responses_server_shift_idx
  on staff_survey_responses (server_id, shift_date);

create index if not exists staff_survey_responses_shift_date_idx
  on staff_survey_responses (shift_date desc);

-- Submitted-only lookups drive the dashboard summary.
create index if not exists staff_survey_responses_submitted_idx
  on staff_survey_responses (submitted_at desc)
  where submitted_at is not null;

-- Scheduler settings. Staff surveys go out after service rather than at the
-- member send time, so they get their own key and their own quiet window.
--
-- Guarded on club_settings existing: on a database that has not had
-- bring-up-to-date.sql run yet, a bare insert would abort this whole file and
-- leave the tables above uncreated. Missing defaults are harmless — the app
-- reads staff_survey_enabled as off and the send time as 20:30 when absent.
do $$
begin
  if to_regclass('public.club_settings') is not null then
    insert into club_settings (key, value, updated_at)
    values ('staff_survey_send_time', '20:30', now()),
           ('staff_survey_enabled',   'false', now())
    on conflict (key) do nothing;
  else
    raise notice 'club_settings not found — run migrations/bring-up-to-date.sql, then re-run this file to seed the staff survey defaults.';
  end if;
end $$;
