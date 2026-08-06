const C = require("./crossover.js");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const golf = (member, date) => ({
  member_id: member, visit_date: date, visitor_type: "golf",
  spend_amount: 0, outlets: { name: "Golf" },
});
const dine = (member, date, spend, outlet = "Grill Room") => ({
  member_id: member, visit_date: date, visitor_type: "member",
  spend_amount: spend, outlets: { name: outlet },
});

// ---------------------------------------------------------- the member-day --

// The unit is a member-day, not a visit. Counting visits would make the
// crossover rate depend on how many times somebody ordered.
const twice = [golf("M1", "2026-08-01"), dine("M1", "2026-08-01", 40), dine("M1", "2026-08-01", 60)];
check("three visits collapse to one member-day", C.memberDays(twice).length, 1);
check("and the spend is the day's total", C.memberDays(twice)[0].spend, 100);
check("the day counts once as a golfer who dined", C.crossover(twice).both, 1);
check("not twice", C.crossover(twice).pct_golfers_who_dined, 100);

// A guest has no identity across visits, so the golfer and the diner cannot
// be shown to be the same person. Counting them would invent crossover.
const guests = [
  { member_id: null, visit_date: "2026-08-01", visitor_type: "golf", spend_amount: 0 },
  { member_id: null, visit_date: "2026-08-01", visitor_type: "other", spend_amount: 80 },
];
check("guests are left out entirely", C.memberDays(guests).length, 0);

check("segments are named", [
  C.segmentOf({ golf: true, dining: true }),
  C.segmentOf({ golf: true, dining: false }),
  C.segmentOf({ golf: false, dining: true }),
], ["both", "golf_only", "dining_only"]);

// ------------------------------------------------------------- the headline --

const FIXTURE = [
  // Four golfers on the 1st: two stay to eat, two do not.
  golf("M1", "2026-08-01"), dine("M1", "2026-08-01", 120),
  golf("M2", "2026-08-01"), dine("M2", "2026-08-01", 80),
  golf("M3", "2026-08-01"),
  golf("M4", "2026-08-01"),
  // Two who only ate.
  dine("M5", "2026-08-01", 60),
  dine("M6", "2026-08-01", 40),
];

const x = C.crossover(FIXTURE);
check("member-days counted", x.member_days, 6);
check("golf days", x.golf_days, 4);
check("dining days", x.dining_days, 4);
check("both", x.both, 2);
check("golf only", x.golf_only, 2);
check("dining only", x.dining_only, 2);
check("half the golfers dined", x.pct_golfers_who_dined, 50);
// The other direction is a different question with a different answer.
check("and half the diners had golfed", x.pct_diners_who_golfed, 50);

// The number that turns the rate into a decision.
check("a golfer's meal averages more", x.avg_spend_golfer_who_dined, 100);
check("than a diner who did not play", x.avg_spend_diner_no_golf, 50);
check("the uplift", x.spend_uplift, 50);
check("as a percentage", x.spend_uplift_pct, 100);

check("the golf-only days are the opportunity", x.missed_dining_days, 2);
check("valued at the rate the club already achieves", x.estimated_missed_spend, 200);

// Nothing to compare against must not read as no difference.
const noDiners = C.crossover([golf("M1", "2026-08-01"), dine("M1", "2026-08-01", 90)]);
check("with no golf-free diners there is no uplift figure", noDiners.spend_uplift, null);
check("rather than a misleading zero", noDiners.avg_spend_diner_no_golf, null);

check("an empty period divides by nothing", C.crossover([]).pct_golfers_who_dined, null);
check("and reports no days", C.crossover([]).member_days, 0);

// A club with no golf at all still reports cleanly.
const diningOnlyClub = C.crossover([dine("M1", "2026-08-01", 50), dine("M2", "2026-08-01", 70)]);
check("no golf means no crossover rate", diningOnlyClub.pct_golfers_who_dined, null);
check("but the dining days are still counted", diningOnlyClub.dining_days, 2);

// ---------------------------------------------------------- day of the week --

// 2026-08-01 is a Saturday. Parsed as a UTC timestamp it lands on the Friday
// for any club west of Greenwich, which would shift every weekend by a day.
const dow = C.byDayOfWeek(FIXTURE);
check("the day of the week is the local one", dow[0].day, "Saturday");
check("with the golf days on it", dow[0].golf_days, 4);
check("and the share who stayed", dow[0].pct_dined, 50);
check("days with no golf are left out", dow.length, 1);

// --------------------------------------------------------------- by outlet --

const outlets = C.byOutlet([
  golf("M1", "2026-08-01"), dine("M1", "2026-08-01", 100, "Halfway House"),
  golf("M2", "2026-08-01"), dine("M2", "2026-08-01", 90, "Halfway House"),
  golf("M3", "2026-08-01"), dine("M3", "2026-08-01", 70, "Grill Room"),
]);
check("the outlet catching most golfers leads", outlets[0].outlet, "Halfway House");
check("with its count", outlets[0].golfer_days, 2);
check("and its share of the crossover", outlets[0].pct_of_crossover, 66.7);

// A golfer who ate in two rooms counts for both, but is still one crossover
// day — the shares are of member-days, so they can exceed 100 together.
const twoRooms = C.byOutlet([
  golf("M1", "2026-08-01"),
  dine("M1", "2026-08-01", 40, "Halfway House"),
  dine("M1", "2026-08-01", 80, "Grill Room"),
]);
check("both rooms are credited", twoRooms.length, 2);
check("each against the one crossover day", twoRooms[0].pct_of_crossover, 100);

// ----------------------------------------------------------------- trend ----

const months = C.trend([
  golf("M1", "2026-06-10"), dine("M1", "2026-06-10", 50),
  golf("M2", "2026-06-11"),
  golf("M3", "2026-07-10"), dine("M3", "2026-07-10", 50),
  golf("M4", "2026-07-11"), dine("M4", "2026-07-11", 50),
]);
check("months are in order", months.map((m) => m.month), ["2026-06", "2026-07"]);
check("and the rate moved", months.map((m) => m.pct_dined), [50, 100]);

// ------------------------------------------------- who to actually talk to --

const never = C.golfersWhoNeverDine([
  golf("M1", "2026-08-01"), golf("M1", "2026-08-08"), golf("M1", "2026-08-15"),
  golf("M2", "2026-08-01"), golf("M2", "2026-08-08"),
  golf("M3", "2026-08-01"), golf("M3", "2026-08-08"), golf("M3", "2026-08-15"),
  dine("M3", "2026-08-15", 60),
], { minRounds: 3 });
check("only members who never once stayed", never.map((m) => m.member_id), ["M1"]);
check("with their round count", never[0].rounds, 3);
// M2 played twice — below the threshold, so not yet a pattern worth acting on.
check("a lower threshold widens it",
  C.golfersWhoNeverDine([golf("M2", "2026-08-01"), golf("M2", "2026-08-08")], { minRounds: 2 })
    .map((m) => m.member_id), ["M2"]);

// ----------------------------------------------------------------- report ---

const full = C.report(FIXTURE);
check("the report carries the headline", full.pct_golfers_who_dined, 50);
check("and the breakdowns", [
  Array.isArray(full.by_day_of_week), Array.isArray(full.by_outlet),
  Array.isArray(full.trend), Array.isArray(full.golfers_who_never_dine),
], [true, true, true, true]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
