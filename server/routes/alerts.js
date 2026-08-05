const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");
const { notifyStaffMember, dashboardUrl } = require("../lib/notify");
const { CLUB_NAME } = require("../lib/club-config");
const { generateFollowUp } = require("../lib/ai");

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
    const { data: alert } = await supabase
      .from("case_alerts")
      .select("severity, outlets(name)")
      .eq("alert_id", req.params.id)
      .maybeSingle();

    const outlet = alert?.outlets?.name || "Unknown outlet";
    const url = dashboardUrl();
    const subject = `[Vero] ${alert?.severity?.toUpperCase()} alert assigned to you — ${outlet}`;
    const body = `Hi ${staffName},\n\nA ${alert?.severity} severity alert at ${outlet} has been assigned to you.\n\nPlease review and resolve it at your earliest convenience.${url ? `\n\nView in dashboard: ${url}` : ""}\n\n${CLUB_NAME}`;

    notifyStaffMember(staffId, subject, body).catch((e) =>
      console.error("Alert assignment notification failed:", e.message)
    );
  }

  res.json({ updated: true });
});

// PUT /api/alerts/:id/resolve — resolve an alert
router.put("/:id/resolve", async (req, res) => {
  const { error } = await supabase
    .from("case_alerts")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("alert_id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ updated: true });
});

// PUT /api/alerts/:id/reopen — reopen a resolved alert
router.put("/:id/reopen", async (req, res) => {
  const { error } = await supabase
    .from("case_alerts")
    .update({ status: "open", resolved_at: null, assigned_to: null, assigned_to_staff_id: null })
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
