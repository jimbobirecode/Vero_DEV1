const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");
const { log, ACTIONS } = require("../lib/audit");

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

  const { error } = await supabase
    .from("club_settings")
    .upsert({ key: req.params.key, value: String(value), updated_at: new Date().toISOString() });

  if (error) return res.status(500).json({ error: error.message });
  log(req, ACTIONS.SETTINGS_CHANGED, { key: req.params.key, value: String(value) });
  res.json({ saved: true });
});

module.exports = router;
