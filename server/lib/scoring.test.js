const s = require("./scoring.js");
let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// --- normalisation
eq("nps 10 -> 100", s.normalize("nps", 10), 100);
eq("nps 0  -> 0", s.normalize("nps", 0), 0);
eq("nps 7  -> 70", s.normalize("nps", 7), 70);
eq("stars 5 -> 100", s.normalize("stars", 5), 100);
eq("stars 1 -> 0", s.normalize("stars", 1), 0);
eq("stars 3 -> 50", s.normalize("stars", 3), 50);
eq("text unscored", s.normalize("text", "hello"), null);
eq("out of range -> null", s.normalize("stars", 9), null);
eq("blank -> null", s.normalize("stars", ""), null);

const fnb = { questions: [
  { key: "q1", type: "nps",   index: "CHI" },
  { key: "q2", type: "stars", index: "SSI" },
  { key: "q3", type: "stars", index: "OHI" },
  { key: "q4", type: "stars", index: "OHI" },
  { key: "q5", type: "text",  index: null  },
]};

// --- single response
const r1 = { answers: { q1: 10, q2: 5, q3: 5, q4: 5, q5: "great" } };
eq("all top marks -> 100s", s.scoreResponse(r1, fnb), { CHI: 100, SSI: 100, OHI: 100 });

const r2 = { answers: { q1: 5, q2: 3, q3: 3, q4: 1 } };
eq("mixed: OHI averages 50 and 0 -> 25", s.scoreResponse(r2, fnb), { CHI: 50, SSI: 50, OHI: 25 });

// --- THE KEY GUARANTEE: adding an unbenchmarked question changes nothing
const withCustom = { questions: [...fnb.questions,
  { key: "custom1", type: "stars", index: null },
  { key: "custom2", type: "stars", index: null },
]};
const r3 = { answers: { q1: 10, q2: 5, q3: 5, q4: 5, custom1: 1, custom2: 1 } };
eq("custom questions excluded from indices", s.scoreResponse(r3, withCustom), { CHI: 100, SSI: 100, OHI: 100 });

// --- adding a BENCHMARKED question does move the index (by design)
const extraOhi = { questions: [...fnb.questions, { key: "q6", type: "stars", index: "OHI" }] };
const r4 = { answers: { q1: 10, q2: 5, q3: 5, q4: 5, q6: 1 } };
eq("new OHI question pulls OHI down", s.scoreResponse(r4, extraOhi), { CHI: 100, SSI: 100, OHI: (100+100+0)/3 });

// --- legacy responses with no answers blob still score via columns
const legacy = { q1_nps: 10, q2_overall_stars: 5, q3_food_stars: 5, q4_service_stars: 5, answers: null };
eq("legacy columns, no template", s.scoreResponse(legacy, null), { CHI: 100, SSI: 100, OHI: 100 });

// --- golf reuses the same columns with different meanings; template fixes it
const golf = { questions: [
  { key: "q1", type: "nps",   index: "CHI" },  // recommend
  { key: "q2", type: "stars", index: "OHI" },  // course conditions
  { key: "q3", type: "stars", index: "OHI" },  // pace of play
  { key: "q4", type: "stars", index: "SSI" },  // pro shop staff
]};
const golfLegacy = { q1_nps: 8, q2_overall_stars: 5, q3_food_stars: 3, q4_service_stars: 1, answers: null };
eq("golf legacy mapped by template, not column name",
   s.scoreResponse(golfLegacy, golf), { CHI: 80, SSI: 0, OHI: 75 });

// --- partial response: missing SSI answer yields null, not zero
const partial = { answers: { q1: 8, q3: 5 } };
eq("missing index -> null not 0", s.scoreResponse(partial, fnb), { CHI: 80, SSI: null, OHI: 100 });

// --- aggregation
const agg = s.aggregate([
  { answers: { q1: 10, q2: 5, q3: 5, q4: 5 }, survey_templates: fnb },
  { answers: { q1: 0,  q2: 1, q3: 1, q4: 1 }, survey_templates: fnb },
]);
eq("aggregate averages responses", { CHI: agg.CHI, SSI: agg.SSI, OHI: agg.OHI }, { CHI: 50, SSI: 50, OHI: 50 });
eq("aggregate counts contributors", agg.CHI_responses, 2);

const aggPartial = s.aggregate([
  { answers: { q1: 10 }, survey_templates: fnb },
  { answers: { q1: 0, q2: 5 }, survey_templates: fnb },
]);
eq("partial rows counted only where present", [aggPartial.CHI, aggPartial.SSI, aggPartial.SSI_responses], [50, 100, 1]);

// --- coverage reporting
eq("coverage of full template", s.templateCoverage(fnb),
   { covered: ["CHI","SSI","OHI"], missing: [], unscored: 0 });
eq("coverage flags gaps and unscored", s.templateCoverage(withCustom),
   { covered: ["CHI","SSI","OHI"], missing: [], unscored: 2 });
eq("coverage flags missing index", s.templateCoverage({ questions: [{ key:"q1", type:"nps", index:"CHI" }] }),
   { covered: ["CHI"], missing: ["SSI","OHI"], unscored: 0 });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
