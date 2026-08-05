const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");

// GET /api/message-log?limit=50&offset=0&member_id=...
router.get("/", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  let query = supabase
    .from("message_log")
    .select("*, members(first_name, last_name)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (req.query.member_id) {
    query = query.eq("member_id", req.query.member_id);
  }
  if (req.query.channel) {
    query = query.eq("channel", req.query.channel);
  }
  if (req.query.status) {
    query = query.eq("status", req.query.status);
  }

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ messages: data, total: count });
});

// PUT /api/message-log/opt-out/:member_id
router.put("/opt-out/:member_id", async (req, res) => {
  const { opt_out } = req.body;
  if (typeof opt_out !== "boolean") {
    return res.status(400).json({ error: "opt_out must be true or false" });
  }

  const { data, error } = await supabase
    .from("members")
    .update({ opt_out, updated_at: new Date().toISOString() })
    .eq("member_id", req.params.member_id)
    .select("member_id, first_name, last_name, opt_out")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Member not found" });
  res.json(data);
});

module.exports = router;
