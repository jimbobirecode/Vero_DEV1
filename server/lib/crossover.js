// Cross-modal analytics: what members do across golf and food-and-beverage.
//
// The club records a round and a lunch as two unrelated visits. The questions
// worth asking sit between them — how many golfers stay to eat, what that is
// worth, and which day of the week loses them on the way from the eighteenth
// to the dining room.
//
// Everything here is pure and works on plain visit rows, so the definitions
// are testable and the route stays a query.
//
// The unit throughout is a MEMBER-DAY, not a visit. A member who plays once
// and eats twice is one golfer who dined, not two — counting visits would
// make the crossover rate depend on how many times somebody ordered.

const { modalityOf, GOLF, DINING } = require("./send-policy");

const spendOf = (v) => {
  const n = parseFloat(v?.spend_amount);
  return Number.isFinite(n) ? n : 0;
};

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const money = (n) => Math.round(n * 100) / 100;

// Groups visits into one record per member per day.
//
//   { member_id, date, golf, dining, spend, outlets:Set, visits:number }
//
// Guests are excluded: without a stable identity across visits there is no
// way to know whether the golfer and the diner are the same person, and
// guessing would quietly invent crossover that did not happen.
function memberDays(visits = []) {
  const byKey = new Map();

  for (const v of visits) {
    if (!v.member_id || !v.visit_date) continue;
    const key = `${v.member_id}|${v.visit_date}`;
    let d = byKey.get(key);
    if (!d) {
      d = {
        member_id: v.member_id, date: v.visit_date,
        golf: false, dining: false, spend: 0, visits: 0,
        outlets: new Set(), dining_outlets: new Set(),
      };
      byKey.set(key, d);
    }
    const modality = modalityOf(v);
    if (modality === GOLF) d.golf = true;
    else {
      d.dining = true;
      d.spend += spendOf(v);
      if (v.outlets?.name) d.dining_outlets.add(v.outlets.name);
    }
    if (v.outlets?.name) d.outlets.add(v.outlets.name);
    d.visits++;
  }

  return [...byKey.values()];
}

function segmentOf(day) {
  if (day.golf && day.dining) return "both";
  return day.golf ? "golf_only" : "dining_only";
}

const mean = (xs) => (xs.length ? money(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

// The headline: of the days somebody played, how many did they also eat?
function crossover(visits = []) {
  const days = memberDays(visits);

  const golfDays = days.filter((d) => d.golf);
  const diningDays = days.filter((d) => d.dining);
  const both = days.filter((d) => d.golf && d.dining);
  const golfOnly = days.filter((d) => d.golf && !d.dining);
  const diningOnly = days.filter((d) => d.dining && !d.golf);

  // What a golfer's meal is worth against everyone else's. This is the number
  // that turns the crossover rate into a decision — a club will chase golfers
  // into the dining room only if it knows what one is worth when it works.
  const golferSpend = both.map((d) => d.spend);
  const nonGolferSpend = diningOnly.map((d) => d.spend);
  const golferAvg = mean(golferSpend);
  const nonGolferAvg = mean(nonGolferSpend);

  return {
    member_days: days.length,
    golf_days: golfDays.length,
    dining_days: diningDays.length,

    both: both.length,
    golf_only: golfOnly.length,
    dining_only: diningOnly.length,

    // Of the days a member golfed, the share on which they also ate.
    pct_golfers_who_dined: pct(both.length, golfDays.length),
    // And the other direction, which is a different question: of the people in
    // the dining room, how many had been on the course?
    pct_diners_who_golfed: pct(both.length, diningDays.length),

    avg_spend_golfer_who_dined: golferAvg,
    avg_spend_diner_no_golf: nonGolferAvg,
    // Null rather than 0 when either side is empty — "no difference" and
    // "nothing to compare" are not the same finding.
    spend_uplift: golferAvg != null && nonGolferAvg != null
      ? money(golferAvg - nonGolferAvg) : null,
    spend_uplift_pct: golferAvg != null && nonGolferAvg && nonGolferAvg > 0
      ? Math.round(((golferAvg - nonGolferAvg) / nonGolferAvg) * 1000) / 10 : null,

    // What the golf-only days would have been worth at the crossover rate the
    // club already achieves. Explicitly an estimate, and labelled as one.
    missed_dining_days: golfOnly.length,
    estimated_missed_spend: golferAvg != null ? money(golfOnly.length * golferAvg) : null,
  };
}

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Crossover by day of the week. Clubs run different operations on a Saturday
// than a Tuesday, and the day the conversion falls off is usually the day the
// kitchen is shut or short-staffed.
function byDayOfWeek(visits = []) {
  const days = memberDays(visits);
  const buckets = DOW.map((name) => ({ day: name, golf_days: 0, both: 0 }));

  for (const d of days) {
    if (!d.golf) continue;
    // Parsed as a plain date rather than a timestamp: 'YYYY-MM-DD' through
    // new Date() is UTC midnight, which lands on the previous day for any
    // club west of Greenwich and would shift every Saturday to a Friday.
    const [y, m, dd] = String(d.date).split("-").map(Number);
    if (!y || !m || !dd) continue;
    const idx = new Date(y, m - 1, dd).getDay();
    buckets[idx].golf_days++;
    if (d.dining) buckets[idx].both++;
  }

  return buckets
    .filter((b) => b.golf_days > 0)
    .map((b) => ({ ...b, pct_dined: pct(b.both, b.golf_days) }));
}

// Which outlets actually catch golfers on their way off the course. A club
// with one crossover rate overall may have one outlet doing all the work.
function byOutlet(visits = []) {
  const days = memberDays(visits);
  const counts = new Map();

  for (const d of days) {
    if (!d.golf || !d.dining) continue;
    for (const name of d.dining_outlets) {
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }

  const total = days.filter((d) => d.golf && d.dining).length;
  return [...counts.entries()]
    .map(([outlet, golfer_days]) => ({ outlet, golfer_days, pct_of_crossover: pct(golfer_days, total) }))
    .sort((a, b) => b.golfer_days - a.golfer_days);
}

// Month by month, so a club can see whether the rate is moving.
function trend(visits = []) {
  const days = memberDays(visits);
  const buckets = new Map();

  for (const d of days) {
    if (!d.golf) continue;
    const month = String(d.date).slice(0, 7);
    if (!buckets.has(month)) buckets.set(month, { month, golf_days: 0, both: 0 });
    const b = buckets.get(month);
    b.golf_days++;
    if (d.dining) b.both++;
  }

  return [...buckets.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((b) => ({ ...b, pct_dined: pct(b.both, b.golf_days) }));
}

// The members who play often and never stay. The actionable list behind the
// headline: who to put in front of the F&B team.
function golfersWhoNeverDine(visits = [], { minRounds = 3 } = {}) {
  const days = memberDays(visits);
  const byMember = new Map();

  for (const d of days) {
    if (!d.golf) continue;
    if (!byMember.has(d.member_id)) byMember.set(d.member_id, { member_id: d.member_id, rounds: 0, dined: 0 });
    const m = byMember.get(d.member_id);
    m.rounds++;
    if (d.dining) m.dined++;
  }

  return [...byMember.values()]
    .filter((m) => m.rounds >= minRounds && m.dined === 0)
    .sort((a, b) => b.rounds - a.rounds);
}

function report(visits = [], options = {}) {
  return {
    ...crossover(visits),
    by_day_of_week: byDayOfWeek(visits),
    by_outlet: byOutlet(visits),
    trend: trend(visits),
    golfers_who_never_dine: golfersWhoNeverDine(visits, options).slice(0, 25),
  };
}

module.exports = {
  memberDays, segmentOf, crossover, byDayOfWeek, byOutlet, trend,
  golfersWhoNeverDine, report, GOLF, DINING,
};
