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

    const subject = `[Club Vero] Daily Digest: ${alertCount} unassigned alert${alertCount !== 1 ? "s" : ""}, ${overdueCount} overdue, ${approvalCount} awaiting sign-off`;

    const results = await notifyManagers(subject, body);
    res.json({ sent: true, alerts: alertCount, overdue: overdueCount, awaiting_approval: approvalCount, notifications: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
