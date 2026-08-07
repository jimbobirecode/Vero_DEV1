// Staff workday surveys — the send path and the management-facing reads.
//
// Mirrors the member flow in routes/surveys.js: mint a one-use token per
// person per shift, send a link over SMS/email, and let them answer without a
// login. The differences are deliberate:
//
//   * Recipients come from who actually worked, derived from that day's
//     visits, rather than from a qualifying-visit rule.
//   * There is no frequency cap. One survey per person per shift is the cap,
//     and the unique index on (server_id, shift_date) enforces it.
//   * Sends are opt-in (staff_survey_enabled), because this messages your own
//     employees and should not start the moment the migration is applied.

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { supabase } = require("../lib/supabase");
const { loadCredentials, sendSms, sendEmail } = require("../lib/senders");
const { staffSmsBody, staffEmailSubject } = require("../lib/messages");

const CLUB_ID = process.env.CLUB_ID;

// Who worked on a given date. visits.server_id is the reliable link; rows that
// carry only server_name (POS uploads, anything logged before the FK existed)
// are resolved by name instead of being dropped.
//
// The name match is case- and whitespace-insensitive and done here rather than
// in the query: a POS export writing "jessica" would not match a servers row
// of "Jessica" under SQL equality, and that person would silently never be
// surveyed. The active server list is small enough to compare in memory.
async function serversWhoWorked(shiftDate) {
  const { data: visits, error } = await supabase
    .from("visits")
    .select("server_id, server_name")
    .eq("visit_date", shiftDate);

  if (error) throw new Error(error.message);
  if (!visits || !visits.length) return [];

  const { data: active } = await supabase
    .from("servers")
    .select("server_id, name, phone, email")
    .eq("active", true);

  const byId = new Map((active || []).map((s) => [s.server_id, s]));
  const byName = new Map((active || []).map((s) => [normaliseName(s.name), s]));

  // Keyed by server_id so someone with several visits is only asked once.
  const picked = new Map();
  for (const v of visits) {
    let server = v.server_id ? byId.get(v.server_id) : null;
    if (!server && v.server_name) server = byName.get(normaliseName(v.server_name));
    if (server) picked.set(server.server_id, server);
  }
  return [...picked.values()];
}

function normaliseName(name) {
  return (name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Reuse an existing row for the shift when there is one, so a retry after a
// partial failure re-sends the same link rather than minting a second.
async function tokenForShift(serverId, shiftDate) {
  const { data: existing } = await supabase
    .from("staff_survey_responses")
    .select("staff_response_id, survey_token, submitted_at, sent_at")
    .eq("server_id", serverId)
    .eq("shift_date", shiftDate)
    .maybeSingle();

  if (existing) return existing;

  const token = crypto.randomUUID();
  const { data, error } = await supabase
    .from("staff_survey_responses")
    .insert({ server_id: serverId, shift_date: shiftDate, survey_token: token })
    .select("staff_response_id, survey_token, submitted_at, sent_at")
    .single();

  // Lost a race against a concurrent tick — the unique index did its job, so
  // take whatever row won rather than failing this person's send.
  if (error) {
    const { data: raced } = await supabase
      .from("staff_survey_responses")
      .select("staff_response_id, survey_token, submitted_at, sent_at")
      .eq("server_id", serverId)
      .eq("shift_date", shiftDate)
      .maybeSingle();
    if (raced) return raced;
    throw new Error(error.message);
  }
  return data;
}

// Does the actual sending. Applies no time gating of its own — the caller
// decides when it is time, exactly as performSend does for members.
async function performStaffSend(linkBase, shiftDate) {
  const results = {
    shift_date: shiftDate, sent: 0,
    skipped_no_contact: 0, skipped_already_sent: 0, skipped_submitted: 0,
    errors: [],
  };

  const creds = await loadCredentials(CLUB_ID);
  if (!creds.sendlyKey && !creds.sendgridKey) {
    return { skipped: true, reason: "No SMS or email provider credentials are configured (SENDLY_API_KEY / SENDGRID_API_KEY)" };
  }

  let servers;
  try {
    servers = await serversWhoWorked(shiftDate);
  } catch (e) {
    return { error: String(e.message || e) };
  }
  if (!servers.length) {
    return { ...results, reason: `No active servers recorded against visits on ${shiftDate}` };
  }

  for (const server of servers) {
    const channel = server.phone ? "sms" : "email";
    const recipient = server.phone || server.email;
    if (!recipient) { results.skipped_no_contact++; continue; }

    let row;
    try {
      row = await tokenForShift(server.server_id, shiftDate);
    } catch (e) {
      results.errors.push(`${server.name}: ${e.message || e}`);
      continue;
    }

    if (row.submitted_at) { results.skipped_submitted++; continue; }
    if (row.sent_at) { results.skipped_already_sent++; continue; }

    const link = `${linkBase}/ss/${row.survey_token}`;
    const firstName = (server.name || "").split(" ")[0];
    const body = staffSmsBody({ link, firstName });

    try {
      // member_id is null throughout: these recipients are staff, not members.
      // message_log still records the send, so delivery stays auditable.
      if (channel === "sms") {
        await sendSms(recipient, body, creds, null, { kind: "staff_survey" });
      } else {
        await sendEmail(recipient, staffEmailSubject(), body, creds, null, {
          first_name: firstName, last_name: (server.name || "").split(" ").slice(1).join(" "),
          survey_url: link, is_reminder: false,
        });
      }
      await supabase
        .from("staff_survey_responses")
        .update({ sent_at: new Date().toISOString() })
        .eq("staff_response_id", row.staff_response_id);
      results.sent++;
    } catch (e) {
      if (e?.code === "insufficient_credit") {
        results.stopped_for_credit = true;
        results.errors.push(`Stopped: ${e.message} The rest of the shift was not surveyed.`);
        break;
      }
      results.errors.push(`${server.name}: ${String(e)}`);
    }
  }

  return results;
}

// --- Management-facing reads ----------------------------------------------

// GET /api/staff-surveys?from=YYYY-MM-DD&to=YYYY-MM-DD&server_id=...
router.get("/", async (req, res) => {
  let q = supabase
    .from("staff_survey_responses")
    .select("staff_response_id, server_id, shift_date, q1_shift_rating, q2_support, q3_workload, q4_tools, q5_comment, submitted_at, sent_at, servers(name)")
    .not("submitted_at", "is", null)
    .order("submitted_at", { ascending: false })
    .limit(Math.min(parseInt(req.query.limit, 10) || 100, 500));

  if (req.query.from) q = q.gte("shift_date", req.query.from);
  if (req.query.to) q = q.lte("shift_date", req.query.to);
  if (req.query.server_id) q = q.eq("server_id", req.query.server_id);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ responses: data || [] });
});

// GET /api/staff-surveys/summary?days=30
// Averages plus a response rate, so a low average can be read against how
// many people actually answered.
router.get("/summary", async (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
  const since = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];

  const { data, error } = await supabase
    .from("staff_survey_responses")
    .select("q1_shift_rating, q2_support, q3_workload, q4_tools, submitted_at")
    .gte("shift_date", since);

  if (error) return res.status(500).json({ error: error.message });

  const rows = data || [];
  const done = rows.filter((r) => r.submitted_at);
  const mean = (key) => {
    const vals = done.map((r) => r[key]).filter((v) => v != null);
    return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null;
  };

  res.json({
    days,
    sent: rows.length,
    submitted: done.length,
    response_rate: rows.length ? Math.round((done.length / rows.length) * 100) : 0,
    avg_shift_rating: mean("q1_shift_rating"),
    avg_support: mean("q2_support"),
    avg_workload: mean("q3_workload"),
    avg_tools: mean("q4_tools"),
  });
});

// POST /api/staff-surveys/send — manual trigger, defaults to today's shift.
router.post("/send", async (req, res) => {
  const base = (process.env.SURVEY_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
  const shiftDate = req.body?.shift_date || new Date().toISOString().split("T")[0];
  try {
    res.json(await performStaffSend(base, shiftDate));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

module.exports = router;
module.exports.performStaffSend = performStaffSend;
module.exports.serversWhoWorked = serversWhoWorked;
