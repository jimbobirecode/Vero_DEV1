// The send path under prepaid credit.
//
// This is where the money and the messages actually meet, and where the
// expensive mistakes live: charging for a message that never went out, sending
// one that was not paid for, or letting two concurrent sends spend the same
// last cent. Each of those is asserted here against a stubbed carrier and a
// stubbed ledger.
process.env.SUPABASE_URL = "https://p";
process.env.SUPABASE_SERVICE_ROLE_KEY = "s";
process.env.CLUB_ID = "";

let ACCOUNT = null, SETTINGS = [], LEDGER = [], LOGGED = [];
let INSERT_FAILS_ONCE = null;

const Module = require("module");
const rr = Module._resolveFilename;
Module._resolveFilename = function (r, ...x) {
  const stub = { supabase: "SB", vault: "VAULT", notify: "NOTIFY", stripe: "STRIPE" };
  const m = /^\.{1,2}\/(?:lib\/)?([a-z-]+)$/.exec(r);
  if (m && stub[m[1]]) return stub[m[1]];
  return rr.call(this, r, ...x);
};

function from(table) {
  let single = false;
  const api = {
    select: () => api, eq: () => api, is: () => api, or: () => api, like: () => api,
    order: () => api, limit: () => api, range: () => api, lt: () => api, maybeSingle: () => api,
    single: () => { single = true; return api; },
    insert(row) {
      if (table === "message_log") {
        LOGGED.push(row);
        // Fails the first (extended) insert only, so the fallback path runs.
        if (INSERT_FAILS_ONCE && LOGGED.length === 1) {
          return { select: () => ({ single: async () => ({ data: null, error: { message: INSERT_FAILS_ONCE } }) }) };
        }
        return { select: () => ({ single: async () => ({ data: { log_id: "log-" + LOGGED.length }, error: null }) }) };
      }
      return api;
    },
    update(row) { if (table === "sms_credit_accounts") ACCOUNT = { ...(ACCOUNT || {}), ...row }; return api; },
    then(resolve) {
      let data;
      if (table === "club_settings") data = SETTINGS;
      else if (table === "sms_credit_accounts") data = ACCOUNT ? [ACCOUNT] : [];
      else data = [];
      return resolve({ data: single ? (data[0] || null) : data, error: null });
    },
  };
  return api;
}

// The atomic debit, faithfully: the balance check and the decrement are one
// step, which is what makes the concurrency test below meaningful.
async function rpc(name, args) {
  const prior = LEDGER.find((e) => e.key === args.p_idempotency_key);
  if (prior) return { data: [{ ok: true, balance_after: prior.after, reason: "already_applied" }], error: null };

  if (name === "debit_sms_credit") {
    if (!ACCOUNT) return { data: [{ ok: false, balance_after: 0, reason: "no_account" }], error: null };
    if (Number(ACCOUNT.balance_cents) < Number(args.p_amount_cents)) {
      return { data: [{ ok: false, balance_after: ACCOUNT.balance_cents, reason: "insufficient_credit" }], error: null };
    }
    ACCOUNT.balance_cents = Number((Number(ACCOUNT.balance_cents) - Number(args.p_amount_cents)).toFixed(4));
    LEDGER.push({ key: args.p_idempotency_key, type: "debit", amount: -args.p_amount_cents, after: ACCOUNT.balance_cents });
    return { data: [{ ok: true, balance_after: ACCOUNT.balance_cents, reason: "ok" }], error: null };
  }
  if (name === "credit_sms_account") {
    if (!ACCOUNT) return { data: [{ ok: false, balance_after: 0, reason: "no_account" }], error: null };
    ACCOUNT.balance_cents = Number((Number(ACCOUNT.balance_cents) + Number(args.p_amount_cents)).toFixed(4));
    LEDGER.push({ key: args.p_idempotency_key, type: args.p_entry_type, amount: args.p_amount_cents, after: ACCOUNT.balance_cents });
    return { data: [{ ok: true, balance_after: ACCOUNT.balance_cents, reason: "ok" }], error: null };
  }
  return { data: null, error: { message: "unknown rpc" } };
}

require.cache["SB"] = { id: "SB", filename: "SB", loaded: true, exports: { supabase: { from, rpc } } };
require.cache["VAULT"] = { id: "VAULT", filename: "VAULT", loaded: true, exports: { readSecret: async () => null } };

let WARNINGS = [];
require.cache["NOTIFY"] = {
  id: "NOTIFY", filename: "NOTIFY", loaded: true,
  exports: { notifyManagers: async (subject) => { WARNINGS.push(subject); }, dashboardUrl: () => "https://vero.test" },
};

let CHARGES = [];
require.cache["STRIPE"] = {
  id: "STRIPE", filename: "STRIPE", loaded: true,
  exports: {
    isConfigured: () => true,
    chargeSavedCard: async (a) => { CHARGES.push(a); return { id: "pi_auto" }; },
  },
};

// The carrier.
let CARRIER_OK = true, CARRIER_CALLS = 0;
global.fetch = async () => {
  CARRIER_CALLS++;
  if (CARRIER_OK) return { ok: true, text: async () => "" };
  return { ok: false, text: async () => "Sendly is down" };
};

const { sendSms } = require("./senders.js");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const RATE = [
  { key: "sms_rate_cents_per_segment", value: "10" },   // 10c/segment, round numbers
  { key: "sms_markup_pct", value: "0" },
  { key: "sms_billing_currency", value: "USD" },
];
const ON = [...RATE, { key: "sms_credit_enabled", value: "true" }];

const account = (over = {}) => ({
  club_id: null, balance_cents: 100, currency: "USD",
  low_balance_cents: 20, critical_balance_cents: 5, low_balance_notified_at: null,
  auto_topup_enabled: false, auto_topup_threshold_cents: 10, auto_topup_amount_cents: 500,
  stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_1", topup_in_flight_at: null, ...over,
});

const CREDS = { sendlyKey: "k", sendlyFrom: "+1" };
const BODY = "Club: how was your visit? https://x";   // one segment

// The rate card is cached for a minute inside senders.js, so each scenario
// needs a fresh module instance to pick up new settings.
function reset({ settings, acct, carrierOk = true }) {
  SETTINGS = settings; ACCOUNT = acct; LEDGER = []; LOGGED = [];
  WARNINGS = []; CHARGES = []; CARRIER_CALLS = 0; CARRIER_OK = carrierOk; INSERT_FAILS_ONCE = null;
  delete require.cache[require.resolve("./senders.js")];
  delete require.cache[require.resolve("./sms-credit-store.js")];
  return require("./senders.js").sendSms;
}

(async () => {
  // ------------------------------------------------- enforcement switched off
  let send = reset({ settings: RATE, acct: account({ balance_cents: 0 }) });
  await send("+15551234567", BODY, CREDS, "M1", { kind: "survey" });
  check("with enforcement off, an empty balance still sends", CARRIER_CALLS, 1);
  check("and the message is recorded as sent", LOGGED[0].status, "sent");

  // -------------------------------------------------- enforcement switched on
  send = reset({ settings: ON, acct: account({ balance_cents: 100 }) });
  await send("+15551234567", BODY, CREDS, "M1", { kind: "survey" });
  check("a funded send goes out", CARRIER_CALLS, 1);
  check("and is debited", ACCOUNT.balance_cents, 90);
  check("exactly once", LEDGER.filter((e) => e.type === "debit").length, 1);

  // The hard stop.
  send = reset({ settings: ON, acct: account({ balance_cents: 0 }) });
  let threw = null;
  try { await send("+15551234567", BODY, CREDS, "M1", { kind: "survey" }); } catch (e) { threw = e; }
  check("an empty balance stops the send", CARRIER_CALLS, 0);
  check("with an error the batch can recognise", threw?.code, "insufficient_credit");
  check("recorded as blocked, not as a delivery failure", LOGGED[0].status, "blocked");
  check("and the reason is on the record", LOGGED[0].error_message.includes("Top up"), true);

  // A balance smaller than the message.
  send = reset({ settings: ON, acct: account({ balance_cents: 5 }) });
  threw = null;
  try { await send("+15551234567", BODY, CREDS, "M1", { kind: "survey" }); } catch (e) { threw = e; }
  check("a balance short of the cost stops it too", CARRIER_CALLS, 0);
  check("and nothing is taken", ACCOUNT.balance_cents, 5);

  // ----------------------------------------- charged, then the carrier fails
  //
  // The debit happens before the send, so a carrier failure must give the money
  // back. Without this the club pays for messages nobody received.
  send = reset({ settings: ON, acct: account({ balance_cents: 100 }), carrierOk: false });
  threw = null;
  try { await send("+15551234567", BODY, CREDS, "M1", { kind: "survey" }); } catch (e) { threw = e; }
  check("a carrier failure still throws", !!threw, true);
  check("the debit is reversed", ACCOUNT.balance_cents, 100);
  check("and the reversal is its own ledger entry, not a deletion",
    LEDGER.map((e) => e.type), ["debit", "reversal"]);
  check("the message is recorded as failed", LOGGED[0].status, "failed");

  // ------------------------------------------------------ two-segment cost --
  send = reset({ settings: ON, acct: account({ balance_cents: 100 }) });
  await send("+15551234567", "a".repeat(200), CREDS, "M1", { kind: "survey" });
  check("a two-segment message costs twice as much", ACCOUNT.balance_cents, 80);

  // ------------------------------------------------------- the last cent ----
  //
  // Two sends racing for a balance that only covers one. The debit is atomic,
  // so exactly one wins — a check-then-debit would let both through.
  send = reset({ settings: ON, acct: account({ balance_cents: 10 }) });
  const results = await Promise.allSettled([
    send("+15551111111", BODY, CREDS, "M1", { kind: "survey" }),
    send("+15552222222", BODY, CREDS, "M2", { kind: "survey" }),
  ]);
  check("exactly one of two racing sends succeeds",
    results.filter((r) => r.status === "fulfilled").length, 1);
  check("the other is refused for credit",
    results.find((r) => r.status === "rejected")?.reason?.code, "insufficient_credit");
  check("and the balance is never overdrawn", ACCOUNT.balance_cents, 0);
  check("only one message reached the carrier", CARRIER_CALLS, 1);

  // ------------------------------------------------------- running low ------
  send = reset({ settings: ON, acct: account({ balance_cents: 25 }) });
  await send("+15551234567", BODY, CREDS, "M1", { kind: "survey" });
  check("crossing the low threshold warns the managers", WARNINGS.length, 1);
  check("and says what is happening", WARNINGS[0].includes("running low"), true);

  // The failure this prevents: a 900-message batch sending 900 identical
  // warnings inside a minute.
  // The later sends in this loop run the balance out and are refused, which is
  // the realistic shape: a batch crosses the threshold, keeps going, and stops.
  send = reset({ settings: ON, acct: account({ balance_cents: 25 }) });
  for (let i = 0; i < 5; i++) {
    try { await send("+1555", BODY, CREDS, "M1", { kind: "survey" }); } catch { /* runs out partway, as expected */ }
  }
  check("a batch running down warns once, not once per message", WARNINGS.length, 1);
  check("and stops sending when it is out", ACCOUNT.balance_cents, 5);

  send = reset({ settings: ON, acct: account({ balance_cents: 0 }) });
  try { await send("+15551234567", BODY, CREDS, "M1", { kind: "survey" }); } catch { /* expected */ }
  check("an exhausted balance says sending has stopped",
    WARNINGS[0].includes("run out"), true);

  // -------------------------------------------------------- auto top-up -----
  send = reset({ settings: ON, acct: account({ balance_cents: 20, auto_topup_enabled: true }) });
  await send("+15551234567", BODY, CREDS, "M1", { kind: "survey" });
  await new Promise((r) => setTimeout(r, 30));   // the charge is fired off-path
  check("dropping below the trigger charges the saved card", CHARGES.length, 1);
  check("for the configured amount", CHARGES[0].amountCents, 500);
  // Credit is granted by the webhook, never optimistically here.
  check("the balance is not credited before Stripe confirms", ACCOUNT.balance_cents, 10);

  // One charge for a batch, not one per message.
  send = reset({ settings: ON, acct: account({ balance_cents: 100, auto_topup_enabled: true, auto_topup_threshold_cents: 95 }) });
  for (let i = 0; i < 5; i++) await send("+1555", BODY, CREDS, "M1", { kind: "survey" });
  await new Promise((r) => setTimeout(r, 30));
  check("a batch crossing the trigger fires one charge, not one per message", CHARGES.length, 1);

  // ------------------------------------------------- billing never blocks ---
  //
  // With no rate configured every message is free, so the gate must not engage
  // — refusing to send free messages for want of credit would be nonsense.
  send = reset({ settings: [{ key: "sms_credit_enabled", value: "true" }], acct: account({ balance_cents: 0 }) });
  await send("+15551234567", BODY, CREDS, "M1", { kind: "survey" });
  check("with no rate configured, an empty balance does not block", CARRIER_CALLS, 1);

  // --------------------------------------- the delivery record must survive --
  //
  // The extended insert carries columns the original message_log did not have.
  // When it fails — a missing migration, or a CLUB_ID that is not a uuid, which
  // is what actually happened — the row must still be written in its original
  // shape. message_log is what the audit trail and the "already sent" checks
  // read, so dropping a row is far worse than dropping the meter reading on it.
  send = reset({ settings: RATE, acct: null });
  INSERT_FAILS_ONCE = 'invalid input syntax for type uuid: "DEV"';
  await send("+15551234567", BODY, CREDS, "M1", { kind: "survey" });
  check("a failed extended insert still records the message", LOGGED.length, 2);
  check("the retry drops only the extra columns", LOGGED[1].club_id, undefined);
  check("and keeps the delivery record itself", LOGGED[1].status, "sent");
  check("with the recipient intact", LOGGED[1].recipient, "+15551234567");
  INSERT_FAILS_ONCE = null;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
