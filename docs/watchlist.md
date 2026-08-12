# Watchlist

Service recovery reports how quickly the club rang somebody and whether the case
was marked resolved. Both of those describe what the club did. Neither is
evidence that it worked.

This tracks the member from the bad visit to their next one, and grades the
outcome on what **they** said, not on what the club recorded.

## The one decision everything else follows from

**Closing the case does not clear the member.**

A manager rings, has a decent conversation, marks the alert resolved, and the
recovery rate goes up. But the only thing that has actually happened is that the
club believes it went well. The member has not been back. Nobody knows.

So a member stays on the watchlist from the incident until one of two things
happens:

* they come back and answer another survey — the verdict, either way, or
* the watch window expires and they become a retention problem instead.

"We called and they seemed fine" is exactly the belief this exists to test, so
it is the one thing that cannot end the watch.

## What counts as an incident

Anything `lib/severity.js` would raise a case alert for: NPS 0–6, or two stars
and under. The same rule the Case Alerts screen uses, so the two screens cannot
disagree about what a bad visit is.

An alert and the survey that caused it are **one** incident, not two. Without
that fold, every bad visit that produced an alert appeared twice — once as
feedback and once as a case — and every count on the screen was inflated.

Feedback that never became a case still counts. Plenty of bad visits sit under
the severity threshold for an alert and well above nothing.

## The four outcomes

| Status | Means | On the watchlist? |
|---|---|---|
| `not_returned` | No visit since the incident | Yes |
| `returned_unmeasured` | Came back, has not been surveyed | Yes — nobody has heard from them |
| `recovered` | Came back and rated it well | No — answered |
| `still_unhappy` | Came back and it was bad again | No — answered, badly |

Both of the last two come off the list. The question has been settled, and a
list that keeps answered questions on it is a list that stops being read.

## Two rules that stop it lying

**A visit within 36 hours is the same occasion, not a return.** A member who
ate in the clubhouse and then the halfway house on one evening has not come
back, and grading the club on a visit nobody could have acted on between times
would score it for something it did not do.

**The recovery rate is measured only on members who came back.** Folding in the
ones who have not returned yet would make the rate a measure of how recent the
incidents are: a club with a bad week would see its rate collapse before anybody
had had the chance to come back. With nothing graded yet, the rate is `null` and
the screen says "nobody has been back yet" — not "0% recovered". Those are very
different things to put in front of a GM.

**Every incident is graded, not just the latest.** A member with a bad visit who
came back and had a second bad visit is *both* a failed recovery and a fresh
open case. Grading only their newest incident dropped the failure out of the
rate entirely — the first version read 100% recovered on a member who had
plainly not been recovered.

## Where the numbers come from

A survey response does not know who gave it. It hangs off a visit, and the visit
knows. So a member's feedback is only reachable through their visits, and a
response whose visit has no `member_id` belongs to a guest — who has no next
visit to track and is excluded.

The load window and the watch window are the same number for a reason: loading
90 days of history to grade a 180-day watch would judge a March incident against
an empty April, which reads as "never came back" for somebody who has been in
every week.

## What was added

| Piece | Where |
|---|---|
| Grading rules — incidents, outcomes, the rate | `server/lib/member-watch.js` (48 tests) |
| Joining responses → visits → members | `server/lib/member-watch-store.js` (18 tests) |
| `GET /api/watchlist`, `GET /api/watchlist/:member_id` | `server/routes/watchlist.js` |
| Watchlist screen | `vero-dashboard.html` |
| Heads-up when a watched member is logged in | Visits screen, `checkWatch()` |

No migration. It reads tables that already exist.

Both endpoints are `dept_head` and above, matching Case Alerts — it is the head
of department who can arrange the good visit.

## Where it is actually useful

The screen is the report. The thing that changes an outcome is the banner on the
**Visits** screen: pick a member for a visit and, if they are owed a good one,
it says so — what they scored, how long ago, whether the case was closed, and
their comment. By the time that member's name reaches a monthly report they have
been and gone.

## What this is not

Past the watch window (180 days by default) a member who never returned drops
off. They are no longer a recovery problem; they are a retention one, which is
`lib/member-health.js` and the Member health panel on the Members screen. Keeping
them here would put the same person on two lists with two different recommended
actions, and the club would trust neither.
