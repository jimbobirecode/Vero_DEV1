const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");

// GET /api/training?limit=10&offset=0
router.get("/", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const offset = parseInt(req.query.offset) || 0;

  const { data, count, error } = await supabase
    .from("training_plans")
    .select("*, outlets(name)", { count: "exact" })
    .order("generated_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ plans: data, total: count });
});

// PUT /api/training/:id/steps — update step completion status
// Body: { steps: [...updated steps array] }
router.put("/:id/steps", async (req, res) => {
  const { steps } = req.body;
  if (!Array.isArray(steps)) return res.status(400).json({ error: "steps array is required" });

  const { error } = await supabase
    .from("training_plans")
    .update({ steps })
    .eq("plan_id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ updated: true });
});

// DELETE /api/training/:id — remove a training plan
router.delete("/:id", async (req, res) => {
  const { error } = await supabase
    .from("training_plans")
    .delete()
    .eq("plan_id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: true });
});

module.exports = router;
