# Member health

`GET /api/analytics/member-health?recent_days=90`, on the Members screen.

A member who stops coming rarely resigns first. They just come less, and then
not at all, and the club finds out when the subscription lapses — by which
point the conversation that would have kept them is a year late.

Reads **visits only**. Attendance is the signal and it exists whether or not
the member ever answered a survey.

## The two decisions that make it usable

Both are about not crying wolf. A list nobody trusts is worse than no list.

**Measured against their own rhythm, not a club-wide rule.** "Hasn't visited in
30 days" flags the member who always came monthly and misses the one who came
three times a week and now comes once. The second is the resignation. So each
member's recent rate is compared against their own baseline from the preceding
year.

**Adjusted for the club's own season.** A golf club in January is not a golf
club in July. Without this every member is at risk every winter, the list is
ignored by February, and the feature is dead. Each member is compared against
what the rest of the membership did over the same weeks.

Two details inside that adjustment, both found by testing:

- It is the **median of each member's own ratio**, not the ratio of the club's
  totals. A total is volume-weighted, so one member who came four times a week
  and stopped moves the club figure further than fifty members who did not
  change — and then everybody steady reads as "growing" against a season one
  person invented.
- It is computed **leaving that member out**. Otherwise a member is partly
  compared against themselves: their own collapse drags the average down, which
  makes the collapse look normal. In a club of four hundred that is a rounding
  error; in a club of thirty it hides exactly the people the list exists to
  find, and it gets worse the more of them there are — a genuine wave of
  resignations would be the hardest thing for it to see.

## Bands

| Band | Meaning |
|---|---|
| `lapsed` | had a real baseline, no visit at all in the window |
| `at_risk` | coming 60%+ less than the season predicts |
| `slipping` | 30%+ less — watch, don't call |
| `steady` | moving with the club |
| `growing` | coming 20%+ more |
| `new` / `infrequent` | not enough history to judge, reported separately |

Members with fewer than four baseline visits are **set aside, not scored as
healthy**. A club three months into using this has no baseline for most of its
membership, and a page of reassuring green would be a lie. The footnote under
the list says how many could not be scored and what the seasonal adjustment
was — or that there were too few members to measure one.

## Ranked by money

`value_at_risk` is the member's baseline spend annualised, scaled by how much
of their custom has actually gone. For a lapsed member that is all of it.

The list is ordered by that, not by percentage drop. A GM has one morning: a
90% fall from a member worth $300 a year is a worse use of it than a 50% fall
from one worth $9,000. `call_list` caps it at ten, because a hundred and forty
names is not a call list.

Contact details and opt-out status ride along, and a member the club has since
removed is marked `on_member_list: false` rather than sitting on the list.

## Demo data

`migrations/member-health-seed.sql` — a year of attendance for 39 members,
relative to now, idempotent, and safe to run alongside the service-recovery
seed (these members are prefixed `MH_`, that one uses `DEMO_`).

It also feeds the Golf & dining crossover panel, since both read visits.

The club is deliberately **busier** in the recent window than the baseline,
which is what a golf club in August looks like against a year that includes
winter. That makes the seasonal adjustment visibly do something — a member
merely holding flat is slipping, because everyone else went up. Seeded flat,
the panel demos as a plain "hasn't been in a while" list, which is the thing
it is not.

Every seeded visit is stamped as already surveyed, so it does not put eight
hundred rows into the Survey Queue.

## Tuning

`recent_days`, `baseline_days` and `min_baseline_visits` are query parameters.
Band thresholds live in `BANDS` in `server/lib/member-health.js`. Shortening
`recent_days` makes it twitchier and catches drops sooner; lengthening it makes
it surer and later.
