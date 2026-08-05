const { mapAnswersToColumns, missingRequired } = require("./response-mapping.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const q = (key, type, required = true, title = key) => ({ key, title, type, required });

const STANDARD = [q("q1","nps"), q("q2","stars"), q("q3","stars"), q("q4","stars", false), q("q5","text", false)];

eq("standard template maps in order",
  mapAnswersToColumns(STANDARD, { q1: 9, q2: 5, q3: 4, q4: 5, q5: "Great" }),
  { q1_nps: 9, q2_overall_stars: 5, q3_food_stars: 4, q4_service_stars: 5, q5_comment: "Great" });

// THE REPORTED BUG: an NPS question keyed q4. Answering 8 previously wrote 8
// into q4_service_stars, whose constraint is 1-5, and the submission failed.
const NPS_LAST = [q("q2","stars"), q("q3","stars"), q("q5","text", false), q("q4","nps")];
const r = mapAnswersToColumns(NPS_LAST, { q2: 5, q3: 4, q4: 8, q5: "fine" });
eq("NPS keyed q4 goes to the NPS column, not stars",
  { nps: r.q1_nps, q4: r.q4_service_stars }, { nps: 8, q4: null });
eq("...and its stars still land correctly",
  { a: r.q2_overall_stars, b: r.q3_food_stars }, { a: 5, b: 4 });

// out-of-range values are dropped, never allowed to break the whole submission
eq("NPS 0 is valid", mapAnswersToColumns(STANDARD, { q1: 0, q2: 3, q3: 3 }).q1_nps, 0);
eq("NPS 10 is valid", mapAnswersToColumns(STANDARD, { q1: 10, q2: 3, q3: 3 }).q1_nps, 10);
eq("NPS 11 is dropped", mapAnswersToColumns(STANDARD, { q1: 11, q2: 3, q3: 3 }).q1_nps, null);
eq("star 0 is dropped", mapAnswersToColumns(STANDARD, { q1: 5, q2: 0, q3: 3 }).q2_overall_stars, null);
eq("star 6 is dropped", mapAnswersToColumns(STANDARD, { q1: 5, q2: 6, q3: 3 }).q2_overall_stars, null);
eq("non-numeric is dropped", mapAnswersToColumns(STANDARD, { q1: "x", q2: 3, q3: 3 }).q1_nps, null);

// skipped optional question
eq("skipped question stays null",
  mapAnswersToColumns(STANDARD, { q1: 8, q2: 4, q3: 4, q4: null }).q4_service_stars, null);

// a club adds a fifth rated question: no column left, but it must not break
const EXTRA = [...STANDARD, q("q6","stars", false)];
const e = mapAnswersToColumns(EXTRA, { q1: 9, q2: 5, q3: 5, q4: 5, q6: 2 });
eq("a fourth stars question overflows harmlessly",
  { q2: e.q2_overall_stars, q3: e.q3_food_stars, q4: e.q4_service_stars }, { q2: 5, q3: 5, q4: 5 });

// golf: same columns, different meanings — order is what matters
const GOLF = [q("q1","nps"), q("q2","stars"), q("q3","stars"), q("q4","stars", false), q("q5","text", false)];
eq("golf maps course/pace/proshop into the three star columns",
  mapAnswersToColumns(GOLF, { q1: 2, q2: 5, q3: 5, q4: 5, q5: "bag drop" }),
  { q1_nps: 2, q2_overall_stars: 5, q3_food_stars: 5, q4_service_stars: 5, q5_comment: "bag drop" });

// no template at all — historical responses
eq("no template falls back to keys",
  mapAnswersToColumns(null, { q1: 7, q2: 4, q3: 4, q4: 3, q5: "ok" }),
  { q1_nps: 7, q2_overall_stars: 4, q3_food_stars: 4, q4_service_stars: 3, q5_comment: "ok" });
eq("no template still range-checks",
  mapAnswersToColumns(null, { q1: 7, q2: 9 }).q2_overall_stars, null);

// comments
eq("long comment is truncated", mapAnswersToColumns(STANDARD, { q5: "x".repeat(600) }).q5_comment.length, 500);
eq("blank comment is null", mapAnswersToColumns(STANDARD, { q5: "   " }).q5_comment, null);

// required-question checking follows the template
eq("missing required questions are named",
  missingRequired([q("q1","nps",true,"Recommend us?"), q("q2","stars",true,"Service?")], { q1: 8 }),
  ["Service?"]);
eq("optional questions are not required",
  missingRequired([q("q1","nps",true), q("q4","stars",false)], { q1: 8 }), []);
eq("nothing missing when all answered",
  missingRequired(STANDARD, { q1: 8, q2: 4, q3: 4 }), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
