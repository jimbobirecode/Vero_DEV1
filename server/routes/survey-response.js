const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");
const { notifyManagers, dashboardUrl } = require("../lib/notify");
const { CLUB_NAME } = require("../lib/club-config");
const { tagComment, generateAlertSummary } = require("../lib/ai");
const { mapAnswersToColumns, missingRequired } = require("../lib/response-mapping");
const { severityFor } = require("../lib/severity");

// GET /api/survey-response/:token
router.get("/:token", async (req, res) => {
  let data, error;

  ({ data, error } = await supabase
    .from("survey_responses")
    .select("response_id, submitted_at, template_id, visits(outlet_id, outlets(name)), survey_templates(template_id, name, survey_type, questions)")
    .eq("survey_token", req.params.token)
    .maybeSingle());

  if (error && error.message && error.message.includes("template_id")) {
    ({ data, error } = await supabase
      .from("survey_responses")
      .select("response_id, submitted_at, visits(outlet_id, outlets(name))")
      .eq("survey_token", req.params.token)
      .maybeSingle());
  }

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "This survey link isn't valid." });
  if (data.submitted_at) return res.status(409).json({ error: "This survey has already been submitted. Thank you!" });

  res.json({
    outlet: data.visits?.outlets?.name ?? null,
    template: data.survey_templates ?? null,
  });
});

// POST /api/survey-response/:token
router.post("/:token", async (req, res) => {
  const { q5_comment } = req.body;

  let existing, findErr;
  ({ data: existing, error: findErr } = await supabase
    .from("survey_responses")
    .select("response_id, submitted_at, survey_templates(questions), visits(outlet_id, outlets(name), members(first_name, last_name))")
    .eq("survey_token", req.params.token)
    .maybeSingle());

  // Databases without the template columns still accept submissions.
  if (findErr && /template|survey_templates/i.test(findErr.message || "")) {
    ({ data: existing, error: findErr } = await supabase
      .from("survey_responses")
      .select("response_id, submitted_at, visits(outlet_id, outlets(name), members(first_name, last_name))")
      .eq("survey_token", req.params.token)
      .maybeSingle());
  }

  if (findErr) return res.status(500).json({ error: findErr.message });
  if (!existing) return res.status(404).json({ error: "This survey link isn't valid." });
  if (existing.submitted_at) return res.status(409).json({ error: "This survey has already been submitted." });

  const answersObj = req.body.answers ?? null;
  const templateQuestions = existing.survey_templates?.questions ?? null;

  // Work the answers out here rather than trusting the page's key-based guess:
  // the column a value belongs in depends on the question's type, and a value
  // that fits no column is kept in `answers` instead of rejecting the lot.
  const submitted = answersObj && typeof answersObj === "object" ? answersObj : {
    q1: req.body.q1_nps, q2: req.body.q2_overall_stars,
    q3: req.body.q3_food_stars, q4: req.body.q4_service_stars, q5: q5_comment,
  };

  const missing = missingRequired(templateQuestions, submitted);
  if (missing.length) {
    return res.status(400).json({ error: `Please answer: ${missing.join(", ")}` });
  }

  const cols = mapAnswersToColumns(templateQuestions, submitted);
  const commentText = cols.q5_comment ?? ((q5_comment ?? "").slice(0, 500) || null);
  const { q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars } = cols;

  const updatePayload = {
    q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars,
    q5_comment: commentText,
    submitted_at: new Date().toISOString(),
    is_complete: q4_service_stars != null && Boolean(commentText),
  };

  // AI comment tagging (non-blocking — don't delay the response)
  const scores = { nps: q1_nps, overall: q2_overall_stars, food: q3_food_stars, service: q4_service_stars };
  const aiTagPromise = tagComment(commentText, scores).catch(e => {
    console.error("[ai] tag error:", e.message);
    return null;
  });

  let updateErr;
  if (answersObj) {
    updatePayload.answers = answersObj;
    ({ error: updateErr } = await supabase
      .from("survey_responses").update(updatePayload).eq("response_id", existing.response_id));
    if (updateErr && updateErr.message && updateErr.message.includes("answers")) {
      delete updatePayload.answers;
      ({ error: updateErr } = await supabase
        .from("survey_responses").update(updatePayload).eq("response_id", existing.response_id));
    }
  } else {
    ({ error: updateErr } = await supabase
      .from("survey_responses").update(updatePayload).eq("response_id", existing.response_id));
  }

  if (updateErr) return res.status(500).json({ error: updateErr.message });

  // Wait for AI tags and store them
  const aiTags = await aiTagPromise;
  if (aiTags) {
    const tagUpdate = { ai_tags: aiTags };
    const { error: tagErr } = await supabase
      .from("survey_responses").update(tagUpdate).eq("response_id", existing.response_id);
    if (tagErr && tagErr.message && tagErr.message.includes("ai_tags")) {
      console.log("[ai] ai_tags column not yet added, skipping tag storage");
    }
  }

  // Severity detection (keyword + score based)
  const hygieneTerms = /\b(sick|ill|food ?poisoning|raw|undercooked|mold|mould|hair|bug|insect|dirty|unsanitary|smell|odor|odour|rodent|rat|mouse|roach|cockroach|vomit|contaminate|expired|rotten|spoiled)\b/i;
  const hasSafetyConcern = (aiTags?.safety_concern === true) || hygieneTerms.test(commentText ?? "");

  // See lib/severity.js — the rules used to compare null against a number,
  // which JavaScript happily coerces, so every response to a template without
  // an NPS question raised a medium alert.
  const severity = severityFor({
    nps: q1_nps, overall: q2_overall_stars, safetyConcern: hasSafetyConcern,
  });

  if (severity) {
    const member = existing.visits?.members;
    const memberName = member ? `${member.first_name} ${member.last_name}` : null;
    const outletName = existing.visits?.outlets?.name;

    // Generate AI summary for the alert
    const aiSummary = await generateAlertSummary(commentText, scores, outletName, memberName).catch(e => {
      console.error("[ai] summary error:", e.message);
      return null;
    });

    const alertInsert = {
      response_id: existing.response_id,
      outlet_id: existing.visits?.outlet_id,
      severity,
      status: "open",
    };
    if (aiSummary) alertInsert.ai_summary = aiSummary;

    // Start the clock the moment the alert exists. The window to ring the
    // member runs from their complaint, not from whenever a manager next opens
    // the dashboard — computing it later would quietly hand the club back the
    // hours it had already used up.
    try {
      const recovery = require("../lib/recovery");
      const { loadSlaSettings } = require("../lib/recovery-store");
      const due = recovery.contactDueAt(new Date().toISOString(), severity, await loadSlaSettings());
      if (due) alertInsert.contact_due_at = due;
    } catch (e) {
      console.error("[recovery] could not set contact_due_at:", e.message);
    }

    // Each optional column depends on a migration that may not have run yet.
    // Strip whichever one the error names and retry, rather than losing the
    // alert entirely — an alert that fails to save is a member nobody hears.
    let { error: alertErr } = await supabase.from("case_alerts").insert(alertInsert);
    for (const col of ["ai_summary", "contact_due_at"]) {
      if (!alertErr || !alertErr.message || !alertErr.message.includes(col)) continue;
      delete alertInsert[col];
      ({ error: alertErr } = await supabase.from("case_alerts").insert(alertInsert));
    }
    if (alertErr) console.error("[alerts] could not create alert:", alertErr.message);

    if (severity === "high" || severity === "medium") {
      const url = dashboardUrl();
      const sevLabel = severity.toUpperCase();
      const subject = `[Club Vero] ${sevLabel} alert — ${aiSummary || "immediate attention needed"}`;
      let body = `A ${severity} severity alert has been auto-created.\n\n`;
      if (aiSummary) body += `Summary: ${aiSummary}\n\n`;
      body += `NPS: ${q1_nps}/10\nOverall: ${q2_overall_stars}/5\nFood: ${q3_food_stars}/5\nService: ${q4_service_stars ?? "N/A"}/5`;
      if (commentText) body += `\nComment: "${commentText}"`;
      if (aiTags?.tags?.length) body += `\nTags: ${aiTags.tags.join(", ")}`;
      body += `\n\nThis alert needs to be assigned and resolved.`;
      if (url) body += `\n\nView in dashboard: ${url}`;
      body += `\n\n${CLUB_NAME}`;

      notifyManagers(subject, body).catch((e) =>
        console.error("Alert notification failed:", e.message)
      );
    }
  }

  res.json({ submitted: true });
});

module.exports = router;
