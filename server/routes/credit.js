// SMS credit — balance, usage history, and buying more.
//
// Nothing in this file grants credit. Top-ups are granted only by the Stripe
// webhook, from Stripe's own account of what happened; a redirect back to a
// success URL proves nothing, and treating it as proof would let anyone with
// the link credit their own account. The one exception is the manual
// adjustment endpoint, which is audited and role-gated for exactly that reason.

const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");
const { log, ACTIONS } = require("../lib/audit");
const credit = require("../lib/sms-credit");
const store = require("../lib/sms-credit-store");
const stripeLib = require("../lib/stripe");
const { CLUB_NAME } = require("../lib/club-config");

const CLUB_ID = process.env.CLUB_ID || null;

async function loadSettings() {
  const { data, error } = await supabase.from("club_settings").select("key, value");
  if (error) throw new Error(error.message);
  const settings = {};
  for (const row of data || []) settings[row.key] = row.value;
  return settings;
}

function baseUrl(req) {
  const configured = process.env.SURVEY_BASE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

// GET /api/credit — balance, state, and what it buys.
router.get("/", async (req, res) => {
  try {
    const [settings, account] = await Promise.all([loadSettings(), store.getAccount()]);
    const balance = Number(account?.balance_cents) || 0;
    const currency = account?.currency || settings.sms_billing_currency || "USD";

    const card = account?.stripe_payment_method_id
      ? await stripeLib.describeCard(account.stripe_payment_method_id)
      : null;

    res.json({
      configured: !!account,
      enforced: credit.creditEnforced(settings),
      balance_cents: balance,
      balance: credit.formatMoney(balance, currency),
      currency,
      state: credit.balanceState(account),
      messages_remaining: credit.messagesRemaining(balance, settings),

      low_balance_cents: Number(account?.low_balance_cents) || 0,
      critical_balance_cents: Number(account?.critical_balance_cents) || 0,

      auto_topup: {
        enabled: !!account?.auto_topup_enabled,
        threshold_cents: Number(account?.auto_topup_threshold_cents) || 0,
        amount_cents: Number(account?.auto_topup_amount_cents) || 0,
        card,
        last_error: account?.last_topup_error || null,
      },

      stripe_ready: stripeLib.isConfigured(),
      // Surfaced rather than hidden: with no rate set every message costs zero,
      // so the balance never moves and the hard stop never engages. That is a
      // setup problem the operator needs to see, not a quiet no-op.
      rate_configured: credit.costOf("x", settings).rate_configured,
      min_topup_cents: credit.MIN_TOPUP_CENTS,
      max_topup_cents: credit.MAX_TOPUP_CENTS,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// GET /api/credit/history — the ledger, and a daily rollup of what was sent.
//
// A club sending 900 surveys a night does not want 900 rows. Top-ups stay
// individual because a payment is a thing someone made happen.
router.get("/history", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 250, 1000);
  const offset = parseInt(req.query.offset) || 0;

  try {
    const [settings, { entries, total }] = await Promise.all([
      loadSettings(),
      store.ledger({ limit, offset }),
    ]);
    const currency = settings.sms_billing_currency || "USD";

    res.json({
      total,
      currency,
      // Payments, shown individually.
      payments: entries
        .filter((e) => e.entry_type !== "debit")
        .map((e) => ({
          entry_id: e.entry_id,
          type: e.entry_type,
          label: credit.describeEntry(e),
          amount_cents: Number(e.amount_cents),
          amount: credit.formatMoney(Number(e.amount_cents), currency),
          balance_after: credit.formatMoney(Number(e.balance_after_cents), currency),
          description: e.description,
          actor: e.actor_email,
          created_at: e.created_at,
        })),
      // Usage, rolled up by day and message type.
      usage: credit.summariseLedger(entries).map((u) => ({
        ...u,
        amount: credit.formatMoney(u.amount_cents, currency),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// POST /api/credit/checkout  { amount_cents, save_card? }
//
// Returns a Stripe-hosted Checkout URL. Card details never reach this server.
router.post("/checkout", async (req, res) => {
  const validated = credit.validateTopup(req.body?.amount_cents);
  if (!validated.ok) return res.status(400).json({ error: validated.error });

  if (!stripeLib.isConfigured()) {
    return res.status(503).json({ error: "Stripe is not configured on this deployment — set STRIPE_SECRET_KEY." });
  }

  try {
    const settings = await loadSettings();
    const account = await store.ensureAccount();
    if (!account) {
      return res.status(503).json({ error: "The credit tables are not set up yet — run migrations/sms-credit.sql." });
    }

    const customerId = await stripeLib.ensureCustomer({
      account, clubName: CLUB_NAME, email: req.user?.email, clubId: CLUB_ID,
    });
    if (customerId !== account.stripe_customer_id) {
      await store.updateAccount({ stripe_customer_id: customerId });
    }

    const root = baseUrl(req);
    const session = await stripeLib.createTopupSession({
      amountCents: validated.amount_cents,
      currency: account.currency || settings.sms_billing_currency || "USD",
      customerId,
      clubId: CLUB_ID,
      clubName: CLUB_NAME,
      saveCard: req.body?.save_card === true,
      successUrl: `${root}/?topup=success`,
      cancelUrl: `${root}/?topup=cancelled`,
    });

    log(req, ACTIONS.SMS_TOPUP_STARTED, { amount_cents: validated.amount_cents, session_id: session.id });
    res.json({ url: session.url, session_id: session.id });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// POST /api/credit/save-card — Checkout in setup mode, no charge.
router.post("/save-card", async (req, res) => {
  if (!stripeLib.isConfigured()) {
    return res.status(503).json({ error: "Stripe is not configured on this deployment — set STRIPE_SECRET_KEY." });
  }
  try {
    const account = await store.ensureAccount();
    if (!account) {
      return res.status(503).json({ error: "The credit tables are not set up yet — run migrations/sms-credit.sql." });
    }

    const customerId = await stripeLib.ensureCustomer({
      account, clubName: CLUB_NAME, email: req.user?.email, clubId: CLUB_ID,
    });
    if (customerId !== account.stripe_customer_id) {
      await store.updateAccount({ stripe_customer_id: customerId });
    }

    const root = baseUrl(req);
    const session = await stripeLib.createCardSetupSession({
      customerId, clubId: CLUB_ID,
      successUrl: `${root}/?card=saved`,
      cancelUrl: `${root}/?card=cancelled`,
    });
    res.json({ url: session.url, session_id: session.id });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// PUT /api/credit/settings — thresholds and auto top-up.
router.put("/settings", async (req, res) => {
  const fields = {};

  // Every amount is validated rather than trusted. A threshold of -1 would mean
  // the warning never fires; an auto top-up amount of 5,000,000 would be a
  // fat-finger charge of fifty thousand dollars.
  const amounts = {
    low_balance_cents: "Low-balance warning",
    critical_balance_cents: "Critical warning",
    auto_topup_threshold_cents: "Auto top-up trigger",
    auto_topup_amount_cents: "Auto top-up amount",
  };
  for (const [field, label] of Object.entries(amounts)) {
    if (req.body[field] === undefined) continue;
    const n = Number(req.body[field]);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: `${label} must be a positive amount.` });
    }
    if (n > credit.MAX_TOPUP_CENTS) {
      return res.status(400).json({ error: `${label} cannot exceed ${credit.formatMoney(credit.MAX_TOPUP_CENTS)}.` });
    }
    fields[field] = n;
  }

  if (req.body.auto_topup_enabled !== undefined) {
    fields.auto_topup_enabled = req.body.auto_topup_enabled === true;
  }

  if (!Object.keys(fields).length) return res.status(400).json({ error: "Nothing to update." });

  try {
    const account = await store.ensureAccount();
    if (!account) {
      return res.status(503).json({ error: "The credit tables are not set up yet — run migrations/sms-credit.sql." });
    }

    // Turning auto top-up on without a card would produce a setting that looks
    // active and silently never fires.
    if (fields.auto_topup_enabled && !account.stripe_payment_method_id) {
      return res.status(400).json({ error: "Save a card first — automatic top-up needs a payment method on file." });
    }

    // An auto top-up smaller than the trigger leaves the balance below the
    // threshold immediately after charging, so the next message triggers
    // another. Refused rather than allowed to loop.
    const threshold = fields.auto_topup_threshold_cents ?? Number(account.auto_topup_threshold_cents);
    const amount = fields.auto_topup_amount_cents ?? Number(account.auto_topup_amount_cents);
    if ((fields.auto_topup_enabled ?? account.auto_topup_enabled) && amount <= threshold) {
      return res.status(400).json({
        error: `The top-up amount must be larger than the trigger level, or the balance would still be below it after topping up.`,
      });
    }

    const updated = await store.updateAccount(fields);
    log(req, ACTIONS.SMS_CREDIT_SETTINGS_CHANGED, fields);
    res.json({ saved: true, account: updated });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// POST /api/credit/adjust  { amount_cents, reason }
//
// Manual credit or debit — a goodwill credit, a correction, credit taken over
// the phone. The only path that moves money without Stripe, so it is audited
// and demands a reason.
router.post("/adjust", async (req, res) => {
  const amount = Number(req.body?.amount_cents);
  if (!Number.isFinite(amount) || amount === 0) {
    return res.status(400).json({ error: "Enter an amount to add or remove." });
  }
  if (Math.abs(amount) > credit.MAX_TOPUP_CENTS) {
    return res.status(400).json({ error: `An adjustment cannot exceed ${credit.formatMoney(credit.MAX_TOPUP_CENTS)}.` });
  }
  if (!req.body?.reason || !String(req.body.reason).trim()) {
    return res.status(400).json({ error: "A reason is required for a manual adjustment." });
  }

  try {
    await store.ensureAccount();
    const result = await store.creditAccount({
      amountCents: amount,
      entryType: "adjustment",
      idempotencyKey: `adjust:${Date.now()}:${req.user?.staff_id || "unknown"}`,
      description: String(req.body.reason).slice(0, 300),
      actorEmail: req.user?.email || null,
    });

    if (!result.ok) {
      // The non-negative constraint refuses a debit larger than the balance,
      // which is the correct outcome rather than an error to work around.
      return res.status(400).json({
        error: result.reason === "no_account"
          ? "The credit tables are not set up yet — run migrations/sms-credit.sql."
          : "That adjustment would take the balance below zero.",
      });
    }

    log(req, ACTIONS.SMS_CREDIT_ADJUSTED, { amount_cents: amount, reason: req.body.reason });
    res.json({ adjusted: true, balance_cents: result.balance_after });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

module.exports = router;
