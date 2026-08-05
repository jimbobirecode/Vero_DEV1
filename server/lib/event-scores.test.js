const { scoreResponses, summarise, normaliseCategory } = require("./event-scores");

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`PASS  ${label.padEnd(50)} -> ${JSON.stringify(got)}`); }
  else { fail++; console.log(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
}

const r = (nps, overall, submitted = "2026-08-01T12:00:00Z") =>
  ({ q1_nps: nps, q2_overall_stars: overall, submitted_at: submitted });

console.log("\n--- NPS is the real thing, not an average score ---");
check("all promoters", scoreResponses([r(10, 5), r(9, 5)]).nps, 100);
check("all detractors", scoreResponses([r(0, 1), r(6, 2)]).nps, -100);
check("half and half", scoreResponses([r(10, 5), r(3, 2)]).nps, 0);
check("passives drag without counting against",
  scoreResponses([r(10, 5), r(8, 4), r(7, 4), r(8, 4)]).nps, 25);
check("promoter/passive/detractor split",
  (({ promoters, passives, detractors }) => ({ promoters, passives, detractors }))(
    scoreResponses([r(10, 5), r(9, 5), r(8, 4), r(6, 3), r(0, 1)])),
  { promoters: 2, passives: 1, detractors: 2 });

console.log("\n--- CSAT ---");
check("mean overall rating", scoreResponses([r(9, 5), r(9, 4)]).csat, 4.5);
check("as a percentage", scoreResponses([r(9, 5), r(9, 4)]).csat_pct, 88);
check("a perfect 5 is 100%", scoreResponses([r(9, 5)]).csat_pct, 100);
check("a straight 1 is 0%", scoreResponses([r(0, 1)]).csat_pct, 0);

console.log("\n--- unanswered surveys never count ---");
check("sent but not submitted", scoreResponses([{ q1_nps: 10, q2_overall_stars: 5, submitted_at: null }]).responses, 0);
check("and score null rather than zero",
  scoreResponses([{ q1_nps: 10, q2_overall_stars: 5, submitted_at: null }]).nps, null);
check("no rows at all", scoreResponses([]), {
  responses: 0, nps: null, nps_base: 0, promoters: 0, passives: 0, detractors: 0,
  csat: null, csat_pct: null, csat_base: 0,
});

console.log("\n--- a missing answer does not drag the other score down ---");
check("comment-only reply leaves NPS on its own base",
  scoreResponses([r(10, 5), { q1_nps: null, q2_overall_stars: 4, submitted_at: "x" }]).nps, 100);
check("but it does count toward CSAT",
  scoreResponses([r(10, 5), { q1_nps: null, q2_overall_stars: 4, submitted_at: "x" }]).csat, 4.5);
check("and responses counts the person, not the answer",
  scoreResponses([r(10, 5), { q1_nps: null, q2_overall_stars: 4, submitted_at: "x" }]).responses, 2);

console.log("\n--- golf and general are separate, and both roll up ---");
const events = [
  { event_id: "e1", name: "Club Championship", event_date: "2026-08-02", category: "golf",
    responses: [r(10, 5), r(9, 5), r(10, 4)] },
  { event_id: "e2", name: "Wine Dinner", event_date: "2026-08-01", category: "general",
    responses: [r(6, 2)] },
];
const s = summarise(events);
check("golf scored on its own", s.by_category.find(c => c.category === "golf").nps, 100);
check("general scored on its own", s.by_category.find(c => c.category === "general").nps, -100);
check("overall weights by response, not by event", s.overall.nps, 50);
check("overall response count", s.overall.responses, 4);
check("event counts per category",
  s.by_category.map(c => [c.category, c.events]), [["general", 1], ["golf", 1]]);
check("per-event rows come back newest first", s.events.map(e => e.name), ["Club Championship", "Wine Dinner"]);
check("each event carries its own score", s.events[0].nps, 100);

console.log("\n--- an unknown or missing category is treated as general ---");
check("null", normaliseCategory(null), "general");
check("something else entirely", normaliseCategory("gala"), "general");
check("golf survives", normaliseCategory("golf"), "golf");
check("an event with no category still rolls up",
  summarise([{ event_id: "e", name: "n", event_date: "d", responses: [r(10, 5)] }])
    .by_category.find(c => c.category === "general").responses, 1);

console.log("\n--- a department with no events at all ---");
check("empty", summarise([]).overall.responses, 0);
check("still reports both categories", summarise([]).by_category.map(c => c.category), ["general", "golf"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
