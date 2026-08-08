const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");
const multer = require("multer");
const { PDFParse } = require("pdf-parse");
const { readFirstSheet } = require("../lib/xlsx-read");
const crypto = require("crypto");
const { loadCredentials, sendSms, sendEmail } = require("../lib/senders");
const pos = require("../lib/pos");
const { ingestRows } = require("../lib/pos/ingest");
const { CLUB_NAME } = require("../lib/club-config");
const { resolveRecipient } = require("../lib/recipient");
const { applyMemberCap, parseCapSettings, modalityOf } = require("../lib/send-policy");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const CLUB_ID = process.env.CLUB_ID;
const SURVEY_BASE_URL = process.env.SURVEY_BASE_URL;
function baseUrl(req) {
  if (SURVEY_BASE_URL) return SURVEY_BASE_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

// The canonical list, shared with members and with the dashboard's dropdowns.
// This used to be a local array, which is how it drifted from the <option>
// tags on screen. See lib/person-types.js.
const personTypes = require("../lib/person-types");
const VALID_TYPES = personTypes.VALUES;

// GET /api/visits?limit=50&offset=0&visitor_type=...
router.get("/", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  let query = supabase
    .from("visits")
    .select("*, members(first_name, last_name), outlets(name), servers(server_id, name)", { count: "exact" })
    .order("visit_date", { ascending: false })
    .range(offset, offset + limit - 1);

  if (req.query.visitor_type && VALID_TYPES.includes(req.query.visitor_type)) {
    query = query.eq("visitor_type", req.query.visitor_type);
  }
  if (req.query.outlet_id) {
    query = query.eq("outlet_id", req.query.outlet_id);
  }

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ visits: data, total: count });
});

// POST /api/visits — add a visit manually
router.post("/", async (req, res) => {
  const { member_id, outlet_id, visit_date, spend_amount, server_name, server_id, visitor_type, guest_name, guest_phone, guest_email, send_survey } = req.body;

  if (!outlet_id || !visit_date || spend_amount == null) {
    return res.status(400).json({ error: "outlet_id, visit_date, and spend_amount are required" });
  }

  const vType = VALID_TYPES.includes(visitor_type) ? visitor_type : "member";

  if (vType === "member" && !member_id) {
    return res.status(400).json({ error: "member_id is required for member visits" });
  }
  if (vType !== "member" && !guest_name) {
    return res.status(400).json({ error: "guest_name is required for non-member visits" });
  }

  if (member_id) {
    const { data: member } = await supabase
      .from("members")
      .select("member_id")
      .eq("member_id", member_id)
      .maybeSingle();
    if (!member) {
      return res.status(404).json({ error: "Member not found — add them on the Members screen first" });
    }
  }

  const { data: outlet } = await supabase
    .from("outlets")
    .select("min_spend_threshold")
    .eq("outlet_id", outlet_id)
    .maybeSingle();

  const qualifies = outlet ? parseFloat(spend_amount) >= parseFloat(outlet.min_spend_threshold) : false;

  const { data, error } = await supabase
    .from("visits")
    .insert({
      member_id: vType === "member" ? member_id : null,
      outlet_id,
      visit_date,
      spend_amount: parseFloat(spend_amount),
      server_name: server_name || null,
      server_id: server_id || null,
      visitor_type: vType,
      guest_name: vType !== "member" ? guest_name : null,
      guest_phone: vType !== "member" ? (guest_phone || null) : null,
      guest_email: vType !== "member" ? (guest_email || null) : null,
      qualifies,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // If send_survey is set, immediately create and send a survey for this visit
  if (send_survey && data) {
    try {
      const token = crypto.randomUUID();
      const { error: srErr } = await supabase.from("survey_responses").insert({
        visit_id: data.visit_id,
        survey_token: token,
      });
      if (!srErr) {
        const link = `${baseUrl(req)}/s/${token}`;
        const message = `${CLUB_NAME}: We'd love your quick feedback on today's visit. Takes under a minute: ${link}`;
        const creds = await loadCredentials(CLUB_ID);

        let member = null, firstName, lastName, logId;
        if (member_id) {
          ({ data: member } = await supabase.from("members").select("*").eq("member_id", member_id).maybeSingle());
          firstName = member?.first_name; lastName = member?.last_name;
          logId = member?.member_id ?? null;
        } else {
          const parts = (guest_name || "").split(" ");
          firstName = parts[0] || ""; lastName = parts.slice(1).join(" ") || "";
          logId = null;
        }

        // Same resolver as the batch send and the queue preview — this used to
        // pick SMS whenever a phone existed, ignoring the member's preference.
        const { channel: sendChannel, recipient } = resolveRecipient({
          member, visit: { guest_phone, guest_email },
        });
        if (recipient) {
          if (sendChannel === "sms") {
            await sendSms(recipient, message, creds, logId, { kind: "survey_on_visit" });
          } else {
            await sendEmail(recipient, "How was your visit today?", message, creds, logId, {
              first_name: firstName || "", last_name: lastName || "",
              survey_url: link, unsubscribe_url: `${baseUrl(req)}/u/${token}`, is_reminder: false,
            });
          }
          const { error: stampErr } = await supabase
            .from("visits")
            .update({ survey_sent_at: new Date().toISOString() })
            .eq("visit_id", data.visit_id);
          data.survey_sent = true;
          data.survey_channel = sendChannel;
          // Sent but not recorded: the visit still reads as unsent, so the
          // next batch would send it a second time. Surface it.
          if (stampErr) data.survey_stamp_error = stampErr.message;
        }
      }
    } catch (_) { /* survey send is best-effort */ }
  }

  res.json(data);
});

// GET /api/visits/queue — visits that qualify for a survey and haven't been
// sent one yet, with the channel each will actually go out on and, for the
// ones that can't send, the reason.
router.get("/queue", async (req, res) => {
  const { data, error } = await supabase
    .from("visits")
    .select("visit_id, member_id, outlet_id, visit_date, spend_amount, server_name, visitor_type, guest_name, guest_phone, guest_email, qualifies, survey_sent_at, members(first_name, last_name, phone_number, email_address, comm_preference, opt_out), outlets(name)")
    .eq("qualifies", true)
    .is("survey_sent_at", null)
    .order("visit_date", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const { data: setting } = await supabase
    .from("club_settings").select("value").eq("key", "survey_send_time").maybeSingle();
  const sendTime = setting?.value || "09:30";

  // The send job's own rules for which of a member's visits actually goes.
  // Without this the queue promised a survey for the golf AND the dinner, and
  // then one of them silently never arrived.
  const { data: capRows } = await supabase.from("club_settings").select("key, value");
  const capSettings = Object.fromEntries((capRows || []).map((r) => [r.key, r.value]));
  const { cap, windowDays } = parseCapSettings(capSettings);

  const windowStart = new Date(Date.now() - windowDays * 86400000).toISOString();
  const alreadySent = {};
  const lastModality = {};
  {
    const { data: sent } = await supabase
      .from("visits")
      .select("member_id, visitor_type, survey_sent_at")
      .not("member_id", "is", null)
      .not("survey_sent_at", "is", null)
      .order("survey_sent_at", { ascending: false })
      .limit(5000);
    for (const r of sent || []) {
      if (!(r.member_id in lastModality)) lastModality[r.member_id] = modalityOf(r);
      if (r.survey_sent_at >= windowStart) {
        alreadySent[r.member_id] = (alreadySent[r.member_id] || 0) + 1;
      }
    }
  }

  const capResult = applyMemberCap(data || [], { cap, windowDays, alreadySent, lastModality });
  const deferredById = new Map(capResult.deferred.map((d) => [d.visit.visit_id, d.reason]));

  // Work out how each row would be delivered, using the same rules the send
  // job applies, so the queue can't promise a send that won't happen.
  const queue = (data || []).map((v) => {
    const deferredReason = deferredById.get(v.visit_id);
    if (deferredReason) {
      return { ...v, channel: null, recipient: null, status: "deferred", blocked_reason: deferredReason };
    }
    // A member_id the members table has no row for. The join returns null
    // rather than an empty object, so test the row itself — testing
    // first_name flagged a real member who simply had no first name.
    if (v.member_id && !v.members) {
      return { ...v, channel: null, recipient: null, status: "blocked",
        blocked_reason: `Member ${v.member_id} is not in the member list` };
    }
    const { channel, recipient, blocked_reason } = resolveRecipient({ member: v.members, visit: v });
    return { ...v, channel, recipient, status: recipient ? "ready" : "blocked", blocked_reason };
  });

  const ready = queue.filter((q) => q.status === "ready");
  const deferred = queue.filter((q) => q.status === "deferred");
  const byOutlet = {};
  for (const q of ready) {
    const name = q.outlets?.name || "Unassigned";
    byOutlet[name] = (byOutlet[name] || 0) + 1;
  }

  res.json({
    queue,
    send_time: sendTime,
    summary: {
      total: queue.length,
      ready: ready.length,
      // Deferred is not blocked: nothing is wrong with these, they simply lost
      // the day's rotation or the member's cap. Lumping them in with "cannot
      // send" would make a working rule look like a fault.
      deferred: deferred.length,
      blocked: queue.length - ready.length - deferred.length,
      sms: ready.filter((q) => q.channel === "sms").length,
      email: ready.filter((q) => q.channel === "email").length,
      by_outlet: Object.entries(byOutlet).map(([outlet, count]) => ({ outlet, count }))
        .sort((a, b) => b.count - a.count),
    },
  });
});

// POST /api/visits/queue/clear-unsendable — drop queued visits that can never
// be sent: an unrecognised member number, no contact details, or opted out.
// These accumulated before uploads stopped queueing unreachable visits.
router.post("/queue/clear-unsendable", async (req, res) => {
  const { data, error } = await supabase
    .from("visits")
    .select("visit_id, member_id, guest_phone, guest_email, members(first_name, phone_number, email_address, comm_preference, opt_out)")
    .eq("qualifies", true)
    .is("survey_sent_at", null);

  if (error) return res.status(500).json({ error: error.message });

  // Same resolver the queue and the send path use, so "unsendable" here means
  // exactly what the send path would refuse rather than an approximation.
  const unsendable = (data || []).filter((v) => {
    if (v.member_id && !v.members) return true;      // member number not in the list
    return !resolveRecipient({ member: v.members, visit: v }).recipient;
  });

  if (!unsendable.length) return res.json({ cleared: 0 });

  const { error: updErr } = await supabase
    .from("visits")
    .update({ qualifies: false })
    .in("visit_id", unsendable.map((v) => v.visit_id));

  if (updErr) return res.status(500).json({ error: updErr.message });
  res.json({ cleared: unsendable.length });
});

// PATCH /api/visits/:id/dequeue — remove a visit from the survey queue
router.patch("/:id/dequeue", async (req, res) => {
  const { error } = await supabase
    .from("visits")
    .update({ qualifies: false })
    .eq("visit_id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ dequeued: true });
});

// DELETE /api/visits/:id — remove a visit
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("visits").delete().eq("visit_id", id);
  if (error) {
    // survey_responses.visit_id has no ON DELETE rule, so a visit that has
    // been surveyed cannot be deleted. That surfaced as a raw Postgres
    // constraint name. Say what it means, and what to do instead — deleting
    // the response as well would throw away a member's feedback.
    if (/foreign key|violates|survey_responses/i.test(error.message || "")) {
      return res.status(409).json({
        error: "This visit has a survey attached, so it can't be deleted. Remove it from the queue instead, or delete the survey response first if the visit was logged in error.",
      });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json({ deleted: true });
});

// GET /api/visits/guest-lookup?q=... — find previous guests by name/phone/email
router.get("/guest-lookup", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (q.length < 2) return res.json([]);

  const { data, error } = await supabase
    .from("visits")
    .select("guest_name, guest_phone, guest_email")
    .is("member_id", null)
    .not("guest_name", "is", null)
    .or(`guest_name.ilike.%${q}%,guest_phone.ilike.%${q}%,guest_email.ilike.%${q}%`)
    .order("visit_date", { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });

  const seen = new Set();
  const unique = data.filter(r => {
    const key = (r.guest_name || "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  res.json(unique.slice(0, 8));
});

// GET /api/visits/outlets — list outlets for the form dropdown
router.get("/outlets", async (req, res) => {
  const { data, error } = await supabase
    .from("outlets")
    .select("outlet_id, name, min_spend_threshold")
    .eq("active", true)
    .order("name");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/visits/upload — bulk upload already-parsed POS rows as JSON:
// { rows: [{ member_id, outlet_name, spend_amount, visit_date, server_name }] }
//
// The dashboard now posts the file itself to /upload-pos and lets the POS
// modules read it, which handles quoted member names and every vendor layout.
// This endpoint stays for scripted imports that have already done the parsing.
router.post("/upload", async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: "rows array is required" });
  }

  res.json(await ingestRows(rows, supabase));
});

// GET /api/visits/pos-modules — the POS systems the uploader can read, for the
// dashboard's dropdown.
router.get("/pos-modules", (req, res) => {
  res.json({ modules: pos.listModules(), file_types: pos.supportedFileTypes() });
});

// POST /api/visits/upload-pos — bulk POS upload from a PDF, CSV or Excel file.
// The POS module registry (lib/pos) identifies which system produced the file
// and parses it; `vendor` in the body forces a specific module when the export
// carries no branding.
//
// Also mounted at /upload-pdf, which is what earlier dashboard builds call.
async function handlePosUpload(req, res) {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const { rows, summary, error } = await pos.parseUpload(req.file, {
    outletName: req.body?.outlet_name || null,
    vendor: req.body?.vendor || null,
  });

  if (error) return res.status(400).json({ error, parse_summary: summary });

  const results = await ingestRows(rows, supabase);
  results.parse_summary = summary;
  res.json(results);
}

router.post("/upload-pos", upload.single("file"), handlePosUpload);
router.post("/upload-pdf", upload.single("file"), handlePosUpload);

// POST /api/visits/upload-teesheet — upload a golf tee sheet (PDF, CSV, or Excel)
// Parses the file for member IDs or names, creates visits for the Golf outlet,
// and immediately sends golf surveys to each member found.
router.post("/upload-teesheet", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const fileName = (req.file.originalname || "").toLowerCase();
  const isPdf = fileName.endsWith(".pdf");
  const isCsv = fileName.endsWith(".csv");
  const isExcel = fileName.endsWith(".xlsx") || fileName.endsWith(".xls");

  if (!isPdf && !isCsv && !isExcel) {
    return res.status(400).json({ error: "Unsupported file type. Upload a PDF, CSV, or Excel (.xlsx/.xls) file." });
  }

  let text = "";
  let sheetRows = [];

  if (isPdf) {
    try {
      const parser = new PDFParse({ data: req.file.buffer });
      const parsed = await parser.getText();
      text = parsed.text;
    } catch (e) {
      return res.status(400).json({ error: "Could not parse PDF: " + String(e) });
    }
    if (!text || text.trim().length < 5) {
      return res.status(400).json({ error: "PDF appears empty or contains no extractable text" });
    }
  } else if (isCsv) {
    text = req.file.buffer.toString("utf-8");
    if (!text || text.trim().length < 5) {
      return res.status(400).json({ error: "CSV file appears empty" });
    }
  } else {
    try {
      const sheet = await readFirstSheet(req.file.buffer);
      sheetRows = sheet.rows;
      text = sheet.csv;
    } catch (e) {
      return res.status(400).json({ error: "Could not parse Excel file: " + String(e) });
    }
    if (!sheetRows.length) {
      return res.status(400).json({ error: "Excel file appears empty" });
    }
  }

  const teeDate = req.body.tee_date || extractDate(text) || new Date().toISOString().split("T")[0];

  const { data: outlets } = await supabase
    .from("outlets")
    .select("outlet_id, name")
    .eq("active", true);

  const golfOutlet = (outlets || []).find(o => o.name.toLowerCase().includes("golf"));
  if (!golfOutlet) {
    return res.status(400).json({ error: "No golf outlet found. Create a golf outlet first in the Survey Builder." });
  }

  let templateId = null;
  try {
    const { data: tpl } = await supabase
      .from("survey_templates")
      .select("template_id")
      .eq("survey_type", "golf")
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    if (tpl) templateId = tpl.template_id;
  } catch (_) {}

  const foundIds = new Set();

  // For structured files (CSV/Excel), extract member IDs from columns
  if (isCsv || isExcel) {
    let rows = sheetRows;
    if (isCsv) {
      const csvLines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (csvLines.length > 1) {
        const hdrs = csvLines[0].split(",").map(h => h.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_"));
        for (let i = 1; i < csvLines.length; i++) {
          const vals = csvLines[i].split(",").map(v => v.trim());
          const row = {};
          hdrs.forEach((h, idx) => { row[h] = vals[idx] || ""; });
          rows.push(row);
        }
      }
    }

    const memberColAliases = ["member_id", "memberid", "member_no", "member_number", "member__", "member___", "id"];
    const nameColAliases = ["member_name", "name", "player", "golfer", "first_name", "player_name"];

    for (const row of rows) {
      const keys = Object.keys(row).map(k => k.toLowerCase().replace(/[^a-z0-9_]/g, "_"));
      const rawKeys = Object.keys(row);

      // Try member ID columns
      for (let k = 0; k < keys.length; k++) {
        if (memberColAliases.some(a => keys[k].includes(a))) {
          const val = String(row[rawKeys[k]] || "").trim();
          if (val) foundIds.add(val);
          break;
        }
      }

      // Also scan all cell values for member ID patterns
      for (const key of rawKeys) {
        const val = String(row[key] || "").trim();
        const idMatch = val.match(/^([A-Z]\d{2,5}(?:-[A-Z0-9]+)?)$/);
        if (idMatch) foundIds.add(idMatch[1]);
      }

      // Try name columns for name-based matching later via text scan
      for (let k = 0; k < keys.length; k++) {
        if (nameColAliases.some(a => keys[k].includes(a))) {
          const val = String(row[rawKeys[k]] || "").trim();
          if (val && val.length > 2) {
            text += "\n" + val;
          }
        }
      }
    }
  }

  // Text-based scanning (works for PDF, and also picks up names from CSV/Excel appended above)
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const memberIdPattern = /\b([A-Z]\d{2,5}(?:-[A-Z0-9]+)?)\b/g;
  for (const line of lines) {
    let match;
    while ((match = memberIdPattern.exec(line)) !== null) {
      foundIds.add(match[1]);
    }
  }

  const { data: allMembers } = await supabase.from("members").select("member_id, first_name, last_name");
  const membersByName = {};
  for (const m of allMembers || []) {
    const fullName = `${m.first_name} ${m.last_name}`.toLowerCase();
    membersByName[fullName] = m.member_id;
    const reverseName = `${m.last_name} ${m.first_name}`.toLowerCase();
    membersByName[reverseName] = m.member_id;
    const lastFirst = `${m.last_name}, ${m.first_name}`.toLowerCase();
    membersByName[lastFirst] = m.member_id;
  }

  const textLower = text.toLowerCase();
  for (const [name, id] of Object.entries(membersByName)) {
    if (textLower.includes(name)) foundIds.add(id);
  }

  if (foundIds.size === 0) {
    return res.status(400).json({
      error: "Could not find any member IDs or names in the tee sheet. Make sure the file contains member numbers (e.g. R272) or member names that match your database."
    });
  }

  // Validate which IDs actually exist in the members table
  const { data: validMembers } = await supabase
    .from("members")
    .select("member_id, first_name, last_name, phone_number, email_address, comm_preference, opt_out")
    .in("member_id", [...foundIds]);

  const result = {
    tee_date: teeDate,
    outlet: golfOutlet.name,
    outlet_id: golfOutlet.outlet_id,
    members_found: foundIds.size,
    members_valid: (validMembers || []).length,
    members: [],
    unmatched_ids: [],
  };

  for (const member of validMembers || []) {
    result.members.push({
      member_id: member.member_id,
      name: `${member.first_name} ${member.last_name}`,
      phone: member.phone_number || "",
      email: member.email_address || "",
      comm_preference: member.comm_preference,
      opt_out: member.opt_out,
    });
  }

  const validIdSet = new Set((validMembers || []).map(m => m.member_id));
  result.unmatched_ids = [...foundIds].filter(id => !validIdSet.has(id));

  res.json(result);
});

// POST /api/visits/send-golf-surveys — queue golf surveys for selected members.
// Surveys are NOT sent immediately: the hourly send-surveys cron picks up the
// queued visits and sends at the club's configured send time (same pipeline
// as dining, respecting the 8pm–8am blackout).
router.post("/send-golf-surveys", async (req, res) => {
  const { member_ids, tee_date, outlet_id } = req.body;
  if (!Array.isArray(member_ids) || !member_ids.length) {
    return res.status(400).json({ error: "No members selected" });
  }
  if (!outlet_id) return res.status(400).json({ error: "outlet_id is required" });

  const date = tee_date || new Date().toISOString().split("T")[0];

  let templateId = null;
  try {
    const { data: tpl } = await supabase
      .from("survey_templates")
      .select("template_id")
      .eq("survey_type", "golf")
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    if (tpl) templateId = tpl.template_id;
  } catch (_) {}

  const { data: members } = await supabase
    .from("members")
    .select("member_id, first_name, last_name, phone_number, email_address, comm_preference, opt_out")
    .in("member_id", member_ids);

  const result = { visits_created: 0, surveys_queued: 0, skipped: 0, errors: [], details: [] };

  for (const member of members || []) {
    if (member.opt_out) {
      result.skipped++;
      result.details.push({ member_id: member.member_id, name: `${member.first_name} ${member.last_name}`, status: "Opted out" });
      continue;
    }

    const { data: existingVisit } = await supabase
      .from("visits")
      .select("visit_id, survey_sent_at")
      .eq("member_id", member.member_id)
      .eq("outlet_id", outlet_id)
      .eq("visit_date", date)
      .maybeSingle();

    let visitId;
    if (existingVisit) {
      visitId = existingVisit.visit_id;
      if (existingVisit.survey_sent_at) {
        result.skipped++;
        result.details.push({ member_id: member.member_id, name: `${member.first_name} ${member.last_name}`, status: "Already surveyed" });
        continue;
      }
    } else {
      const { data: newVisit, error: visitErr } = await supabase
        .from("visits")
        .insert({
          member_id: member.member_id,
          outlet_id: outlet_id,
          visit_date: date,
          spend_amount: 0,
          visitor_type: "golf",
          qualifies: true,
        })
        .select("visit_id")
        .single();

      if (visitErr) {
        result.errors.push(`${member.member_id}: ${visitErr.message}`);
        continue;
      }
      visitId = newVisit.visit_id;
      result.visits_created++;
    }

    const token = crypto.randomUUID();
    const insertPayload = { visit_id: visitId, survey_token: token };
    if (templateId) insertPayload.template_id = templateId;

    let surveyResp, insertErr;
    ({ data: surveyResp, error: insertErr } = await supabase
      .from("survey_responses")
      .insert(insertPayload)
      .select("response_id")
      .single());

    if (insertErr) {
      if (insertErr.message && insertErr.message.includes("template_id")) {
        delete insertPayload.template_id;
        ({ data: surveyResp, error: insertErr } = await supabase
          .from("survey_responses")
          .insert(insertPayload)
          .select("response_id")
          .single());
      }
      if (insertErr) {
        result.details.push({ member_id: member.member_id, name: `${member.first_name} ${member.last_name}`, status: "Survey already exists" });
        continue;
      }
    }

    // Do NOT send now — leave survey_sent_at null so the hourly send-surveys
    // cron delivers it at the club's configured send time.
    if (!member.phone_number && !member.email_address) {
      result.errors.push(`No contact method for ${member.member_id}`);
      result.details.push({ member_id: member.member_id, name: `${member.first_name} ${member.last_name}`, status: "No contact info" });
      continue;
    }
    result.surveys_queued++;
    result.details.push({ member_id: member.member_id, name: `${member.first_name} ${member.last_name}`, status: "Queued" });
  }

  res.json(result);
});

function extractDate(text) {
  // Try common date formats: MM/DD/YYYY, YYYY-MM-DD, Month DD YYYY, DD-Mon-YYYY
  const patterns = [
    /(\d{4}-\d{2}-\d{2})/,
    /(\d{1,2}\/\d{1,2}\/\d{4})/,
    /(\d{1,2}\/\d{1,2}\/\d{2})\b/,
    /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})/i,
    /(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const d = new Date(m[1]);
      if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
    }
  }
  return null;
}

// GET /api/visits/golf-stats — aggregated golf survey statistics for the overview
router.get("/golf-stats", async (req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];

    // Golf visits in the last 30 days
    const { data: golfVisits, error: vErr } = await supabase
      .from("visits")
      .select("visit_id, visit_date, survey_sent_at, member_id, guest_name, members(first_name, last_name)")
      .eq("visitor_type", "golf")
      .gte("visit_date", thirtyDaysAgo)
      .order("visit_date", { ascending: false });

    if (vErr) return res.status(500).json({ error: vErr.message });

    const visitIds = (golfVisits || []).map(v => v.visit_id);
    const surveysSent = (golfVisits || []).filter(v => v.survey_sent_at).length;

    // Completed golf survey responses
    let responses = [];
    if (visitIds.length) {
      const { data: rData, error: rErr } = await supabase
        .from("survey_responses")
        .select("response_id, q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, q5_comment, submitted_at, answers, visit_id, visits(visit_date, member_id, guest_name, members(first_name, last_name), outlets(name))")
        .in("visit_id", visitIds)
        .not("submitted_at", "is", null)
        .order("submitted_at", { ascending: false });

      if (rErr) return res.status(500).json({ error: rErr.message });
      responses = rData || [];
    }

    // Compute averages from golf responses
    let avgNps = null, avgCourse = null, avgPace = null, avgProShop = null;
    if (responses.length) {
      let npsSum = 0, npsCount = 0;
      let courseSum = 0, courseCount = 0;
      let paceSum = 0, paceCount = 0;
      let proSum = 0, proCount = 0;

      for (const r of responses) {
        if (r.q1_nps != null) { npsSum += r.q1_nps; npsCount++; }
        // Golf template maps: q2 = course conditions, q3 = pace of play, q4 = pro shop
        // These are stored in q2_overall_stars, q3_food_stars, q4_service_stars respectively
        if (r.q2_overall_stars != null) { courseSum += r.q2_overall_stars; courseCount++; }
        if (r.q3_food_stars != null) { paceSum += r.q3_food_stars; paceCount++; }
        if (r.q4_service_stars != null) { proSum += r.q4_service_stars; proCount++; }
      }

      avgNps = npsCount ? Math.round((npsSum / npsCount) * 10) / 10 : null;
      avgCourse = courseCount ? Math.round((courseSum / courseCount) * 10) / 10 : null;
      avgPace = paceCount ? Math.round((paceSum / paceCount) * 10) / 10 : null;
      avgProShop = proCount ? Math.round((proSum / proCount) * 10) / 10 : null;
    }

    // NPS score calculation (promoters - detractors as % of total)
    let npsScore = null;
    const npsResponses = responses.filter(r => r.q1_nps != null);
    if (npsResponses.length) {
      const promoters = npsResponses.filter(r => r.q1_nps >= 9).length;
      const detractors = npsResponses.filter(r => r.q1_nps <= 6).length;
      npsScore = Math.round(((promoters - detractors) / npsResponses.length) * 100);
    }

    // Recent responses (last 10) for the feed
    const recent = responses.slice(0, 10).map(r => {
      const v = r.visits || {};
      const m = v.members;
      const name = m ? `${m.first_name} ${m.last_name}` : (v.guest_name || "Guest");
      return {
        name,
        date: v.visit_date,
        nps: r.q1_nps,
        course_conditions: r.q2_overall_stars,
        pace_of_play: r.q3_food_stars,
        pro_shop: r.q4_service_stars,
        comment: r.q5_comment,
        outlet: v.outlets?.name,
      };
    });

    res.json({
      period: "30d",
      surveys_sent: surveysSent,
      responses_received: responses.length,
      response_rate: surveysSent ? Math.round((responses.length / surveysSent) * 100) : 0,
      nps_score: npsScore,
      avg_nps: avgNps,
      avg_course_conditions: avgCourse,
      avg_pace_of_play: avgPace,
      avg_pro_shop: avgProShop,
      recent,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/visits/golf-log — paginated golf survey log with response status
router.get("/golf-log", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  const { data, count, error } = await supabase
    .from("visits")
    .select("visit_id, visit_date, member_id, guest_name, survey_sent_at, members(first_name, last_name), survey_responses(q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, q5_comment, is_complete, submitted_at)", { count: "exact" })
    .eq("visitor_type", "golf")
    .order("visit_date", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ visits: data || [], total: count });
});

// GET /api/visits/overview-stats — live KPIs for the overview tab
router.get("/overview-stats", async (req, res) => {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const startDate = sevenDaysAgo.toISOString().split("T")[0];

    const { data: recentVisits } = await supabase
      .from("visits")
      .select("visit_id, survey_sent_at, outlet_id, outlets(name)")
      .gte("visit_date", startDate);

    // Filter only on this table's own columns and narrow by visit date in JS.
    // Filtering across the embedded `visits` relation is where this broke
    // before, and the overview is the one screen that must never go blank.
    const warnings = [];
    let recentResponses = [];
    {
      // ai_tags is only present once the AI tagging migration has run. The
      // overview must not depend on an optional feature's column, so drop it
      // and retry rather than reporting no responses at all.
      const BASE = "response_id, q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, q5_comment, submitted_at, visits(visit_date, outlet_id, member_id, members(first_name, last_name), outlets(name))";
      // Event surveys have no visit and no outlet — they are reported on the
      // Events screen as their own department, not folded in here.
      const run = (select) => supabase
        .from("survey_responses")
        .select(select)
        .not("submitted_at", "is", null)
        .not("visit_id", "is", null)
        .gte("submitted_at", `${startDate}T00:00:00Z`)
        .order("submitted_at", { ascending: false })
        .limit(1000);

      let { data, error } = await run(`${BASE.replace("q5_comment,", "q5_comment, ai_tags,")}`);
      if (error && /ai_tags/i.test(error.message || "")) {
        ({ data, error } = await run(BASE));
      }

      if (error) {
        console.error("[overview] response query failed:", error.message);
        warnings.push(`Responses could not be loaded: ${error.message}`);
      } else {
        // Count a response when either its visit or its submission falls in
        // the window, so a late reply to a recent visit still shows.
        recentResponses = (data || []).filter((r) => {
          const visitDate = r.visits?.visit_date;
          return !visitDate || visitDate >= startDate;
        });
      }
    }

    const { data: openAlerts } = await supabase
      .from("case_alerts")
      .select("alert_id, severity, created_at, status, outlet_id, outlets(name), survey_responses(q1_nps, q2_overall_stars, q5_comment, visits(member_id, members(first_name, last_name)))")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(5);

    const surveysSent = (recentVisits || []).filter(v => v.survey_sent_at).length;
    const completed = (recentResponses || []).filter(r => r.submitted_at);
    const responseRate = surveysSent > 0 ? Math.round((completed.length / surveysSent) * 100) : 0;

    const npsScores = completed.map(r => r.q1_nps).filter(n => n != null);
    const promoters = npsScores.filter(n => n >= 9).length;
    const detractors = npsScores.filter(n => n <= 6).length;
    const nps = npsScores.length > 0 ? Math.round(((promoters - detractors) / npsScores.length) * 100) : null;

    // Recent comments (last 5 with text)
    const recentComments = completed
      .filter(r => r.q5_comment)
      .sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at))
      .slice(0, 5)
      .map(r => ({
        comment: r.q5_comment,
        outlet: r.visits?.outlets?.name || "Unknown",
        date: r.submitted_at,
        nps: r.q1_nps,
        overall: r.q2_overall_stars,
        tags: r.ai_tags?.tags || [],
        sentiment: r.ai_tags?.sentiment || null,
      }));

    // Outlet breakdown
    const outletMap = {};
    for (const r of completed) {
      const name = r.visits?.outlets?.name;
      if (!name) continue;
      if (!outletMap[name]) outletMap[name] = { nps_scores: [], count: 0 };
      outletMap[name].count++;
      if (r.q1_nps != null) outletMap[name].nps_scores.push(r.q1_nps);
    }
    const outlets = Object.entries(outletMap).map(([name, d]) => {
      const p = d.nps_scores.filter(n => n >= 9).length;
      const det = d.nps_scores.filter(n => n <= 6).length;
      const outletNps = d.nps_scores.length > 0 ? Math.round(((p - det) / d.nps_scores.length) * 100) : null;
      return { name, nps: outletNps, responses: d.count };
    });

    const alerts = (openAlerts || []).map(a => {
      const resp = a.survey_responses;
      const member = resp?.visits?.members;
      const memberName = member ? `${member.last_name}, ${member.first_name}` : "Guest";
      return {
        alert_id: a.alert_id,
        severity: a.severity,
        created_at: a.created_at,
        outlet: a.outlets?.name || "Unknown",
        member_name: memberName,
        overall: resp?.q2_overall_stars,
        comment: resp?.q5_comment,
      };
    });

    res.json({
      nps,
      response_rate: responseRate,
      surveys_sent: surveysSent,
      responses: completed.length,
      open_alerts: alerts.length,
      alerts,
      outlets,
      recent_comments: recentComments,
      warnings,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/visits/trend-stats — monthly trend data for charts
router.get("/trend-stats", async (req, res) => {
  try {
    const now = new Date();
    const sixMonthsAgo = new Date(now);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    const startDate = sixMonthsAgo.toISOString().split("T")[0];

    const { data: responses } = await supabase
      .from("survey_responses")
      .select("q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, submitted_at, visits(outlet_id, outlets(name))")
      .not("submitted_at", "is", null)
      .not("visit_id", "is", null)   // events are trended on their own screen
      .gte("submitted_at", startDate);

    if (!responses || !responses.length) {
      return res.json({ outlets: {}, months: [], outlet_names: [] });
    }

    const monthLabels = [];
    const monthKeys = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date(sixMonthsAgo);
      d.setMonth(d.getMonth() + i);
      monthLabels.push(d.toLocaleString("en-US", { month: "short" }));
      monthKeys.push(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"));
    }

    const buckets = {};
    const outletNames = new Map();

    for (const r of responses) {
      const dt = new Date(r.submitted_at);
      const mk = dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0");
      if (!monthKeys.includes(mk)) continue;

      const outletName = r.visits?.outlets?.name || "Unknown";
      const outletKey = outletName.toLowerCase().replace(/\s+/g, "_");
      outletNames.set(outletKey, outletName);

      for (const key of ["all", outletKey]) {
        if (!buckets[key]) buckets[key] = {};
        if (!buckets[key][mk]) buckets[key][mk] = { csat: [], food: [], service: [], nps: [] };
        const b = buckets[key][mk];
        if (r.q2_overall_stars != null) b.csat.push(r.q2_overall_stars);
        if (r.q3_food_stars != null) b.food.push(r.q3_food_stars);
        if (r.q4_service_stars != null) b.service.push(r.q4_service_stars);
        if (r.q1_nps != null) b.nps.push(r.q1_nps);
      }
    }

    const avg = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;
    const npsCalc = arr => {
      if (!arr.length) return null;
      const p = arr.filter(n => n >= 9).length;
      const d = arr.filter(n => n <= 6).length;
      return Math.round(((p - d) / arr.length) * 100);
    };

    const result = {};
    for (const [key, monthData] of Object.entries(buckets)) {
      result[key] = { csat: [], food: [], service: [], nps: [] };
      for (const mk of monthKeys) {
        const b = monthData[mk];
        result[key].csat.push(b ? avg(b.csat) : null);
        result[key].food.push(b ? avg(b.food) : null);
        result[key].service.push(b ? avg(b.service) : null);
        result[key].nps.push(b ? npsCalc(b.nps) : null);
      }
    }

    const outletList = Array.from(outletNames.entries()).map(([key, name]) => ({ key, name }));
    res.json({ outlets: result, months: monthLabels, outlet_names: outletList });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
