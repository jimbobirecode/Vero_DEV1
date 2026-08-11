// Pay-as-you-go SMS credit — the decisions, with no database in them.
//
// What a message costs, whether there is enough left to send it, when to warn,
// when to auto top-up, and how to describe any of that to a club. The parts
// that touch Postgres or Stripe live in sms-credit-store.js and stripe.js; this
// file is pure so the rules can be tested exhaustively, which for money is the
// only way they should be tested.
//
// Amounts are in cents throughout, carried as numbers with up to four decimal
// places. A segment can cost a fraction of a cent, so rounding per message
// would overcharge on every single one — see sms-billing.js for the same point
// about metering. Rounding happens when a figure is shown, never when it is
// stored.

const { meter, rateCard, priceMessage, SETTING_KEYS } = require("./sms-billing");

// ------------------------------------------------------------- what it costs --

// The cost of sending one body, at the rate in force.
//
// Returns segments as well as money because the ledger stores both: the club is
// shown dollars, but a disputed charge is answered with "that message was two
// segments", and that has to be recoverable.
function costOf(body, settings = {}) {
  const metered = meter(body);
  const card = rateCard(settings);
  const priced = priceMessage(metered, card);
  return {
    segments: metered.segments,
    encoding: metered.encoding,
    unit_price_cents: card.unit_price_cents,
    cost_cents: priced.billable_cents,
    currency: card.currency,
    rate_configured: card.configured,
  };
}

// ----------------------------------------------------------- may we send it? --

// Enforcement is opt-in, and deliberately so.
//
// A deployment that upgrades into this feature must not stop sending surveys
// because nobody has bought credit yet. Blocking begins when someone turns it
// on, not when the migration runs.
// It is also the operator's switch, not the club's. A club that could turn
// enforcement off would be deciding for itself whether to keep sending on an
// empty balance, which is the one decision it must not have. SMS_CREDIT_ENABLED
// wins over club_settings wherever it is set, there is no control for it in the
// dashboard, and routes/settings.js will not write the key.
function creditEnforced(settings = {}) {
  const fromEnv = process.env.SMS_CREDIT_ENABLED;
  const value = fromEnv !== undefined && String(fromEnv).trim() !== ""
    ? fromEnv
    : (settings.sms_credit_enabled ?? "false");
  return String(value).trim().toLowerCase() === "true";
}

// The settings the dashboard may not write, whatever role is asking.
//
// Each one decides what a club is charged or whether it may send at all, and
// each is read from the environment first. Leaving the generic
// PUT /api/settings/:key able to write them would mean a general manager could
// set a database row that takes effect on any deployment where the matching
// variable happens to be unset — which is the override this is here to stop.
const OPERATOR_SETTING_KEYS = Object.freeze([
  "sms_credit_enabled",
  SETTING_KEYS.RATE,
  SETTING_KEYS.MARKUP,
  SETTING_KEYS.CURRENCY,
]);

// The gate, called before every SMS.
//
// `account` may be null — a club that has never been set up. With enforcement
// off that is fine and sending continues; with it on, there is nothing to debit
// and the send is refused, because the alternative is giving away texts to a
// club whose account was never created.
//
// A zero cost never blocks. If no rate is configured every message costs
// nothing, and refusing to send free messages for want of credit would be
// nonsense — the operator has simply not finished setting pricing up.
function canSend({ cost_cents, account, settings = {} }) {
  if (!(cost_cents > 0)) {
    return { allowed: true, reason: "no_charge" };
  }
  if (!creditEnforced(settings)) {
    return { allowed: true, reason: "enforcement_off" };
  }
  if (!account) {
    return {
      allowed: false,
      reason: "no_account",
      message: "SMS credit is switched on but this club has no credit account. Add credit before sending.",
    };
  }
  const balance = Number(account.balance_cents) || 0;
  if (balance < cost_cents) {
    return {
      allowed: false,
      reason: "insufficient_credit",
      balance_cents: balance,
      needed_cents: cost_cents,
      message: `Not enough SMS credit — ${formatMoney(balance, account.currency)} left, this message costs ${formatMoney(cost_cents, account.currency)}. Top up to resume sending.`,
    };
  }
  return { allowed: true, reason: "ok", balance_cents: balance };
}

// ------------------------------------------------------------ running low ----

const BALANCE_STATES = ["healthy", "low", "critical", "empty"];

// Where a balance sits against the club's own thresholds.
//
// Two thresholds rather than one because they mean different things: "low" is
// sort this out this week, "critical" is you are about to stop sending. A
// single warning at a single level either fires too early to be taken
// seriously or too late to act on.
function balanceState(account) {
  if (!account) return "empty";
  const balance = Number(account.balance_cents) || 0;
  if (balance <= 0) return "empty";
  if (balance <= (Number(account.critical_balance_cents) || 0)) return "critical";
  if (balance <= (Number(account.low_balance_cents) || 0)) return "low";
  return "healthy";
}

// Whether to send a low-balance warning now.
//
// Notified-at is cleared by any top-up, so the club is warned once per run-down
// rather than once per message. Without that, a nightly batch crossing the
// threshold would send several hundred identical warnings in a minute, and the
// club would filter them — which is worse than not sending them at all.
function shouldWarn(account, now = Date.now()) {
  const state = balanceState(account);
  if (state === "healthy") return false;
  if (!account?.low_balance_notified_at) return true;

  // Re-warn daily while it stays low. Something they are already ignoring
  // should not go quiet, but nor should it arrive hourly.
  const last = Date.parse(account.low_balance_notified_at);
  if (!Number.isFinite(last)) return true;
  return now - last >= 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------- auto top-up -----

// Ten minutes. Long enough that a Stripe charge either settles or fails inside
// it, short enough that a genuinely stuck top-up does not lock the club out of
// auto top-up for the rest of the night.
const TOPUP_LOCK_MS = 10 * 60 * 1000;

// Whether to fire an automatic top-up.
//
// The in-flight guard is the important part. A 900-message batch crossing the
// threshold would otherwise fire an auto top-up per message — 900 Stripe
// charges — and each one that succeeded would push the balance back above the
// threshold only after the rest had already been queued. One at a time, with a
// lock that expires so a crashed process cannot wedge it permanently.
function shouldAutoTopup(account, now = Date.now()) {
  if (!account) return { topup: false, reason: "no_account" };
  if (!account.auto_topup_enabled) return { topup: false, reason: "disabled" };
  if (!account.stripe_customer_id || !account.stripe_payment_method_id) {
    return { topup: false, reason: "no_saved_card" };
  }

  const balance = Number(account.balance_cents) || 0;
  const threshold = Number(account.auto_topup_threshold_cents) || 0;
  if (balance > threshold) return { topup: false, reason: "above_threshold" };

  if (account.topup_in_flight_at) {
    const started = Date.parse(account.topup_in_flight_at);
    if (Number.isFinite(started) && now - started < TOPUP_LOCK_MS) {
      return { topup: false, reason: "already_in_flight" };
    }
  }

  const amount = Number(account.auto_topup_amount_cents) || 0;
  if (amount <= 0) return { topup: false, reason: "no_amount_configured" };

  return { topup: true, reason: "below_threshold", amount_cents: amount };
}

// ------------------------------------------------------------- top-up size --

// What a club may buy in one go.
//
// The floor is Stripe's own practical minimum — below roughly 50 cents the
// card fee exceeds the purchase and most processors decline it. The ceiling is
// a fat-finger guard: someone typing an amount in cents when they meant dollars
// should be stopped, not charged a hundred times what they intended.
const MIN_TOPUP_CENTS = 500;      // $5
const MAX_TOPUP_CENTS = 500000;   // $5,000

function validateTopup(amountCents) {
  const n = Number(amountCents);
  if (!Number.isFinite(n)) return { ok: false, error: "Enter an amount to top up." };
  if (!Number.isInteger(n)) return { ok: false, error: "A top-up must be a whole number of cents." };
  if (n < MIN_TOPUP_CENTS) {
    return { ok: false, error: `The smallest top-up is ${formatMoney(MIN_TOPUP_CENTS)}.` };
  }
  if (n > MAX_TOPUP_CENTS) {
    return { ok: false, error: `The largest single top-up is ${formatMoney(MAX_TOPUP_CENTS)}. Contact us for a larger amount.` };
  }
  return { ok: true, amount_cents: n };
}

// ---------------------------------------------------------------- display ---

function toCents(n) {
  return Math.sign(n) * Math.round(Math.abs(n) * 100) / 100;
}

function formatMoney(cents, currency = "USD") {
  const symbol = { USD: "$", GBP: "£", EUR: "€", CAD: "$", AUD: "$" }[currency] || "";
  const value = (Number(cents) || 0) / 100;
  const sign = value < 0 ? "-" : "";
  return `${sign}${symbol}${Math.abs(value).toFixed(2)}`;
}

// Roughly how much sending a balance still buys.
//
// Expressed in messages rather than segments because that is the unit a club
// thinks in. It is explicitly approximate — a two-segment message costs double
// — and the wording says so rather than implying a precision it does not have.
function messagesRemaining(balanceCents, settings = {}) {
  const card = rateCard(settings);
  if (!card.configured || card.unit_price_cents <= 0) return null;
  return Math.floor((Number(balanceCents) || 0) / card.unit_price_cents);
}

// How the ledger reads to someone who did not write it.
const LEDGER_LABELS = {
  topup: "Top-up",
  debit: "Messages sent",
  refund: "Refund",
  adjustment: "Adjustment",
  reversal: "Reversed — message not sent",
};

const KIND_LABELS = {
  survey: "Survey",
  survey_manual: "Survey (sent manually)",
  survey_on_visit: "Survey (on visit)",
  event_survey: "Event survey",
  staff_survey: "Staff shift survey",
  integration_test: "Test message",
};

function describeEntry(entry) {
  if (entry?.entry_type === "debit" && entry.kind) {
    return KIND_LABELS[entry.kind] || entry.kind;
  }
  return LEDGER_LABELS[entry?.entry_type] || entry?.entry_type || "";
}

// Roll ledger entries into a daily summary.
//
// A club sending 900 surveys a night does not want 900 rows; it wants "3 August
// — 412 surveys, $3.25". Top-ups stay as individual rows, because a payment is
// a thing someone made happen and should be visible on its own.
function summariseLedger(entries = []) {
  const days = new Map();

  for (const e of entries) {
    if (e.entry_type !== "debit") continue;
    const day = String(e.created_at || "").slice(0, 10);
    const kind = e.kind || "other";
    const key = day + "|" + kind;
    const row = days.get(key) || { date: day, kind, label: describeEntry(e), messages: 0, amount_cents: 0 };
    row.messages++;
    row.amount_cents = Math.round((row.amount_cents + Math.abs(Number(e.amount_cents) || 0)) * 10000) / 10000;
    days.set(key, row);
  }

  return [...days.values()].sort((a, b) =>
    b.date.localeCompare(a.date) || b.amount_cents - a.amount_cents);
}

module.exports = {
  costOf, creditEnforced, canSend, OPERATOR_SETTING_KEYS,
  balanceState, shouldWarn, BALANCE_STATES,
  shouldAutoTopup, TOPUP_LOCK_MS,
  validateTopup, MIN_TOPUP_CENTS, MAX_TOPUP_CENTS,
  formatMoney, toCents, messagesRemaining,
  describeEntry, summariseLedger, LEDGER_LABELS, KIND_LABELS,
};
