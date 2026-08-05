// Event scoring — the Events department's own numbers.
//
// Kept apart from lib/scoring.js on purpose. CHI, SSI and OHI are benchmarked
// from what members say about an outlet they visited; an event is a different
// operation with its own template and its own team, so folding it in would
// move a member-facing score on the strength of a wedding. Events get NPS and
// CSAT of their own instead.
//
// Golf events and everything else are scored identically and separately, then
// rolled up: you can read them apart when you want to, and together when you
// want the department.

const CATEGORIES = ["general", "golf"];
const CATEGORY_LABELS = { general: "Events", golf: "Golf events" };

function normaliseCategory(value) {
  return CATEGORIES.includes(value) ? value : "general";
}

const mean = (vals) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
const round = (v, dp = 1) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);

// rows: submitted survey_responses for one event, or several.
// NPS is the standard −100..100: promoters (9–10) minus detractors (0–6), as
// a percentage of everyone who answered the NPS question. CSAT is the mean
// overall rating on the template's 1–5 scale, with a percentage alongside it
// because a 4.2 means less to most people than "84%".
function scoreResponses(rows = []) {
  const answered = rows.filter((r) => r && r.submitted_at);

  const npsVals = answered.map((r) => r.q1_nps).filter((v) => Number.isInteger(v));
  const csatVals = answered.map((r) => r.q2_overall_stars).filter((v) => Number.isInteger(v));

  const promoters = npsVals.filter((v) => v >= 9).length;
  const passives = npsVals.filter((v) => v >= 7 && v <= 8).length;
  const detractors = npsVals.filter((v) => v <= 6).length;

  const csat = mean(csatVals);

  return {
    responses: answered.length,
    nps: npsVals.length ? Math.round(((promoters - detractors) / npsVals.length) * 100) : null,
    nps_base: npsVals.length,
    promoters, passives, detractors,
    csat: round(csat, 2),
    // 1–5 mapped onto 0–100, so 5 is 100% and 1 is 0%.
    csat_pct: csat == null ? null : Math.round(((csat - 1) / 4) * 100),
    csat_base: csatVals.length,
  };
}

// events: [{ event_id, name, event_date, category, responses: [...] }]
// Returns per-event scores, a total for each category, and the department
// overall. The overall is computed from every response rather than by
// averaging the two categories, so an event with forty replies counts for
// more than one with three.
function summarise(events = []) {
  const perEvent = events.map((e) => ({
    event_id: e.event_id,
    name: e.name,
    event_date: e.event_date,
    category: normaliseCategory(e.category),
    ...scoreResponses(e.responses || []),
  }));

  const byCategory = {};
  for (const category of CATEGORIES) {
    const rows = events
      .filter((e) => normaliseCategory(e.category) === category)
      .flatMap((e) => e.responses || []);
    byCategory[category] = {
      category,
      label: CATEGORY_LABELS[category],
      events: perEvent.filter((e) => e.category === category).length,
      ...scoreResponses(rows),
    };
  }

  return {
    overall: {
      label: "Events overall",
      events: perEvent.length,
      ...scoreResponses(events.flatMap((e) => e.responses || [])),
    },
    by_category: CATEGORIES.map((c) => byCategory[c]),
    events: perEvent.sort((a, b) => String(b.event_date).localeCompare(String(a.event_date))),
  };
}

module.exports = { scoreResponses, summarise, normaliseCategory, CATEGORIES, CATEGORY_LABELS };
