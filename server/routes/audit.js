const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");

// GET /api/audit?limit=&offset=&action=&days=
// Read-only. There is deliberately no write or delete route — the trail is
// append-only, and the application must not be able to edit its own history.
router.get("/", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const offset = parseInt(req.query.offset, 10) || 0;
  const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  let query = supabase
    .from("audit_log")
    .select("audit_id, action, actor_email, actor_role, ip_address, details, created_at", { count: "exact" })
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (req.query.action) query = query.eq("action", req.query.action);

  const { data, count, error } = await query;
  if (error) {
    if (/relation .*audit_log.* does not exist/i.test(error.message)) {
      return res.status(503).json({ error: "The audit_log table has not been created yet — run the migration in Supabase." });
    }
    return res.status(500).json({ error: error.message });
  }

  res.json({ entries: data || [], total: count ?? 0, days });
});

// Retention: entries are kept for 12 months, then deleted. Runs from a daily
// cron; the delete is bounded by date so a repeat run is harmless.
const RETENTION_DAYS = 365;

async function purgeExpired() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
  const { data, error } = await supabase
    .from("audit_log")
    .delete()
    .lt("created_at", cutoff)
    .select("audit_id");

  if (error) throw new Error(error.message);
  return { deleted: (data || []).length, cutoff, retention_days: RETENTION_DAYS };
}

module.exports = router;
module.exports.purgeExpired = purgeExpired;
module.exports.RETENTION_DAYS = RETENTION_DAYS;
