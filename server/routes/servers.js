const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");
const { parseDelimited, prepareServers, normalisePhone } = require("../lib/roster-import");

// GET /api/servers?active=true
router.get("/", async (req, res) => {
  let query = supabase
    .from("servers")
    .select("*")
    .order("name", { ascending: true });

  if (req.query.active !== undefined) {
    query = query.eq("active", req.query.active === "true");
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ servers: data });
});

// POST /api/servers/import — bulk add the server roster.
//
// Matching is by name, normalised the same way the shift-survey send path
// matches a POS export: case- and whitespace-insensitively. Re-uploading a
// roster with phone numbers filled in therefore updates the people already
// there instead of creating a second Jessica.
//
// Declared before the /:id routes so "import" is not read as an id.
router.post("/import", async (req, res) => {
  const { text } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: "Paste the roster, or choose a file, first." });
  }

  const parsed = parseDelimited(text);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const prepared = prepareServers(parsed);
  if (prepared.error) return res.status(400).json({ error: prepared.error });

  const { data: existingRows, error: readErr } = await supabase
    .from("servers")
    .select("server_id, name, phone, email, active");
  if (readErr) return res.status(500).json({ error: `Could not read the current roster: ${readErr.message}` });

  const norm = (n) => (n || "").trim().toLowerCase().replace(/\s+/g, " ");
  const byName = new Map((existingRows || []).map((s) => [norm(s.name), s]));

  const result = {
    total_rows: parsed.rows.length,
    created: 0, updated: 0,
    unreachable: prepared.records.filter((r) => !r.reachable).map((r) => r.name),
    warnings: prepared.records.filter((r) => r.warning).map((r) => `${r.name}: ${r.warning}`),
    skipped: prepared.skipped,
  };

  for (const rec of prepared.records) {
    const existing = byName.get(norm(rec.name));

    if (existing) {
      // Only fill gaps and improve on what is there. An import that blanked a
      // number somebody had typed in by hand, because this month's export
      // happened to omit it, would quietly make that person unsurveyable.
      const updates = { active: true };
      if (rec.phone && rec.phone !== existing.phone) updates.phone = rec.phone;
      if (rec.email && rec.email !== existing.email) updates.email = rec.email;

      const { error } = await supabase.from("servers").update(updates).eq("server_id", existing.server_id);
      if (error) { result.skipped.push({ value: rec.name, reason: error.message }); continue; }
      result.updated++;
      continue;
    }

    const { error } = await supabase
      .from("servers")
      .insert({ name: rec.name, phone: rec.phone, email: rec.email });
    if (error) { result.skipped.push({ value: rec.name, reason: error.message }); continue; }
    result.created++;
  }

  res.json(result);
});

// GET /api/servers/unmatched?days=30
//
// Names attributed to sales on visits that have no active server record. These
// people are working and being credited, but a shift survey can never reach
// them — and nothing else in the app would ever say so. Declared before the
// /:id routes so "unmatched" is not read as an id.
router.get("/unmatched", async (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
  const since = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];

  const { data: visits, error } = await supabase
    .from("visits")
    .select("server_name, visit_date")
    .gte("visit_date", since)
    .not("server_name", "is", null);

  if (error) return res.status(500).json({ error: error.message });

  const { data: active } = await supabase.from("servers").select("name").eq("active", true);

  // Same normalisation the send path uses, so this list is exactly the set of
  // people that path would fail to find.
  const norm = (n) => (n || "").trim().toLowerCase().replace(/\s+/g, " ");
  const known = new Set((active || []).map((s) => norm(s.name)));

  const found = new Map();
  for (const v of visits || []) {
    const name = (v.server_name || "").trim();
    if (!name || known.has(norm(name))) continue;
    const entry = found.get(norm(name)) || { name, visits: 0, last_seen: null };
    entry.visits++;
    if (!entry.last_seen || v.visit_date > entry.last_seen) entry.last_seen = v.visit_date;
    found.set(norm(name), entry);
  }

  res.json({
    days,
    unmatched: [...found.values()].sort((a, b) => b.visits - a.visits),
  });
});

// POST /api/servers
router.post("/", async (req, res) => {
  const { name, phone, email } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  // A server is a server. This used to create a staff row alongside, at role
  // dept_head — so every waiter added to the roster appeared under Team
  // members and was granted access to operational reporting, alerts, events
  // and the staff list. Adding somebody to the roster is a statement about
  // who is credited with a cheque, not a grant of access to the dashboard.
  //
  // Somebody who genuinely needs both is added on both screens, deliberately.

  // Same name matching the shift-survey send path uses, so adding somebody
  // who is already there corrects their details instead of creating a second
  // Jessica that the POS will never match.
  const norm = (n) => (n || "").trim().toLowerCase().replace(/\s+/g, " ");
  const { data: existingRows } = await supabase.from("servers").select("server_id, name, phone, email, active");
  const existing = (existingRows || []).find((s) => norm(s.name) === norm(name));

  // A number that is not E.164 will not send, so it is normalised here rather
  // than stored raw — the roster import already does this, and a server added
  // by hand should not end up with a number that silently never delivers.
  const normalisedPhone = normalisePhone(phone);
  const phoneWarning = phone && !normalisedPhone
    ? `"${phone}" is not a number we can text, so it was not saved. Use +1 610 555 1234 or 610-555-1234.`
    : null;

  if (existing) {
    const updates = { active: true };
    if (normalisedPhone) updates.phone = normalisedPhone;
    if (email) updates.email = email;

    const { data, error } = await supabase
      .from("servers").update(updates).eq("server_id", existing.server_id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ...data, already_existed: true, ...(phoneWarning ? { warning: phoneWarning } : {}) });
  }

  const { data, error } = await supabase
    .from("servers")
    .insert({ name: name.trim(), phone: normalisedPhone, email: email || null })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ ...data, ...(phoneWarning ? { warning: phoneWarning } : {}) });
});

// PUT /api/servers/:id
router.put("/:id", async (req, res) => {
  const { name, phone, email, active } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email || null;
  if (active !== undefined) updates.active = active;

  // Editing a number in the roster list goes through the same normalisation
  // as adding and importing one, so all three agree on what is storable.
  let phoneWarning = null;
  if (phone !== undefined) {
    updates.phone = normalisePhone(phone);
    if (phone && !updates.phone) {
      phoneWarning = `"${phone}" is not a number we can text. Use +1 610 555 1234 or 610-555-1234.`;
    }
  }

  const { data, error } = await supabase
    .from("servers")
    .update(updates)
    .eq("server_id", req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // No longer mirrored into staff. Correcting a server's phone number should
  // not reach into a team member's record, and the two are separate people
  // as often as they are the same one.
  res.json({ ...data, ...(phoneWarning ? { warning: phoneWarning } : {}) });
});

// DELETE /api/servers/:id — soft-delete
router.delete("/:id", async (req, res) => {
  // Soft-delete, so the leaderboard and survey history of everything they
  // served keep resolving to a name.
  //
  // Deactivating a server no longer deactivates a staff account: taking
  // somebody off the roster for the season should not remove their dashboard
  // login, and it certainly should not do it silently.
  const { error } = await supabase
    .from("servers")
    .update({ active: false })
    .eq("server_id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: true });
});

module.exports = router;
