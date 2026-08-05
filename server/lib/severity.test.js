const { severityFor } = require("./severity");

let pass = 0, fail = 0;
function check(label, got, want) {
  if (got === want) { pass++; console.log(`PASS  ${label.padEnd(56)} -> ${got ?? "no alert"}`); }
  else { fail++; console.log(`FAIL  ${label}\n      got ${got}, want ${want}`); }
}

console.log("\n--- the bug: a template with no NPS question ---");
check("nps null, overall 5 — a happy member", severityFor({ nps: null, overall: 5 }), null);
check("nps null, overall 4", severityFor({ nps: null, overall: 4 }), null);
check("nps null, overall 3", severityFor({ nps: null, overall: 3 }), null);
check("nps null, overall 2 — still low on its own merits", severityFor({ nps: null, overall: 2 }), "low");
check("nps null, overall 1", severityFor({ nps: null, overall: 1 }), "medium");
check("nps and overall both null", severityFor({}), null);
check("nps undefined (not just null)", severityFor({ nps: undefined, overall: 5 }), null);

console.log("\n--- ordinary dining responses are unchanged ---");
check("nps 10, overall 5", severityFor({ nps: 10, overall: 5 }), null);
check("nps 7, overall 4", severityFor({ nps: 7, overall: 4 }), null);
check("nps 6 — passive", severityFor({ nps: 6, overall: 4 }), "low");
check("nps 5 — passive", severityFor({ nps: 5, overall: 4 }), "low");
check("nps 4 — detractor", severityFor({ nps: 4, overall: 4 }), "medium");
check("nps 0", severityFor({ nps: 0, overall: 3 }), "medium");
check("overall 1 outranks a good nps", severityFor({ nps: 9, overall: 1 }), "medium");
check("overall 2", severityFor({ nps: 9, overall: 2 }), "low");

console.log("\n--- safety concerns ---");
check("safety + overall 1", severityFor({ nps: 8, overall: 1, safetyConcern: true }), "high");
check("safety + overall 2", severityFor({ nps: 8, overall: 2, safetyConcern: true }), "high");
check("safety + overall 3", severityFor({ nps: 8, overall: 3, safetyConcern: true }), "medium");
check("safety + overall 5", severityFor({ nps: 10, overall: 5, safetyConcern: true }), "medium");
check("safety + overall null — medium, not high", severityFor({ nps: null, overall: null, safetyConcern: true }), "medium");

console.log("\n--- non-integer input is not trusted as a number ---");
check("nps as a string", severityFor({ nps: "4", overall: 5 }), null);
check("overall as a string", severityFor({ nps: 9, overall: "1" }), null);
check("nps NaN", severityFor({ nps: NaN, overall: 5 }), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
