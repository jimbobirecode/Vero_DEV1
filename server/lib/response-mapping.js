// Map a member's answers onto the fixed q1–q5 columns.
//
// Those columns carry check constraints — q1_nps 0-10, q2/q3/q4 stars 1-5 —
// but a template's question keys say nothing about their type. Mapping "q4"
// straight into q4_service_stars meant a template whose fourth question was
// an NPS scale rejected the entire submission, and the member lost their
// answers to a database error.
//
// So the mapping follows each question's TYPE, in the order the member saw
// them, and any value outside a column's range is left out rather than
// failing the submission. The answers JSON keeps the complete record, and
// scoring reads that, so nothing is lost either way.

const STAR_SLOTS = ["q2_overall_stars", "q3_food_stars", "q4_service_stars"];

function inRange(v, min, max) {
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && n >= min && n <= max;
}

// questions: the template's question array (may be null for older responses)
// answers:   { [key]: value } as submitted
function mapAnswersToColumns(questions, answers = {}) {
  const out = {
    q1_nps: null,
    q2_overall_stars: null,
    q3_food_stars: null,
    q4_service_stars: null,
    q5_comment: null,
  };

  // No template: fall back to the historical key-based mapping, still range
  // checked so a bad value cannot reject the submission.
  if (!Array.isArray(questions) || !questions.length) {
    if (inRange(answers.q1, 0, 10)) out.q1_nps = Number(answers.q1);
    if (inRange(answers.q2, 1, 5)) out.q2_overall_stars = Number(answers.q2);
    if (inRange(answers.q3, 1, 5)) out.q3_food_stars = Number(answers.q3);
    if (inRange(answers.q4, 1, 5)) out.q4_service_stars = Number(answers.q4);
    if (answers.q5 != null && String(answers.q5).trim()) out.q5_comment = String(answers.q5).slice(0, 500);
    return out;
  }

  let npsTaken = false;
  let starIdx = 0;

  for (const q of questions) {
    if (!q || !q.key) continue;
    const v = answers[q.key];

    if (q.type === "nps") {
      // Only the first NPS question has a column; later ones live in answers.
      if (!npsTaken) {
        npsTaken = true;
        if (inRange(v, 0, 10)) out.q1_nps = Number(v);
      }
      continue;
    }

    if (q.type === "stars") {
      if (starIdx < STAR_SLOTS.length) {
        const slot = STAR_SLOTS[starIdx];
        starIdx++;
        if (inRange(v, 1, 5)) out[slot] = Number(v);
      }
      continue;
    }

    if (q.type === "text" && out.q5_comment === null) {
      if (v != null && String(v).trim()) out.q5_comment = String(v).slice(0, 500);
    }
  }

  return out;
}

// Which required questions the member left unanswered, per the template.
// Without a template we keep the original rule: NPS and the first two ratings.
function missingRequired(questions, answers = {}) {
  if (!Array.isArray(questions) || !questions.length) {
    const missing = [];
    if (answers.q1 == null) missing.push("NPS");
    if (answers.q2 == null) missing.push("overall rating");
    if (answers.q3 == null) missing.push("food rating");
    return missing;
  }
  return questions
    .filter((q) => q && q.required && q.type !== "text")
    .filter((q) => answers[q.key] == null || answers[q.key] === "")
    .map((q) => q.title || q.key);
}


// --- Staff shift survey ---------------------------------------------------
// Same idea, different columns. The staff table has four 1-5 ratings and a
// comment, and no NPS at all, so the mapping is simply "rating questions in
// the order they were asked". Keyed by type rather than by the question's key
// so renaming a question in the Builder cannot silently stop its answers
// being stored.

const STAFF_RATING_SLOTS = ["q1_shift_rating", "q2_support", "q3_workload", "q4_tools"];

function mapStaffAnswersToColumns(questions, answers = {}) {
  const out = { q1_shift_rating: null, q2_support: null, q3_workload: null, q4_tools: null, q5_comment: null };

  // No template: the page posts the column names directly.
  if (!Array.isArray(questions) || !questions.length) {
    for (const slot of STAFF_RATING_SLOTS) {
      if (inRange(answers[slot], 1, 5)) out[slot] = Number(answers[slot]);
    }
    if (answers.q5_comment != null && String(answers.q5_comment).trim()) {
      out.q5_comment = String(answers.q5_comment).slice(0, 1000);
    }
    return out;
  }

  let ratingIdx = 0;
  for (const q of questions) {
    if (!q || !q.key) continue;
    const v = answers[q.key];

    if (q.type === "text") {
      if (out.q5_comment === null && v != null && String(v).trim()) {
        out.q5_comment = String(v).slice(0, 1000);
      }
      continue;
    }

    // Anything that is not free text is a rating. Extra ones beyond the four
    // columns still reach the database inside `answers`.
    if (ratingIdx < STAFF_RATING_SLOTS.length) {
      const slot = STAFF_RATING_SLOTS[ratingIdx];
      ratingIdx++;
      if (inRange(v, 1, 5)) out[slot] = Number(v);
    }
  }

  return out;
}

module.exports = { mapAnswersToColumns, missingRequired, mapStaffAnswersToColumns };
