const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { supabase } = require("../lib/supabase");
const { loadCredentials, sendSms, sendEmail } = require("../lib/senders");
const { CLUB_NAME } = require("../lib/club-config");
const { smsBody, emailSubject, resolveSurveyForVisit } = require("../lib/messages");
const { applyMemberCap, parseCapSettings } = require("../lib/send-policy");
const { resolveRecipient } = require("../lib/recipient");

const CLUB_ID = process.env.CLUB_ID;
const SURVEY_BASE_URL = process.env.SURVEY_BASE_URL;
function baseUrl(req) {
  if (SURVEY_BASE_URL) return SURVEY_BASE_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

// Wall-clock time at the club, read straight from the formatter rather than
// re-parsing a formatted string — the gate for every send depends on this,
// and a parse failure would silently stop all surveys.
function easternNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour12: false, hour: "2-digit", minute: "2-digit",
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  const hour = parseInt(parts.hour, 10) % 24;   // some ICU builds emit 24 at midnight
  return { hour, minute: parseInt(parts.minute, 10) };
}

// Fire on the first cron tick at or after the configured time, and only that
// one. Ticks land on :00 and :30, so a slot is the half hour that follows it.
function isSendSlot(now, sendHour, sendMinute) {
  if (now.hour !== sendHour) return false;
  return now.minute >= sendMinute && now.minute < sendMinute + 30;
}

// POST /api/cron/send-surveys
// Runs every half hour via Render Cron. Sends only when the club's configured
// send time comes round, and never inside the 8pm–8am blackout.
// Every invocation stamps its outcome, so "did the scheduler even call us?"
// is answerable from the dashboard instead of from Render's logs.
async function recordRun(outcome) {
  try {
    await supabase.from("club_settings").upsert([
      { key: "last_send_run_at", value: new Date().toISOString(), updated_at: new Date().toISOString() },
      { key: "last_send_run_outcome", value: JSON.stringify(outcome).slice(0, 1000), updated_at: new Date().toISOString() },
    ]);
  } catch (e) {
    console.error("[send-surveys] could not record run:", String(e));
  }
}

// Does the actual sending. Called by the in-app scheduler (see
// lib/scheduler.js) and by the manual endpoint below. Applies no time gating
// of its own — the caller decides when it is time.
async function performSend(linkBase) {
  const results = { sent: 0, skipped_opt_out: 0, skipped_frequency_cap: 0, errors: [] };
  const creds = await loadCredentials(CLUB_ID);

  // Nothing can go out without a provider key; say so plainly rather than
  // letting every message fail one by one against the provider.
  if (!creds.sendlyKey && !creds.sendgridKey) {
    const out = { skipped: true, reason: "No SMS or email provider credentials are configured (SENDLY_API_KEY / SENDGRID_API_KEY)" };
    await recordRun(out);
    return out;
  }

  // Resolve the live template for each survey type once. Without this the
  // response carries no template and the member sees the survey page's
  // built-in defaults rather than the questions configured in the Builder.
  const templatesByType = {};
  const templatesById = {};
  try {
    const { data: tpls } = await supabase
      .from("survey_templates")
      .select("template_id, survey_type, created_at")
      .eq("active", true)
      .order("created_at", { ascending: false });
    for (const t of tpls || []) {
      templatesById[t.template_id] = t;
      if (!templatesByType[t.survey_type]) templatesByType[t.survey_type] = t;
    }
  } catch (_) { /* templates are optional; fall back to defaults */ }

  const { data: visits, error } = await supabase
    .from("visits")
    .select("visit_id, member_id, outlet_id, visit_date, visitor_type, guest_name, guest_phone, guest_email, members(*), outlets(*)")
    .eq("qualifies", true)
    .is("survey_sent_at", null);

  if (error) {
    const out = { error: error.message };
    await recordRun(out);
    return out;
  }

  // Cap how many surveys one member receives across all outlets. Repeat
  // cheques at a single outlet are already merged upstream; this handles a
  // member who used several outlets in a day.
  const { data: capRows } = await supabase.from("club_settings").select("key, value");
  const capSettings = {};
  for (const r of capRows || []) capSettings[r.key] = r.value;
  const { cap, windowDays } = parseCapSettings(capSettings);

  // Count what each member has already had inside the window, so the cap
  // holds across separate uploads rather than only within one batch.
  const windowStart = new Date(Date.now() - windowDays * 86400000).toISOString();
  const alreadySent = {};
  {
    const { data: recent } = await supabase
      .from("visits")
      .select("member_id")
      .not("member_id", "is", null)
      .not("survey_sent_at", "is", null)
      .gte("survey_sent_at", windowStart);
    for (const r of recent || []) {
      alreadySent[r.member_id] = (alreadySent[r.member_id] || 0) + 1;
    }
  }

  const capResult = applyMemberCap(visits ?? [], { cap, windowDays, alreadySent });
  results.skipped_member_cap = capResult.deferred.length;

  // Take the deferred visits out of the queue so they do not resurface
  // tomorrow as stale surveys about a visit the member has moved on from.
  for (const d of capResult.deferred) {
    await supabase.from("visits").update({ qualifies: false }).eq("visit_id", d.visit.visit_id);
  }

  for (const visit of capResult.send) {
    const member = visit.members;
    const outlet = visit.outlets;

    // Shared with the Survey Queue screen — see lib/recipient.js. Written
    // separately, the two drifted: the queue fell back across channels and
    // this did not, so a member who preferred email but had only a phone was
    // previewed as ready and then failed here.
    const { channel: sendChannel, recipient, blocked_reason } = resolveRecipient({ member, visit });
    const recipientName = member ? `${member.first_name} ${member.last_name}` : (visit.guest_name || "Guest");
    const logId = member ? member.member_id : null;

    if (blocked_reason === "Member has opted out") { results.skipped_opt_out++; continue; }
    if (!recipient) {
      results.errors.push(`${blocked_reason || "No contact method"} for ${recipientName || 'visit ' + visit.visit_id}`);
      continue;
    }

    // Frequency cap only applies to dining members — golf visits are
    // pre-screened at tee sheet review, and guests have no repeat tracking
    if (member && visit.visitor_type !== "golf") {
      const windowStart = new Date(Date.now() - (outlet?.frequency_limit_days ?? 30) * 24 * 60 * 60 * 1000).toISOString();
      const { count: recentSurveyCount } = await supabase
        .from("visits")
        .select("visit_id", { count: "exact", head: true })
        .eq("member_id", member.member_id)
        .eq("outlet_id", visit.outlet_id)
        .not("survey_sent_at", "is", null)
        .gte("survey_sent_at", windowStart);

      if ((recentSurveyCount ?? 0) > 0) {
        results.skipped_frequency_cap++;
        continue;
      }
    }

    const { data: existingResp } = await supabase
      .from("survey_responses")
      .select("survey_token, submitted_at")
      .eq("visit_id", visit.visit_id)
      .maybeSingle();

    // Already answered. Stamp the visit so it leaves the queue: selection is
    // by survey_sent_at being empty, so skipping without stamping left the
    // visit being re-examined on every run for ever and still showing on the
    // Survey Queue screen as unsent.
    if (existingResp?.submitted_at) {
      await supabase
        .from("visits")
        .update({ survey_sent_at: existingResp.submitted_at })
        .eq("visit_id", visit.visit_id);
      continue;
    }

    // An outlet may nominate its own template; otherwise the visit's type
    // decides. Wording follows whichever template is actually used.
    const survey = resolveSurveyForVisit({ visit, templatesById, templatesByType });

    let token;
    if (existingResp) {
      token = existingResp.survey_token;
    } else {
      token = crypto.randomUUID();
      const payload = { visit_id: visit.visit_id, survey_token: token };
      if (survey.template_id) payload.template_id = survey.template_id;

      let { error: insertErr } = await supabase.from("survey_responses").insert(payload);
      if (insertErr && insertErr.message && insertErr.message.includes("template_id")) {
        delete payload.template_id;
        ({ error: insertErr } = await supabase.from("survey_responses").insert(payload));
      }
      if (insertErr) {
        results.errors.push(insertErr.message);
        continue;
      }
    }

    const link = `${linkBase}/s/${token}`;
    const surveyType = survey.survey_type;
    const message = smsBody({ surveyType, link });

    try {
      if (sendChannel === "sms") {
        await sendSms(recipient, message, creds, logId);
      } else {
        const nameParts = recipientName.split(" ");
        await sendEmail(recipient, emailSubject({ surveyType }), message, creds, logId, {
          first_name: nameParts[0] || "",
          last_name: nameParts.slice(1).join(" ") || "",
          survey_url: link,
          unsubscribe_url: `${linkBase}/u/${token}`,
          outlet_name: outlet?.name || "",
          visit_date: visit.visit_date || "",
          is_reminder: false,
        });
      }
      // The message has gone. If recording that fails, the visit still reads
      // as unsent and tomorrow's batch sends the same member the same survey
      // again — the per-outlet frequency cap cannot catch it either, because
      // that check keys on the same column. Say so instead of swallowing it.
      const { error: stampErr } = await supabase
        .from("visits")
        .update({ survey_sent_at: new Date().toISOString() })
        .eq("visit_id", visit.visit_id);
      if (stampErr) {
        results.errors.push(`${recipientName}: sent, but recording it failed — ${stampErr.message}. They may be sent it again.`);
      }
      results.sent++;
    } catch (e) {
      results.errors.push(String(e));
    }
  }

  await recordRun({
    ran: true, sent: results.sent,
    skipped_opt_out: results.skipped_opt_out,
    skipped_frequency_cap: results.skipped_frequency_cap,
    errors: results.errors.length,
    first_error: results.errors[0] ? String(results.errors[0]).slice(0, 200) : null,
  });
  return results;
}

// POST /api/cron/send-surveys
// Scheduling lives in the app (lib/scheduler.js), driven by the send time set
// in Settings. This endpoint remains as a manual trigger and a fallback, and
// still honours the configured time unless ?force=true is passed.
router.post("/send-surveys", async (req, res) => {
  const now = easternNow();
  const clock = `${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}`;
  const force = req.query.force === "true";

  if (!force) {
    if (now.hour < 8 || now.hour >= 20) {
      const out = { skipped: true, reason: `Outside the SMS window (8am–8pm Eastern); local time is ${clock}` };
      await recordRun(out);
      return res.json(out);
    }
    const { data: setting } = await supabase
      .from("club_settings").select("value").eq("key", "survey_send_time").maybeSingle();
    const sendTime = setting?.value || "09:30";
    const [sh, sm] = sendTime.split(":").map(Number);
    if (!isSendSlot(now, sh, sm)) {
      const out = { skipped: true, reason: `Not the send slot (configured ${sendTime} Eastern, now ${clock})` };
      await recordRun(out);
      return res.json(out);
    }
  }

  const result = await performSend(baseUrl(req));
  if (result.error) return res.status(500).json(result);
  if (result.skipped) return res.status(503).json(result);
  res.json(result);
});

module.exports = router;
module.exports.performSend = performSend;
module.exports.recordRun = recordRun;
module.exports.easternNow = easternNow;
module.exports.isSendSlot = isSendSlot;
