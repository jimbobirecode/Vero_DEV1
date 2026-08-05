# Service recovery

Case alerts used to run `open → assigned → resolved`. Every one of those states
describes what staff did internally, so a club could resolve every alert it ever
raised and no member would ever know they had been heard.

This closes the loop back to the member — and deliberately **does not** do it by
sending them anything.

## The one decision everything else follows from

The valuable act is a manager telephoning the member within a day. An
auto-generated apology is not a cheaper version of that; it is worse than
silence, because it tells the member the club noticed and handed it to software.

So nothing here messages the member. The system **times the call, records it,
and reports on it**. `generateFollowUp()` still exists to help a manager decide
what to say, and it is still advisory only.

## What was added

| Piece | Where |
|---|---|
| Rules — SLA windows, escalation stages, metric definitions | `server/lib/recovery.js` (pure, 69 tests) |
| Database work shared by all three callers | `server/lib/recovery-store.js` (31 tests) |
| Queue, stats, outreach and the resolve gate | `server/routes/alerts.js` |
| One-tap logging from a phone | `server/routes/recovery-log.js`, mounted at `/c` |
| Hourly escalation | `POST /api/cron/recovery-sweep`, `render.yaml` |
| Schema | `migrations/service-recovery.sql` |

Run `migrations/service-recovery.sql` before deploying. Until it runs, the
recovery endpoints return 503 with a message naming what is missing, and
`resolve` keeps its old behaviour so the existing screen does not break.

## The clock

`contact_due_at` is set when the alert is created, from the member's complaint
— not from whenever a manager next opens the dashboard, which would quietly hand
back the hours already used up. Windows come from `club_settings` and default to
24h / 3d / 7d by severity.

An alert then sits in one of: `waiting`, `due` (past half the window), `urgent`
(past 90%), `breached`, or `contacted`. Alerts raised before this shipped have no
clock and report as `unscheduled` rather than being silently counted as met.

The sweep runs **hourly**, not daily. A daily job cannot police a 24-hour promise
— an alert raised at 10am would get its first and only nudge after it expired.
Each stage is sent once; the assignee gets it, or the managers if nobody is
assigned, because an unassigned alert running out of time is exactly the case
where nobody feels responsible.

## Logging the call

Two doors, one code path (`logOutreach`), because they must not disagree about
what a logged call means:

- **Dashboard** — a modal on the recovery queue.
- **One tap** — `/c/:token`, linked from the assignment and escalation emails.
  Three buttons at thumb size. This exists because of where the act happens: a
  manager rings from the car park, hangs up, and has about thirty seconds of
  willingness left. Nothing is recorded on `GET`, because mail scanners prefetch
  every link in an email and those would become calls nobody made.

Distinctions that keep the numbers honest:

- Only `reached` is a conversation. A voicemail is an **attempt** — it stops the
  SLA clock, because ringing within the hour and getting no answer is the thing
  the promise is about — but it is not recovery. A club that leaves 40 voicemails
  has not recovered 40 members.
- `wrong_number` is not an attempt at all: the club never reached the right
  person, so the clock keeps running.
- Sentiment can only be recorded on a call that connected.
- A later call never overwrites `first_contact_at`, and a call logged against a
  resolved alert does not drag it back out of resolved.

## Resolving

`PUT /api/alerts/:id/resolve` now returns **409** when nobody has contacted the
member, with the list of reasons. The dashboard turns that into a prompt.

It asks rather than blocks. Refusing outright would only teach people to log a
call that never happened, which corrupts the metric instead of protecting it.
The reason is recorded, and alerts closed with one leave the denominator so they
neither flatter nor punish the number.

Reopening leaves any logged contact on the record — reopening means the fix was
not good enough, not that the call never happened.

## The three numbers

`GET /api/alerts/recovery-stats?days=90`

- **% contacted within the window** — the promise. Scored only against alerts
  whose window has *closed* (contacted, or breached). An alert still inside its
  window has not been missed and can yet be called; counting it would drop the
  headline every time a new alert arrived, punishing a club for a busy Saturday.
  Those are reported separately as `still_in_window`.
- **Median hours to first contact** — the texture.
- **% who rated the club higher on their next survey** — the proof, and the only
  one about the member's experience rather than the club's process.

The follow-up score is the first survey a member submitted *after* the call, not
their next one chronologically — otherwise the response that raised the alert
gets read as evidence of recovery.

Where nobody has returned yet, the recovery rate is `null`, not `0`. "0%
recovered" and "nobody has come back yet" are very different things to put in
front of a GM.

## Known gap

A member with no phone and no email cannot be rung however urgent the alert is.
The queue marks these explicitly rather than leaving them to look like neglect,
and `no_contact_details` is one of the resolve reasons. Fixing the underlying
cause is the member-ID matching work, which is not built yet.
