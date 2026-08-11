const C = require("./sms-credit.js");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const RATE = { sms_rate_cents_per_segment: "0.79", sms_markup_pct: "0" };
const ON = { ...RATE, sms_credit_enabled: "true" };

const acct = (over = {}) => ({
  club_id: null, balance_cents: 5000, currency: "USD",
  low_balance_cents: 2000, critical_balance_cents: 500, low_balance_notified_at: null,
  auto_topup_enabled: false, auto_topup_threshold_cents: 1000, auto_topup_amount_cents: 5000,
  stripe_customer_id: null, stripe_payment_method_id: null, topup_in_flight_at: null, ...over,
});

// ------------------------------------------------------- the live rate card --
// The confirmed price is $0.02 per segment with no margin, and the setting is
// denominated in cents — so the stored value is 2, not 0.02. That distinction
// is a factor of 100 in Vero's favour or the club's, and nothing else in the
// system would notice, so it is pinned here against the real figures.

const LIVE = { sms_rate_cents_per_segment: "2", sms_markup_pct: "0" };

check("a one-segment message costs two cents",
  C.costOf("Club: how was your visit? https://x", LIVE).cost_cents, 2);
check("which reads as $0.02", C.formatMoney(C.costOf("x", LIVE).cost_cents), "$0.02");
check("a two-segment message costs four", C.costOf("a".repeat(200), LIVE).cost_cents, 4);
check("a thousand one-segment messages cost $20.00",
  C.formatMoney(C.costOf("x", LIVE).cost_cents * 1000), "$20.00");
check("no margin is applied on top",
  C.costOf("x", LIVE).unit_price_cents, 2);
// $50 of credit at 2c a segment is 2,500 single-segment messages.
check("fifty dollars of credit buys 2,500 messages", C.messagesRemaining(5000, LIVE), 2500);
// The 100x error, stated explicitly so the wrong reading is visibly wrong.
check("0.02 would be two hundredths of a cent, not two cents",
  C.formatMoney(C.costOf("x", { sms_rate_cents_per_segment: "0.02" }).cost_cents * 1000), "$0.20");

// ------------------------------------------------------------ what it costs --

check("a one-segment message costs one segment's worth",
  C.costOf("Club: how was your visit?", RATE).cost_cents, 0.79);
check("a longer message costs more", C.costOf("a".repeat(200), RATE).cost_cents, 1.58);
// The metering rules are sms-billing's, but the cost has to inherit them or a
// club is undercharged for exactly the messages that cost the most.
check("a non-GSM character still triples the cost",
  C.costOf("a".repeat(154) + "—", RATE).cost_cents, 2.37);
check("with no rate configured a message costs nothing", C.costOf("hello", {}).cost_cents, 0);
check("and says the rate is not configured", C.costOf("hello", {}).rate_configured, false);

// -------------------------------------------------------------- the gate ----

check("enforcement is off unless switched on", C.creditEnforced({}), false);
check("and is off for anything that is not the string true",
  C.creditEnforced({ sms_credit_enabled: "yes" }), false);
check("switched on it enforces", C.creditEnforced({ sms_credit_enabled: "true" }), true);

// A deployment that upgrades into this must not stop sending because nobody
// has bought credit yet.
check("with enforcement off, no credit still sends",
  C.canSend({ cost_cents: 0.79, account: null, settings: RATE }).allowed, true);
check("with enforcement on and enough credit, it sends",
  C.canSend({ cost_cents: 0.79, account: acct(), settings: ON }).allowed, true);
check("with enforcement on and no credit, it stops",
  C.canSend({ cost_cents: 0.79, account: acct({ balance_cents: 0 }), settings: ON }).allowed, false);
check("and says why", C.canSend({ cost_cents: 0.79, account: acct({ balance_cents: 0 }), settings: ON }).reason,
  "insufficient_credit");
check("a balance smaller than the message stops it",
  C.canSend({ cost_cents: 2.37, account: acct({ balance_cents: 2 }), settings: ON }).allowed, false);
check("a balance exactly equal to the cost still sends",
  C.canSend({ cost_cents: 2.37, account: acct({ balance_cents: 2.37 }), settings: ON }).allowed, true);
check("with enforcement on and no account at all, it stops",
  C.canSend({ cost_cents: 0.79, account: null, settings: ON }).reason, "no_account");

// Refusing to send free messages for want of credit would be nonsense.
check("a message that costs nothing is never blocked",
  C.canSend({ cost_cents: 0, account: acct({ balance_cents: 0 }), settings: ON }).allowed, true);
check("and is recorded as not a charge",
  C.canSend({ cost_cents: 0, account: null, settings: ON }).reason, "no_charge");

check("the refusal message tells the club what to do",
  C.canSend({ cost_cents: 2.37, account: acct({ balance_cents: 1 }), settings: ON }).message.includes("Top up"), true);
check("and quotes both the balance and the cost, in money",
  C.canSend({ cost_cents: 2.37, account: acct({ balance_cents: 1 }), settings: ON }).message.includes("$0.01"), true);

// ----------------------------------------------------------- running low ----

check("a healthy balance is healthy", C.balanceState(acct()), "healthy");
check("at the low threshold it is low", C.balanceState(acct({ balance_cents: 2000 })), "low");
check("below the critical threshold it is critical", C.balanceState(acct({ balance_cents: 400 })), "critical");
check("at zero it is empty", C.balanceState(acct({ balance_cents: 0 })), "empty");
check("a missing account reads as empty", C.balanceState(null), "empty");

const T0 = Date.parse("2026-08-01T12:00:00Z");
check("a healthy balance warns nobody", C.shouldWarn(acct(), T0), false);
check("a low balance warns once", C.shouldWarn(acct({ balance_cents: 1000 }), T0), true);
// The failure this prevents: a nightly batch crossing the threshold sending
// several hundred identical warnings inside a minute.
check("and does not warn again immediately",
  C.shouldWarn(acct({ balance_cents: 1000, low_balance_notified_at: new Date(T0 - 60000).toISOString() }), T0), false);
check("but does warn again the next day",
  C.shouldWarn(acct({ balance_cents: 1000, low_balance_notified_at: new Date(T0 - 25 * 3600000).toISOString() }), T0), true);
check("an unparseable timestamp warns rather than going silent",
  C.shouldWarn(acct({ balance_cents: 1000, low_balance_notified_at: "not a date" }), T0), true);

// ----------------------------------------------------------- auto top-up ----

const auto = (over = {}) => acct({
  auto_topup_enabled: true, stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_1",
  balance_cents: 500, ...over,
});

check("above the threshold it does not fire", C.shouldAutoTopup(auto({ balance_cents: 5000 }), T0).topup, false);
check("below the threshold it fires", C.shouldAutoTopup(auto(), T0).topup, true);
check("and for the configured amount", C.shouldAutoTopup(auto(), T0).amount_cents, 5000);
check("it does not fire when disabled", C.shouldAutoTopup(auto({ auto_topup_enabled: false }), T0).topup, false);
check("nor without a saved card",
  C.shouldAutoTopup(auto({ stripe_payment_method_id: null }), T0).reason, "no_saved_card");
check("nor with no amount configured",
  C.shouldAutoTopup(auto({ auto_topup_amount_cents: 0 }), T0).reason, "no_amount_configured");

// The one that matters: a 900-message batch must fire one charge, not 900.
check("a top-up already in flight blocks another",
  C.shouldAutoTopup(auto({ topup_in_flight_at: new Date(T0 - 60000).toISOString() }), T0).reason, "already_in_flight");
// ...but a crashed process must not wedge it forever.
check("a stale in-flight lock expires",
  C.shouldAutoTopup(auto({ topup_in_flight_at: new Date(T0 - 20 * 60000).toISOString() }), T0).topup, true);

// ------------------------------------------------------------- top-up size --

check("a sensible top-up is accepted", C.validateTopup(5000), { ok: true, amount_cents: 5000 });
check("the minimum is enforced", C.validateTopup(100).ok, false);
check("the maximum is enforced", C.validateTopup(9999999).ok, false);
check("fractional cents are refused", C.validateTopup(500.5).ok, false);
check("nonsense is refused", C.validateTopup("free").ok, false);
check("nothing is refused", C.validateTopup(undefined).ok, false);
check("a negative amount cannot be used to drain an account", C.validateTopup(-5000).ok, false);

// ---------------------------------------------------------------- display ---

check("money formats to two places", C.formatMoney(1114.69), "$11.15");
check("zero formats", C.formatMoney(0), "$0.00");
check("a negative reads as negative, not as a stray symbol", C.formatMoney(-500), "-$5.00");
check("currency is honoured", C.formatMoney(1000, "GBP"), "£10.00");

check("a balance converts to roughly how many messages it buys",
  C.messagesRemaining(5000, RATE), 6329);
check("with no rate configured that number is unknowable, not zero",
  C.messagesRemaining(5000, {}), null);

check("a debit is described by what it was for",
  C.describeEntry({ entry_type: "debit", kind: "staff_survey" }), "Staff shift survey");
check("a top-up is described plainly", C.describeEntry({ entry_type: "topup" }), "Top-up");
check("a reversal says the message did not go",
  C.describeEntry({ entry_type: "reversal" }), "Reversed — message not sent");
check("an unlabelled debit falls back to its kind",
  C.describeEntry({ entry_type: "debit", kind: "something_new" }), "something_new");

// A club sending 900 surveys a night wants one row, not 900.
const entries = [
  { entry_type: "debit", kind: "survey", amount_cents: -0.79, created_at: "2026-08-03T09:00:00Z" },
  { entry_type: "debit", kind: "survey", amount_cents: -0.79, created_at: "2026-08-03T09:01:00Z" },
  { entry_type: "debit", kind: "staff_survey", amount_cents: -1.58, created_at: "2026-08-03T18:00:00Z" },
  { entry_type: "debit", kind: "survey", amount_cents: -0.79, created_at: "2026-08-02T09:00:00Z" },
  { entry_type: "topup", amount_cents: 5000, created_at: "2026-08-01T09:00:00Z" },
];
const summary = C.summariseLedger(entries);
check("debits roll up by day and type", summary.length, 3);
check("the busiest line comes first", [summary[0].date, summary[0].messages], ["2026-08-03", 2]);
check("and carries the day's total", summary[0].amount_cents, 1.58);
check("a top-up is not folded into the daily rollup",
  summary.some((s) => s.kind === "topup"), false);
check("an empty ledger summarises to nothing", C.summariseLedger([]), []);

// ------------------------------------ the operator's switches, not the club's --
//
// Enforcement and pricing are set in the deployment's environment. A club that
// could turn enforcement off, or set its own rate, would be choosing whether to
// keep sending on an empty balance and what to pay for it. The database row
// stays as a fallback for deployments that predate the variables — but where
// both exist, the environment has to win, or the fallback is the override.
{
  const env = { ...process.env };
  const restore = () => { for (const k of Object.keys(process.env)) delete process.env[k];
                          Object.assign(process.env, env); };

  process.env.SMS_CREDIT_ENABLED = "true";
  check("the environment can switch enforcement on",
    C.creditEnforced({}), true);
  check("and overrules a club that set the row to false",
    C.creditEnforced({ sms_credit_enabled: "false" }), true);

  process.env.SMS_CREDIT_ENABLED = "false";
  check("the environment can switch it off again", C.creditEnforced({}), false);
  check("and overrules a club that set the row to true",
    C.creditEnforced({ sms_credit_enabled: "true" }), false);

  // Render writes an empty string for a variable left blank in its UI. Reading
  // that as "false" would silently disable enforcement on a deployment that had
  // merely not filled the box in.
  process.env.SMS_CREDIT_ENABLED = "";
  check("a blank variable is unset, not false",
    C.creditEnforced({ sms_credit_enabled: "true" }), true);
  delete process.env.SMS_CREDIT_ENABLED;
  check("with nothing in the environment the database still decides",
    C.creditEnforced({ sms_credit_enabled: "true" }), true);

  process.env.SMS_RATE_CENTS_PER_SEGMENT = "2";
  check("the rate comes from the environment", C.costOf("x", {}).cost_cents, 2);
  check("and beats a cheaper rate the club stored",
    C.costOf("x", { sms_rate_cents_per_segment: "0.01" }).cost_cents, 2);
  process.env.SMS_MARKUP_PCT = "50";
  check("the margin comes from there too", C.costOf("x", {}).cost_cents, 3);
  restore();
  check("and none of it leaks into the next test", C.costOf("x", {}).cost_cents, 0);
}

// The list the settings endpoint refuses to write. If a key is dropped from
// here it becomes writable from the dashboard again, silently.
check("every operator setting is named", C.OPERATOR_SETTING_KEYS,
  ["sms_credit_enabled", "sms_rate_cents_per_segment", "sms_markup_pct", "sms_billing_currency"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
