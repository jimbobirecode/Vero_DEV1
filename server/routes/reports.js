// Reportable analytics, in three formats off one model.
//
// GET /api/reports/summary            → JSON, for the screen
// GET /api/reports/summary.xlsx       → workbook
// GET /api/reports/summary.pdf        → board pack
//
// All three call the same gather() and the same report.build(), so a figure in
// the PDF cannot disagree with the same figure on the dashboard. The renderers
// do no arithmetic — see lib/report.js for why that matters.

const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");
const { log, ACTIONS } = require("../lib/audit");
const { CLUB_NAME } = require("../lib/club-config");
const report = require("../lib/report");
const render = require("../lib/report-render");
const credit = require("../lib/sms-credit");

// Reuse the score aggregation the dashboard already reads, rather than writing
// a second one. Two implementations of NPS is two answers to "what is our NPS".
const scoresRoute = require("./scores");

// Resolve ?from/?to, defaulting to the last 30 days.
function resolveRange(query) {
  const to = query.to ? new Date(query.to) : new Date();
  if (isNaN(to)) return { error: "to is not a valid date" };

  let from;
  if (query.from) {
    from = new Date(query.from);
    if (isNaN(from)) return { error: "from is not a valid date" };
  } else {
    const days = Math.min(Math.max(parseInt(query.days, 10) || 30, 1), 730);
    from = new Date(to.getTime() - days * 86400000);
  }
  if (from >= to) return { error: "from must be before to" };

  // A report over five years is a request nobody makes on purpose, and it is a
  // slow query against every table at once.
  if ((to - from) / 86400000 > 730) return { error: "A report can cover at most two years." };

  return { from: from.toISOString(), to: to.toISOString() };
}

// The period immediately before this one, of the same length — so "previous"
// means a comparable stretch rather than an arbitrary month.
function precedingRange({ from, to }) {
  const span = new Date(to) - new Date(from);
  return {
    from: new Date(new Date(from).getTime() - span).toISOString(),
    to: from,
  };
}

async function fetchJson(handler, query) {
  // The score route is an Express handler; calling it directly avoids an HTTP
  // round trip to ourselves and keeps the auth context out of it.
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve(this.statusCode === 200 ? body : null); },
    };
    Promise.resolve(handler({ query }, res)).catch(() => resolve(null));
  });
}

function findRoute(router_, path) {
  const layer = router_.stack.find((l) => l.route && l.route.path === path && l.route.methods.get);
  return layer ? layer.route.stack[0].handle : null;
}

async function gather(range) {
  const scoresHandler = findRoute(scoresRoute, "/");
  const previous = precedingRange(range);

  // In parallel: none of these depends on another, and a report that takes
  // four sequential round trips to Supabase is a report nobody waits for.
  const [scores, previousScores, leaderboard, alerts, creditData, surveys] = await Promise.all([
    scoresHandler ? fetchJson(scoresHandler, { start: range.from.slice(0, 10), end: range.to.slice(0, 10) }) : null,
    scoresHandler ? fetchJson(scoresHandler, { start: previous.from.slice(0, 10), end: previous.to.slice(0, 10) }) : null,
    gatherLeaderboard(range),
    gatherAlerts(range),
    gatherCredit(range),
    gatherSurveys(range),
  ]);

  return { scores, previousScores, leaderboard, alerts, credit: creditData, surveys };
}

async function gatherLeaderboard(range) {
  try {
    const { data } = await supabase
      .from("survey_responses")
      .select("q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, submitted_at, visits(server_name)")
      .gte("submitted_at", range.from)
      .lt("submitted_at", range.to)
      .not("submitted_at", "is", null)
      .limit(5000);

    const by = new Map();
    for (const r of data || []) {
      const name = r.visits?.server_name;
      if (!name) continue;
      const e = by.get(name) || { server_name: name, n: 0, nps: 0, overall: 0, food: 0, service: 0 };
      e.n++;
      e.nps += Number(r.q1_nps) || 0;
      e.overall += Number(r.q2_overall_stars) || 0;
      e.food += Number(r.q3_food_stars) || 0;
      e.service += Number(r.q4_service_stars) || 0;
      by.set(name, e);
    }

    return [...by.values()]
      .filter((e) => e.n >= 3)   // fewer than three responses is noise, not a score
      .map((e) => ({
        server_name: e.server_name,
        survey_count: e.n,
        avg_nps: e.nps / e.n,
        avg_overall: e.overall / e.n,
        avg_food: e.food / e.n,
        avg_service: e.service / e.n,
        // The same weighting the Server Performance screen uses.
        composite_score: (e.nps / e.n / 2) * 0.3 + (e.overall / e.n) * 0.3 +
                         (e.food / e.n) * 0.2 + (e.service / e.n) * 0.2,
      }))
      .sort((a, b) => b.composite_score - a.composite_score)
      .slice(0, 25);
  } catch (e) {
    console.error("[reports] leaderboard:", String(e));
    return [];
  }
}

async function gatherAlerts(range) {
  try {
    const out = { by_severity: [], open_by_severity: [], total: 0, open: 0 };
    for (const severity of ["high", "medium", "low"]) {
      const { count } = await supabase.from("case_alerts")
        .select("alert_id", { count: "exact", head: true })
        .gte("created_at", range.from).lt("created_at", range.to).eq("severity", severity);
      const { count: open } = await supabase.from("case_alerts")
        .select("alert_id", { count: "exact", head: true })
        .gte("created_at", range.from).lt("created_at", range.to)
        .eq("severity", severity).eq("status", "open");
      out.by_severity.push({ severity, count: count || 0 });
      out.open_by_severity.push({ severity, count: open || 0 });
      out.total += count || 0;
      out.open += open || 0;
    }
    return out;
  } catch (e) {
    console.error("[reports] alerts:", String(e));
    return null;
  }
}

async function gatherCredit(range) {
  try {
    const store = require("../lib/sms-credit-store");
    const [account, ledger] = await Promise.all([store.getAccount(), store.ledger({ limit: 1000 })]);
    if (!account && !ledger.entries.length) return null;

    const inRange = ledger.entries.filter((e) =>
      e.created_at >= range.from && e.created_at < range.to);

    return {
      balance_cents: Number(account?.balance_cents) || 0,
      currency: account?.currency || "USD",
      usage: credit.summariseLedger(inRange),
    };
  } catch (e) {
    console.error("[reports] credit:", String(e));
    return null;
  }
}

async function gatherSurveys(range) {
  try {
    const { count: sent } = await supabase.from("survey_responses")
      .select("response_id", { count: "exact", head: true })
      .gte("created_at", range.from).lt("created_at", range.to);
    const { count: responded } = await supabase.from("survey_responses")
      .select("response_id", { count: "exact", head: true })
      .gte("created_at", range.from).lt("created_at", range.to)
      .not("submitted_at", "is", null);
    return { sent: sent || 0, responded: responded || 0 };
  } catch (e) {
    console.error("[reports] surveys:", String(e));
    return null;
  }
}

async function buildModel(req) {
  const range = resolveRange(req.query);
  if (range.error) return { error: range.error };

  const parts = await gather(range);
  return {
    model: report.build({
      clubName: CLUB_NAME,
      from: range.from, to: range.to,
      generatedAt: new Date().toISOString(),
      ...parts,
    }),
  };
}

// GET /api/reports/summary — the model, for the screen.
router.get("/summary", async (req, res) => {
  try {
    const { model, error } = await buildModel(req);
    if (error) return res.status(400).json({ error });
    res.json({ ...model, sections: report.sections(model) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// GET /api/reports/summary.xlsx
router.get("/summary.xlsx", async (req, res) => {
  try {
    const { model, error } = await buildModel(req);
    if (error) return res.status(400).json({ error });

    const name = report.filename(model, "xlsx");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    // The quoted filename matters: a club name with a space in it otherwise
    // truncates at the space in some browsers.
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);

    log(req, ACTIONS.REPORT_EXPORTED, { format: "xlsx", from: model.period.from, to: model.period.to });
    await render.toExcel(model, res);
  } catch (e) {
    // Once bytes are on the wire a JSON error body would corrupt the download,
    // so past that point the only honest move is to end the response.
    console.error("[reports] xlsx failed:", String(e));
    if (!res.headersSent) res.status(500).json({ error: String(e.message || e) });
    else res.end();
  }
});

// GET /api/reports/summary.pdf
router.get("/summary.pdf", async (req, res) => {
  try {
    const { model, error } = await buildModel(req);
    if (error) return res.status(400).json({ error });

    const name = report.filename(model, "pdf");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);

    log(req, ACTIONS.REPORT_EXPORTED, { format: "pdf", from: model.period.from, to: model.period.to });
    render.toPdf(model, res);
  } catch (e) {
    console.error("[reports] pdf failed:", String(e));
    if (!res.headersSent) res.status(500).json({ error: String(e.message || e) });
    else res.end();
  }
});

module.exports = router;
