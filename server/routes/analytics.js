// Cross-modal analytics.
//
// The club's data already knows who played and who ate; nothing joined the
// two. This answers the questions that sit between them.

const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");
const crossover = require("../lib/crossover");
const health = require("../lib/member-health");

// GET /api/analytics/crossover?days=90
//
// Reads visits rather than survey responses on purpose: a member who played
// and ate is a fact about the club's operation whether or not they ever
// answered a survey. Tying it to responses would report the crossover rate of
// people who fill in forms.
router.get("/crossover", async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 730);
  const since = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];

  let query = supabase
    .from("visits")
    .select("member_id, visit_date, visitor_type, spend_amount, outlet_id, outlets(name)")
    .not("member_id", "is", null)
    .gte("visit_date", since)
    .order("visit_date", { ascending: false })
    .limit(20000);

  if (req.query.outlet_id) query = query.eq("outlet_id", req.query.outlet_id);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const minRounds = Math.max(parseInt(req.query.min_rounds, 10) || 3, 1);
  const report = crossover.report(data || [], { minRounds });

  // Name the members on the never-dined list. The list is only useful if the
  // F&B director can read who is on it.
  if (report.golfers_who_never_dine.length) {
    const ids = report.golfers_who_never_dine.map((m) => m.member_id);
    const { data: members } = await supabase
      .from("members").select("member_id, first_name, last_name").in("member_id", ids);
    const names = new Map((members || []).map((m) => [m.member_id, `${m.first_name} ${m.last_name}`]));
    report.golfers_who_never_dine = report.golfers_who_never_dine.map((m) => ({
      ...m, name: names.get(m.member_id) || m.member_id,
    }));
  }

  res.json({
    period_days: days,
    since,
    // Said plainly, because every rate below is a share of member-days and
    // reading them as visits would overstate anyone who ate twice.
    unit: "member-day",
    ...report,
  });
});

// GET /api/analytics/member-health?recent_days=90&baseline_days=365
//
// Who is quietly on their way out. Reads visits only — a member's attendance
// is the signal, and it exists whether or not they ever answered a survey.
router.get("/member-health", async (req, res) => {
  const recentDays = Math.min(Math.max(parseInt(req.query.recent_days, 10) || 90, 14), 365);
  const baselineDays = Math.min(Math.max(parseInt(req.query.baseline_days, 10) || 365, recentDays * 2), 1095);
  const since = new Date(Date.now() - baselineDays * 86400000).toISOString().split("T")[0];

  const { data, error } = await supabase
    .from("visits")
    .select("member_id, visit_date, spend_amount")
    .not("member_id", "is", null)
    .gte("visit_date", since)
    .limit(100000);

  if (error) return res.status(500).json({ error: error.message });

  const result = health.memberHealth(data || [], {
    recentDays, baselineDays,
    minBaselineVisits: Math.max(parseInt(req.query.min_baseline_visits, 10) || 4, 1),
  });

  // Name them, and carry the contact details — the output is a call list, and
  // a call list of member numbers is not one.
  const shown = [...result.members.slice(0, 100)];
  if (shown.length) {
    const { data: members } = await supabase
      .from("members")
      .select("member_id, first_name, last_name, phone_number, email_address, opt_out")
      .in("member_id", shown.map((m) => m.member_id));
    const byId = new Map((members || []).map((m) => [m.member_id, m]));
    for (const m of shown) {
      const rec = byId.get(m.member_id);
      m.name = rec ? `${rec.first_name} ${rec.last_name}` : m.member_id;
      m.phone = rec?.phone_number || null;
      m.email = rec?.email_address || null;
      m.opt_out = Boolean(rec?.opt_out);
      // A member the club has since removed should not sit on a call list.
      m.on_member_list = Boolean(rec);
    }
  }

  res.json({
    ...result,
    members: shown,
    truncated: result.members.length > shown.length,
    call_list: health.callList({ members: shown }, { limit: 10 }),
  });
});

module.exports = router;
