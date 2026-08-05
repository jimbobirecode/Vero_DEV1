const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");
const { notifyStaffMember, dashboardUrl } = require("../lib/notify");
const { CLUB_NAME } = require("../lib/club-config");
const { generateFollowUp } = require("../lib/ai");
const recovery = require("../lib/recovery");
const store = require("../lib/recovery-store");

// GET /api/alerts?status=open&limit=50&offset=0
router.get("/", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  let query = supabase
    .from("case_alerts")
    .select(
      "*, outlets(name), survey_responses(q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, q5_comment, submitted_at, visits(visit_date, member_id, guest_name, members(first_name, last_name)))",
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (req.query.status && ["open", "assigned", "resolved"].includes(req.query.status)) {
    query = query.eq("status", req.query.status);
  }

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ alerts: data, total: count });
});

// PUT /api/alerts/:id/assign — assign an alert to a staff member
// Accepts { staff_id } (preferred) or { assigned_to } (legacy text fallback)
router.put("/:id/assign", async (req, res) => {
  const { staff_id, assigned_to } = req.body;

  if (!staff_id && !assigned_to) {
    return res.status(400).json({ error: "staff_id or assigned_to is required" });
  }

  let staffName = assigned_to;
  let staffId = staff_id;

  if (staff_id) {
    const { data: staff } = await supabase
      .from("staff")
      .select("staff_id, name")
      .eq("staff_id", staff_id)
      .maybeSingle();
    if (!staff) return res.status(404).json({ error: "Staff member not found" });
    staffName = staff.name;
  }

  const update = { assigned_to: staffName, status: "assigned" };
  if (staffId) update.assigned_to_staff_id = staffId;

  let updateErr;
  ({ error: updateErr } = await supabase
    .from("case_alerts")
    .update(update)
    .eq("alert_id", req.params.id));

  if (updateErr && updateErr.message && updateErr.message.includes("assigned_to_staff_id")) {
    delete update.assigned_to_staff_id;
    ({ error: updateErr } = await supabase
      .from("case_alerts")
      .update(update)
      .eq("alert_id", req.params.id));
  }

  if (updateErr) return res.status(500).json({ error: updateErr.message });

  // Immediate notification to the assigned staff member
  if (staffId) {
    const ready = await store.recoveryReady();
    const { alert } = ready.ok
      ? await store.alertForRecovery(req.params.id)
      : { alert: null };

    let fallback = null;
    if (!alert) {
      const { data } = await supabase
        .from("case_alerts").select("severity, outlets(name)").eq("alert_id", req.params.id).maybeSingle();
      fallback = data;
    }

    const severity = alert?.severity || fallback?.severity;
    const outlet = alert?.outlet_name || fallback?.outlets?.name || "Unknown outlet";
    const url = dashboardUrl();
    const subject = `[Club Vero] ${String(severity || "").toUpperCase()} alert assigned to you — ${outlet}`;

    let body = `Hi ${staffName},\n\nA ${severity} severity alert at ${outlet} has been assigned to you.\n`;

    // Who to ring, by when, and a one-tap way to log it. A manager does this
    // from a phone thirty seconds after hanging up — an email that only links
    // to a dashboard collects nothing, and a recovery metric built on nothing
    // is worse than no metric.
    if (alert) {
      const withDue = await store.ensureDueDate(alert, await store.loadSlaSettings());
      const token = await store.ensureRecoveryToken(alert.alert_id, alert.recovery_token);

      if (withDue.member_name) {
        body += `\nMember: ${withDue.member_name}`;
        if (withDue.member_phone) body += `\nPhone: ${withDue.member_phone}`;
        else if (withDue.member_email) body += `\nEmail: ${withDue.member_email}`;
        else body += `\n(No phone or email on file — this member cannot be reached.)`;
      }
      if (withDue.comment) body += `\nThey said: "${withDue.comment}"`;
      if (withDue.contact_due_at) {
        body += `\n\nCall them by ${new Date(withDue.contact_due_at).toUTCString()}.`;
      }
      if (token && url) {
        body += `\n\nOnce you have called, log it in one tap:\n${url}/c/${token}`;
      }
    }

    body += `\n${url ? `\nView in dashboard: ${url}` : ""}\n\n${CLUB_NAME}`;

    notifyStaffMember(staffId, subject, body).catch((e) =>
      console.error("Alert assignment notification failed:", e.message)
    );
  }

  res.json({ updated: true });
});

// ---------------------------------------------------------------------------
// Service recovery — closing the alert back to the member.
//
// Nothing here messages the member automatically. The act worth having is a
// manager telephoning them within the day; an auto-sent apology would replace
// that with something worse than silence. These endpoints time the call,
// record it, and report on it.
// ---------------------------------------------------------------------------

// GET /api/alerts/recovery-queue — who is waiting to be called, most at risk
// first. Declared before the /:id routes so "recovery-queue" is never read as
// an alert id.
router.get("/recovery-queue", async (req, res) => {
  const ready = await store.recoveryReady();
  if (!ready.ok) return res.status(503).json({ error: ready.error });

  const includeContacted = req.query.include_contacted === "true";

  let query = supabase
    .from("case_alerts")
    .select(store.ALERT_WITH_MEMBER)
    .neq("status", "resolved")
    .order("created_at", { ascending: true })
    .limit(200);

  if (!includeContacted) query = query.is("first_contact_at", null);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const settings = await store.loadSlaSettings();
  const now = Date.now();

  // Alerts raised before this feature shipped have no clock. Give them one on
  // the way past rather than leaving them permanently unscheduled.
  const alerts = [];
  for (const row of data || []) {
    let a = store.shapeAlert(row);
    if (!a.contact_due_at) a = await store.ensureDueDate(a, settings);
    alerts.push(a);
  }

  const queue = alerts
    .sort((a, b) => recovery.queueRank(a, now) - recovery.queueRank(b, now))
    .map((a) => {
      const sla = recovery.slaState(a, now);
      return {
        ...a,
        sla_state: sla.state,
        ms_remaining: sla.ms_remaining,
        remaining_label: recovery.formatRemaining(sla.ms_remaining),
        // Whether there is anybody to ring, which is the difference between
        // "nobody called them" and "nobody could".
        contactable: Boolean(a.member_phone || a.member_email),
      };
    });

  res.json({
    queue,
    summary: {
      waiting: queue.filter((q) => q.sla_state === "waiting").length,
      due: queue.filter((q) => q.sla_state === "due").length,
      urgent: queue.filter((q) => q.sla_state === "urgent").length,
      breached: queue.filter((q) => q.sla_state === "breached").length,
      uncontactable: queue.filter((q) => !q.contactable && !q.first_contact_at).length,
    },
    channels: recovery.CHANNELS,
    outcomes: recovery.OUTCOMES,
    sentiments: recovery.SENTIMENTS,
    no_contact_reasons: recovery.NO_CONTACT_REASONS,
  });
});

// GET /api/alerts/recovery-stats?days=90 — the three numbers worth quoting.
router.get("/recovery-stats", async (req, res) => {
  const ready = await store.recoveryReady();
  if (!ready.ok) return res.status(503).json({ error: ready.error });

  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 365);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const { data, error } = await supabase
    .from("case_alerts")
    .select(store.ALERT_WITH_MEMBER)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(2000);

  if (error) return res.status(500).json({ error: error.message });

  const alerts = (data || []).map(store.shapeAlert);
  const followUps = await store.followUpScores(alerts);

  res.json({ period_days: days, ...recovery.recoveryMetrics(alerts, followUps) });
});

// GET /api/alerts/:id/outreach — every attempt made on this alert.
router.get("/:id/outreach", async (req, res) => {
  const ready = await store.recoveryReady();
  if (!ready.ok) return res.status(503).json({ error: ready.error });
  res.json({ outreach: await store.outreachFor(req.params.id) });
});

// POST /api/alerts/:id/outreach — log a call that already happened.
router.post("/:id/outreach", async (req, res) => {
  const ready = await store.recoveryReady();
  if (!ready.ok) return res.status(503).json({ error: ready.error });

  const { alert, error } = await store.alertForRecovery(req.params.id);
  if (error) return res.status(500).json({ error });
  if (!alert) return res.status(404).json({ error: "Alert not found" });

  const result = await store.logOutreach(alert, req.body, {
    staff_id: req.user?.staff_id || null,
    name: req.user?.name || req.body?.logged_by_name || null,
    via: "dashboard",
  });
  if (result.error) return res.status(result.status || 500).json({ error: result.error });

  res.json({
    logged: true,
    outreach: result.outreach,
    alert: result.alert,
    sla: recovery.slaState(result.alert),
    warning: result.warning,
  });
});

// PUT /api/alerts/:id/resolve — resolve an alert.
//
// Resolution used to be purely internal, which is how a club could close every
// alert it ever raised without a single member hearing back. It now needs
// either a logged contact or an explicit reason there wasn't one. The reason
// is recorded and reported rather than blocking — refusing outright would only
// teach people to log a call that never happened.
router.put("/:id/resolve", async (req, res) => {
  const ready = await store.recoveryReady();

  // Before the migration runs, resolve keeps its old behaviour rather than
  // breaking a working screen.
  if (!ready.ok) {
    const { error } = await supabase
      .from("case_alerts")
      .update({ status: "resolved", resolved_at: new Date().toISOString() })
      .eq("alert_id", req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ updated: true, recovery_tracking: false });
  }

  const { alert, error: loadErr } = await store.alertForRecovery(req.params.id);
  if (loadErr) return res.status(500).json({ error: loadErr });
  if (!alert) return res.status(404).json({ error: "Alert not found" });

  const reason = req.body?.no_contact_reason || null;
  const verdict = recovery.canResolve(alert, { noContactReason: reason });
  if (!verdict.ok) {
    return res.status(409).json({
      error: verdict.error,
      needs_reason: true,
      reasons: verdict.reasons,
      member_name: alert.member_name,
      contactable: Boolean(alert.member_phone || alert.member_email),
    });
  }

  const update = { status: "resolved", resolved_at: new Date().toISOString() };
  if (!alert.first_contact_at && reason) update.no_contact_reason = reason;

  const { error } = await supabase
    .from("case_alerts").update(update).eq("alert_id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ updated: true, closed_with_member: Boolean(alert.first_contact_at) });
});

// PUT /api/alerts/:id/reopen — reopen a resolved alert.
//
// Any contact that happened is left on the record: reopening means the club's
// fix was not good enough, not that the call never took place. Clearing it
// would quietly rewrite the recovery history.
router.put("/:id/reopen", async (req, res) => {
  const { error } = await supabase
    .from("case_alerts")
    .update({
      status: "open", resolved_at: null, assigned_to: null,
      assigned_to_staff_id: null, no_contact_reason: null,
    })
    .eq("alert_id", req.params.id);

  if (error) {
    // Fall back if assigned_to_staff_id column doesn't exist yet
    const { error: fallbackErr } = await supabase
      .from("case_alerts")
      .update({ status: "open", resolved_at: null, assigned_to: null })
      .eq("alert_id", req.params.id);
    if (fallbackErr) return res.status(500).json({ error: fallbackErr.message });
  }

  res.json({ updated: true });
});

// GET /api/alerts/:id/suggested-response — AI-generated follow-up plan
router.get("/:id/suggested-response", async (req, res) => {
  const { data: alert, error } = await supabase
    .from("case_alerts")
    .select("*, outlets(name), survey_responses(q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, q5_comment, visits(visit_date, members(first_name, last_name)))")
    .eq("alert_id", req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!alert) return res.status(404).json({ error: "Alert not found" });

  const followUp = await generateFollowUp(alert);
  if (!followUp) return res.status(503).json({ error: "AI analysis unavailable. Check ANTHROPIC_API_KEY." });

  res.json(followUp);
});

module.exports = router;
