# Golf and dining: one survey, and the analytics behind it

Two changes that belong together. The first stops a member who plays and then
eats from getting two surveys. The second is the only place the club can still
see that they did both.

## One survey per member per day

A member cap already existed (`server/lib/send-policy.js`, default one survey
per member per day). It picked the **highest-spend** visit — and a round is
recorded with a spend of zero.

So dining won every single time. A member who golfed and then had lunch was
never once asked about the golf, at any club, ever. The cap looked like it was
working and the golf survey silently never went out.

The cap now settles a day that spans both by **rotation** rather than spend:

- Whatever the member was last asked about, they get the other one now.
- With no history the rotation starts on **golf** — the round is the anchor of
  the day, and the meal after it is usually incidental to being at the club.
- Within the winning side, the largest occasion still leads. Golf plus two
  meals, rotation says dining, the bigger meal goes.

The cap is still the harder rule: a member already at their limit gets nothing,
whatever the rotation would have preferred. And a cap above one lets both
through — the rotation is about choosing when only one may go, not about
suppressing the second on principle.

Rotation state is **derived, not stored**: the most recent visit with a
`survey_sent_at` gives the last modality. A separate counter could drift from
what was actually sent.

Applied in two places, which must agree:

- `POST /api/cron/send-surveys` — the send itself.
- `GET /api/visits/queue` — the preview. Without this the queue promised a
  survey for the golf *and* the dinner, and one of them silently never arrived.
  Rotated-out visits show as `deferred`, not `blocked`: nothing is wrong with
  them, they simply lost the day's toss, and lumping them in with "cannot send"
  would make a working rule look like a fault.

## Crossover analytics

`GET /api/analytics/crossover?days=90`, rendered on the Golf screen.

**The unit is a member-day, not a visit.** Somebody who played once and ordered
twice is one golfer who dined, not two — counting visits would make the
crossover rate depend on how many times a member went to the bar.

**Guests are excluded.** Without a member number there is no way to know the
golfer and the diner were the same person, and assuming it would invent
crossover that did not happen.

**It reads visits, not survey responses.** A member who played and then ate is
a fact about the club's operation whether or not they ever answered anything.
Tying it to responses would report the crossover rate of people who fill in
forms.

What it answers:

| | |
|---|---|
| `pct_golfers_who_dined` | of the days a member played, the share they also ate |
| `pct_diners_who_golfed` | the other direction — a different question with a different answer |
| `spend_uplift` | what a golfer's meal is worth against a diner who did not play |
| `estimated_missed_spend` | the golf-only days valued at the rate the club already achieves — an estimate, and labelled as one |
| `by_day_of_week` | where the conversion falls off, usually the day the kitchen is short |
| `by_outlet` | which room actually catches golfers on the way in |
| `golfers_who_never_dine` | the actionable list: who plays regularly and never stays |

Where either side of a comparison is empty the figure is `null`, not `0` — "no
difference" and "nothing to compare" are different findings.

Dates are parsed as plain local dates. `new Date('2026-08-01')` is UTC midnight,
which lands on the previous day for any club west of Greenwich and would shift
every Saturday to a Friday.
