const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");
const { loadCredentials } = require("../lib/senders");
const { easternNow, isSendSlot } = require("./surveys");

const CLUB_ID = process.env.CLUB_ID;

// GET /api/diagnostics/delivery
// Answers "why hasn't anything sent?" by reporting each gate a survey must
// pass, in the order it is applied. Reports whether credentials exist, never
// what they are.
router.get("/delivery", async (req, res) => {
  const now = easternNow();
  const clock = `${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}`;
  const checks = [];

  const settings = {};
  const { data: rows } = await supabase.from("club_settings").select("key, value");
  for (const r of rows || []) settings[r.key] = r.value;

  // 1. Is the in-app scheduler running? It heartbeats every minute, so a stale
  //    beat means the service is down or was restarted and failed to start it.
  const beat = settings.scheduler_heartbeat_at ? new Date(settings.scheduler_heartbeat_at) : null;
  const beatMins = beat ? Math.round((Date.now() - beat.getTime()) / 60000) : null;
  checks.push({
    step: "Scheduler is running",
    ok: beat != null && beatMins <= 5,
    detail: beat
      ? `Last checked ${beatMins <= 1 ? "less than a minute" : beatMins + " minutes"} ago`
      : "The scheduler has not reported in. The service may have just started, or failed to boot.",
    fix: beat && beatMins > 5
      ? "The scheduler checks every minute. Confirm the Vero web service is running in Render — if it restarted, the scheduler restarts with it."
      : (beat ? null : "Give the service a minute after a deploy, then re-check. If it stays empty, look at the Render logs for '[scheduler]'."),
    last_outcome: settings.last_send_run_outcome ? safeParse(settings.last_send_run_outcome) : null,
  });

  // 2. Has today's batch already gone?
  const clubDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  checks.push({
    step: "Today's send",
    ok: true,
    detail: settings.last_sent_date === clubDate
      ? `Already sent today (${clubDate}) — the next batch goes tomorrow at the configured time.`
      : `Not yet sent today (${clubDate}).`,
    fix: null,
  });

  // 2. Provider credentials
  let creds = {};
  try { creds = await loadCredentials(CLUB_ID); } catch { /* reported below */ }
  const hasSms = Boolean(creds.sendlyKey);
  const hasEmail = Boolean(creds.sendgridKey);
  checks.push({
    step: "Messaging provider is configured",
    ok: hasSms || hasEmail,
    detail: `SMS (Sendly): ${hasSms ? "configured" : "NOT configured"} · Email (SendGrid): ${hasEmail ? "configured" : "NOT configured"}`
      + (hasSms && !creds.sendlyFrom ? " · no Sendly from-number set" : ""),
    fix: (hasSms || hasEmail) ? null
      : "Set SENDLY_API_KEY (and SENDLY_FROM_NUMBER) or SENDGRID_API_KEY / SENDGRID_FROM_EMAIL in the Render environment.",
  });

  // 3. Send window and configured time
  const sendTime = settings.survey_send_time || "09:30";
  const [sh, sm] = sendTime.split(":").map(Number);
  const inBlackout = now.hour < 8 || now.hour >= 20;
  checks.push({
    step: "Send time and blackout window",
    ok: true,
    detail: `Configured ${sendTime} Eastern · club time now ${clock}`
      + (inBlackout ? " · currently inside the 8pm–8am blackout" : "")
      + (isSendSlot(now, sh, sm) ? " · this is the send slot" : " · not the send slot right now"),
    fix: null,
  });

  // 4. Is there anything queued?
  const { data: queued } = await supabase
    .from("visits")
    .select("visit_id, member_id, guest_phone, guest_email, members(phone_number, email_address, comm_preference, opt_out)")
    .eq("qualifies", true)
    .is("survey_sent_at", null);

  const total = (queued || []).length;
  const sendable = (queued || []).filter((v) => {
    const m = v.members;
    if (v.member_id && !m) return false;
    if (m?.opt_out) return false;
    return Boolean(m?.phone_number || m?.email_address || v.guest_phone || v.guest_email);
  }).length;

  checks.push({
    step: "Surveys are waiting to be sent",
    ok: sendable > 0,
    detail: total
      ? `${total} queued, ${sendable} of them reachable`
      : "Nothing is queued. Upload an end-of-shift report, or check that visits are meeting the outlet spend threshold.",
    fix: total && !sendable ? "Everything queued is opted out, missing contact details, or has a member ID not in the member list — see the Survey Queue." : null,
  });

  // 5. What did the provider actually say most recently?
  const { data: recent } = await supabase
    .from("message_log")
    .select("channel, status, error_message, created_at")
    .order("created_at", { ascending: false })
    .limit(20);

  const failures = (recent || []).filter((m) => m.status === "failed");
  checks.push({
    step: "Provider accepted recent messages",
    ok: failures.length === 0,
    detail: (recent || []).length
      ? `${(recent || []).length} recent attempts, ${failures.length} failed`
      : "No send attempts recorded yet.",
    fix: failures.length ? `Most recent provider error: ${String(failures[0].error_message || "").slice(0, 300)}` : null,
  });

  res.json({
    club_time: clock,
    send_time: sendTime,
    blocking: checks.filter((c) => !c.ok).map((c) => c.step),
    checks,
    recent_messages: (recent || []).slice(0, 8),
  });
});

function safeParse(v) { try { return JSON.parse(v); } catch { return v; } }

module.exports = router;
