const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `You analyze private club guest feedback for one outlet over the past 7 days.
Always respond in valid JSON only — no preamble, no markdown.`;

const USER_PROMPT_TEMPLATE = `Below are responses from the past 7 days for one outlet. Each includes:
star ratings (overall, food, service), NPS score, and free text where given.

{{RESPONSES_JSON}}

Return a JSON object with exactly this shape:
{
  "urgency": "critical" | "watch" | "maintain",
  "headline": "one sentence root-cause summary, specific to what guests actually said",
  "themes": [
    { "keyword": string, "sentiment": "positive" | "negative" | "neutral",
      "count": number, "trend": "rising" | "falling" | "stable", "example_quote": string }
  ]
}

Rules:
- "critical" only if there's a sharp, recent decline with a clear cause in the comments.
- Every theme must trace to something in the comments below — never generic hospitality advice.
- If fewer than 3 comments are present, set urgency to "maintain" and say the sample is too small for a reliable read in the headline, with an empty themes array.`;

function mondayOfCurrentWeek() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff)).toISOString().split("T")[0];
}

// GET /api/insights — fetch stored insights, newest first
router.get("/", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);

  // Try ai_insights table first
  const { data, error } = await supabase
    .from("ai_insights")
    .select("*, outlets(name)")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    // Table may not exist yet — return empty
    return res.json({ insights: [], source: "none" });
  }

  res.json({ insights: data || [], source: "ai_insights" });
});

// POST /api/insights/generate — on-demand analysis (not cron-gated)
router.post("/generate", async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not configured" });
  }

  const weekStart = mondayOfCurrentWeek();
  const { data: outlets } = await supabase.from("outlets").select("*").eq("active", true);
  const results = [];

  for (const outlet of outlets ?? []) {
    const { data: responses } = await supabase
      .from("survey_responses")
      .select("q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, q5_comment, visits!inner(outlet_id, visit_date)")
      .eq("visits.outlet_id", outlet.outlet_id)
      .gte("visits.visit_date", weekStart);

    if (!responses || responses.length === 0) continue;

    const payload = responses.map((r) => ({
      nps: r.q1_nps, overall: r.q2_overall_stars, food: r.q3_food_stars,
      service: r.q4_service_stars, comment: r.q5_comment ?? null,
    }));

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 800,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: USER_PROMPT_TEMPLATE.replace("{{RESPONSES_JSON}}", JSON.stringify(payload, null, 2)) }],
      }),
    });

    const aiData = await aiRes.json();
    const text = aiData.content?.[0]?.text ?? "{}";
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      parsed = { urgency: "maintain", headline: "Analysis failed to parse — check logs", themes: [] };
    }

    const insight = {
      outlet_id: outlet.outlet_id,
      week_start: weekStart,
      urgency: parsed.urgency,
      headline: parsed.headline ?? "",
      themes: parsed.themes ?? [],
      response_count: responses.length,
    };

    await supabase.from("ai_insights").insert(insight).then(() => {}, () => {});

    results.push({ ...insight, outlet_name: outlet.name });
  }

  res.json({ analyzed: results.length, insights: results });
});

module.exports = router;
