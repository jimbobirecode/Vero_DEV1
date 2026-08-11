// The granular half of a period report.
//
// lib/report.js builds the headline model — one row per outlet, one per month.
// This is what sits underneath it: the same responses cut by time, by
// question, and by who the member was and when they came in.
//
// Everything here is a pure function over an array of response rows, for the
// same reason the rest of the report is: the screen, the spreadsheet and the
// PDF must not each do their own arithmetic. The route fetches rows once and
// hands them to these functions; the renderers only lay out what comes back.
//
// A row is whatever the route selected, but these fields are the contract:
//
//   submitted_at      when the member answered (ISO)
//   q1_nps            0-10, or null
//   q2_overall_stars  1-5, or null   (q3_food_stars, q4_service_stars likewise)
//   q5_comment        text, or null
//   answers           jsonb from the survey page, keyed by question key
//   template_id       which template was answered
//   visits.visit_date the day of the visit (date, no time)
//   visits.visit_time the time, when the POS export carried one — see below
//   visits.visitor_type  member | visitor | commercial | other | golf
//   visits.outlets.name  the outlet

const { INDEX_LABELS } = require("./scoring");

const round = (n, dp = 1) => (n == null || Number.isNaN(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// ---------------------------------------------------------------------------
// NPS, as its three parts
// ---------------------------------------------------------------------------
// The net score hides its own composition: 40% promoters against 20%
// detractors nets to the same +20 as 60% against 40%, and those are different
// clubs with different problems. The standard cuts are 9-10, 7-8, 0-6.
function npsBreakdown(rows) {
  const scores = rows.map((r) => r.q1_nps).filter((n) => n != null).map(Number);
  const total = scores.length;
  if (!total) return { responses: 0, promoters: 0, passives: 0, detractors: 0, nps: null };

  const promoters = scores.filter((n) => n >= 9).length;
  const passives = scores.filter((n) => n >= 7 && n <= 8).length;
  const detractors = scores.filter((n) => n <= 6).length;

  return {
    responses: total,
    promoters, passives, detractors,
    promoter_pct: round((promoters / total) * 100, 1),
    passive_pct: round((passives / total) * 100, 1),
    detractor_pct: round((detractors / total) * 100, 1),
    nps: round(((promoters - detractors) / total) * 100, 0),
  };
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------
// A month is too coarse to act on and a single response is too fine to read,
// so the caller picks. Weeks start on Monday, matching how a club talks about
// a trading week.
const GRANULARITIES = ["day", "week", "month"];

function bucketKey(dateStr, granularity) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  if (granularity === "month") return dateStr.slice(0, 7);
  if (granularity === "week") {
    // Monday of this date's week, in UTC so the bucket never shifts with the
    // server's timezone.
    const day = (d.getUTCDay() + 6) % 7;      // 0 = Monday
    d.setUTCDate(d.getUTCDate() - day);
    return d.toISOString().slice(0, 10);
  }
  return dateStr.slice(0, 10);
}

// The period each bucket covers, so a renderer can label "w/c 3 Aug" rather
// than printing a bare date and leaving the reader to work out what it means.
function bucketLabel(key, granularity) {
  if (granularity === "month") {
    const [y, m] = key.split("-");
    return new Date(Date.UTC(+y, +m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  }
  const d = new Date(`${key}T00:00:00Z`);
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return granularity === "week" ? `w/c ${day}` : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function dateOf(row) {
  return row?.visits?.visit_date || (row?.submitted_at ? String(row.submitted_at).slice(0, 10) : null);
}

// Aggregate one set of rows into the figures every breakdown reports, so a
// column means the same thing whichever table it appears in.
function aggregate(rows) {
  const nums = (k) => rows.map((r) => r[k]).filter((v) => v != null).map(Number);
  const nps = npsBreakdown(rows);
  return {
    responses: rows.length,
    nps: nps.nps,
    promoters: nps.promoters,
    detractors: nps.detractors,
    csat: round(mean(nums("q2_overall_stars")), 2),
    food: round(mean(nums("q3_food_stars")), 2),
    service: round(mean(nums("q4_service_stars")), 2),
    comments: rows.filter((r) => r.q5_comment && String(r.q5_comment).trim()).length,
  };
}

function byPeriod(rows, granularity = "week") {
  const g = GRANULARITIES.includes(granularity) ? granularity : "week";
  const buckets = new Map();
  for (const r of rows) {
    const d = dateOf(r);
    if (!d) continue;
    const key = bucketKey(d, g);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, group]) => ({ key, label: bucketLabel(key, g), granularity: g, ...aggregate(group) }));
}

// Each outlet's own trend. The period total tells you the Grill is down; this
// tells you whether it has been down all month or fell off a cliff on the 12th.
function byOutletPeriod(rows, granularity = "week") {
  const byOutlet = new Map();
  for (const r of rows) {
    const name = r?.visits?.outlets?.name;
    if (!name) continue;
    if (!byOutlet.has(name)) byOutlet.set(name, []);
    byOutlet.get(name).push(r);
  }
  return [...byOutlet.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([outlet, group]) => ({ outlet, periods: byPeriod(group, granularity) }));
}

// ---------------------------------------------------------------------------
// Segments — who, and when
// ---------------------------------------------------------------------------
const VISITOR_TYPE_LABELS = {
  member: "Members", visitor: "Visitors", commercial: "Corporate",
  golf: "Golf", other: "Other",
};
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Lunch or dinner, when the visit has a time at all.
//
// visits.visit_date is a date. A clock time only exists when the POS export
// carried one and the column is present, so this returns null rather than
// guessing — a report that splits lunch from dinner by inventing the split is
// worse than one that says it cannot.
function daypart(row) {
  const t = row?.visits?.visit_time;
  if (!t) return null;
  const hour = parseInt(String(t).slice(0, 2), 10);
  if (!Number.isInteger(hour)) return null;
  if (hour < 11) return "Breakfast";
  if (hour < 16) return "Lunch";
  return "Dinner";
}

function segment(rows, keyFn, labelFn, order = null) {
  const groups = new Map();
  for (const r of rows) {
    const key = keyFn(r);
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  let entries = [...groups.entries()];
  entries = order
    ? entries.sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    : entries.sort((a, b) => b[1].length - a[1].length);
  return entries.map(([key, group]) => ({ key, label: labelFn(key), ...aggregate(group) }));
}

function bySegment(rows) {
  const weekdayOf = (r) => {
    const d = dateOf(r);
    if (!d) return null;
    const dt = new Date(`${d}T00:00:00Z`);
    return Number.isNaN(dt.getTime()) ? null : String(dt.getUTCDay());
  };

  const dayparts = segment(rows, daypart, (k) => k, ["Breakfast", "Lunch", "Dinner"]);

  return {
    visitor_type: segment(rows, (r) => r?.visits?.visitor_type || null,
      (k) => VISITOR_TYPE_LABELS[k] || k),
    weekday: segment(rows, weekdayOf, (k) => WEEKDAYS[+k],
      ["1", "2", "3", "4", "5", "6", "0"]),   // Monday first
    daypart: dayparts,
    // Said once, here, so no renderer has to decide whether an empty array
    // means "no lunches" or "we do not record the time".
    daypart_available: dayparts.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Question by question
// ---------------------------------------------------------------------------
// Everything above reports the four columns the schema has had from the start.
// A club that adds a question in the Builder can see the answers in the survey
// log and nowhere else — it has never appeared in a report. This reports every
// question in every template that was answered during the period, whether or
// not it is tagged to an index.
function answerFor(row, question) {
  const key = question.key;
  if (row.answers && Object.prototype.hasOwnProperty.call(row.answers, key)) return row.answers[key];
  // Databases that predate the answers column still store the first five
  // questions in their own columns.
  const legacy = {
    q1: row.q1_nps, q2: row.q2_overall_stars, q3: row.q3_food_stars,
    q4: row.q4_service_stars, q5: row.q5_comment,
    q1_nps: row.q1_nps, q2_overall_stars: row.q2_overall_stars,
    q3_food_stars: row.q3_food_stars, q4_service_stars: row.q4_service_stars,
    q5_comment: row.q5_comment,
  };
  return Object.prototype.hasOwnProperty.call(legacy, key) ? legacy[key] : undefined;
}

function questionStats(question, values) {
  const type = question.type || "stars";
  const answered = values.filter((v) => v != null && v !== "");

  if (type === "text") {
    return {
      type, answered: answered.length,
      // Length is the only thing worth reporting in aggregate about free text;
      // the comments themselves belong in the survey log, not a board pack.
      average_length: answered.length
        ? Math.round(answered.reduce((a, v) => a + String(v).length, 0) / answered.length)
        : null,
    };
  }

  const nums = answered.map(Number).filter((n) => !Number.isNaN(n));
  const max = type === "nps" ? 10 : 5;
  const distribution = [];
  for (let i = type === "nps" ? 0 : 1; i <= max; i++) {
    distribution.push({ value: i, count: nums.filter((n) => n === i).length });
  }

  return {
    type,
    answered: nums.length,
    average: round(mean(nums), 2),
    // Normalised to 0-100 the same way the indices are, so a five-star
    // question and an NPS question can sit in one column and be compared.
    normalised: nums.length ? round((mean(nums) / max) * 100, 1) : null,
    distribution,
  };
}

function byQuestion(rows, templates = []) {
  const rowsByTemplate = new Map();
  for (const r of rows) {
    const id = r.template_id || r.survey_templates?.template_id || null;
    if (!rowsByTemplate.has(id)) rowsByTemplate.set(id, []);
    rowsByTemplate.get(id).push(r);
  }

  const out = [];
  for (const tpl of templates) {
    const group = rowsByTemplate.get(tpl.template_id) || [];
    if (!group.length) continue;
    const questions = Array.isArray(tpl.questions) ? tpl.questions : [];
    out.push({
      template_id: tpl.template_id,
      template: tpl.name,
      survey_type: tpl.survey_type,
      responses: group.length,
      questions: questions.map((q) => ({
        key: q.key,
        title: q.title || q.key,
        required: q.required !== false,
        // Null is the honest answer for an untagged question: it is collected
        // and reported here, and it moves no index. See lib/scoring.js.
        index: q.index || null,
        index_label: q.index ? (INDEX_LABELS[q.index] || q.index) : null,
        ...questionStats(q, group.map((r) => answerFor(r, q))),
      })),
    });
  }
  return out;
}

module.exports = {
  npsBreakdown,
  byPeriod, byOutletPeriod, bucketKey, bucketLabel,
  bySegment, daypart,
  byQuestion,
  aggregate,
  GRANULARITIES, VISITOR_TYPE_LABELS, WEEKDAYS,
};
