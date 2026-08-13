// The report model — one shape, three renderings.
//
// A report that is assembled separately for the screen, the spreadsheet and the
// PDF drifts, and the drift is invisible until a GM emails a board pack whose
// NPS disagrees with the dashboard they were looking at an hour earlier. So the
// numbers are computed exactly once, here, and the three renderers are dumb: a
// JSON passthrough, an exceljs writer, and a pdfkit writer, none of which does
// any arithmetic of its own.
//
// Pure. Everything arrives as arguments and leaves as a plain object, so the
// whole model can be tested without a database, a spreadsheet or a PDF.

// Uppercase, and the same labels lib/scoring.js uses.
//
// These were lowercase here at first, which silently emptied the whole indices
// section: aggregate() keys its output CHI/SSI/OHI, so overall["chi"] was always
// undefined and every index got filtered out as "not fed". The unit test did not
// catch it because the fixture had been written to match this file rather than
// to match what /api/scores actually returns — a fixture invented from the
// consumer's assumptions tests the assumption, not the contract.
const INDEX_LABELS = {
  CHI: "Club Health Index",
  SSI: "Service Satisfaction Index",
  OHI: "Operational Health Index",
};

const detail = require("./report-detail");
const responseRates = require("./response-rate");

function round(n, dp = 1) {
  if (n == null || !isFinite(n)) return null;
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

function pct(n) {
  return n == null ? null : round(n, 1);
}

// Change between two numbers, with the direction stated rather than left to a
// sign the reader has to interpret.
function delta(current, previous, dp = 1) {
  if (current == null || previous == null) return null;
  const diff = round(current - previous, dp);
  return {
    value: diff,
    direction: diff > 0 ? "up" : diff < 0 ? "down" : "flat",
    // Formatted here so every renderer writes the same string. A PDF that says
    // +0.5 beside a spreadsheet that says 0.5 looks like two different numbers.
    label: diff > 0 ? `+${diff}` : diff < 0 ? String(diff) : "no change",
  };
}

// A response rate, guarded.
//
// Sent can legitimately be zero — a quiet week, a club that has not started —
// and dividing by it produces either Infinity or NaN, both of which render as
// something alarming. Zero sent is "no rate", not "0%".
function responseRate(responded, sent) {
  if (!sent) return null;
  return round((responded / sent) * 100, 1);
}

// A period, as both machine bounds and something a person reads on a cover page.
function period(from, to) {
  const start = new Date(from), end = new Date(to);
  const fmt = (d) => d.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const days = Math.max(1, Math.round((end - start) / 86400000));
  return { from, to, label: `${fmt(start)} — ${fmt(end)}`, days };
}

// -------------------------------------------------------------- the model --

// Assemble the report.
//
// Every input is optional: a club that has not uploaded POS data has no outlet
// section, one that has never sent a survey has no scores. A report that throws
// because a club is new is worse than one that says "no data for this period",
// so each section degrades to an explicit empty rather than to an exception.
function build({
  clubName = "Club",
  from, to,
  scores = null,          // /api/scores payload
  previousScores = null,  // the same, for the preceding period
  leaderboard = [],       // /api/staff/leaderboard
  alerts = null,          // /api/alerts/severity-stats
  credit = null,          // { balance_cents, currency, usage: [...] }
  surveys = null,         // { sent, responded }
  sentSurveys = [],       // the period's sends, answered or not, for the rate cuts
  responses = [],         // the period's raw responses, for the granular cuts
  previousResponses = [], // the same for the preceding period, for the deltas
  templates = [],         // survey templates, so every question can be reported
  events = null,          // lib/event-scores summarise() output
  granularity = "week",   // day | week | month, for the trend tables
  generatedAt,
} = {}) {
  const p = period(from, to);

  // /api/scores answers one question — what are CHI, SSI and OHI — and returns
  // only those. It carries no NPS, CSAT, food or service figure, so a report
  // that read them from there printed a dash in every one of those columns.
  // They are derived from the responses instead, which is also the only way
  // the headline can agree with the breakdowns underneath it.
  const rowsNow = Array.isArray(responses) ? responses : [];
  const rowsPrev = Array.isArray(previousResponses) ? previousResponses : [];
  const derived = detail.aggregate(rowsNow);
  const derivedPrev = detail.aggregate(rowsPrev);

  const overall = { ...(scores?.overall || {}) };
  const prev = { ...(previousScores?.overall || {}) };
  if (overall.nps == null && rowsNow.length) overall.nps = derived.nps;
  if (overall.csat == null && rowsNow.length) overall.csat = derived.csat;
  if (prev.nps == null && rowsPrev.length) prev.nps = derivedPrev.nps;
  if (prev.csat == null && rowsPrev.length) prev.csat = derivedPrev.csat;

  // Who was asked and who answered, by room, by week, by survey and by type of
  // member. Built from the sends themselves rather than from a pair of counts,
  // because a rate is only worth reading once you can see which part of the
  // club it came from.
  const sends = Array.isArray(sentSurveys) ? sentSurveys : [];
  const rates = sends.length
    ? responseRates.build(sends, { templates, granularity, now: generatedAt ? Date.parse(generatedAt) : Date.now() })
    : null;

  // Headline figures, each with its change against the preceding period of the
  // same length — a number with no comparison is a number nobody can act on.
  const headline = [
    { key: "nps", label: "NPS", value: round(overall.nps, 0), previous: round(prev.nps, 0), format: "number" },
    { key: "csat", label: "CSAT", value: round(overall.csat, 2), previous: round(prev.csat, 2), format: "rating" },
    { key: "responses", label: "Responses", value: scores?.response_count ?? 0, previous: previousScores?.response_count ?? null, format: "count" },
    {
      key: "response_rate", label: "Response rate",
      // From the same rows as the table below it. Reading the headline from a
      // count query and the breakdown from the rows is how a report ends up
      // disagreeing with itself two panels apart.
      value: rates ? rates.rate : (surveys ? responseRate(surveys.responded, surveys.sent) : null),
      previous: null, format: "percent",
    },
  ].map((h) => ({ ...h, delta: delta(h.value, h.previous, h.format === "rating" ? 2 : h.format === "number" ? 0 : 1) }));

  // The three club indices, when the templates feed them.
  //
  // Labels come from the scores payload when it carries them, so the report
  // cannot drift from what the dashboard calls the same index.
  const labels = scores?.labels || INDEX_LABELS;
  const indices = Object.keys(INDEX_LABELS).map((key) => ({
    key,
    label: labels[key] || INDEX_LABELS[key],
    value: round(overall[key], 1),
    previous: round(prev[key], 1),
    delta: delta(round(overall[key], 1), round(prev[key], 1), 1),
  })).filter((i) => i.value != null);

  // Per outlet: the response counts come from the scores payload, the scores
  // themselves from the rows, for the reason above.
  const byOutletRows = new Map();
  for (const r of rowsNow) {
    const name = r?.visits?.outlets?.name;
    if (!name) continue;
    if (!byOutletRows.has(name)) byOutletRows.set(name, []);
    byOutletRows.get(name).push(r);
  }
  const outlets = (scores?.by_outlet || []).map((o) => {
    const own = byOutletRows.get(o.outlet);
    const a = own ? detail.aggregate(own) : null;
    return {
      outlet: o.outlet,
      responses: o.response_count,
      nps: o.nps != null ? round(o.nps, 0) : (a ? a.nps : null),
      csat: o.csat != null ? round(o.csat, 2) : (a ? a.csat : null),
      food: o.food != null ? round(o.food, 2) : (a ? a.food : null),
      service: o.service != null ? round(o.service, 2) : (a ? a.service : null),
    };
  });

  const derivedMonths = detail.byPeriod(rowsNow, "month");
  const months = (scores?.by_month || []).map((m) => {
    const own = derivedMonths.find((x) => x.key === m.month);
    return {
      month: m.month,
      responses: m.response_count,
      nps: m.nps != null ? round(m.nps, 0) : (own ? own.nps : null),
      csat: m.csat != null ? round(m.csat, 2) : (own ? own.csat : null),
    };
  });

  const servers = (leaderboard || []).map((s, i) => ({
    rank: i + 1,
    name: s.server_name,
    surveys: s.survey_count,
    composite: round(s.composite_score, 1),
    nps: round(s.avg_nps, 1),
    overall: round(s.avg_overall, 1),
    food: round(s.avg_food, 1),
    service: round(s.avg_service, 1),
  }));

  const alertRows = (alerts?.by_severity || []).map((a) => {
    const open = (alerts.open_by_severity || []).find((o) => o.severity === a.severity);
    return {
      severity: a.severity,
      label: a.severity.charAt(0).toUpperCase() + a.severity.slice(1),
      raised: a.count,
      open: open ? open.count : 0,
      // Stated rather than left to the reader to divide. A club looking at a
      // board pack should not have to do arithmetic to find the bad news.
      resolved: Math.max(0, a.count - (open ? open.count : 0)),
    };
  });

  const creditUsage = (credit?.usage || []).map((u) => ({
    date: u.date, type: u.label || u.kind, messages: u.messages,
    cost_cents: round(u.amount_cents, 2),
  }));

  // The granular half. Every one of these is derived from the same response
  // rows, by lib/report-detail.js, so a figure here cannot disagree with the
  // headline above it — they are the same answers grouped differently.
  const nps_breakdown = detail.npsBreakdown(rowsNow);
  const periods = detail.byPeriod(rowsNow, granularity);
  const outlet_periods = detail.byOutletPeriod(rowsNow, granularity);
  const segments = detail.bySegment(rowsNow);
  const questions = detail.byQuestion(rowsNow, templates || []);

  const eventRows = (events?.events || []).map((e) => ({
    name: e.name,
    date: e.event_date,
    category: e.category,
    responses: e.responses ?? e.response_count ?? 0,
    nps: round(e.nps, 0),
    csat: round(e.csat, 2),
  }));

  return {
    club: clubName,
    period: p,
    generated_at: generatedAt || null,
    granularity,
    headline,
    indices,
    nps_breakdown,
    outlets,
    months,
    periods,
    outlet_periods,
    segments,
    questions,
    response_rate: rates,
    events: events ? {
      nps: round(events.nps, 0),
      csat: round(events.csat, 2),
      responses: events.responses ?? 0,
      by_category: events.by_category || null,
      list: eventRows,
    } : null,
    servers,
    alerts: alertRows,
    alerts_total: alerts?.total ?? 0,
    alerts_open: alerts?.open ?? 0,
    credit: credit ? {
      balance_cents: credit.balance_cents ?? 0,
      currency: credit.currency || "USD",
      spend_cents: round(creditUsage.reduce((a, u) => a + (u.cost_cents || 0), 0), 2),
      messages: creditUsage.reduce((a, u) => a + (u.messages || 0), 0),
      usage: creditUsage,
    } : null,
    // What is genuinely absent, said once, so a renderer never has to guess
    // whether an empty array means "nothing happened" or "not configured".
    empty_sections: [
      !outlets.length && "outlets",
      !servers.length && "servers",
      !alertRows.length && "alerts",
      !months.length && "trend",
      !periods.length && "periods",
      !questions.length && "questions",
      !segments.visitor_type.length && "segments",
      !rates && "response_rate",
      !eventRows.length && "events",
      !segments.daypart_available && "daypart",
      !credit && "credit",
    ].filter(Boolean),
  };
}

// The sheets a workbook contains, and the order they appear in. Shared so the
// spreadsheet and the PDF cover the same ground in the same sequence.
function sections(model) {
  const out = [
    { key: "summary", title: "Summary" },
  ];
  if (model.indices.length) out.push({ key: "indices", title: "Club indices" });
  if (model.outlets.length) out.push({ key: "outlets", title: "By outlet" });
  if (model.nps_breakdown && model.nps_breakdown.responses) {
    out.push({ key: "nps_breakdown", title: "NPS composition" });
  }
  if (model.months.length) out.push({ key: "trend", title: "Month on month" });
  if (model.periods && model.periods.length) {
    const g = model.granularity === "day" ? "Day by day" : model.granularity === "month" ? "Month by month" : "Week by week";
    out.push({ key: "periods", title: g });
  }
  if (model.outlet_periods && model.outlet_periods.length) out.push({ key: "outlet_periods", title: "Outlet trends" });
  if (model.response_rate && model.response_rate.sent) {
    out.push({ key: "response_rate", title: "Response rate" });
  }
  if (model.segments && model.segments.visitor_type.length) out.push({ key: "segments", title: "Segments" });
  if (model.questions && model.questions.length) out.push({ key: "questions", title: "Question detail" });
  if (model.events && model.events.list.length) out.push({ key: "events", title: "Events" });
  if (model.servers.length) out.push({ key: "servers", title: "Server performance" });
  if (model.alerts.length) out.push({ key: "alerts", title: "Case alerts" });
  if (model.credit && model.credit.usage.length) out.push({ key: "credit", title: "SMS credit" });
  return out;
}

// A filename someone can find again in six months. Dated, slugged, and without
// the characters Windows refuses.
function filename(model, ext) {
  const slug = String(model.club || "club").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "club";
  return `${slug}-report-${model.period.from.slice(0, 10)}-to-${model.period.to.slice(0, 10)}.${ext}`;
}

module.exports = { build, sections, filename, period, delta, responseRate, round, pct, INDEX_LABELS };
