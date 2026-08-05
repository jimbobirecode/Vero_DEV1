// How serious a submitted survey is, and therefore whether it raises a case
// alert and pages the managers.
//
// Lifted out of routes/survey-response.js so the rules are testable without a
// database. Every comparison guards against null first: a template with no NPS
// question leaves q1_nps null, and `null <= 4` is true in JavaScript — which
// meant every response to such a template raised a medium alert and emailed
// the management team, however good the ratings were.

function severityFor({ nps, overall, safetyConcern = false } = {}) {
  const n = Number.isInteger(nps) ? nps : null;
  const o = Number.isInteger(overall) ? overall : null;

  if (safetyConcern) return o != null && o <= 2 ? "high" : "medium";
  if (o === 1) return "medium";
  if (n != null && n <= 4) return "medium";
  if (o === 2 || (n != null && n >= 5 && n <= 6)) return "low";
  return null;
}

module.exports = { severityFor };
