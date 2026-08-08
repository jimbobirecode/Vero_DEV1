const express = require("express");
const router = express.Router();
const multer = require("multer");
const { PDFParse } = require("pdf-parse");
const { supabase } = require("../lib/supabase");
const { log, auditRead, ACTIONS } = require("../lib/audit");
// The same vocabulary Visits uses for visitor_type — see lib/person-types.js.
const personTypes = require("../lib/person-types");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const REQUIRED_COLUMNS = [
  "member_id", "first_name", "last_name", "phone_number",
  "email_address", "communication_preference", "opt_out_flag",
];
// Deliberately not required. Every membership export in existence predates this
// column, and refusing to load one for want of it would be a poor trade for a
// field that has a sensible default.
const OPTIONAL_COLUMNS = ["member_type"];
const E164_RE = /^\+[1-9]\d{6,14}$/;

// POST /api/members  — add a single member (from the Members screen's form)
router.post("/", async (req, res) => {
  const { member_id, first_name, last_name, phone_number, email_address, comm_preference, opt_out, member_type } = req.body;
  if (!member_id || !first_name || !last_name) {
    return res.status(400).json({ error: "member_id, first_name, and last_name are required" });
  }
  const { error } = await supabase.from("members").upsert({
    member_id, first_name, last_name,
    phone_number: phone_number || null,
    email_address: email_address || null,
    comm_preference: comm_preference === "email" ? "email" : "sms",
    member_type: personTypes.normalise(member_type),
    opt_out: Boolean(opt_out),
    updated_at: new Date().toISOString(),
  });
  if (error) {
    // The column arrives with migrations/member-types.sql. Until it has run,
    // saving a person should still work — losing the record over a field the
    // database has not heard of yet is the worse outcome.
    if (/member_type/i.test(error.message || "")) {
      const { error: retry } = await supabase.from("members").upsert({
        member_id, first_name, last_name,
        phone_number: phone_number || null,
        email_address: email_address || null,
        comm_preference: comm_preference === "email" ? "email" : "sms",
        opt_out: Boolean(opt_out),
        updated_at: new Date().toISOString(),
      });
      if (retry) return res.status(500).json({ error: retry.message });
      console.error("[members] member_type column missing — run migrations/member-types.sql");
      return res.json({ saved: true, member_type_ignored: true });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json({ saved: true });
});

// GET /api/members?q=search
router.get("/", auditRead(ACTIONS.MEMBER_LIST_VIEWED), async (req, res) => {
  const { q } = req.query;
  let query = supabase.from("members").select("*").order("last_name");
  if (q) query = query.or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,member_id.ilike.%${q}%`);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/members/import  — bulk CSV import (rows already parsed client-side or via multer)
// Body: { rows: [{ member_id, first_name, last_name, phone_number, email_address, communication_preference, opt_out_flag }, ...] }
router.post("/import", async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "No rows provided" });
  }

  const firstRowKeys = Object.keys(rows[0]).map((k) => k.toLowerCase());
  const missingColumns = REQUIRED_COLUMNS.filter((c) => !firstRowKeys.includes(c));
  if (missingColumns.length > 0) {
    return res.status(400).json({ error: `Missing required columns: ${missingColumns.join(", ")}` });
  }

  const result = { total_rows: rows.length, created: 0, updated: 0, skipped: [] };

  // Checked once, not per row. If the column is not there yet, a thousand-row
  // import would otherwise fail a thousand times and report the whole roster as
  // skipped — a migration that has not been run should cost the type, not the
  // import.
  let hasTypeColumn = true;
  {
    const { error: probe } = await supabase.from("members").select("member_type").limit(1);
    if (probe && /member_type/i.test(probe.message || "")) {
      hasTypeColumn = false;
      console.error("[members] member_type column missing — run migrations/member-types.sql; importing without it");
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const memberId = String(row.member_id ?? "").trim();
    const firstName = String(row.first_name ?? "").trim();
    const lastName = String(row.last_name ?? "").trim();
    const phone = String(row.phone_number ?? "").trim();
    const email = String(row.email_address ?? "").trim();
    const pref = String(row.communication_preference ?? "sms").trim().toLowerCase() || "sms";
    const optOut = /^(yes|true|1)$/i.test(String(row.opt_out_flag ?? ""));
    // Absent, blank or misspelled all fall back to "member" rather than
    // skipping the row — see normalise() for the aliases a CRM actually emits.
    const memberType = personTypes.normalise(row.member_type);

    if (!memberId || !firstName || !lastName) {
      result.skipped.push({ row: i + 2, member_id: memberId || "(blank)", reason: "Missing member_id, first_name, or last_name" });
      continue;
    }
    if (!phone && !email) {
      result.skipped.push({ row: i + 2, member_id: memberId, reason: "No phone number or email — at least one is needed for survey delivery" });
      continue;
    }

    // Determine effective preference: if SMS preferred but phone is missing or invalid, fall back to email
    let effectivePref = pref === "email" ? "email" : "sms";
    const validPhone = phone && E164_RE.test(phone) ? phone : null;
    if (effectivePref === "sms" && !validPhone) {
      effectivePref = email ? "email" : "sms";
    }

    const { data: existing } = await supabase.from("members").select("member_id").eq("member_id", memberId).maybeSingle();
    const { error } = await supabase.from("members").upsert({
      member_id: memberId, first_name: firstName, last_name: lastName,
      phone_number: validPhone, email_address: email || null,
      comm_preference: effectivePref,
      ...(hasTypeColumn ? { member_type: memberType } : {}),
      opt_out: optOut, updated_at: new Date().toISOString(),
    });
    if (error) { result.skipped.push({ row: i + 2, member_id: memberId, reason: error.message }); continue; }
    existing ? result.updated++ : result.created++;
  }

  log(req, ACTIONS.MEMBER_IMPORTED, { source: "csv", total_rows: result.total_rows, created: result.created, updated: result.updated, skipped: result.skipped.length });
  res.json(result);
});

// POST /api/members/import-pdf — extract member data from a PDF table
router.post("/import-pdf", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  let text;
  try {
    const parser = new PDFParse({ data: req.file.buffer });
    const parsed = await parser.getText();
    text = parsed.text;
  } catch (e) {
    return res.status(400).json({ error: "Could not parse PDF: " + String(e) });
  }

  if (!text || text.trim().length < 10) {
    return res.status(400).json({ error: "PDF appears to be empty or contains no extractable text" });
  }

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // Try to find a header line containing member_id or similar column names
  const HEADER_PATTERNS = ["member_id", "member id", "member #", "member#", "memberid"];
  let headerIdx = -1;
  let headerLine = "";
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const lower = lines[i].toLowerCase();
    if (HEADER_PATTERNS.some(p => lower.includes(p))) {
      headerIdx = i;
      headerLine = lines[i];
      break;
    }
  }

  if (headerIdx === -1) {
    return res.status(400).json({
      error: "Could not find a header row with 'member_id' in the PDF. Make sure the PDF contains a table with columns: member_id, first_name, last_name, phone_number, email_address."
    });
  }

  // Detect delimiter — tabs, multiple spaces, pipes, or commas
  let delimiter;
  if (headerLine.includes("\t")) delimiter = /\t+/;
  else if (headerLine.includes("|")) delimiter = /\s*\|\s*/;
  else if (headerLine.includes(",")) delimiter = /,/;
  else delimiter = /\s{2,}/;

  const headers = headerLine.split(delimiter).map(h => h.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_"));

  const colMap = {};
  const aliases = {
    member_id: ["member_id", "memberid", "member__", "member_no", "member_number", "id"],
    first_name: ["first_name", "firstname", "first"],
    last_name: ["last_name", "lastname", "last", "surname"],
    phone_number: ["phone_number", "phone", "mobile", "cell", "telephone"],
    email_address: ["email_address", "email", "e_mail"],
    communication_preference: ["communication_preference", "comm_preference", "preference", "comm_pref", "contact_method"],
    opt_out_flag: ["opt_out_flag", "opt_out", "optout", "opted_out"],
  };

  for (const [field, alts] of Object.entries(aliases)) {
    const idx = headers.findIndex(h => alts.includes(h));
    if (idx !== -1) colMap[field] = idx;
  }

  if (colMap.member_id === undefined || colMap.first_name === undefined || colMap.last_name === undefined) {
    return res.status(400).json({
      error: `Could not map required columns. Found headers: ${headers.join(", ")}. Need at least: member_id, first_name, last_name.`
    });
  }

  const result = { total_rows: 0, created: 0, updated: 0, skipped: [] };

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = lines[i].split(delimiter).map(c => c.trim());
    if (cols.length < 3) continue;

    const memberId = cols[colMap.member_id] || "";
    const firstName = cols[colMap.first_name] || "";
    const lastName = cols[colMap.last_name] || "";
    const phone = colMap.phone_number !== undefined ? (cols[colMap.phone_number] || "") : "";
    const email = colMap.email_address !== undefined ? (cols[colMap.email_address] || "") : "";
    const pref = colMap.communication_preference !== undefined ? (cols[colMap.communication_preference] || "sms").toLowerCase() : "sms";
    const optOut = colMap.opt_out_flag !== undefined ? /^(yes|true|1)$/i.test(cols[colMap.opt_out_flag] || "") : false;

    result.total_rows++;

    if (!memberId || !firstName || !lastName) {
      result.skipped.push({ row: i + 1, member_id: memberId || "(blank)", reason: "Missing required fields" });
      continue;
    }

    const { data: existing } = await supabase.from("members").select("member_id").eq("member_id", memberId).maybeSingle();
    const { error } = await supabase.from("members").upsert({
      member_id: memberId, first_name: firstName, last_name: lastName,
      phone_number: phone || null, email_address: email || null,
      comm_preference: pref === "email" ? "email" : "sms",
      opt_out: optOut, updated_at: new Date().toISOString(),
    });
    if (error) { result.skipped.push({ row: i + 1, member_id: memberId, reason: error.message }); continue; }
    existing ? result.updated++ : result.created++;
  }

  res.json(result);
});

// PUT /api/members/:id — update a member's details
router.put("/:id", async (req, res) => {
  const { first_name, last_name, phone_number, email_address, comm_preference, opt_out, member_type } = req.body;
  const updates = { updated_at: new Date().toISOString() };

  if (first_name !== undefined) updates.first_name = first_name;
  if (last_name !== undefined) updates.last_name = last_name;
  if (phone_number !== undefined) updates.phone_number = phone_number || null;
  if (email_address !== undefined) updates.email_address = email_address || null;
  if (comm_preference !== undefined) updates.comm_preference = comm_preference === "email" ? "email" : "sms";
  if (opt_out !== undefined) updates.opt_out = Boolean(opt_out);
  if (member_type !== undefined) updates.member_type = personTypes.normalise(member_type);

  const { data, error } = await supabase
    .from("members")
    .update(updates)
    .eq("member_id", req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  log(req, ACTIONS.MEMBER_UPDATED, { member_id: req.params.id, fields: Object.keys(updates).filter(k => k !== "updated_at") });
  res.json(data);
});

// DELETE /api/members/:id — remove a member
router.delete("/:id", async (req, res) => {
  const { error } = await supabase
    .from("members")
    .delete()
    .eq("member_id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  log(req, ACTIONS.MEMBER_DELETED, { member_id: req.params.id });
  res.json({ deleted: true });
});

module.exports = router;
