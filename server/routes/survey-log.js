const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { supabase } = require("../lib/supabase");
const { loadCredentials, sendSms, sendEmail } = require("../lib/senders");
const { CLUB_NAME } = require("../lib/club-config");

const CLUB_ID = process.env.CLUB_ID;
const SURVEY_BASE_URL = process.env.SURVEY_BASE_URL;
function baseUrl(req) {
  if (SURVEY_BASE_URL) return SURVEY_BASE_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

// GET /api/surveys?limit=50&offset=0
router.get("/", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  // The template travels with the response so the log can label each answer
  // with the question actually asked. Without it golf's "pace of play" was
  // displayed under the dining label "Food quality".
  let query = supabase
    .from("survey_responses")
    .select(
            "response_id, survey_token, q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, q5_comment, submitted_at, is_complete, created_at, answers, template_id, survey_templates(template_id, name, survey_type, questions), visits(visit_id, member_id, visitor_type, guest_name, guest_phone, guest_email, visit_date, survey_sent_at, reminder_sent_at, outlet_id, members(member_id, first_name, last_name, phone_number, email_address, comm_preference), outlets(name))",
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (req.query.status === "pending") {
    query = query.is("submitted_at", null);
  } else if (req.query.status === "completed") {
    query = query.not("submitted_at", "is", null);
  }

  let { data, count, error } = await query;

  // Databases predating the template columns should still get their log.
  if (error && /template_id|answers|survey_templates/i.test(error.message || "")) {
    let fallback = supabase
      .from("survey_responses")
      .select(
        "response_id, survey_token, q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, q5_comment, submitted_at, is_complete, created_at, visits(visit_id, member_id, visitor_type, guest_name, guest_phone, guest_email, visit_date, survey_sent_at, reminder_sent_at, outlet_id, members(member_id, first_name, last_name, phone_number, email_address, comm_preference), outlets(name))",
        { count: "exact" }
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (req.query.status === "pending") fallback = fallback.is("submitted_at", null);
    else if (req.query.status === "completed") fallback = fallback.not("submitted_at", "is", null);
    ({ data, count, error } = await fallback);
  }

  if (error) return res.status(500).json({ error: error.message });
  res.json({ surveys: data, total: count });
});

// POST /api/surveys/send
// Supports members ({ member_id, channel }) and guests ({ visit_id, channel })
router.post("/send", async (req, res) => {
  const { member_id, visit_id, channel, template_id } = req.body;

  let visit, recipient, sendChannel, logId, memberInfo;

  if (visit_id) {
    const { data } = await supabase
      .from("visits")
      .select("*, members(*)")
      .eq("visit_id", visit_id)
      .maybeSingle();

    if (!data) return res.status(404).json({ error: "Visit not found" });
    visit = data;

    if (data.member_id && data.members) {
      const m = data.members;
      if (m.opt_out) return res.status(400).json({ error: "Member has opted out of surveys" });
      sendChannel = channel || m.comm_preference || "sms";
      recipient = sendChannel === "sms" ? m.phone_number : m.email_address;
      logId = m.member_id;
      memberInfo = m;
    } else {
      sendChannel = channel || (data.guest_phone ? "sms" : "email");
      recipient = sendChannel === "sms" ? data.guest_phone : data.guest_email;
      logId = null;
    }
  } else if (member_id) {
    const { data: member } = await supabase
      .from("members")
      .select("*")
      .eq("member_id", member_id)
      .maybeSingle();

    if (!member) return res.status(404).json({ error: "Member not found" });
    if (member.opt_out) return res.status(400).json({ error: "Member has opted out of surveys" });

    sendChannel = channel || member.comm_preference || "sms";
    recipient = sendChannel === "sms" ? member.phone_number : member.email_address;
    logId = member.member_id;
    memberInfo = member;

    const { data: latestVisit } = await supabase
      .from("visits")
      .select("visit_id, outlet_id")
      .eq("member_id", member_id)
      .order("visit_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!latestVisit) {
      return res.status(400).json({ error: "No visits on record for this member" });
    }
    visit = latestVisit;
  } else {
    return res.status(400).json({ error: "member_id or visit_id is required" });
  }

  if (!recipient) {
    return res.status(400).json({ error: `No ${sendChannel === "sms" ? "phone number" : "email address"} on file for ${sendChannel} delivery` });
  }

  // Reuse existing survey response if one already exists for this visit
  const { data: existing } = await supabase
    .from("survey_responses")
    .select("survey_token, submitted_at")
    .eq("visit_id", visit.visit_id)
    .maybeSingle();

  if (existing?.submitted_at) {
    return res.status(400).json({ error: "This visit already has a completed survey response" });
  }

  let token;
  if (existing) {
    token = existing.survey_token;
  } else {
    token = crypto.randomUUID();
    const insertPayload = { visit_id: visit.visit_id, survey_token: token };
    if (template_id) insertPayload.template_id = template_id;
    let insertErr;
    ({ error: insertErr } = await supabase.from("survey_responses").insert(insertPayload));
    if (insertErr && insertErr.message && insertErr.message.includes("template_id")) {
      delete insertPayload.template_id;
      ({ error: insertErr } = await supabase.from("survey_responses").insert(insertPayload));
    }
    if (insertErr) return res.status(500).json({ error: insertErr.message });
  }

  const link = `${baseUrl(req)}/s/${token}`;
  const message = `${CLUB_NAME}: We'd love your quick feedback on your recent visit. Takes under a minute: ${link}`;
  const creds = await loadCredentials(CLUB_ID);

  try {
    if (sendChannel === "sms") {
      await sendSms(recipient, message, creds, logId);
    } else {
      await sendEmail(recipient, "How was your visit?", message, creds, logId, {
        first_name: memberInfo?.first_name || "",
        last_name: memberInfo?.last_name || "",
        survey_url: link,
        unsubscribe_url: `${baseUrl(req)}/u/${token}`,
        is_reminder: false,
      });
    }
    // Sent but not recorded leaves the visit looking unsent, so the next
    // scheduled batch sends the same member the same survey again. Report it
    // rather than returning a clean success.
    const { error: stampErr } = await supabase
      .from("visits")
      .update({ survey_sent_at: new Date().toISOString() })
      .eq("visit_id", visit.visit_id);
    res.json({
      sent: true, channel: sendChannel, survey_token: token,
      ...(stampErr ? { warning: `Sent, but recording it failed — ${stampErr.message}. They may receive it again.` } : {}),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

module.exports = router;
