// Public endpoints for the staff workday survey. No auth: the token in the
// URL is the credential, same as the member survey.
//
// The token deliberately reveals only the first name and shift date. A link
// forwarded or found on a shared phone should not expose a colleague's phone
// number, email, or anything they have previously written.

const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");

const { mapStaffAnswersToColumns } = require("../lib/response-mapping");

const RATING_KEYS = ["q1_shift_rating", "q2_support", "q3_workload", "q4_tools"];

function invalidRating(value) {
  return !Number.isInteger(value) || value < 1 || value > 5;
}

// The live staff template, so the page asks whatever Survey Builder shows.
// Null when there isn't one — the page then falls back to its built-in
// questions, which are the same five this template was seeded from.
async function activeStaffTemplate() {
  try {
    const { data } = await supabase
      .from("survey_templates")
      .select("template_id, name, survey_type, questions")
      .eq("survey_type", "staff")
      .eq("active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data || null;
  } catch (_) {
    return null;   // older database with no staff type — fall back
  }
}

// GET /api/staff-survey-response/:token
router.get("/:token", async (req, res) => {
  const { data, error } = await supabase
    .from("staff_survey_responses")
    .select("staff_response_id, shift_date, submitted_at, servers(name)")
    .eq("survey_token", req.params.token)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "This survey link isn't valid." });
  if (data.submitted_at) return res.status(409).json({ error: "You've already submitted this one. Thank you!" });

  res.json({
    shift_date: data.shift_date,
    first_name: (data.servers?.name || "").split(" ")[0] || null,
    template: await activeStaffTemplate(),
  });
});

// POST /api/staff-survey-response/:token
router.post("/:token", async (req, res) => {
  const template = await activeStaffTemplate();
  const questions = Array.isArray(template?.questions) ? template.questions : null;
  const answersObj = req.body.answers && typeof req.body.answers === "object" ? req.body.answers : null;

  // Which questions the template says must be answered. Without a template
  // the original rule holds: the first three ratings.
  // The page posts everything under `answers`; older builds posted the column
  // names at the top level. Read whichever arrived.
  const given = answersObj ?? req.body;

  const missing = questions
    ? questions.filter((q) => q && q.required && q.type !== "text")
        .filter((q) => given[q.key] == null || given[q.key] === "")
        .map((q) => q.title || q.key)
    : (given.q1_shift_rating == null || given.q2_support == null || given.q3_workload == null
        ? ["the shift, support and workload ratings"] : []);

  if (missing.length) {
    return res.status(400).json({ error: `Please answer: ${missing.join(", ")}` });
  }

  // Validate before writing rather than letting the column CHECK constraint
  // fail — the database error would surface to a member of staff as an opaque
  // 500 at the end of a long shift.
  for (const key of RATING_KEYS) {
    const value = given[key];
    if (value == null) continue;
    if (invalidRating(value)) {
      return res.status(400).json({ error: `${key} must be a whole number from 1 to 5.` });
    }
  }

  // Map by question type, in the order they were asked — see
  // lib/response-mapping.js. Renaming a question in the Builder must not
  // silently stop its answers reaching a column.
  const cols = mapStaffAnswersToColumns(questions, given);

  const { data: existing, error: findErr } = await supabase
    .from("staff_survey_responses")
    .select("staff_response_id, submitted_at")
    .eq("survey_token", req.params.token)
    .maybeSingle();

  if (findErr) return res.status(500).json({ error: findErr.message });
  if (!existing) return res.status(404).json({ error: "This survey link isn't valid." });
  if (existing.submitted_at) return res.status(409).json({ error: "You've already submitted this one." });

  const { error } = await supabase
    .from("staff_survey_responses")
    .update({
      ...cols,
      answers: answersObj,
      submitted_at: new Date().toISOString(),
      is_complete: true,
    })
    .eq("staff_response_id", existing.staff_response_id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ submitted: true });
});

module.exports = router;
