const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");
const { log, ACTIONS } = require("../lib/audit");
const { OPERATOR_SETTING_KEYS } = require("../lib/sms-credit");

// Billing is set on the server, not by the club.
//
// This route writes whatever key it is handed, which is what makes it useful —
// a new setting needs no new endpoint. It also means that without this list a
// general manager could POST sms_credit_enabled or a rate of their choosing
// straight past the environment, on any deployment where that variable is
// unset. The dashboard offers no control for these; refusing them here is what
// makes that true rather than merely tidy.
const LOCKED = new Set(OPERATOR_SETTING_KEYS);

// GET /api/settings
router.get("/", async (req, res) => {
  const { data, error } = await supabase
    .from("club_settings")
    .select("key, value");

  if (error) return res.status(500).json({ error: error.message });

  const settings = {};
  for (const row of data || []) settings[row.key] = row.value;
  res.json(settings);
});

// PUT /api/settings/:key
router.put("/:key", async (req, res) => {
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: "value is required" });

  if (LOCKED.has(req.params.key)) {
    return res.status(403).json({
      error: `"${req.params.key}" is set on the server, not from the dashboard. ` +
             `Change it in the deployment's environment variables and restart.`,
    });
  }

  const { error } = await supabase
    .from("club_settings")
    .upsert({ key: req.params.key, value: String(value), updated_at: new Date().toISOString() });

  if (error) return res.status(500).json({ error: error.message });
  log(req, ACTIONS.SETTINGS_CHANGED, { key: req.params.key, value: String(value) });
  res.json({ saved: true });
});

module.exports = router;
