// Cross-modal analytics.
//
// The club's data already knows who played and who ate; nothing joined the
// two. This answers the questions that sit between them.

const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");
const crossover = require("../lib/crossover");

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

module.exports = router;
