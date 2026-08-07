// Stripe — the only file that talks to it.
//
// Two flows, and they are deliberately different shapes:
//
//   Manual top-up  — Stripe Checkout, hosted by Stripe. The club is redirected
//                    there, pays, and comes back. Card details never touch this
//                    server or the dashboard, which is what keeps the whole
//                    deployment out of PCI scope.
//
//   Auto top-up    — an off-session PaymentIntent against a card the club saved
//                    earlier, also through Checkout (in setup mode). Off-session
//                    means nobody is at the keyboard, so there is no way to
//                    complete a 3-D Secure challenge; a card that demands one
//                    fails and the club is emailed. That is a real outcome, not
//                    an edge case, and the code treats it as one.
//
// Credit is never granted here. It is granted by the webhook, from Stripe's own
// account of what happened — see routes/stripe-webhook.js. Trusting a redirect
// back to a success URL would let anyone with the link grant themselves credit.

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";

let _stripe = null;
function stripe() {
  if (!STRIPE_SECRET_KEY) return null;
  if (!_stripe) {
    const Stripe = require("stripe");
    _stripe = new Stripe(STRIPE_SECRET_KEY, {
      // Pinned. Stripe changes response shapes between versions, and a billing
      // integration that silently follows whatever the account default happens
      // to be is one dashboard setting away from breaking.
      apiVersion: "2024-06-20",
      maxNetworkRetries: 2,
      timeout: 20000,
      appInfo: { name: "Vero", url: "https://github.com/jimbobirecode/Vero_DEV1" },
    });
  }
  return _stripe;
}

function isConfigured() {
  return !!STRIPE_SECRET_KEY;
}

function notConfigured() {
  return new Error(
    "Stripe is not configured — set STRIPE_SECRET_KEY (and STRIPE_WEBHOOK_SECRET) before taking payments."
  );
}

// A Stripe customer for this club, created once and reused.
//
// Reused rather than recreated because a saved card belongs to a customer: make
// a new one each time and auto top-up loses its payment method.
async function ensureCustomer({ account, clubName, email, clubId }) {
  const s = stripe();
  if (!s) throw notConfigured();

  if (account?.stripe_customer_id) {
    try {
      const existing = await s.customers.retrieve(account.stripe_customer_id);
      if (existing && !existing.deleted) return existing.id;
    } catch (e) {
      // Falls through and creates a new one. A customer deleted in the Stripe
      // dashboard should not permanently break top-ups.
      console.error("[stripe] stored customer could not be retrieved, creating another:", String(e.message || e));
    }
  }

  const customer = await s.customers.create({
    name: clubName || undefined,
    email: email || undefined,
    metadata: { club_id: clubId || "", source: "vero" },
  });
  return customer.id;
}

// Checkout session for a one-off top-up.
//
// `amountCents` is validated by the caller against sms-credit.js. The club_id
// and the amount are put in metadata so the webhook can credit the right
// account without trusting anything the browser sends back.
async function createTopupSession({ amountCents, currency = "USD", customerId, clubId, clubName, successUrl, cancelUrl, saveCard = false }) {
  const s = stripe();
  if (!s) throw notConfigured();

  return s.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: currency.toLowerCase(),
        unit_amount: Math.round(amountCents),
        product_data: {
          name: "SMS credit",
          description: `Message credit for ${clubName || "your club"}`,
        },
      },
    }],
    payment_intent_data: {
      // The metadata has to be set HERE as well as on the session below.
      //
      // Metadata on a Checkout Session stays on the session; the PaymentIntent
      // that session creates gets none of it. So payment_intent.succeeded
      // arrived carrying nothing, the webhook could not tell it was a top-up,
      // and no credit was ever granted — silently, on a payment that had
      // genuinely succeeded. payment_intent_data is what puts it on the intent.
      metadata: {
        club_id: clubId || "",
        purpose: "sms_credit_topup",
        amount_cents: String(Math.round(amountCents)),
      },
      // Saves the card for auto top-up. Only set when the club asked for it —
      // keeping a card on file that nobody agreed to is not ours to do.
      ...(saveCard ? { setup_future_usage: "off_session" } : {}),
    },
    // And on the session, so checkout.session.completed can recognise it too.
    // Either event is enough to credit, and both share an idempotency key
    // derived from the payment intent, so whichever arrives first wins and the
    // other is a no-op. One webhook shape being wrong should not cost a club
    // its money.
    metadata: {
      club_id: clubId || "",
      purpose: "sms_credit_topup",
      amount_cents: String(Math.round(amountCents)),
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
}

// Checkout session in setup mode — saves a card without charging it.
//
// Used when a club turns on auto top-up without wanting to buy credit at the
// same moment.
async function createCardSetupSession({ customerId, clubId, successUrl, cancelUrl }) {
  const s = stripe();
  if (!s) throw notConfigured();

  return s.checkout.sessions.create({
    mode: "setup",
    customer: customerId,
    metadata: { club_id: clubId || "", purpose: "sms_credit_card_setup" },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
}

// Charge a saved card with nobody present.
//
// The idempotency key is what makes this safe to retry. Stripe treats two
// requests with the same key as one charge, so a timeout that is actually a
// success cannot become a double charge when the caller tries again.
async function chargeSavedCard({ customerId, paymentMethodId, amountCents, currency = "USD", clubId, idempotencyKey }) {
  const s = stripe();
  if (!s) throw notConfigured();

  return s.paymentIntents.create(
    {
      amount: Math.round(amountCents),
      currency: currency.toLowerCase(),
      customer: customerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      description: "SMS credit — automatic top-up",
      metadata: {
        club_id: clubId || "",
        purpose: "sms_credit_topup",
        auto: "true",
        amount_cents: String(Math.round(amountCents)),
      },
    },
    { idempotencyKey }
  );
}

// The card behind a completed setup session, so it can be stored for later use.
async function paymentMethodFromSetup(setupIntentId) {
  const s = stripe();
  if (!s) throw notConfigured();
  const intent = await s.setupIntents.retrieve(setupIntentId);
  return intent?.payment_method || null;
}

// Enough about the saved card to show "Visa ending 4242" — and nothing more.
// The full number is never available to us, which is the point of Checkout.
async function describeCard(paymentMethodId) {
  const s = stripe();
  if (!s || !paymentMethodId) return null;
  try {
    const pm = await s.paymentMethods.retrieve(paymentMethodId);
    if (!pm?.card) return null;
    return { brand: pm.card.brand, last4: pm.card.last4, exp_month: pm.card.exp_month, exp_year: pm.card.exp_year };
  } catch (e) {
    console.error("[stripe] could not describe the saved card:", String(e.message || e));
    return null;
  }
}

// Verify a webhook came from Stripe.
//
// Requires the raw request body — a parsed and re-serialised body will not
// match the signature, which is why the webhook route is mounted with
// express.raw() ahead of the JSON parser in index.js.
function constructEvent(rawBody, signature) {
  const s = stripe();
  if (!s) throw notConfigured();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set — webhook events cannot be verified");
  return s.webhooks.constructEvent(rawBody, signature, secret);
}

module.exports = {
  stripe, isConfigured, ensureCustomer,
  createTopupSession, createCardSetupSession, chargeSavedCard,
  paymentMethodFromSetup, describeCard, constructEvent,
};
