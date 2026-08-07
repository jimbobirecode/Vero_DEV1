const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");

const { isIndex, INDEXES } = require("../lib/scoring");
const { smsBody, emailSubject, sampleLink, staffSmsBody, staffEmailSubject, staffSampleLink } = require("../lib/messages");
const { meter: smsMeter, offendingCharacters } = require("../lib/sms-billing");

// "staff" is the shift survey sent to your own team. It lives here with the
// rest so the Builder is the one place any survey's wording is seen and
// changed — its questions used to be hardcoded in staff-survey-page.html,
// which made the one survey going to your own people the one nobody could
// read.
const VALID_SURVEY_TYPES = ["food_bev", "golf", "events", "staff"];

// Normalise incoming questions: keep `index` only when it names a real
// benchmark, so a typo silently drops the question out of scoring rather
// than corrupting an index.
function sanitizeQuestions(questions) {
  if (!Array.isArray(questions)) return { error: "questions must be an array" };
  const clean = [];
  for (const q of questions) {
    if (!q || !q.key || !q.title) {
      return { error: "each question needs a key and a title" };
    }
    if (q.index != null && q.index !== "" && !isIndex(q.index)) {
      return { error: `index must be one of ${INDEXES.join(", ")} (or empty for an unbenchmarked question)` };
    }
    if (q.type === "text" && isIndex(q.index)) {
      return { error: `"${q.title}" is a free-text question and cannot feed an index` };
    }
    clean.push({
      key: q.key,
      title: q.title,
      hint: q.hint ?? "",
      type: q.type || "stars",
      required: Boolean(q.required),
      index: isIndex(q.index) ? q.index : null,
      explainer: q.explainer ?? "",
    });
  }
  return { questions: clean };
}

// GET /api/survey-templates — list all active templates
router.get("/", async (req, res) => {
  const { data, error } = await supabase
    .from("survey_templates")
    .select("*")
    .eq("active", true)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ templates: data });
});

// GET /api/survey-templates/preview/:id — exactly what a member receives for
// this template: the message text, and the questions in order. Built from the
// same helpers the sender uses so the two cannot drift.
router.get("/preview/:id", async (req, res) => {
  const { data: tpl, error } = await supabase
    .from("survey_templates")
    .select("*")
    .eq("template_id", req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!tpl) return res.status(404).json({ error: "Template not found" });

  // Which template the sender would actually pick for this survey type: the
  // most recently created active one. If that is not this template, editing
  // it changes nothing that goes out.
  const { data: actives } = await supabase
    .from("survey_templates")
    .select("template_id, name, created_at")
    .eq("survey_type", tpl.survey_type)
    .eq("active", true)
    .order("created_at", { ascending: false });

  const live = (actives || [])[0] || null;

  // Staff surveys go out on their own wording, from their own link path, so
  // the preview has to use the sender's staff helpers rather than the member
  // ones — otherwise it would show a message that is never sent.
  const isStaff = tpl.survey_type === "staff";
  const link = isStaff ? staffSampleLink(process.env.SURVEY_BASE_URL) : sampleLink(process.env.SURVEY_BASE_URL);
  const sms = isStaff
    ? staffSmsBody({ link, firstName: "Jessica" })
    : smsBody({ surveyType: tpl.survey_type, link });

  res.json({
    template_id: tpl.template_id,
    name: tpl.name,
    survey_type: tpl.survey_type,
    active: tpl.active,
    questions: Array.isArray(tpl.questions) ? tpl.questions : [],
    audience: isStaff ? "staff" : "member",
    message: {
      sms,
      sms_length: sms.length,
      // Metered properly rather than by length/160, which this used to do and
      // which was wrong in the direction that costs money: it ignores encoding
      // entirely, so the golf survey — one em dash, therefore UCS-2, therefore
      // three segments — reported as one. See lib/sms-billing.js.
      sms_segments: smsMeter(sms).segments,
      sms_encoding: smsMeter(sms).encoding,
      sms_non_gsm: offendingCharacters(sms),
      email_subject: isStaff ? staffEmailSubject() : emailSubject({ surveyType: tpl.survey_type }),
      sample_link: link,
    },
    delivery: {
      is_live: live ? live.template_id === tpl.template_id : false,
      live_template_name: live ? live.name : null,
      active_count_for_type: (actives || []).length,
    },
  });
});

// GET /api/survey-templates/:id — get a single template
router.get("/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("survey_templates")
    .select("*")
    .eq("template_id", req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Template not found" });
  res.json(data);
});

// POST /api/survey-templates — create a template
router.post("/", async (req, res) => {
  const { name, survey_type, questions } = req.body;

  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }
  if (!VALID_SURVEY_TYPES.includes(survey_type)) {
    return res.status(400).json({ error: `survey_type must be one of: ${VALID_SURVEY_TYPES.join(", ")}` });
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: "questions must be a non-empty array" });
  }

  const sanitized = sanitizeQuestions(questions);
  if (sanitized.error) return res.status(400).json({ error: sanitized.error });

  const { data, error } = await supabase
    .from("survey_templates")
    .insert({ name, survey_type, questions: sanitized.questions })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/survey-templates/:id — update a template
router.put("/:id", async (req, res) => {
  const updates = {};
  const { name, survey_type, questions, active } = req.body;

  if (name !== undefined) updates.name = name;
  if (survey_type !== undefined) {
    if (!VALID_SURVEY_TYPES.includes(survey_type)) {
      return res.status(400).json({ error: `survey_type must be one of: ${VALID_SURVEY_TYPES.join(", ")}` });
    }
    updates.survey_type = survey_type;
  }
  if (questions !== undefined) {
    const sanitized = sanitizeQuestions(questions);
    if (sanitized.error) return res.status(400).json({ error: sanitized.error });
    updates.questions = sanitized.questions;
  }
  if (active !== undefined) updates.active = active;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  const { data, error } = await supabase
    .from("survey_templates")
    .update(updates)
    .eq("template_id", req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Template not found" });
  res.json(data);
});

// DELETE /api/survey-templates/:id — soft-delete (set active=false)
router.delete("/:id", async (req, res) => {
  const { error } = await supabase
    .from("survey_templates")
    .update({ active: false })
    .eq("template_id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: true });
});

module.exports = router;
