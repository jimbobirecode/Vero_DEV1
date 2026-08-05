const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");
const { notifyManagers, dashboardUrl } = require("../lib/notify");
const { CLUB_NAME } = require("../lib/club-config");

// POST /api/cron/daily-digest
// Sends a single digest email to each manager covering:
//  1. Unassigned open alerts (medium/high)
//  2. Overdue tasks (due_by < today, not completed)
//  3. Tasks awaiting manager sign-off (completed but not approved)
router.post("/daily-digest", async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const url = dashboardUrl();

    // 1. Unassigned open alerts (medium + high only)
    const { data: unassignedAlerts } = await supabase
      .from("case_alerts")
      .select("alert_id, severity, created_at, outlets(name)")
      .eq("status", "open")
      .is("assigned_to_staff_id", null)
      .in("severity", ["medium", "high"])
      .order("created_at", { ascending: false });

    // 2. Overdue tasks
    const { data: overdueTasks } = await supabase
      .from("server_tasks")
      .select("task_id, server_name, title, due_by, category")
      .eq("completed", false)
      .lt("due_by", today);

    // 3. Tasks awaiting sign-off (completed but not approved)
    const { data: awaitingApproval } = await supabase
      .from("server_tasks")
      .select("task_id, server_name, title, completed_at, category")
      .eq("completed", true)
      .is("approved_by", null);

    const alertCount = unassignedAlerts?.length || 0;
    const overdueCount = overdueTasks?.length || 0;
    const approvalCount = awaitingApproval?.length || 0;

    if (alertCount === 0 && overdueCount === 0 && approvalCount === 0) {
      return res.json({ sent: false, reason: "nothing to report" });
    }

    let body = `Daily Digest — ${CLUB_NAME}\n${"=".repeat(40)}\n\n`;

    if (alertCount > 0) {
      body += `UNASSIGNED ALERTS (${alertCount})\n${"-".repeat(30)}\n`;
      for (const a of unassignedAlerts) {
        const outlet = a.outlets?.name || "Unknown";
        const date = new Date(a.created_at).toLocaleDateString();
        body += `  • [${a.severity.toUpperCase()}] ${outlet} — created ${date}\n`;
      }
      body += "\n";
    }

    if (overdueCount > 0) {
      body += `OVERDUE TASKS (${overdueCount})\n${"-".repeat(30)}\n`;
      for (const t of overdueTasks) {
        body += `  • ${t.server_name}: ${t.title} (due ${t.due_by})\n`;
      }
      body += "\n";
    }

    if (approvalCount > 0) {
      body += `AWAITING YOUR SIGN-OFF (${approvalCount})\n${"-".repeat(30)}\n`;
      for (const t of awaitingApproval) {
        const completed = new Date(t.completed_at).toLocaleDateString();
        body += `  • ${t.server_name}: ${t.title} (completed ${completed})\n`;
      }
      body += "\n";
    }

    if (url) {
      body += `View dashboard: ${url}\n`;
    }

    const subject = `[Vero] Daily Digest: ${alertCount} unassigned alert${alertCount !== 1 ? "s" : ""}, ${overdueCount} overdue, ${approvalCount} awaiting sign-off`;

    const results = await notifyManagers(subject, body);
    res.json({ sent: true, alerts: alertCount, overdue: overdueCount, awaiting_approval: approvalCount, notifications: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cron/recovery-sweep — hourly.
//
// A daily digest is the wrong instrument for a promise measured in hours: an
// alert raised at 10am with a 24-hour window would get its first and only
// nudge after it had already expired. This runs hourly and nudges at half the
// window, at 90%, and once on breach — each stage sent once, because a prompt
// that arrives every hour is one people filter.
router.post("/recovery-sweep", async (req, res) => {
  try {
    const recovery = require("../lib/recovery");
    const store = require("../lib/recovery-store");
    const { notifyStaffMember } = require("../lib/notify");

    const ready = await store.recoveryReady();
    if (!ready.ok) return res.status(503).json({ error: ready.error });

    const { data, error } = await supabase
      .from("case_alerts")
      .select(store.ALERT_WITH_MEMBER)
      .neq("status", "resolved")
      .is("first_contact_at", null)
      .limit(500);

    if (error) return res.status(500).json({ error: error.message });

    const settings = await store.loadSlaSettings();
    const url = dashboardUrl();
    const now = Date.now();
    const sent = [];

    for (const row of data || []) {
      let alert = store.shapeAlert(row);
      if (!alert.contact_due_at) alert = await store.ensureDueDate(alert, settings);

      const stage = recovery.escalationStage(alert, now);
      if (!stage) continue;

      const token = await store.ensureRecoveryToken(alert.alert_id, alert.recovery_token);
      const who = alert.member_name || "a member";
      const outlet = alert.outlet_name ? ` at ${alert.outlet_name}` : "";
      const remaining = recovery.formatRemaining(recovery.slaState(alert, now).ms_remaining);

      const subject = stage === "breached"
        ? `[Club Vero] MISSED — ${who} was never called back`
        : `[Club Vero] ${who} is still waiting for a call (${remaining})`;

      let body = stage === "breached"
        ? `${who} had a poor experience${outlet} and the window to call them back has passed.\n\n`
          + `It is still worth ringing — a late call lands better than none — but this one is recorded as missed.\n`
        : `${who} had a poor experience${outlet} and has not been called back yet.\n\n${remaining}.\n`;

      if (alert.member_phone) body += `\nPhone: ${alert.member_phone}`;
      else if (alert.member_email) body += `\nEmail: ${alert.member_email}`;
      else body += `\nNo phone or email on file — this member cannot be reached. Resolve the alert and record why.`;

      if (alert.comment) body += `\n\nThey said: "${alert.comment}"`;
      if (token && url) body += `\n\nAlready called? Log it in one tap:\n${url}/c/${token}`;
      if (url) body += `\n\nDashboard: ${url}`;
      body += `\n\n${CLUB_NAME}`;

      // The assignee owns it. With nobody assigned it goes to the managers,
      // because an unassigned alert running out of time is exactly the case
      // where nobody currently feels responsible.
      if (alert.assigned_to_staff_id) {
        await notifyStaffMember(alert.assigned_to_staff_id, subject, body)
          .catch((e) => console.error("[recovery] notify failed:", e.message));
      } else {
        await notifyManagers(subject, body)
          .catch((e) => console.error("[recovery] notify failed:", e.message));
      }

      await supabase.from("case_alerts")
        .update({ escalated_stage: stage, escalated_at: new Date().toISOString() })
        .eq("alert_id", alert.alert_id);

      sent.push({ alert_id: alert.alert_id, stage, member: alert.member_name });
    }

    console.log(`[recovery] swept ${(data || []).length} open alerts, escalated ${sent.length}`);
    res.json({ swept: (data || []).length, escalated: sent.length, details: sent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
