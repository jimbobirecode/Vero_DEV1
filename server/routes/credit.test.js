// The credit endpoints and the Stripe webhook, against a stubbed database and
// a stubbed Stripe.
//
// sms-credit.test.js proves the rules. This proves the things that only break
// once HTTP and a payment processor are involved, and every one of them is a
// way to lose or invent money: an unsigned webhook granting credit, a retried
// webhook crediting twice, an auto top-up that cannot pay for itself, a manual
// adjustment with no reason attached.
process.env.SUPABASE_URL = "https://p";
process.env.SUPABASE_SERVICE_ROLE_KEY = "s";
process.env.CLUB_ID = "";
process.env.STRIPE_SECRET_KEY = "sk_test_stub";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_stub";
process.env.SURVEY_BASE_URL = "https://vero.test";

let ACCOUNT = null, LEDGER = [], SETTINGS = [], RPC = [];
let TABLE_ERROR = null, RPC_ERROR = null, INSERT_ERROR = null;

const Module = require("module");
const rr = Module._resolveFilename;
// Matches both spellings: routes reach these as "../lib/x", and lib files
// reach each other as "./x". Missing the second form loads the real Supabase
// client, which then fails on a network call rather than on an obvious import.
Module._resolveFilename = function (r, ...x) {
  const stub = { supabase: "SB", audit: "AUD", stripe: "STRIPE", notify: "NOTIFY" };
  const m = /^\.{1,2}\/(?:lib\/)?([a-z-]+)$/.exec(r);
  if (m && stub[m[1]]) return stub[m[1]];
  return rr.call(this, r, ...x);
};

function from(table) {
  let single = false;
  const api = {
    select: () => api, eq: () => api, is: () => api, or: () => api, like: () => api,
    order: () => api, limit: () => api, range: () => api, lt: () => api,
    single: () => { single = true; return api; },
    insert(row) { if (!INSERT_ERROR && table === "sms_credit_accounts") ACCOUNT = { ...(ACCOUNT || {}), ...row }; return api; },
    update(row) { if (table === "sms_credit_accounts") ACCOUNT = { ...(ACCOUNT || {}), ...row }; return api; },
    then(resolve) {
      if (TABLE_ERROR && table === "sms_credit_accounts") return resolve({ data: null, error: TABLE_ERROR });
      if (INSERT_ERROR && table === "sms_credit_accounts") return resolve({ data: null, error: INSERT_ERROR });
      let data;
      if (table === "sms_credit_accounts") data = ACCOUNT ? [ACCOUNT] : [];
      else if (table === "sms_credit_ledger") data = LEDGER;
      else if (table === "club_settings") data = SETTINGS;
      else data = [];
      return resolve({ data: single ? (data[0] || null) : data, count: data.length, error: null });
    },
  };
  return api;
}

// The database functions, reimplemented faithfully enough to exercise the
// behaviour that matters: idempotency, and refusing to overdraw.
async function rpc(name, args) {
  RPC.push({ name, args });
  if (RPC_ERROR) return { data: null, error: RPC_ERROR };
  const prior = LEDGER.find((e) => e.idempotency_key === args.p_idempotency_key);
  if (prior) return { data: [{ ok: true, balance_after: prior.balance_after_cents, reason: "already_applied" }], error: null };

  if (name === "debit_sms_credit") {
    if (!ACCOUNT) return { data: [{ ok: false, balance_after: 0, reason: "no_account" }], error: null };
    if (Number(ACCOUNT.balance_cents) < Number(args.p_amount_cents)) {
      return { data: [{ ok: false, balance_after: ACCOUNT.balance_cents, reason: "insufficient_credit" }], error: null };
    }
    ACCOUNT.balance_cents = Number(ACCOUNT.balance_cents) - Number(args.p_amount_cents);
    LEDGER.unshift({ entry_type: "debit", amount_cents: -args.p_amount_cents, balance_after_cents: ACCOUNT.balance_cents, idempotency_key: args.p_idempotency_key, kind: args.p_kind, created_at: new Date().toISOString() });
    return { data: [{ ok: true, balance_after: ACCOUNT.balance_cents, reason: "ok" }], error: null };
  }

  if (name === "credit_sms_account") {
    if (!ACCOUNT) ACCOUNT = { club_id: null, balance_cents: 0, currency: "USD" };
    const next = Number(ACCOUNT.balance_cents) + Number(args.p_amount_cents);
    if (next < 0) return { data: [{ ok: false, balance_after: ACCOUNT.balance_cents, reason: "would_go_negative" }], error: null };
    ACCOUNT.balance_cents = next;
    LEDGER.unshift({ entry_type: args.p_entry_type, amount_cents: args.p_amount_cents, balance_after_cents: next, idempotency_key: args.p_idempotency_key, description: args.p_description, created_at: new Date().toISOString() });
    return { data: [{ ok: true, balance_after: next, reason: "ok" }], error: null };
  }
  return { data: null, error: { message: "unknown rpc " + name } };
}

require.cache["SB"] = { id: "SB", filename: "SB", loaded: true, exports: { supabase: { from, rpc } } };
require.cache["AUD"] = { id: "AUD", filename: "AUD", loaded: true, exports: { log: () => {}, ACTIONS: {} } };
require.cache["NOTIFY"] = { id: "NOTIFY", filename: "NOTIFY", loaded: true, exports: { notifyManagers: async () => {}, dashboardUrl: () => "https://vero.test" } };

// Stripe, stubbed. constructEvent is the security boundary, so the stub keeps
// its real behaviour: a signature that is not the literal "good" is rejected.
let STRIPE_CALLS = [];
require.cache["STRIPE"] = {
  id: "STRIPE", filename: "STRIPE", loaded: true,
  exports: {
    isConfigured: () => true,
    ensureCustomer: async () => "cus_stub",
    createTopupSession: async (a) => { STRIPE_CALLS.push(["topup", a]); return { id: "cs_1", url: "https://checkout.stripe.com/cs_1" }; },
    createCardSetupSession: async (a) => { STRIPE_CALLS.push(["setup", a]); return { id: "cs_2", url: "https://checkout.stripe.com/cs_2" }; },
    chargeSavedCard: async (a) => { STRIPE_CALLS.push(["charge", a]); return { id: "pi_auto" }; },
    describeCard: async () => ({ brand: "visa", last4: "4242", exp_month: 4, exp_year: 2030 }),
    paymentMethodFromSetup: async () => "pm_from_setup",
    constructEvent: (raw, sig) => {
      if (sig !== "good") throw new Error("No signatures found matching the expected signature for payload");
      return JSON.parse(raw.toString());
    },
  },
};

const express = require("express");
const creditRouter = require("./credit.js");
const webhookRouter = require("./stripe-webhook.js");

const app = express();
// Mounted exactly as index.js does: raw body for the webhook, ahead of JSON.
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }), webhookRouter);
app.use(express.json());
app.use((req, _res, next) => { req.user = { email: "gm@club.com", role: "general_manager", staff_id: "s1" }; next(); });
app.use("/api/credit", creditRouter);

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

let server;
const call = async (method, path, body, headers = {}) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
};

const RATE = [
  { key: "sms_rate_cents_per_segment", value: "0.79" },
  { key: "sms_markup_pct", value: "0" },
  { key: "sms_billing_currency", value: "USD" },
  { key: "sms_credit_enabled", value: "true" },
];

const account = (over = {}) => ({
  club_id: null, balance_cents: 5000, currency: "USD",
  low_balance_cents: 2000, critical_balance_cents: 500, low_balance_notified_at: null,
  auto_topup_enabled: false, auto_topup_threshold_cents: 1000, auto_topup_amount_cents: 5000,
  stripe_customer_id: "cus_stub", stripe_payment_method_id: null, topup_in_flight_at: null,
  last_topup_error: null, ...over,
});

(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));

  SETTINGS = RATE;
  ACCOUNT = account();

  // ------------------------------------------------------------- balance ---
  let r = await call("GET", "/api/credit");
  check("the balance is served", r.body.balance, "$50.00");
  check("with its state", r.body.state, "healthy");
  check("and roughly what it buys", r.body.messages_remaining, 6329);
  check("enforcement is reported", r.body.enforced, true);

  ACCOUNT = account({ balance_cents: 1500 });
  check("a low balance is called low", (await call("GET", "/api/credit")).body.state, "low");
  ACCOUNT = account({ balance_cents: 100 });
  check("a very low one is critical", (await call("GET", "/api/credit")).body.state, "critical");
  ACCOUNT = account({ balance_cents: 0 });
  check("an exhausted one is empty", (await call("GET", "/api/credit")).body.state, "empty");

  // -------------------------------------------------------------- top-up ---
  ACCOUNT = account();
  r = await call("POST", "/api/credit/checkout", { amount_cents: 5000 });
  check("a top-up returns a Stripe Checkout URL", r.body.url, "https://checkout.stripe.com/cs_1");
  check("the club is never asked for card details by us", r.body.card_field === undefined, true);

  r = await call("POST", "/api/credit/checkout", { amount_cents: 100 });
  check("a top-up below the minimum is refused", r.status, 400);
  r = await call("POST", "/api/credit/checkout", { amount_cents: 99999999 });
  check("a fat-fingered amount is refused", r.status, 400);
  r = await call("POST", "/api/credit/checkout", { amount_cents: -5000 });
  check("a negative top-up cannot be used to drain the balance", r.status, 400);

  // Checkout must not itself grant credit — only the webhook does.
  check("starting a checkout does not move the balance", ACCOUNT.balance_cents, 5000);

  // ---------------------------------------------------------- setup faults --
  //
  // These three all used to render as "the credit tables are not set up yet",
  // which is only true for the first. The other two sent people off to re-run a
  // migration that had already worked while the real fault stayed hidden.

  ACCOUNT = null;
  TABLE_ERROR = { message: "Could not find the table 'public.sms_credit_accounts' in the schema cache" };
  r = await call("GET", "/api/credit");
  check("a missing table is reported as a missing table", r.body.setup.reason, "no_tables");

  TABLE_ERROR = null; RPC_ERROR = { message: "function debit_sms_credit does not exist" };
  r = await call("GET", "/api/credit");
  check("tables without functions are reported as a half-applied migration", r.body.setup.reason, "no_functions");

  RPC_ERROR = null;
  r = await call("GET", "/api/credit");
  check("everything present but no credit yet says exactly that", r.body.setup.reason, "no_account_yet");

  // The bug that started this: club_id was the primary key and therefore NOT
  // NULL, so a deployment with no CLUB_ID set could never create an account —
  // and the failure was reported as a missing migration.
  INSERT_ERROR = { message: 'null value in column "club_id" violates not-null constraint' };
  r = await call("POST", "/api/credit/checkout", { amount_cents: 5000 });
  check("a constraint failure is not reported as a missing migration",
    r.body.error.includes("not set up yet"), false);
  check("it quotes the real database error", r.body.error.includes("club_id"), true);
  check("and points at the fix", r.body.error.includes("NOT NULL"), true);
  INSERT_ERROR = null;

  ACCOUNT = account();

  // ------------------------------------------------------------- webhook ---
  const pi = (over = {}) => JSON.stringify({
    id: "evt_1", type: "payment_intent.succeeded",
    data: { object: { id: "pi_1", amount: 5000, amount_received: 5000, metadata: { purpose: "sms_credit_topup", club_id: "" }, ...over } },
  });

  // The security boundary. Without signature verification anyone who finds this
  // URL can credit themselves.
  r = await call("POST", "/api/stripe/webhook", pi(), { "stripe-signature": "forged" });
  check("an unsigned webhook is refused", r.status, 400);
  check("and grants nothing", ACCOUNT.balance_cents, 5000);

  r = await call("POST", "/api/stripe/webhook", pi(), {});
  check("a webhook with no signature header at all is refused", r.status, 400);

  r = await call("POST", "/api/stripe/webhook", pi(), { "stripe-signature": "good" });
  check("a signed payment credits the account", r.status, 200);
  check("by the amount actually received", ACCOUNT.balance_cents, 10000);

  // Stripe retries for up to three days. A retry that credits again is money
  // given away, and this is the guard that stops it.
  r = await call("POST", "/api/stripe/webhook", pi(), { "stripe-signature": "good" });
  check("a retried webhook does not credit twice", ACCOUNT.balance_cents, 10000);
  check("and still answers 200 so Stripe stops retrying", r.status, 200);

  // A partial capture must credit what was taken, not what was quoted.
  LEDGER = []; ACCOUNT = account({ balance_cents: 0 });
  await call("POST", "/api/stripe/webhook",
    pi({ id: "pi_partial", amount: 5000, amount_received: 3000 }), { "stripe-signature": "good" });
  check("a partial capture credits what was received", ACCOUNT.balance_cents, 3000);

  // Anything not ours must be ignored rather than credited.
  LEDGER = []; ACCOUNT = account({ balance_cents: 0 });
  await call("POST", "/api/stripe/webhook",
    pi({ id: "pi_other", metadata: { purpose: "something_else" } }), { "stripe-signature": "good" });
  check("a payment for something else is not SMS credit", ACCOUNT.balance_cents, 0);

  // An unrecognised event must return 200, or Stripe retries it forever.
  r = await call("POST", "/api/stripe/webhook",
    JSON.stringify({ id: "evt_x", type: "invoice.paid", data: { object: {} } }), { "stripe-signature": "good" });
  check("an event we do not handle is acknowledged, not retried forever", r.status, 200);
  check("and is reported as ignored", r.body.ignored, "invoice.paid");

  // ------------------------------------- what Stripe actually sends back ----
  //
  // The live failure. Metadata set on a Checkout Session stays on the session:
  // the PaymentIntent it creates carries none of it. So the real
  // payment_intent.succeeded arrived with empty metadata, the handler could not
  // tell it was a top-up, and no credit was granted — on a payment that had
  // genuinely gone through, silently, forever.
  LEDGER = []; ACCOUNT = account({ balance_cents: 0 });
  const bareIntent = JSON.stringify({
    id: "evt_bare", type: "payment_intent.succeeded",
    data: { object: { id: "pi_bare", amount: 5000, amount_received: 5000, metadata: {} } },
  });
  const session = (over = {}) => JSON.stringify({
    id: "evt_cs", type: "checkout.session.completed",
    data: { object: {
      id: "cs_1", mode: "payment", payment_status: "paid", amount_total: 5000,
      payment_intent: "pi_bare",
      metadata: { purpose: "sms_credit_topup", club_id: "" },
      ...over,
    } },
  });

  await call("POST", "/api/stripe/webhook", bareIntent, { "stripe-signature": "good" });
  check("an intent with no metadata alone credits nothing", ACCOUNT.balance_cents, 0);

  await call("POST", "/api/stripe/webhook", session(), { "stripe-signature": "good" });
  check("but the session event credits it", ACCOUNT.balance_cents, 5000);

  // Both events describe one payment, so the second must not double it.
  await call("POST", "/api/stripe/webhook", bareIntent, { "stripe-signature": "good" });
  check("and the intent event afterwards does not credit twice", ACCOUNT.balance_cents, 5000);

  // Order reversed: the intent (now carrying metadata, as it will once
  // payment_intent_data is set) lands first, then the session.
  LEDGER = []; ACCOUNT = account({ balance_cents: 0 });
  await call("POST", "/api/stripe/webhook", JSON.stringify({
    id: "evt_i2", type: "payment_intent.succeeded",
    data: { object: { id: "pi_both", amount: 5000, amount_received: 5000,
      metadata: { purpose: "sms_credit_topup", club_id: "" } } },
  }), { "stripe-signature": "good" });
  check("the intent event credits when it does carry metadata", ACCOUNT.balance_cents, 5000);
  await call("POST", "/api/stripe/webhook", session({ payment_intent: "pi_both" }), { "stripe-signature": "good" });
  check("and the session afterwards is a no-op, not a second credit", ACCOUNT.balance_cents, 5000);

  // An unpaid session must never grant credit.
  LEDGER = []; ACCOUNT = account({ balance_cents: 0 });
  await call("POST", "/api/stripe/webhook", session({ id: "cs_unpaid", payment_status: "unpaid", payment_intent: "pi_unpaid" }), { "stripe-signature": "good" });
  check("an unpaid session credits nothing", ACCOUNT.balance_cents, 0);

  // A session for something else entirely.
  await call("POST", "/api/stripe/webhook", session({ id: "cs_other", payment_intent: "pi_other2", metadata: { purpose: "merch" } }), { "stripe-signature": "good" });
  check("a session for something else is not SMS credit", ACCOUNT.balance_cents, 0);

  // Setup mode saves a card. This used to call a function that did not exist,
  // so it threw, returned 500, and Stripe retried it for three days.
  ACCOUNT = account({ stripe_payment_method_id: null });
  r = await call("POST", "/api/stripe/webhook", JSON.stringify({
    id: "evt_setup", type: "checkout.session.completed",
    data: { object: { id: "cs_setup", mode: "setup", setup_intent: "seti_1", metadata: { club_id: "" } } },
  }), { "stripe-signature": "good" });
  check("a setup session is handled rather than throwing", r.status, 200);
  check("and the card is stored for automatic top-up", ACCOUNT.stripe_payment_method_id, "pm_from_setup");

  ACCOUNT = account();

  // Refunds come back out.
  LEDGER = []; ACCOUNT = account({ balance_cents: 5000 });
  await call("POST", "/api/stripe/webhook", JSON.stringify({
    id: "evt_r", type: "charge.refunded",
    data: { object: { id: "ch_1", amount_refunded: 2000, payment_intent: "pi_1", metadata: { purpose: "sms_credit_topup", club_id: "" } } },
  }), { "stripe-signature": "good" });
  check("a refund is taken back off the balance", ACCOUNT.balance_cents, 3000);

  // -------------------------------------------------------- auto top-up ----
  LEDGER = []; ACCOUNT = account({ stripe_payment_method_id: null });
  r = await call("PUT", "/api/credit/settings", { auto_topup_enabled: true });
  check("auto top-up cannot be enabled without a card", r.status, 400);

  ACCOUNT = account({ stripe_payment_method_id: "pm_1" });
  r = await call("PUT", "/api/credit/settings", { auto_topup_enabled: true, auto_topup_threshold_cents: 5000, auto_topup_amount_cents: 2000 });
  check("a top-up smaller than its own trigger is refused", r.status, 400);
  check("because it would fire again immediately", r.body.error.includes("still be below"), true);

  r = await call("PUT", "/api/credit/settings", { auto_topup_enabled: true, auto_topup_threshold_cents: 1000, auto_topup_amount_cents: 5000 });
  check("a sensible auto top-up is accepted", r.status, 200);

  r = await call("PUT", "/api/credit/settings", { low_balance_cents: -100 });
  check("a negative threshold is refused", r.status, 400);

  // -------------------------------------------------------- adjustments ----
  ACCOUNT = account({ balance_cents: 5000 }); LEDGER = [];
  r = await call("POST", "/api/credit/adjust", { amount_cents: 1000 });
  check("a manual adjustment needs a reason", r.status, 400);

  r = await call("POST", "/api/credit/adjust", { amount_cents: 1000, reason: "Goodwill after the outage" });
  check("an audited adjustment applies", r.status, 200);
  check("and moves the balance", ACCOUNT.balance_cents, 6000);

  r = await call("POST", "/api/credit/adjust", { amount_cents: -99999, reason: "oops" });
  check("an adjustment cannot take the balance below zero", r.status, 400);

  // ------------------------------------------------------------- history ---
  LEDGER = [
    { entry_type: "topup", amount_cents: 5000, balance_after_cents: 5000, description: "Top-up", created_at: "2026-08-01T10:00:00Z" },
    { entry_type: "debit", kind: "survey", amount_cents: -0.79, balance_after_cents: 4999.21, created_at: "2026-08-03T09:00:00Z" },
    { entry_type: "debit", kind: "survey", amount_cents: -0.79, balance_after_cents: 4998.42, created_at: "2026-08-03T09:01:00Z" },
    { entry_type: "debit", kind: "staff_survey", amount_cents: -1.58, balance_after_cents: 4996.84, created_at: "2026-08-03T18:00:00Z" },
  ];
  r = await call("GET", "/api/credit/history");
  check("payments are listed individually", r.body.payments.length, 1);
  check("with a readable label", r.body.payments[0].label, "Top-up");
  // 900 surveys a night must not be 900 rows.
  check("usage is rolled up by day and type", r.body.usage.length, 2);
  check("the busiest line first", [r.body.usage[0].kind, r.body.usage[0].messages], ["survey", 2]);
  check("and shown as money", r.body.usage[0].amount, "$0.02");
  // No encoding, no segments, no rate — that was the point of the redesign.
  check("the history exposes no encoding detail",
    JSON.stringify(r.body).match(/gsm7|ucs2|segment|encoding/i), null);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
