// The granular report breakdowns.
//
// These are the figures a club will act on — "Saturdays are the problem",
// "corporate bookings score worse than members", "the question we added in
// March is the one dragging OHI down" — so the arithmetic is worth pinning
// down rather than eyeballing on screen.

const d = require("./report-detail");

let pass = 0, fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}\n      got  ${g}\n      want ${w}`); }
}
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "\n      " + detail : ""}`); }
}

// A response, with only the fields a breakdown reads.
const r = (nps, date, extra = {}) => ({
  q1_nps: nps, q2_overall_stars: 4, q3_food_stars: 4, q4_service_stars: 4,
  q5_comment: null, submitted_at: `${date}T12:00:00Z`,
  visits: { visit_date: date, visitor_type: "member", outlets: { name: "Grill" }, ...(extra.visits || {}) },
  ...extra,
});

console.log("--- NPS as its three parts ---");
{
  // 4 promoters, 2 passives, 4 detractors → (40 - 40) = 0, from ten responses.
  const rows = [10, 10, 9, 9, 8, 7, 6, 3, 0, 5].map((n) => r(n, "2026-07-01"));
  const b = d.npsBreakdown(rows);
  eq("promoters are 9 and 10", b.promoters, 4);
  eq("passives are 7 and 8", b.passives, 2);
  eq("detractors are 0 through 6", b.detractors, 4);
  eq("the net score is promoters minus detractors, as a percentage", b.nps, 0);
  eq("percentages are reported too", [b.promoter_pct, b.passive_pct, b.detractor_pct], [40, 20, 40]);
}
{
  // The composition the net score hides: +20 twice, from different clubs.
  const calm = d.npsBreakdown([...Array(6)].map(() => r(9, "2026-07-01"))
    .concat([...Array(4)].map(() => r(3, "2026-07-01"))));
  const split = d.npsBreakdown([...Array(4)].map(() => r(9, "2026-07-01"))
    .concat([...Array(2)].map(() => r(3, "2026-07-01")))
    .concat([...Array(4)].map(() => r(8, "2026-07-01"))));
  eq("both net to the same score", [calm.nps, split.nps], [20, 20]);
  check("but the split is visible", calm.detractors !== split.detractors,
    `${calm.detractors} vs ${split.detractors}`);
}
eq("no NPS answers at all", d.npsBreakdown([r(null, "2026-07-01")]).nps, null);

console.log("\n--- time buckets ---");
eq("a day is itself", d.bucketKey("2026-08-07", "day"), "2026-08-07");
eq("a month is the month", d.bucketKey("2026-08-07", "month"), "2026-08");
// 2026-08-07 is a Friday; its week starts Monday the 3rd.
eq("a week starts on the Monday", d.bucketKey("2026-08-07", "week"), "2026-08-03");
eq("Monday belongs to its own week", d.bucketKey("2026-08-03", "week"), "2026-08-03");
eq("Sunday belongs to the week that began six days earlier",
  d.bucketKey("2026-08-09", "week"), "2026-08-03");
eq("a nonsense date buckets to nothing", d.bucketKey("not-a-date", "day"), null);
{
  const rows = [r(10, "2026-08-03"), r(0, "2026-08-05"), r(10, "2026-08-11")];
  const weeks = d.byPeriod(rows, "week");
  eq("two weeks", weeks.map((w) => w.key), ["2026-08-03", "2026-08-10"]);
  eq("the first holds two responses", weeks[0].responses, 2);
  eq("and nets to zero", weeks[0].nps, 0);
  eq("weeks are labelled as weeks", weeks[0].label, "w/c Aug 3");
  const days = d.byPeriod(rows, "day");
  eq("by day there are three", days.length, 3);
  eq("and they are in order", days.map((x) => x.key), ["2026-08-03", "2026-08-05", "2026-08-11"]);
  eq("an unknown granularity falls back to weeks", d.byPeriod(rows, "fortnight").length, 2);
}
{
  // Whether a bucket lands right must not depend on where the server is.
  const saved = process.env.TZ;
  process.env.TZ = "Pacific/Kiritimati";   // UTC+14
  const far = d.bucketKey("2026-08-07", "week");
  process.env.TZ = "Pacific/Midway";       // UTC-11
  const near = d.bucketKey("2026-08-07", "week");
  process.env.TZ = saved;
  eq("the week is the same either side of the date line", [far, near], ["2026-08-03", "2026-08-03"]);
}

console.log("\n--- each outlet's own trend ---");
{
  const rows = [
    r(10, "2026-08-03"), r(0, "2026-08-04", { visits: { visit_date: "2026-08-04", outlets: { name: "Poolside" } } }),
    r(9, "2026-08-11"),
  ];
  const trends = d.byOutletPeriod(rows, "week");
  eq("one entry per outlet, alphabetical", trends.map((t) => t.outlet), ["Grill", "Poolside"]);
  eq("the Grill spans two weeks", trends[0].periods.length, 2);
  eq("Poolside only one", trends[1].periods.length, 1);
}

console.log("\n--- segments ---");
{
  const rows = [
    r(10, "2026-08-03"),                                                   // Monday, member
    r(2, "2026-08-08", { visits: { visit_date: "2026-08-08", visitor_type: "commercial" } }), // Saturday
    r(2, "2026-08-08", { visits: { visit_date: "2026-08-08", visitor_type: "commercial" } }),
  ];
  const s = d.bySegment(rows);
  eq("visitor types are labelled for a reader", s.visitor_type.map((x) => x.label), ["Corporate", "Members"]);
  eq("and the larger group comes first", s.visitor_type[0].responses, 2);
  eq("corporate nets badly", s.visitor_type[0].nps, -100);
  eq("weekdays are named", s.weekday.map((x) => x.label), ["Monday", "Saturday"]);
  check("and run Monday first", s.weekday[0].label === "Monday");
}
{
  // The honest part: no time on the visit means no lunch/dinner split.
  const s = d.bySegment([r(9, "2026-08-03")]);
  eq("no daypart when the visit carries no time", s.daypart, []);
  eq("and that is stated rather than left ambiguous", s.daypart_available, false);
}
{
  const withTime = (t, nps) => r(nps, "2026-08-03", { visits: { visit_date: "2026-08-03", visit_time: t } });
  const s = d.bySegment([withTime("09:15:00", 10), withTime("12:30:00", 8), withTime("19:45:00", 2)]);
  eq("a time splits the day", s.daypart.map((x) => x.label), ["Breakfast", "Lunch", "Dinner"]);
  eq("and it is available", s.daypart_available, true);
  eq("dinner is the bad one", s.daypart[2].nps, -100);
}
eq("11:00 is lunch", d.daypart({ visits: { visit_time: "11:00" } }), "Lunch");
eq("16:00 is dinner", d.daypart({ visits: { visit_time: "16:00" } }), "Dinner");
eq("a missing time is null, not a guess", d.daypart({ visits: {} }), null);

console.log("\n--- question by question ---");
{
  const template = {
    template_id: "t1", name: "Food & Beverage", survey_type: "food_bev",
    questions: [
      { key: "q1", title: "How likely are you to recommend us?", type: "nps", index: "CHI" },
      { key: "q2", title: "Overall", type: "stars", index: "SSI" },
      { key: "q6", title: "Was the music too loud?", type: "stars", index: null },
      { key: "q5", title: "Anything else?", type: "text", required: false },
    ],
  };
  const rows = [
    { template_id: "t1", q1_nps: 10, q2_overall_stars: 5, q5_comment: "Great night",
      answers: { q1: 10, q2: 5, q6: 2, q5: "Great night" }, visits: { visit_date: "2026-08-03" } },
    { template_id: "t1", q1_nps: 8, q2_overall_stars: 4, q5_comment: null,
      answers: { q1: 8, q2: 4, q6: 1 }, visits: { visit_date: "2026-08-04" } },
  ];
  const out = d.byQuestion(rows, [template]);
  eq("one entry for the template that was answered", out.length, 1);
  eq("carrying every question, not just the scored four", out[0].questions.length, 4);

  const music = out[0].questions.find((q) => q.key === "q6");
  check("including the question the club added itself", Boolean(music));
  eq("with its average", music.average, 1.5);
  eq("and no index, because it is untagged", music.index, null);
  eq("normalised onto the same 0-100 scale as the indices", music.normalised, 30);

  const nps = out[0].questions.find((q) => q.key === "q1");
  eq("an NPS question is scaled against 10, not 5", nps.normalised, 90);
  eq("and its distribution spans 0-10", nps.distribution.length, 11);
  eq("a stars distribution spans 1-5", music.distribution.length, 5);

  const text = out[0].questions.find((q) => q.key === "q5");
  eq("free text reports how many answered", text.answered, 1);
  eq("and how long the answers ran", text.average_length, "Great night".length);
  check("but never averages the words", text.average === undefined);
}
{
  // A database written before the answers column still reports.
  const template = { template_id: "t1", name: "F&B", survey_type: "food_bev",
    questions: [{ key: "q1_nps", title: "NPS", type: "nps", index: "CHI" }] };
  const out = d.byQuestion([{ template_id: "t1", q1_nps: 9, answers: null, visits: {} }], [template]);
  eq("falls back to the dedicated columns", out[0].questions[0].average, 9);
}
eq("a template nobody answered is left out",
  d.byQuestion([], [{ template_id: "t9", name: "Unused", questions: [] }]).length, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
