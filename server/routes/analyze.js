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
  ],
  "training_action": {
    "title": string,
    "metric_context": "e.g. NPS dropped 43 points this week",
    "steps": [ { "text": string, "priority": "immediate" | "this_week" | "ongoing" } ],
    "timeline": string
  }
}

Rules:
- "critical" only if there's a sharp, recent decline with a clear cause in the comments.
- Every step must trace to something in the comments below — never generic hospitality advice.
- If fewer than 3 comments are present, set urgency to "maintain" and say the sample is too small for a reliable read in the headline, with an empty themes array and no training_action steps.`;

function mondayOfCurrentWeek() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff)).toISOString().split("T")[0];
}

// Does the analysis. Called by the in-app scheduler (see lib/scheduler.js)
// and by the endpoint below. Applies no time gating of its own — the caller
// decides when it is time, the same split performSend uses for surveys.
async function performWeeklyAnalysis() {
  const weekStart = mondayOfCurrentWeek();
  const { data: outlets } = await supabase.from("outlets").select("*").eq("active", true);
  const created = [];

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
      parsed = { urgency: "maintain", headline: "Analysis failed to parse — check logs", themes: [], training_action: null };
    }

    if (parsed.urgency === "critical") {
      await supabase.from("case_alerts").insert({ outlet_id: outlet.outlet_id, severity: "high", status: "open" });
    }

    // Store the full AI narrative for the Insights screen
    await supabase.from("ai_insights").insert({
      outlet_id: outlet.outlet_id,
      week_start: weekStart,
      urgency: parsed.urgency,
      headline: parsed.headline ?? "",
      themes: parsed.themes ?? [],
      response_count: responses.length,
    }).then(() => {}, () => {});  // ignore if table doesn't exist yet

    const row = {
      outlet_id: outlet.outlet_id,
      week_start: weekStart,
      steps: parsed.training_action?.steps ?? [],
      basis_summary: `${parsed.headline ?? ""} · Based on ${responses.length} responses this week`,
    };

    // An outlet that already nominates somebody for its case alerts has said
    // who answers for it. A plan generated at 6am on a Friday and owned by
    // nobody is read by everybody as somebody else's job, so it starts with
    // that name on it rather than waiting for a manager to notice and pick
    // one. They can hand it to someone else on the screen.
    if (outlet.owner_staff_id) {
      row.owner_staff_id = outlet.owner_staff_id;
      row.assigned_at = new Date().toISOString();
      const { data: owner } = await supabase
        .from("staff").select("name").eq("staff_id", outlet.owner_staff_id).maybeSingle();
      if (owner) row.owner_name = owner.name;
    }

    let { data: plan, error: planErr } = await supabase
      .from("training_plans").insert(row).select().single();

    // Before migrations/training-owner.sql the columns do not exist. The plan
    // matters more than the ownership, so it is written without it.
    if (planErr && String(planErr.message || "").includes("owner")) {
      delete row.owner_staff_id; delete row.owner_name; delete row.assigned_at;
      ({ data: plan } = await supabase.from("training_plans").insert(row).select().single());
    }

    created.push({ outlet: outlet.name, urgency: parsed.urgency, plan_id: plan?.plan_id });
  }

  return { analyzed: created.length, results: created, week_start: weekStart };
}

// POST /api/cron/analyze-weekly — manual trigger and fallback. Scheduling
// lives in the app now, driven by the day and time set in Settings.
router.post("/analyze-weekly", async (req, res) => {
  try {
    res.json(await performWeeklyAnalysis());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

module.exports = router;
module.exports.performWeeklyAnalysis = performWeeklyAnalysis;
