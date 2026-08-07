// End-to-end cover for the back-charge endpoints, against a stubbed database.
//
// lib/sms-billing.test.js proves the arithmetic. This proves the parts that
// only go wrong once a database and an HTTP layer are involved: that a closed
// period cannot be quietly rewritten, that a month cannot be closed while it is
// still running, and — the one that would silently produce a wrong invoice —
// that a statement does not stop at the first page of message_log.
process.env.SUPABASE_URL = "https://p";
process.env.SUPABASE_SERVICE_ROLE_KEY = "s";
process.env.CLUB_ID = "";

let MESSAGES = [], SETTINGS = [], PERIODS = [], INSERTED = [], UPDATED = [];

const Module = require("module");
const rr = Module._resolveFilename;
Module._resolveFilename = function (r, ...x) {
  if (r.endsWith("lib/supabase") || r === "../lib/supabase") return "SB";
  if (r.endsWith("lib/audit") || r === "../lib/audit") return "AUD";
  return rr.call(this, r, ...x);
};

// Range-aware so the pagination loop is genuinely exercised: a stub that
// ignores .range() would return everything on the first call and the loop would
// look correct while being untested.
function from(table) {
  let lo = 0, hi = 999, single = false;
  const api = {
    select: () => api, eq: () => api, gte: () => api, lt: () => api, neq: () => api,
    or: () => api, like: () => api, order: () => api, limit: () => api,
    range: (a, b) => { lo = a; hi = b; return api; },
    single: () => { single = true; return api; },
    insert(row) { INSERTED.push({ table, row }); PERIODS.push({ ...row, period_id: "p-new", closed_at: "2026-08-01T00:00:00Z" }); return api; },
    update(row) { UPDATED.push({ table, row }); return api; },
    then(resolve) {
      let data;
      if (table === "message_log") data = MESSAGES.slice(lo, hi + 1);
      else if (table === "club_settings") data = SETTINGS;
      else if (table === "sms_billing_periods") data = PERIODS;
      else data = [];
      if (INSERTED.length && table === "sms_billing_periods" && single) data = PERIODS[PERIODS.length - 1];
      else if (single) data = data[0] || null;
      return resolve({ data, error: null });
    },
  };
  return api;
}
require.cache["SB"] = { id: "SB", filename: "SB", loaded: true, exports: { supabase: { from } } };
require.cache["AUD"] = { id: "AUD", filename: "AUD", loaded: true, exports: { log: () => {}, ACTIONS: {} } };

const express = require("express");
const router = require("./billing.js");

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { email: "gm@club.com", role: "general_manager" }; next(); });
app.use("/api/billing", router);

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const RATE = [
  { key: "sms_rate_cents_per_segment", value: "0.79" },
  { key: "sms_markup_pct", value: "0" },
  { key: "sms_billing_currency", value: "USD" },
];

const msg = (over = {}) => ({
  log_id: "m" + Math.random().toString(36).slice(2),
  channel: "sms", status: "sent", body: "Club: quick feedback please",
  segments: 1, encoding: "gsm7", unit_price_cents: 0.79, kind: "survey",
  created_at: "2026-07-05T10:00:00Z", club_id: null, ...over,
});

let server;
const call = async (method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));

  SETTINGS = RATE;

  // ------------------------------------------------------------ statement --
  MESSAGES = [msg(), msg(), msg({ segments: 3, encoding: "ucs2" })];
  let r = await call("GET", "/api/billing/sms?period=2026-07");
  check("a statement is served for a month", r.status, 200);
  check("segments are summed across messages", r.body.totals.segments_sent, 5);
  check("the total is the segments at the rate", r.body.totals.amount_cents, 3.95);
  check("an unclosed month reads as open", r.body.status, "open");

  MESSAGES = [msg(), msg({ status: "failed", segments: 3 })];
  r = await call("GET", "/api/billing/sms?period=2026-07");
  check("a failed send is not billed", r.body.totals.amount_cents, 0.79);
  check("but it is shown as not billed", r.body.totals.messages_failed, 1);

  // The failure that produces a wrong invoice with no error anywhere: PostgREST
  // caps a response at 1,000 rows, and a club sending nightly passes that in a
  // month. A statement built from page one alone would simply be short.
  MESSAGES = Array.from({ length: 2350 }, () => msg());
  r = await call("GET", "/api/billing/sms?period=2026-07");
  check("every page of message_log is read, not just the first", r.body.totals.segments_sent, 2350);

  MESSAGES = [];
  r = await call("GET", "/api/billing/sms?period=2026-07");
  check("a month with no sends is a zero invoice", r.body.totals.amount_cents, 0);
  check("and not an error", r.status, 200);

  r = await call("GET", "/api/billing/sms?period=nonsense");
  check("a malformed period is refused", r.status, 400);

  r = await call("GET", "/api/billing/sms?from=2026-08-01&to=2026-07-01");
  check("a backwards date range is refused", r.status, 400);

  // ------------------------------------------------------------- closing ---
  MESSAGES = [msg(), msg({ segments: 2 })];

  r = await call("POST", "/api/billing/sms/close", { period: "2099-01" });
  check("a month that has not happened cannot be closed", r.status, 400);

  const thisMonth = new Date().toISOString().slice(0, 7);
  r = await call("POST", "/api/billing/sms/close", { period: thisMonth });
  check("nor can the month still running", r.status, 400);

  r = await call("POST", "/api/billing/sms/close", { period: "2026-07", invoice_ref: "INV-1" });
  check("a finished month closes", r.status, 200);
  check("and freezes the figures that were invoiced", r.body.period.amount_cents, 2.37);
  check("recording who closed it", r.body.period.closed_by_email, "gm@club.com");

  // Now that the period is closed the statement must serve the frozen number,
  // even though the underlying rows have changed underneath it.
  MESSAGES = [msg(), msg({ segments: 2 }), msg({ segments: 5 })];
  r = await call("GET", "/api/billing/sms?period=2026-07");
  check("a closed period serves the invoiced total", r.body.totals.amount_cents, 2.37);
  check("and is marked closed", r.body.closed, true);
  check("while the drift against live data is shown", r.body.recomputed.amount_cents, 6.32);
  check("and flagged as not matching", r.body.recomputed.matches, false);

  r = await call("POST", "/api/billing/sms/close", { period: "2026-07" });
  check("a closed period cannot be closed twice", r.status, 409);

  r = await call("POST", "/api/billing/sms/reprice", { period: "2026-07", dry_run: false });
  check("and cannot be repriced behind the club's back", r.status, 409);

  // --------------------------------------------------------- voiding ------
  r = await call("POST", "/api/billing/sms/periods/p-new/void", {});
  check("voiding an invoice needs a stated reason", r.status, 400);

  // -------------------------------------------------------- repricing -----
  PERIODS = [];
  MESSAGES = [
    msg({ created_at: "2026-06-05T10:00:00Z", segments: null, encoding: null, unit_price_cents: null, body: "a".repeat(200) }),
    msg({ created_at: "2026-06-06T10:00:00Z" }),
  ];
  r = await call("POST", "/api/billing/sms/reprice", { period: "2026-06" });
  check("repricing defaults to a dry run", r.body.applied, false);
  check("only unmetered rows are counted", r.body.messages_repriced, 1);
  check("and their segments recovered from the body", r.body.segments_recovered, 2);
  check("the price caveat is stated, not buried", typeof r.body.caveat, "string");

  UPDATED = [];
  r = await call("POST", "/api/billing/sms/reprice", { period: "2026-06", dry_run: false });
  check("an explicit run applies", r.body.applied, true);
  check("writing only the metering columns", Object.keys(UPDATED[0].row).sort(),
    ["billable_cents", "encoding", "segments", "unit_price_cents"]);

  SETTINGS = [{ key: "sms_rate_cents_per_segment", value: "0" }];
  r = await call("POST", "/api/billing/sms/reprice", { period: "2026-06", dry_run: false });
  check("repricing with no rate configured is refused rather than zeroing rows", r.status, 400);

  // --------------------------------------------------------- preview ------
  SETTINGS = RATE;
  r = await call("POST", "/api/billing/sms/preview", { body: "Club: how was your visit? " + "x".repeat(50) });
  check("a short message previews as one segment", r.body.segments, 1);
  check("with a per-recipient price", r.body.cost_per_recipient, "$0.01");

  r = await call("POST", "/api/billing/sms/preview", { body: "Club: how was your round - great to see you", recipients: 1000 });
  check("a batch cost is projected", r.body.projected_cost, "$7.90");

  r = await call("POST", "/api/billing/sms/preview", { body: "Club: how was your round — great to see you" });
  check("an em dash is caught before it is sent", r.body.encoding, "ucs2");
  check("and named", r.body.non_gsm_characters[0].code_point, "U+2014");
  check("with a warning that says what it costs",
    r.body.warnings.some((w) => w.includes("GSM-7 cannot carry")), true);

  r = await call("POST", "/api/billing/sms/preview", { body: "a".repeat(157) });
  check("a message near the limit is warned about",
    r.body.warnings.some((w) => w.includes("headroom")), true);

  r = await call("POST", "/api/billing/sms/preview", {});
  check("a preview with no body is refused", r.status, 400);

  // ------------------------------------------------- the live templates ----
  // Built from the same helpers the sender uses, so a template cannot be shown
  // here as cheap and sent as expensive.
  r = await call("GET", "/api/billing/sms/templates");
  check("every outgoing template is metered", r.body.templates.length, 4);
  check("they are named for a human", r.body.templates.map((t) => t.key),
    ["food_bev", "golf", "events", "staff"]);
  check("none of them currently costs an avoidable segment",
    r.body.templates.filter((t) => t.avoidable_segments > 0), []);
  check("the golf survey is one segment now the em dash is gone",
    r.body.templates.find((t) => t.key === "golf").segments, 1);
  check("the staff survey is honestly reported as two",
    r.body.templates.find((t) => t.key === "staff").segments, 2);
  // The food & beverage survey sits 5 characters under the limit. That is not a
  // problem today and becomes one the moment the club is renamed.
  check("a template close to the limit is flagged as tight",
    r.body.templates.find((t) => t.key === "food_bev").tight, true);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
