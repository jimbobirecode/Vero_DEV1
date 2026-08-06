const H = require("./member-health.js");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const DAY = 86400000;
const NOW = new Date(2026, 7, 1).getTime();   // 1 Aug 2026, local
const ago = (days) => {
  const d = new Date(NOW - days * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// n visits for a member, evenly spread between `from` and `to` days ago.
const visits = (member, n, from, to, spend = 80) => {
  const out = [];
  if (n <= 0) return out;
  const step = n === 1 ? 0 : (from - to) / (n - 1);
  for (let i = 0; i < n; i++) {
    out.push({ member_id: member, visit_date: ago(Math.round(from - step * i)), spend_amount: spend });
  }
  return out;
};

const opts = { now: NOW };

// A cohort holding steady, so the club has a season to be measured against.
// Without it the panel is whoever is in the fixture, and two declining members
// ARE the club declining — which the leave-one-out adjustment correctly reads
// as normal. Real clubs have a middle; the fixtures need one too.
const steadyCohort = (prefix, n = 6) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(...visits(`${prefix}${i}`, 12, 360, 95), ...visits(`${prefix}${i}`, 4, 85, 5));
  }
  return out;
};
const find = (r, id) => r.members.find((m) => m.member_id === id) || r.not_scored.find((m) => m.member_id === id);

// ------------------------------------------------------- their own baseline --
//
// The whole point: a rule like "hasn't visited in 30 days" flags the member
// who always came monthly and misses the one who came weekly and stopped.

const regular = [
  ...steadyCohort("MID"),
  ...visits("HEAVY", 36, 360, 95),   // ~4 a month for nine months
  ...visits("HEAVY", 3, 85, 5),      // then almost nothing
  ...visits("LIGHT", 9, 360, 95),    // ~1 a month, steady
  ...visits("LIGHT", 3, 85, 5),      // ...and still ~1 a month
];
const r1 = H.memberHealth(regular, opts);

check("the heavy member who collapsed is flagged", find(r1, "HEAVY").band, "at_risk");
// LIGHT came only three times in three months and is entirely fine.
check("the light member who kept their rhythm is not", find(r1, "LIGHT").band, "steady");
check("and a blunt recency rule would have said the opposite",
  find(r1, "LIGHT").days_since_last_visit <= 30, true);

// --------------------------------------------------------------- seasonal ---
//
// A golf club in January is not a golf club in July. Without adjustment every
// member is "at risk" every winter, the list is ignored by February, and the
// feature is dead.

// Every member halves. That is the season, not eight resignations.
const wholeClubHalves = [];
for (const m of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
  wholeClubHalves.push(...visits(m, 24, 360, 95), ...visits(m, 3, 85, 5));
}
const seasonal = H.memberHealth(wholeClubHalves, opts);

check("the club-wide drop is measured", seasonal.club.seasonal_ratio < 0.7, true);
check("and nobody is flagged for moving with it", seasonal.summary.at_risk + seasonal.summary.lapsed, 0);
check("they read as steady", find(seasonal, "A").band, "steady");

// Same club, but one member drops far harder than the season explains.
const oneRealDrop = [...wholeClubHalves, ...visits("SINKING", 24, 360, 95)];
const withDrop = H.memberHealth(oneRealDrop, opts);
check("a member who stopped entirely still stands out", find(withDrop, "SINKING").band, "lapsed");
check("and only them", withDrop.summary.lapsed + withDrop.summary.at_risk, 1);

// Turning the adjustment off is what the naive version would have done.
const unadjusted = H.memberHealth(wholeClubHalves, { ...opts, seasonalAdjust: false });
check("without seasonal adjustment the whole club is flagged",
  unadjusted.summary.at_risk, 8);
check("which is the trap this exists to avoid",
  unadjusted.club.seasonal_adjusted, false);

// A member's own collapse must not excuse itself. With them left in the
// average, a big enough drop drags the club figure down far enough to make the
// drop look normal — and the more members resign at once, the harder the list
// finds it to see them.
const selfDamping = [
  ...steadyCohort("SD", 3),
  ...visits("COLLAPSE", 120, 360, 95),   // enormous baseline, dominates the club
  ...visits("COLLAPSE", 4, 85, 5),
];
const sd = H.memberHealth(selfDamping, opts);
check("a member who dominates the club is still judged against the rest",
  find(sd, "COLLAPSE").band, "at_risk");
check("and the basis is stated", sd.club.seasonal_basis, "leave-one-out");
check("with the panel size behind it", sd.club.panel_size, 4);

// ------------------------------------------------------- not enough history --

const thin = [
  ...visits("NEWJOINER", 4, 40, 3),          // only ever been here recently
  ...visits("RARE", 2, 300, 200),            // twice, ages ago
  ...visits("RARE", 0, 0, 0),
];
const r3 = H.memberHealth(thin, opts);
check("a member who only just joined is not scored for decline", find(r3, "NEWJOINER").band, "new");
check("a member with no rhythm to read is set aside", find(r3, "RARE").band, "infrequent");
check("neither lands in the scored list", r3.members.length, 0);
// A club of mostly new members should see that it cannot yet be told, rather
// than a page of reassuring green.
check("and the response says how many could not be scored", r3.club.unscored_members, 2);

// --------------------------------------------------------------- lapsed -----

const gone = [...visits("GONE", 20, 360, 100)];   // nothing at all since
const r4 = H.memberHealth([...gone, ...wholeClubHalves], opts);
check("no visits at all in the window is lapsed, not at risk", find(r4, "GONE").band, "lapsed");
check("with the days since counted", find(r4, "GONE").days_since_last_visit >= 90, true);

// -------------------------------------------------------------- the money ---

// Two members declining identically; one is worth twenty times the other.
const valued = [
  ...steadyCohort("VMID"),
  ...visits("BIG", 24, 360, 95, 400), ...visits("BIG", 2, 80, 10, 400),
  ...visits("SMALL", 24, 360, 95, 20), ...visits("SMALL", 2, 80, 10, 20),
];
const r5 = H.memberHealth(valued, opts);
check("the list is ordered by money, not by percentage",
  r5.members[0].member_id, "BIG");
check("both are declining by the same proportion",
  find(r5, "BIG").shortfall_pct === find(r5, "SMALL").shortfall_pct, true);
check("but the value at risk is not the same",
  find(r5, "BIG").value_at_risk > find(r5, "SMALL").value_at_risk * 10, true);
check("and the club total is the sum of the ones actually going",
  r5.summary.value_at_risk > 0, true);

// A member who is coming MORE is not carrying value at risk.
const growingSet = [
  ...visits("UP", 6, 360, 95), ...visits("UP", 12, 85, 2),
  ...visits("FLAT1", 12, 360, 95), ...visits("FLAT1", 3, 85, 5),
  ...visits("FLAT2", 12, 360, 95), ...visits("FLAT2", 3, 85, 5),
  ...visits("FLAT3", 12, 360, 95), ...visits("FLAT3", 3, 85, 5),
];
const r6 = H.memberHealth(growingSet, opts);
check("a member coming more often reads as growing", find(r6, "UP").band, "growing");
check("and carries no value at risk", find(r6, "UP").value_at_risk, 0);

// ------------------------------------------------------------ member-days ---

// Golf then lunch is one occasion. Counting it twice would make their rhythm
// look busier, and then make them look like they collapsed when they stop
// doing both.
const sameDay = [
  { member_id: "M", visit_date: ago(200), spend_amount: 0 },
  { member_id: "M", visit_date: ago(200), spend_amount: 90 },
];
check("two visits on one day are one occasion",
  H.memberWindows(sameDay, { now: NOW, recentDays: 90, baselineDays: 365 })[0].baseline_days, 1);
check("but both cheques are counted",
  H.memberWindows(sameDay, { now: NOW, recentDays: 90, baselineDays: 365 })[0].baseline_spend, 90);

// ---------------------------------------------------------------- hygiene ---

check("guests are ignored", H.memberHealth([
  { member_id: null, visit_date: ago(10), spend_amount: 90 },
], opts).club.scored_members + H.memberHealth([
  { member_id: null, visit_date: ago(10), spend_amount: 90 },
], opts).club.unscored_members, 0);

check("an empty club does not divide by zero", H.memberHealth([], opts).summary.at_risk, 0);
check("and reports a flat season rather than NaN", H.memberHealth([], opts).club.seasonal_ratio, 1);
check("saying it could not adjust", H.memberHealth([], opts).club.seasonal_adjusted, false);

check("a bad date is skipped, not crashed on",
  H.memberHealth([{ member_id: "X", visit_date: "not a date", spend_amount: 10 }], opts).club.unscored_members, 0);
// Anything older than the baseline window is outside the question being asked.
check("visits older than the baseline window are excluded",
  H.memberHealth([{ member_id: "X", visit_date: ago(900), spend_amount: 10 }], opts).club.unscored_members, 0);

// ------------------------------------------------------------- call list ----

const list = H.callList(r5, { limit: 1 });
check("the call list is capped so it can actually be worked", list.length, 1);
check("and starts with the most valuable", list[0].member_id, "BIG");
check("it only carries the ones worth a call",
  H.callList(r6, { limit: 10 }).length, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
