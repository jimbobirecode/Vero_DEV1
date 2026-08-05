const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");
const { aggregate, INDEXES, INDEX_LABELS, templateCoverage } = require("../lib/scoring");

const RESPONSE_SELECT =
  "response_id, q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, answers, template_id, submitted_at, " +
  "survey_templates(template_id, name, survey_type, questions), " +
  "visits(visit_id, visit_date, visitor_type, outlet_id, outlets(name))";

function defaultRange(query) {
  const end = query.end || new Date().toISOString().split("T")[0];
  const start = query.start
    || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  return { start, end };
}

// Older databases predate the templates join; fall back to bare columns so
// the endpoint still returns legacy-scored numbers instead of erroring.
async function fetchResponses(start, end) {
  // visit_id not null excludes event surveys. CHI, SSI and OHI are benchmarked
  // from what a member said about an outlet they visited; an event has no
  // visit and no outlet, and is scored as its own department (see
  // lib/event-scores.js). Without this filter an event response with an
  // index-tagged template moved all three club indices.
  let { data, error } = await supabase
    .from("survey_responses")
    .select(RESPONSE_SELECT)
    .not("submitted_at", "is", null)
    .not("visit_id", "is", null)
    .gte("submitted_at", `${start}T00:00:00Z`)
    .lte("submitted_at", `${end}T23:59:59Z`);

  if (error) {
    ({ data, error } = await supabase
      .from("survey_responses")
      .select("response_id, q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, submitted_at, visits(visit_id, visit_date, visitor_type, outlet_id, outlets(name))")
      .not("submitted_at", "is", null)
      .not("visit_id", "is", null)
      .gte("submitted_at", `${start}T00:00:00Z`)
      .lte("submitted_at", `${end}T23:59:59Z`));
  }
  return { data: data || [], error };
}

// GET /api/scores?start=&end=&outlet_id=&survey_type=
// Returns CHI / SSI / OHI overall, per outlet, and per month.
router.get("/", async (req, res) => {
  const { start, end } = defaultRange(req.query);
  const { data: responses, error } = await fetchResponses(start, end);
  if (error) return res.status(500).json({ error: error.message });

  let rows = responses;
  if (req.query.outlet_id) {
    rows = rows.filter((r) => r.visits?.outlet_id === req.query.outlet_id);
  }
  if (req.query.survey_type) {
    rows = rows.filter((r) => r.survey_templates?.survey_type === req.query.survey_type);
  }

  // Per outlet
  const byOutletMap = {};
  for (const r of rows) {
    const name = r.visits?.outlets?.name || "Unassigned";
    (byOutletMap[name] ||= []).push(r);
  }
  const by_outlet = Object.entries(byOutletMap)
    .map(([outlet, list]) => ({ outlet, response_count: list.length, ...aggregate(list) }))
    .sort((a, b) => b.response_count - a.response_count);

  // Per month, oldest first, so the dashboard can plot a trend
  const byMonthMap = {};
  for (const r of rows) {
    const key = (r.submitted_at || "").slice(0, 7);
    if (!key) continue;
    (byMonthMap[key] ||= []).push(r);
  }
  const by_month = Object.keys(byMonthMap).sort()
    .map((month) => ({ month, response_count: byMonthMap[month].length, ...aggregate(byMonthMap[month]) }));

  res.json({
    range: { start, end },
    labels: INDEX_LABELS,
    indexes: INDEXES,
    response_count: rows.length,
    overall: aggregate(rows),
    by_outlet,
    by_month,
  });
});

// GET /api/scores/coverage — which indices each active template feeds.
// Powers the builder warning when a template stops feeding a benchmark.
router.get("/coverage", async (req, res) => {
  const { data, error } = await supabase
    .from("survey_templates")
    .select("template_id, name, survey_type, questions")
    .eq("active", true);

  if (error) return res.status(500).json({ error: error.message });

  res.json({
    labels: INDEX_LABELS,
    templates: (data || []).map((t) => ({
      template_id: t.template_id,
      name: t.name,
      survey_type: t.survey_type,
      ...templateCoverage(t),
    })),
  });
});

module.exports = router;
