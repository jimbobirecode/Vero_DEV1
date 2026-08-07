const { randomUUID } = require("crypto");
const { supabase } = require("./supabase");
const { readSecret } = require("./vault");
const { CLUB_NAME, CLUB_UUID } = require("./club-config");
const { meterAndPrice } = require("./sms-billing");
const credit = require("./sms-credit");
const creditStore = require("./sms-credit-store");

const SENDLY_API_KEY = process.env.SENDLY_API_KEY || "";

async function loadCredentials(clubId) {
  const { data: cfg } = await supabase
    .from("club_integrations")
    .select("*")
    .eq("club_id", clubId)
    .maybeSingle();

  return {
    sendlyKey: (await readSecret(cfg?.sendly_api_key_secret_id)) ?? SENDLY_API_KEY,
    sendlyFrom: cfg?.sendly_from_number ?? process.env.SENDLY_FROM_NUMBER ?? "",
    sendgridKey: (await readSecret(cfg?.sendgrid_api_key_secret_id)) ?? process.env.SENDGRID_API_KEY ?? "",
    sendgridFrom: cfg?.sendgrid_from_email ?? process.env.SENDGRID_FROM_EMAIL ?? "",
  };
}

// Only ever a real uuid or null — see club-config.js. Writing a non-uuid label
// here failed every message_log insert, losing the delivery record entirely.
const CLUB_ID = CLUB_UUID;

// The rate card, cached briefly.
//
// Every send would otherwise read club_settings, and a nightly batch is
// hundreds of sends against a rate that changes a few times a year. Sixty
// seconds is short enough that a rate edit takes effect while someone is still
// looking at the Settings screen, and long enough that a batch reads it once.
let rateCardCache = { at: 0, settings: null };
const RATE_CACHE_MS = 60_000;

async function billingSettings() {
  const now = Date.now();
  if (rateCardCache.settings && now - rateCardCache.at < RATE_CACHE_MS) {
    return rateCardCache.settings;
  }
  const settings = {};
  try {
    const { data } = await supabase
      .from("club_settings")
      .select("key, value")
      .like("key", "sms_%");
    for (const row of data || []) settings[row.key] = row.value;
    rateCardCache = { at: now, settings };
  } catch (e) {
    // Pricing must never be the reason a survey does not go out. An unpriced
    // message is still metered and can be repriced later; an unsent one is a
    // member who was never asked.
    console.error("[sms-billing] could not read rate card:", String(e));
    return rateCardCache.settings || {};
  }
  return settings;
}

// `billing` carries the meter reading for an SMS: segments, encoding, the unit
// price in force, and the resulting charge. Null for email, which is not
// deducted per message.
async function logMessage(memberId, channel, recipient, subject, body, status, errorMessage, { kind = null, billing = null } = {}) {
  const entry = {
    member_id: memberId ?? null,
    channel,
    recipient,
    subject: subject ?? null,
    body,
    status,
    error_message: errorMessage ?? null,
    kind,
    club_id: CLUB_ID,
  };

  if (billing) {
    entry.segments = billing.segments;
    entry.encoding = billing.encoding;
    entry.unit_price_cents = billing.unit_price_cents;
    // A message that did not go out is metered but not charged. The carrier
    // bills for delivery attempts it accepted, not for requests that failed
    // before one — and a club must never find a failed send on its invoice.
    entry.billable_cents = status === "sent" ? billing.billable_cents : 0;
  }

  const { data, error } = await supabase.from("message_log").insert(entry).select("log_id").single();

  // Any failure at all falls back to the original, minimal shape.
  //
  // This used to retry only on an unknown-column error, on the assumption that
  // a missing migration was the sole way the extended insert could fail. It was
  // not: a CLUB_ID that is not a uuid made every insert fail on a type error,
  // and because that pattern did not match, the delivery record was dropped
  // entirely and the only trace was a line in the server log. message_log is
  // what the audit trail and the "already sent" checks read, so losing a row is
  // far worse than losing the meter reading attached to it — retry with the
  // columns that have always existed and keep the record.
  if (error) {
    console.error(
      "[sms-billing] could not write the full message_log entry, retrying without the billing columns:",
      error.message
    );
    const { data: fallback, error: fallbackError } = await supabase.from("message_log").insert({
      member_id: memberId ?? null, channel, recipient,
      subject: subject ?? null, body,
      // 'blocked' needs migrations/sms-credit.sql. Without it the row would be
      // rejected a second time, so it degrades to 'failed' — the message did
      // not go either way, and losing the record entirely is the worse outcome.
      status: status === "blocked" ? "failed" : status,
      error_message: errorMessage ?? null,
    }).select("log_id").single();

    if (fallbackError) {
      console.error("[sms-billing] the message_log entry could not be written at all:", fallbackError.message);
    }
    return fallback?.log_id || null;
  }
  return data?.log_id || null;
}

// Thrown when a send is refused for want of credit.
//
// Its own class because callers need to tell it apart from a carrier failure:
// a batch that hits an empty balance should stop rather than grind through
// another 800 recipients, each producing an identical error. routes/surveys.js
// and the other batch senders check for it.
class InsufficientCreditError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "InsufficientCreditError";
    this.code = "insufficient_credit";
    Object.assign(this, details);
  }
}

// sendSms(to, body, creds, memberId, { kind })
//
// `kind` labels the send for the club's usage history — 'survey', 'reminder',
// 'event_survey', 'staff_survey', 'integration_test'.
//
// The credit sequence is: meter, debit, send, and reverse the debit if the send
// did not happen. Debiting *before* the carrier call is what makes the hard stop
// real — the debit is a conditional UPDATE that fails when the balance is short,
// so two concurrent sends cannot both spend the last cent. Checking the balance
// first and debiting afterwards would let a nightly batch overdraw, silently.
//
// The cost of that ordering is a debit for a message that then fails to send,
// which is why the reversal exists. It is recorded as its own ledger entry
// rather than by deleting the debit: a club querying its balance is owed the
// sequence of events, not a tidied version.
async function sendSms(to, body, creds, memberId, { kind = null } = {}) {
  const payload = {
    to,
    text: body,
    message_type: "transactional",
  };
  if (creds.sendlyFrom) payload.from = creds.sendlyFrom;

  const settings = await billingSettings();

  // Metered before the send rather than after, so a message that throws
  // mid-flight is still recorded with the segment count it would have cost.
  const billing = meterAndPrice(body, settings);
  const cost = billing.billable_cents;

  const enforced = credit.creditEnforced(settings) && cost > 0;
  const sendId = randomUUID();
  let debited = false;

  if (enforced) {
    const account = await creditStore.getAccount();
    const gate = credit.canSend({ cost_cents: cost, account, settings });

    if (!gate.allowed) {
      await logMessage(memberId, "sms", to, null, body, "blocked", gate.message, { kind, billing });
      // Fire the warning and any automatic top-up before throwing, so the club
      // is told and possibly recovered rather than simply stopped.
      await afterBalanceChange(account, settings, 0);
      throw new InsufficientCreditError(gate.message, { balance_cents: gate.balance_cents, needed_cents: cost });
    }

    const result = await creditStore.debit({
      amountCents: cost, kind, idempotencyKey: sendId,
    });

    // The gate above passed and the debit still failed: another send took the
    // remaining credit in between. The atomic debit is the authority, not the
    // check — this branch is the race actually happening, not a theoretical one.
    if (!result.ok) {
      const message = credit.canSend({
        cost_cents: cost,
        account: { balance_cents: result.balance_after ?? 0, currency: settings.sms_billing_currency || "USD" },
        settings,
      }).message || "Not enough SMS credit to send this message.";
      await logMessage(memberId, "sms", to, null, body, "blocked", message, { kind, billing });
      await afterBalanceChange(null, settings, result.balance_after ?? 0);
      throw new InsufficientCreditError(message, { balance_cents: result.balance_after, needed_cents: cost });
    }

    debited = true;

    // Warn and auto top-up on the way down, using the balance the debit just
    // returned rather than reading the account again — a 900-message batch
    // should not be 900 extra queries.
    await afterBalanceChange(null, settings, result.balance_after);
  }

  try {
    const res = await fetch("https://sendly.live/api/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.sendlyKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text();
      const logId = await logMessage(memberId, "sms", to, null, body, "failed", errText, { kind, billing });
      if (debited) await creditStore.reverseDebit({ amountCents: cost, messageLogId: logId, idempotencyKey: sendId });
      throw new Error(`Sendly error: ${errText}`);
    }
    await logMessage(memberId, "sms", to, null, body, "sent", null, { kind, billing });
  } catch (e) {
    if (!e.message.startsWith("Sendly error:")) {
      const logId = await logMessage(memberId, "sms", to, null, body, "failed", e.message, { kind, billing });
      if (debited) await creditStore.reverseDebit({ amountCents: cost, messageLogId: logId, idempotencyKey: sendId });
    }
    throw e;
  }
}

// Called after every debit, with the balance the debit returned.
//
// Cheap in the common case: a healthy balance does no work at all, which is
// what keeps a nightly batch from adding a query per message. Only once the
// balance is near a threshold does it re-read the account and act.
async function afterBalanceChange(knownAccount, settings, balanceAfter) {
  try {
    const account = knownAccount || await creditStore.getAccount();
    if (!account) return;

    const current = { ...account, balance_cents: knownAccount ? account.balance_cents : balanceAfter };

    const topup = credit.shouldAutoTopup(current);
    if (topup.topup) {
      // Deliberately not awaited on the send path's critical timing, but the
      // promise is handled — an unhandled rejection here would be a silent
      // failure of the one mechanism that keeps a club sending.
      runAutoTopup(current, topup.amount_cents).catch((e) =>
        console.error("[sms-credit] automatic top-up failed:", String(e))
      );
      return;
    }

    if (credit.shouldWarn(current)) {
      await creditStore.markWarned();
      notifyLowBalance(current, settings).catch((e) =>
        console.error("[sms-credit] could not send the low-balance warning:", String(e))
      );
    }
  } catch (e) {
    // Never let a warning or a top-up break a send.
    console.error("[sms-credit] post-debit handling failed:", String(e));
  }
}

async function runAutoTopup(account, amountCents) {
  const stripeLib = require("./stripe");
  if (!stripeLib.isConfigured()) return;

  // One charge at a time. The lock is a compare-and-set in the database, so two
  // processes racing here produce one charge, not two.
  if (!(await creditStore.claimTopupLock())) return;

  try {
    // Keyed on the account and the balance band rather than on the moment, so a
    // retry after a timeout joins the original charge instead of making a
    // second one.
    const key = `autotopup:${account.club_id || "default"}:${Math.floor(Date.now() / 60000)}`;
    await stripeLib.chargeSavedCard({
      customerId: account.stripe_customer_id,
      paymentMethodId: account.stripe_payment_method_id,
      amountCents,
      currency: account.currency || "USD",
      clubId: account.club_id,
      idempotencyKey: key,
    });
    // Credit is granted by the webhook, from Stripe's own account of what
    // happened — never here. A charge that succeeds and a webhook that never
    // arrives is a reconciliation problem; granting credit locally on an
    // optimistic read is a free-money problem.
    console.log(`[sms-credit] automatic top-up of ${amountCents} cents requested`);
  } catch (e) {
    const message = String(e?.message || e);
    console.error("[sms-credit] automatic top-up declined:", message);
    await creditStore.releaseTopupLock(undefined, message);
    notifyTopupFailed(account, message).catch(() => {});
    return;
  }
  // Left held until the webhook settles it, so a slow confirmation does not
  // trigger a second charge. The lock expires on its own if nothing arrives.
}

async function notifyLowBalance(account, settings) {
  const { notifyManagers, dashboardUrl } = require("./notify");
  const state = credit.balanceState(account);
  const balance = credit.formatMoney(account.balance_cents, account.currency);
  const remaining = credit.messagesRemaining(account.balance_cents, settings);

  const subject = state === "empty"
    ? `${CLUB_NAME}: SMS credit has run out — surveys are not sending`
    : `${CLUB_NAME}: SMS credit is running low (${balance})`;

  const body = state === "empty"
    ? `SMS credit is exhausted, so surveys and alerts are no longer being sent by text.\n\n` +
      `Top up to resume: ${dashboardUrl()}\n\n` +
      `Nothing has been lost — members who could not be reached will be picked up by the next send once credit is available.`
    : `SMS credit is down to ${balance}` +
      (remaining ? `, roughly ${remaining.toLocaleString()} more messages.` : ".") +
      `\n\nTop up here: ${dashboardUrl()}\n\n` +
      `When it reaches zero, text sending stops until it is topped up.`;

  await notifyManagers(subject, body);
}

async function notifyTopupFailed(account, reason) {
  const { notifyManagers, dashboardUrl } = require("./notify");
  await notifyManagers(
    `${CLUB_NAME}: automatic SMS top-up was declined`,
    `An automatic top-up of ${credit.formatMoney(account.auto_topup_amount_cents, account.currency)} could not be taken from the card on file.\n\n` +
    `Reason given by the card issuer: ${reason}\n\n` +
    `SMS sending will stop when the balance reaches zero. Update the card or top up manually: ${dashboardUrl()}`
  );
}

const SENDGRID_TEMPLATE_ID = process.env.SENDGRID_TEMPLATE_ID || "";
const SENDGRID_REMINDER_TEMPLATE_ID = process.env.SENDGRID_REMINDER_TEMPLATE_ID || "";

// Off unless explicitly enabled — see the note where these are applied.
const CLICK_TRACKING = process.env.SENDGRID_CLICK_TRACKING === "true";
const OPEN_TRACKING = process.env.SENDGRID_OPEN_TRACKING !== "false";

// Click tracking rewrites every link through SendGrid's branded domain. While
// that domain's certificate is wrong the rewritten link dead-ends, and with
// HSTS on the parent domain the browser will not even offer a way past the
// warning. Set SENDGRID_CLICK_TRACKING=true once it serves a valid cert.
//
// Exported because there are two SendGrid call sites — this one for member
// messages and lib/notify.js for internal staff mail. The second was written
// without any tracking settings at all, so alert and digest emails kept
// rewriting their dashboard links long after member surveys stopped.
//
// internal: staff notifications force click tracking off whatever the flag
// says. Knowing that a manager clicked a link to their own dashboard is worth
// nothing, so there is no case in which breaking that link is a trade.
function trackingSettings({ internal = false } = {}) {
  const click = internal ? false : CLICK_TRACKING;
  return {
    click_tracking: { enable: click, enable_text: click },
    open_tracking: { enable: internal ? false : OPEN_TRACKING },
  };
}


// One-click unsubscribe headers (RFC 8058).
//
// Gmail, Yahoo and Microsoft all weigh these heavily for anything that looks
// like bulk mail, and their absence is one of the strongest signals pushing a
// legitimate send into Junk. They also give the recipient a way out that does
// not involve reporting you as spam, which is what actually damages a sending
// reputation — one spam complaint costs more than a hundred unsubscribes.
//
// List-Unsubscribe-Post means the mail client can honour the click itself with
// a POST, no page visit. Our /u/:token POST already performs the opt-out, so
// the header points at a URL that genuinely works rather than one that only
// looks compliant.
function unsubscribeHeaders(unsubscribeUrl) {
  if (!unsubscribeUrl) return null;
  return {
    "List-Unsubscribe": `<${unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

async function sendEmail(to, subject, body, creds, memberId, templateData, { kind = null } = {}) {
  if (!creds.sendgridKey) {
    const msg = "SendGrid API key not configured — set SENDGRID_API_KEY env var or save it in Settings > Integrations";
    await logMessage(memberId, "email", to, subject, body, "failed", msg, { kind });
    throw new Error(msg);
  }
  if (!creds.sendgridFrom) {
    const msg = "SendGrid from email not configured — set SENDGRID_FROM_EMAIL env var to a verified sender address, or save it in Settings > Integrations";
    await logMessage(memberId, "email", to, subject, body, "failed", msg, { kind });
    throw new Error(msg);
  }

  try {
    let payload;

    const templateId = templateData?.is_reminder
      ? (SENDGRID_REMINDER_TEMPLATE_ID || SENDGRID_TEMPLATE_ID)
      : SENDGRID_TEMPLATE_ID;

    if (templateId && templateData) {
      payload = {
        personalizations: [{
          to: [{ email: to }],
          dynamic_template_data: {
            club_name: CLUB_NAME,
            subject,
            ...templateData,
          },
        }],
        from: { email: creds.sendgridFrom, name: CLUB_NAME },
        template_id: templateId,
      };
    } else {
      payload = {
        personalizations: [{ to: [{ email: to }] }],
        from: { email: creds.sendgridFrom, name: CLUB_NAME },
        subject,
        content: [{ type: "text/plain", value: body }],
      };
    }

    // For a survey, click tracking is pure downside: the member's one-time
    // link and the unsubscribe link both stop working the moment the branded
    // domain's certificate is wrong. We already know who each link was sent
    // to and record the response, so the tracking buys nothing. See
    // trackingSettings() above.
    payload.tracking_settings = trackingSettings();

    // Survey mail is bulk by nature, so it carries the headers bulk mail is
    // expected to carry. Without them a perfectly legitimate send lands in
    // Junk — see docs/email-deliverability.md.
    const listHeaders = unsubscribeHeaders(templateData?.unsubscribe_url);
    if (listHeaders) payload.headers = { ...(payload.headers || {}), ...listHeaders };

    // Lets SendGrid report engagement per message type rather than lumping
    // every send together, which is how you find out that one kind of message
    // is dragging the domain's reputation down.
    payload.categories = [templateData?.is_reminder ? "survey-reminder" : "survey"];

    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.sendgridKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text();
      await logMessage(memberId, "email", to, subject, body, "failed", errText, { kind });
      throw new Error(`SendGrid error: ${errText}`);
    }
    await logMessage(memberId, "email", to, subject, body, "sent", null, { kind });
  } catch (e) {
    if (!e.message.startsWith("SendGrid error:")) {
      await logMessage(memberId, "email", to, subject, body, "failed", e.message, { kind });
    }
    throw e;
  }
}

module.exports = {
  loadCredentials, sendSms, sendEmail, trackingSettings, unsubscribeHeaders,
  InsufficientCreditError,
};
