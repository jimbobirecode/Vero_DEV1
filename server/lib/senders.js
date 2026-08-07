const { supabase } = require("./supabase");
const { readSecret } = require("./vault");
const { CLUB_NAME } = require("./club-config");
const { meterAndPrice } = require("./sms-billing");

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

const CLUB_ID = process.env.CLUB_ID || null;

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
// back charged per message.
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

  const { error } = await supabase.from("message_log").insert(entry);

  // The billing columns are added by migrations/sms-back-charge.sql. Until it
  // has been run the insert is rejected for unknown columns, and losing the
  // delivery record — which is what the audit trail and the "already sent"
  // checks rely on — would be a far worse failure than losing the meter
  // reading. So fall back to the pre-billing shape and say so once.
  if (error && /column .* does not exist|Could not find the '.*' column/i.test(error.message || "")) {
    console.error(
      "[sms-billing] message_log is missing the billing columns — run migrations/sms-back-charge.sql. " +
      "Logging the message without its meter reading; it can be recovered with POST /api/billing/sms/reprice."
    );
    await supabase.from("message_log").insert({
      member_id: memberId ?? null, channel, recipient,
      subject: subject ?? null, body, status, error_message: errorMessage ?? null,
    });
  } else if (error) {
    console.error("[sms-billing] could not write message_log entry:", error.message);
  }
}

// sendSms(to, body, creds, memberId, { kind })
//
// `kind` labels the send for the invoice breakdown — 'survey', 'reminder',
// 'event', 'staff_survey', 'test'. Optional, and an unlabelled send still bills
// correctly; it just rolls up as "unattributed" on the statement.
async function sendSms(to, body, creds, memberId, { kind = null } = {}) {
  const payload = {
    to,
    text: body,
    message_type: "transactional",
  };
  if (creds.sendlyFrom) payload.from = creds.sendlyFrom;

  // Metered before the send rather than after, so a message that throws
  // mid-flight is still recorded with the segment count it would have cost.
  const billing = meterAndPrice(body, await billingSettings());

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
      await logMessage(memberId, "sms", to, null, body, "failed", errText, { kind, billing });
      throw new Error(`Sendly error: ${errText}`);
    }
    await logMessage(memberId, "sms", to, null, body, "sent", null, { kind, billing });
  } catch (e) {
    if (!e.message.startsWith("Sendly error:")) {
      await logMessage(memberId, "sms", to, null, body, "failed", e.message, { kind, billing });
    }
    throw e;
  }
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

module.exports = { loadCredentials, sendSms, sendEmail, trackingSettings, unsubscribeHeaders };
