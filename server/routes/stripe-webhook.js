// Stripe webhook — the only thing that grants credit.
//
// Three properties matter here, and all three are easy to get wrong:
//
//   1. Signature verification. This endpoint is public by necessity. Without
//      verifying Stripe's signature over the *raw* body, anyone who finds the
//      URL can POST a fake payment_intent.succeeded and credit themselves. The
//      route is mounted with express.raw() ahead of the JSON parser in index.js
//      precisely so the bytes Stripe signed are the bytes we check.
//
//   2. Idempotency. Stripe retries — for up to three days, on any non-2xx, and
//      sometimes even after a 200. Every credit goes through a key derived from
//      the Stripe object id, and a unique index in the database makes a
//      double-credit impossible rather than unlikely.
//
//   3. Answering 200 quickly, even for events we ignore. A non-2xx tells Stripe
//      to retry, so an unrecognised event type returning 500 turns into an
//      indefinite retry loop against an endpoint that will never like it.

const express = require("express");
const router = express.Router();
const store = require("../lib/sms-credit-store");
const stripeLib = require("../lib/stripe");

// Which events we act on. Everything else is acknowledged and dropped.
const HANDLED = new Set([
  "checkout.session.completed",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.refunded",
]);

router.post("/", async (req, res) => {
  const signature = req.headers["stripe-signature"];
  if (!signature) return res.status(400).send("Missing stripe-signature header");

  let event;
  try {
    // req.body is a Buffer here, not an object — see the express.raw() mount.
    event = stripeLib.constructEvent(req.body, signature);
  } catch (e) {
    // A signature that does not verify is either a misconfiguration or someone
    // trying it on. Either way it is refused, and never processed.
    console.error("[stripe] webhook signature verification failed:", String(e.message || e));
    return res.status(400).send(`Webhook signature verification failed: ${e.message}`);
  }

  if (!HANDLED.has(event.type)) {
    return res.json({ received: true, ignored: event.type });
  }

  try {
    await handleEvent(event);
    res.json({ received: true });
  } catch (e) {
    // A 500 asks Stripe to retry, which is what we want for a transient
    // database problem — the idempotency key makes the retry safe.
    console.error(`[stripe] handling ${event.type} failed:`, String(e.message || e));
    res.status(500).send("Handler failed");
  }
});

async function handleEvent(event) {
  const object = event.data.object;

  switch (event.type) {
    case "checkout.session.completed": {
      if (object.mode === "setup") return saveCardFromSetup(object);
      return grantCreditFromSession(object, event.id);
    }

    case "payment_intent.succeeded":
      return grantCredit(object, event.id);

    case "payment_intent.payment_failed":
      return recordFailure(object);

    case "charge.refunded":
      return applyRefund(object, event.id);
  }
}

// Money in, from the Checkout session.
//
// This is the belt to payment_intent.succeeded's braces, and for a while it was
// the only one that would have worked: session metadata is set directly by us,
// whereas the metadata on the PaymentIntent depends on having passed
// payment_intent_data correctly — which originally we had not, so every top-up
// arrived unrecognisable and no credit was granted.
//
// Both paths key on the payment intent id, so whichever event lands first
// credits and the other is a no-op.
async function grantCreditFromSession(session, eventId) {
  if (session?.metadata?.purpose !== "sms_credit_topup") return;
  if (session.payment_status && session.payment_status !== "paid") {
    console.log(`[stripe] session ${session.id} completed but is not paid (${session.payment_status}) — not crediting`);
    return;
  }

  const amount = Number(session.amount_total);
  if (!Number.isFinite(amount) || amount <= 0) return;

  const intentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;

  const result = await store.creditAccount({
    clubId: session.metadata?.club_id || undefined,
    amountCents: amount,
    entryType: "topup",
    // The payment intent, so this and payment_intent.succeeded cannot both
    // apply. Falls back to the session only when there is no intent to key on.
    idempotencyKey: intentId ? `stripe:pi:${intentId}` : `stripe:cs:${session.id}`,
    description: "Top-up",
    paymentIntentId: intentId || null,
    sessionId: session.id,
  });

  if (result.reason === "already_applied") {
    console.log(`[stripe] session ${session.id} was already credited — the payment intent event got here first`);
  } else if (result.ok) {
    console.log(`[stripe] credited ${amount} cents from session ${session.id} (event ${eventId})`);
  } else {
    throw new Error(`Could not credit session ${session.id}: ${result.reason}`);
  }
}

// Store the card a club saved through Checkout in setup mode.
//
// Called but never defined until now, so any setup-mode session threw a
// ReferenceError, returned 500, and left Stripe retrying it for three days.
async function saveCardFromSetup(session) {
  const setupIntentId = typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent?.id;
  if (!setupIntentId) return;

  try {
    const paymentMethod = await stripeLib.paymentMethodFromSetup(setupIntentId);
    if (!paymentMethod) return;

    const clubId = session.metadata?.club_id || undefined;
    await store.updateAccount({ stripe_payment_method_id: paymentMethod }, clubId);
    console.log(`[stripe] saved a card for future top-ups from session ${session.id}`);
  } catch (e) {
    // Worth a retry: without the stored reference, automatic top-up silently
    // never fires and the club finds out when sending stops.
    throw new Error(`Could not store the saved card from ${session.id}: ${e.message || e}`);
  }
}

// Money in, from the payment intent.
async function grantCredit(intent, eventId) {
  if (intent?.metadata?.purpose !== "sms_credit_topup") return;

  // Trust Stripe's amount_received, not the metadata. Metadata is what we asked
  // for; amount_received is what was actually taken, and a partial capture must
  // credit what was paid rather than what was quoted.
  const amount = Number(intent.amount_received ?? intent.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error("[stripe] payment intent had no usable amount:", intent.id);
    return;
  }

  const clubId = intent.metadata?.club_id || null;
  const automatic = intent.metadata?.auto === "true";

  const result = await store.creditAccount({
    clubId: clubId || undefined,
    amountCents: amount,
    entryType: "topup",
    // Keyed on the payment intent, not the event: Stripe can deliver the same
    // payment under more than one event id, and the intent is the thing that
    // must only ever be credited once.
    idempotencyKey: `stripe:pi:${intent.id}`,
    description: automatic ? "Automatic top-up" : "Top-up",
    paymentIntentId: intent.id,
  });

  if (result.reason === "already_applied") {
    console.log(`[stripe] ${intent.id} was already credited — retry ignored`);
  } else if (result.ok) {
    console.log(`[stripe] credited ${amount} cents from ${intent.id} (event ${eventId})`);
  } else {
    // Throwing asks Stripe to retry. A payment taken but not credited is the
    // one failure here that must never be quietly swallowed.
    throw new Error(`Could not credit ${intent.id}: ${result.reason}`);
  }

  // The automatic top-up lock is held from when the charge was requested until
  // now, so a slow confirmation cannot trigger a second charge.
  if (automatic) await store.releaseTopupLock(clubId || undefined, null);

  // A card used for an automatic top-up, or one the club asked to save, is
  // stored for next time.
  if (intent.setup_future_usage === "off_session" && intent.payment_method) {
    await store.updateAccount({ stripe_payment_method_id: intent.payment_method }, clubId || undefined);
  }
}

async function recordFailure(intent) {
  if (intent?.metadata?.purpose !== "sms_credit_topup") return;
  const clubId = intent.metadata?.club_id || null;
  const reason = intent.last_payment_error?.message || "The card was declined.";

  console.error(`[stripe] top-up failed for ${intent.id}: ${reason}`);
  // Releases the lock so the next threshold crossing may try again — with a
  // different card, or after the club has fixed the one on file.
  await store.releaseTopupLock(clubId || undefined, reason);
}

// Money out. Recorded as its own ledger entry so the balance and the history
// stay reconcilable rather than the original top-up being edited away.
async function applyRefund(charge, eventId) {
  if (charge?.metadata?.purpose !== "sms_credit_topup" && charge?.payment_intent == null) return;

  const refunded = Number(charge.amount_refunded);
  if (!Number.isFinite(refunded) || refunded <= 0) return;

  const clubId = charge.metadata?.club_id || null;
  const result = await store.creditAccount({
    clubId: clubId || undefined,
    amountCents: -refunded,
    entryType: "refund",
    // Keyed on the refunded total, so a second partial refund on the same
    // charge is a distinct entry while a redelivery of the same one is not.
    idempotencyKey: `stripe:refund:${charge.id}:${refunded}`,
    description: "Refunded to the card on file",
    paymentIntentId: typeof charge.payment_intent === "string" ? charge.payment_intent : null,
  });

  if (!result.ok && result.reason !== "already_applied") {
    // A refund larger than the remaining balance would take it negative, which
    // the constraint refuses. That is a real situation — credit spent before the
    // refund — and it needs a human, not a retry loop.
    console.error(
      `[stripe] could not apply refund for ${charge.id} (event ${eventId}): ${result.reason}. ` +
      `The balance may be lower than the refunded amount; adjust it manually.`
    );
  }
}

module.exports = router;
