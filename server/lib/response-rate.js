// How many of the surveys we sent came back, cut the ways a club can act on.
//
// The headline figure has been on the report for a while as one number. One
// number cannot be acted on: 38% is a fine club-wide rate and a disaster in the
// room that sends 300 of them, and the two are indistinguishable until the rate
// is split by where, when and what.
//
// The rule everything here follows, and the one that makes the arithmetic
// defensible:
//
//   A survey belongs to the period it was SENT in. It counts as answered
//   whenever the answer arrived, even if that was after the period closed.
//
// The alternative — counting responses that arrived inside the window against
// sends inside the window — quietly punishes the last few days of every report.
// A survey sent on the Friday and answered on the Monday lands in the
// denominator and never in the numerator, so a club that sent more towards the
// end of a month reads as though its rate fell. Cohorts, not calendars.
//
// The cost of the honest rule is that the most recent days are still settling:
// their surveys have had less time to be answered than the ones at the start.
// That is stated rather than smoothed away — see `settling` below — because a
// footnote is cheaper than a club distrusting the whole table.
//
// Pure. Rows in, plain objects out, no database.

const { bucketKey, bucketLabel, VISITOR_TYPE_LABELS, GRANULARITIES } = require("./report-detail");

const HOUR = 3600000;

// Zero sent is "no rate", not 0%. Dividing by it gives NaN or Infinity, and
// both render as something alarming for what is only a quiet week.
function rate(responded, sent) {
  if (!sent) return null;
  return Math.round((responded / sent) * 1000) / 10;
}

// A survey is answered if it carries a submission time. is_complete is
// deliberately not consulted: a member who answered the first two questions and
// closed the tab responded — the club got feedback, and counting that as
// silence would flatter nobody.
const answered = (r) => Boolean(r && r.submitted_at);

// When the survey went out. created_at is written when the row is made, which
// is at send time.
const sentAt = (r) => r?.created_at || null;

// Group rows, count both halves, and rate them.
function tally(rows, keyOf, labelOf = (k) => k) {
  const groups = new Map();
  for (const r of rows || []) {
    const key = keyOf(r);
    if (key == null) continue;
    let g = groups.get(key);
    if (!g) { g = { key, label: labelOf(key, r), sent: 0, responded: 0 }; groups.set(key, g); }
    g.sent++;
    if (answered(r)) g.responded++;
  }
  return [...groups.values()].map((g) => ({ ...g, rate: rate(g.responded, g.sent) }));
}

// ------------------------------------------------------------- the whole --

function overall(rows) {
  const sent = (rows || []).length;
  const responded = (rows || []).filter(answered).length;
  return { sent, responded, rate: rate(responded, sent) };
}

// --------------------------------------------------------------- by where --

// The outlet the visit was to. A survey with no visit behind it — an event
// survey — is not an outlet's to answer for, and is reported separately rather
// than dropped or lumped into whichever outlet happens to sort first.
const outletOf = (r) => r?.visits?.outlets?.name || null;

function byOutlet(rows) {
  return tally(rows, outletOf).sort((a, b) => b.sent - a.sent || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------- by when --

function byPeriod(rows, granularity = "week") {
  const g = GRANULARITIES.includes(granularity) ? granularity : "week";
  return tally(
    rows,
    (r) => (sentAt(r) ? bucketKey(sentAt(r).slice(0, 10), g) : null),
    (key) => bucketLabel(key, g)
  ).sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------- by what --

// Which survey it was. Templates carry the readable name; a response whose
// template has since been deleted still counts, under its id, rather than
// vanishing from a total that has to add up.
function byTemplate(rows, templates = []) {
  const names = new Map((templates || []).map((t) => [t.template_id, t.name]));
  return tally(
    rows,
    (r) => r?.template_id || "__none__",
    (key) => (key === "__none__" ? "No template" : names.get(key) || "Deleted template")
  ).sort((a, b) => b.sent - a.sent);
}

// --------------------------------------------------------------- by whom ---

function byVisitorType(rows) {
  return tally(
    rows,
    (r) => r?.visits?.visitor_type || null,
    (key) => VISITOR_TYPE_LABELS[key] || key
  ).sort((a, b) => b.sent - a.sent);
}

// ------------------------------------------------------- how long it takes --

// How quickly the answers come back.
//
// The median rather than the mean: one member who answers three weeks later
// drags a mean into uselessness, and the question this answers — how long is
// worth waiting before a reminder is pointless — needs the typical case.
//
// same_day and within_48h are the two numbers a club will actually use. If
// nine in ten answers arrive within a day, a reminder sent on day four is
// chasing people who were never going to reply.
function speed(rows) {
  const gaps = [];
  for (const r of rows || []) {
    if (!answered(r) || !sentAt(r)) continue;
    const gap = Date.parse(r.submitted_at) - Date.parse(sentAt(r));
    // A negative gap means the clocks disagree, not that somebody answered
    // before they were asked. Dropped rather than counted as instant.
    if (Number.isFinite(gap) && gap >= 0) gaps.push(gap);
  }
  if (!gaps.length) return { answers: 0, median_hours: null, same_day_pct: null, within_48h_pct: null };

  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;

  return {
    answers: gaps.length,
    median_hours: Math.round((median / HOUR) * 10) / 10,
    same_day_pct: Math.round((gaps.filter((g) => g <= 24 * HOUR).length / gaps.length) * 1000) / 10,
    within_48h_pct: Math.round((gaps.filter((g) => g <= 48 * HOUR).length / gaps.length) * 1000) / 10,
  };
}

// ------------------------------------------------------- still settling ----

// How much of the period has not had time to answer yet.
//
// Reported, not corrected. Excluding recent sends would make the rate look
// better and make two reports of the same period disagree; leaving it unsaid
// invites "our response rate is falling" when what fell is the number of days
// the last cohort has had. The window is the median time to respond, rounded up
// to whole days and floored at one, so a club whose members answer within the
// hour is not told to discount three days of sends.
function settling(rows, { now = Date.now(), medianHours = null } = {}) {
  const rowsWithSend = (rows || []).filter((r) => sentAt(r));
  if (!rowsWithSend.length) return { sent: 0, responded: 0, hours: 0 };

  const hours = Math.max(24, Math.ceil((medianHours ?? 24) / 24) * 24);
  const cutoff = now - hours * HOUR;
  const recent = rowsWithSend.filter((r) => Date.parse(sentAt(r)) >= cutoff);

  return {
    sent: recent.length,
    responded: recent.filter(answered).length,
    hours,
    // The rate over everything that has had a fair chance, which is the figure
    // to compare against last month's.
    settled_rate: rate(
      rowsWithSend.filter((r) => Date.parse(sentAt(r)) < cutoff && answered(r)).length,
      rowsWithSend.filter((r) => Date.parse(sentAt(r)) < cutoff).length
    ),
  };
}

// ------------------------------------------------------------ everything ---

function build(rows, { templates = [], granularity = "week", now = Date.now() } = {}) {
  const all = Array.isArray(rows) ? rows : [];
  const totals = overall(all);
  const timing = speed(all);

  return {
    ...totals,
    unanswered: totals.sent - totals.responded,
    by_outlet: byOutlet(all),
    by_period: byPeriod(all, granularity),
    by_template: byTemplate(all, templates),
    by_visitor_type: byVisitorType(all),
    speed: timing,
    settling: settling(all, { now, medianHours: timing.median_hours }),
  };
}

module.exports = {
  build, overall, byOutlet, byPeriod, byTemplate, byVisitorType, speed, settling, rate, tally,
};
