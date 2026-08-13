// The response rate, and the ways it can lie.
//
// A rate is a fraction, and every argument about one is an argument about what
// went in the denominator. These pin that down: which period a survey belongs
// to, what counts as an answer, and what the number does when there is nothing
// to divide.

const R = require("./response-rate");

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

// One survey. Sent on `sent`, answered on `at` (or never).
const s = (sent, at = null, extra = {}) => ({
  response_id: Math.random().toString(36).slice(2),
  created_at: `${sent}T09:00:00Z`,
  submitted_at: at,
  template_id: "t1",
  visits: { visit_date: sent, visitor_type: "member", outlets: { name: "Grill" } },
  ...extra,
});

console.log("--- the fraction ---");
eq("half of them came back", R.rate(6, 12), 50);
eq("a rate is given to one decimal place", R.rate(412, 900), 45.8);
eq("nothing sent is no rate, not nought per cent", R.rate(0, 0), null);
eq("and nothing sent with something answered is still no rate", R.rate(3, 0), null);
eq("everybody answering is a hundred", R.rate(9, 9), 100);

console.log("\n--- what counts as an answer ---");
{
  // A member who answered two questions and closed the tab told us something.
  const partial = s("2026-08-03", "2026-08-03T10:00:00Z", { is_complete: false });
  eq("a part-finished survey counts as answered", R.overall([partial]).responded, 1);
  eq("a survey never opened does not", R.overall([s("2026-08-03")]).responded, 0);
}

console.log("\n--- which period a survey belongs to ---");
{
  // The rule the whole file rests on: a survey sent on the Friday and answered
  // on the Monday is a success, not a miss, even though the answer landed after
  // the report closed. Counting by when the answer arrived would punish the end
  // of every period and make a club that sent more in the last week read as
  // though its rate fell.
  const fridayCohort = [
    s("2026-08-28", "2026-09-01T11:00:00Z"),   // answered after the month ended
    s("2026-08-28", "2026-08-28T18:00:00Z"),
    s("2026-08-28"),
  ];
  eq("a late answer still counts for the period it was sent in",
    R.overall(fridayCohort), { sent: 3, responded: 2, rate: 66.7 });
}

console.log("\n--- by outlet ---");
{
  const rows = [
    s("2026-08-03", "2026-08-03T12:00:00Z"),
    s("2026-08-04"),
    s("2026-08-05", "2026-08-05T12:00:00Z", { visits: { visit_date: "2026-08-05", outlets: { name: "Poolside" } } }),
    s("2026-08-06", null, { visits: { visit_date: "2026-08-06", outlets: { name: "Poolside" } } }),
    s("2026-08-07", null, { visits: { visit_date: "2026-08-07", outlets: { name: "Poolside" } } }),
  ];
  const out = R.byOutlet(rows);
  eq("the busiest room comes first", out.map((o) => o.label), ["Poolside", "Grill"]);
  eq("Poolside sent three and got one", [out[0].sent, out[0].responded, out[0].rate], [3, 1, 33.3]);
  eq("the Grill managed half", out[1].rate, 50);

  // A club-wide 40% made of one room at 80% and another at 15% is two
  // different problems, and the point of the split is that they are visible.
  check("the club figure sits between them",
    R.overall(rows).rate > out[0].rate && R.overall(rows).rate < out[1].rate,
    `${R.overall(rows).rate} vs ${out[0].rate}/${out[1].rate}`);
}
eq("a survey with no outlet behind it is left out rather than misfiled",
  R.byOutlet([s("2026-08-03", null, { visits: null })]), []);

console.log("\n--- by period ---");
{
  const rows = [
    s("2026-08-03", "2026-08-03T12:00:00Z"), s("2026-08-05"),
    s("2026-08-11", "2026-08-11T12:00:00Z"), s("2026-08-12", "2026-08-12T12:00:00Z"),
  ];
  const weeks = R.byPeriod(rows, "week");
  eq("two weeks, oldest first", weeks.map((w) => w.key), ["2026-08-03", "2026-08-10"]);
  eq("the first week was half", weeks[0].rate, 50);
  eq("the second was everybody", weeks[1].rate, 100);
  eq("weeks are labelled as weeks", weeks[0].label, "w/c Aug 3");
  eq("by day it is four rows", R.byPeriod(rows, "day").length, 4);
  eq("and by month, one", R.byPeriod(rows, "month").length, 1);
  eq("a nonsense granularity falls back to weeks", R.byPeriod(rows, "fortnight").length, 2);
}

console.log("\n--- by survey ---");
{
  const rows = [
    s("2026-08-03", "2026-08-03T12:00:00Z"),
    s("2026-08-04", null, { template_id: "t2" }),
    s("2026-08-05", null, { template_id: "t2" }),
    s("2026-08-06", "2026-08-06T12:00:00Z", { template_id: "gone" }),
  ];
  const out = R.byTemplate(rows, [{ template_id: "t1", name: "Food & Beverage" }, { template_id: "t2", name: "Golf" }]);
  eq("each survey is named", out.map((t) => t.label).sort(), ["Deleted template", "Food & Beverage", "Golf"]);
  const golf = out.find((t) => t.label === "Golf");
  eq("golf asked twice and heard nothing", [golf.sent, golf.responded, golf.rate], [2, 0, 0]);
  // A deleted template must not take its sends out of the total with it.
  eq("every send is still accounted for", out.reduce((n, t) => n + t.sent, 0), 4);
}

console.log("\n--- who answers ---");
{
  const rows = [
    s("2026-08-03", "2026-08-03T12:00:00Z"),
    s("2026-08-04", null, { visits: { visit_date: "2026-08-04", visitor_type: "commercial", outlets: { name: "Grill" } } }),
    s("2026-08-05", null, { visits: { visit_date: "2026-08-05", visitor_type: "commercial", outlets: { name: "Grill" } } }),
  ];
  const out = R.byVisitorType(rows);
  eq("visitor types read as words", out.map((v) => v.label), ["Corporate", "Members"]);
  eq("corporate never answers", out[0].rate, 0);
  eq("members always do", out[1].rate, 100);
}

console.log("\n--- how long they take ---");
{
  const rows = [
    s("2026-08-03", "2026-08-03T11:00:00Z"),   // 2 hours
    s("2026-08-03", "2026-08-03T15:00:00Z"),   // 6 hours
    s("2026-08-03", "2026-08-05T09:00:00Z"),   // 48 hours
    s("2026-08-03"),                            // never
  ];
  const sp = R.speed(rows);
  eq("only the answers are timed", sp.answers, 3);
  eq("the middle one is the median", sp.median_hours, 6);
  eq("two of three came the same day", sp.same_day_pct, 66.7);
  eq("all three within two days", sp.within_48h_pct, 100);
}
{
  // One member answering three weeks later must not become the typical case.
  const rows = [s("2026-08-03", "2026-08-03T10:00:00Z"), s("2026-08-03", "2026-08-03T11:00:00Z"),
                s("2026-08-03", "2026-08-24T09:00:00Z")];
  eq("a straggler does not drag the median", R.speed(rows).median_hours, 2);
}
eq("nothing answered yet has no timing",
  R.speed([s("2026-08-03")]), { answers: 0, median_hours: null, same_day_pct: null, within_48h_pct: null });
{
  // Clocks disagreeing is not somebody answering before they were asked.
  const backwards = { created_at: "2026-08-03T12:00:00Z", submitted_at: "2026-08-03T11:00:00Z" };
  eq("a negative gap is dropped, not counted as instant", R.speed([backwards]).answers, 0);
}

console.log("\n--- what has not had time to answer ---");
{
  const NOW = Date.parse("2026-08-20T12:00:00Z");
  const rows = [
    s("2026-08-01", "2026-08-01T12:00:00Z"), s("2026-08-02", "2026-08-02T12:00:00Z"),
    s("2026-08-03"), s("2026-08-04", "2026-08-04T12:00:00Z"),
    // Sent this morning: no answer yet means nothing yet.
    { created_at: "2026-08-20T09:00:00Z", submitted_at: null },
    { created_at: "2026-08-20T10:00:00Z", submitted_at: null },
  ];
  const st = R.settling(rows, { now: NOW, medianHours: 3 });
  eq("today's sends are counted as still settling", st.sent, 2);
  eq("none of them has answered yet", st.responded, 0);
  eq("the window is at least a day even for a fast club", st.hours, 24);
  // 3 of 4 older ones answered.
  eq("the settled rate excludes them", st.settled_rate, 75);
  check("which is better than the headline, and honestly so",
    R.overall(rows).rate < st.settled_rate, `${R.overall(rows).rate} vs ${st.settled_rate}`);

  const slow = R.settling(rows, { now: NOW, medianHours: 30 });
  eq("a slower club gets a longer window", slow.hours, 48);
}
eq("no sends at all settles to nothing", R.settling([]), { sent: 0, responded: 0, hours: 0 });

console.log("\n--- the whole thing ---");
{
  const rows = [s("2026-08-03", "2026-08-03T12:00:00Z"), s("2026-08-04")];
  const b = R.build(rows, { templates: [{ template_id: "t1", name: "F&B" }], granularity: "week",
                            now: Date.parse("2026-08-20T00:00:00Z") });
  eq("it carries the total", [b.sent, b.responded, b.rate], [2, 1, 50]);
  eq("and how many never came back", b.unanswered, 1);
  check("with every cut present",
    Array.isArray(b.by_outlet) && Array.isArray(b.by_period) &&
    Array.isArray(b.by_template) && Array.isArray(b.by_visitor_type) &&
    b.speed && b.settling, JSON.stringify(Object.keys(b)));
}
{
  const b = R.build([]);
  eq("a club that has sent nothing gets no rate rather than a zero", b.rate, null);
  eq("and empty tables rather than an exception", [b.by_outlet, b.by_period], [[], []]);
}
eq("rubbish in place of rows does not throw", R.build(null).sent, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
