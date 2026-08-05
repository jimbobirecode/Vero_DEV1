// Index-based scoring.
//
// Every rated question can declare which benchmarked index it feeds via an
// `index` field on the template question: "CHI", "SSI", "OHI", or null.
// Questions with a null/absent index are collected but never scored — that is
// how a club adds its own questions without disturbing benchmarks.
//
//   CHI — Club Health Index      loyalty / likelihood to recommend
//   SSI — Service Satisfaction   staff and service quality
//   OHI — Operational Health     operational effectiveness: how well the
//                                 operation runs — pace, readiness, delivery
//
// Answers arrive on different scales (NPS 0-10, stars 1-5), so each is
// normalised to 0-100 before being averaged. An index score is the mean of
// its normalised answers, which keeps it stable when questions are added or
// removed.

const INDEXES = ["CHI", "SSI", "OHI"];

const INDEX_LABELS = {
  CHI: "Club Health Index",
  SSI: "Service Satisfaction Index",
  OHI: "Operational Health Index",
};

// Used when a response predates templates entirely and we only have the
// fixed q1-q4 columns to work with.
const LEGACY_QUESTION_TYPES = { q1: "nps", q2: "stars", q3: "stars", q4: "stars" };
const LEGACY_INDEX_MAP = { q1: "CHI", q2: "SSI", q3: "OHI", q4: "OHI" };

function isIndex(value) {
  return INDEXES.includes(value);
}

// Normalise a single answer to 0-100. Returns null for anything unscoreable
// (text answers, blanks, values outside the question's range).
function normalize(type, value) {
  if (value === null || value === undefined || value === "") return null;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;

  if (type === "nps") {
    if (v < 0 || v > 10) return null;
    return (v / 10) * 100;
  }
  if (type === "stars") {
    if (v < 1 || v > 5) return null;
    return ((v - 1) / 4) * 100;
  }
  return null;
}

// Build {key: {type, index}} from a template's question array.
function questionMap(template) {
  const map = {};
  const questions = template && Array.isArray(template.questions) ? template.questions : [];
  for (const q of questions) {
    if (!q || !q.key) continue;
    map[q.key] = { type: q.type, index: isIndex(q.index) ? q.index : null };
  }
  return map;
}

// Pull answers out of a response, preferring the JSON blob and falling back to
// the legacy fixed columns so historical responses still score.
function answersFor(response) {
  if (response && response.answers && typeof response.answers === "object" && !Array.isArray(response.answers)) {
    const keys = Object.keys(response.answers);
    if (keys.length) return { answers: response.answers, legacy: false };
  }
  return {
    legacy: true,
    answers: {
      q1: response?.q1_nps ?? null,
      q2: response?.q2_overall_stars ?? null,
      q3: response?.q3_food_stars ?? null,
      q4: response?.q4_service_stars ?? null,
    },
  };
}

// Score one response. Returns { CHI, SSI, OHI } where each value is 0-100 or
// null when the response contained nothing scoreable for that index.
function scoreResponse(response, template) {
  const qmap = questionMap(template);
  const { answers, legacy } = answersFor(response);
  const sums = {};
  const counts = {};

  for (const [key, raw] of Object.entries(answers)) {
    const meta = qmap[key];
    // Fall back to legacy shape only where the template says nothing.
    const type = meta?.type ?? (legacy ? LEGACY_QUESTION_TYPES[key] : undefined);
    const index = meta ? meta.index : legacy ? LEGACY_INDEX_MAP[key] : null;
    if (!index || !isIndex(index)) continue;

    const norm = normalize(type, raw);
    if (norm === null) continue;

    sums[index] = (sums[index] ?? 0) + norm;
    counts[index] = (counts[index] ?? 0) + 1;
  }

  const out = {};
  for (const idx of INDEXES) {
    out[idx] = counts[idx] ? sums[idx] / counts[idx] : null;
  }
  return out;
}

// Average a set of responses into one index score per index, plus the number
// of responses that actually contributed to each.
function aggregate(responses, templateById) {
  const sums = {};
  const counts = {};

  for (const r of responses || []) {
    const template = r.survey_templates
      || (templateById && r.template_id ? templateById[r.template_id] : null);
    const scored = scoreResponse(r, template);
    for (const idx of INDEXES) {
      if (scored[idx] === null) continue;
      sums[idx] = (sums[idx] ?? 0) + scored[idx];
      counts[idx] = (counts[idx] ?? 0) + 1;
    }
  }

  const out = {};
  for (const idx of INDEXES) {
    out[idx] = counts[idx] ? Math.round((sums[idx] / counts[idx]) * 10) / 10 : null;
    out[`${idx}_responses`] = counts[idx] ?? 0;
  }
  return out;
}

// Which indices a template actually covers — powers the "this template
// doesn't feed SSI" warning in the builder.
function templateCoverage(template) {
  const covered = new Set();
  const questions = template && Array.isArray(template.questions) ? template.questions : [];
  for (const q of questions) {
    if (q && isIndex(q.index)) covered.add(q.index);
  }
  return {
    covered: INDEXES.filter((i) => covered.has(i)),
    missing: INDEXES.filter((i) => !covered.has(i)),
    unscored: questions.filter((q) => q && q.type !== "text" && !isIndex(q.index)).length,
  };
}

module.exports = {
  INDEXES,
  INDEX_LABELS,
  LEGACY_INDEX_MAP,
  isIndex,
  normalize,
  questionMap,
  scoreResponse,
  aggregate,
  templateCoverage,
};
