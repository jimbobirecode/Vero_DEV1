const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { supabase } = require("../lib/supabase");
const { loadCredentials, sendSms, sendEmail } = require("../lib/senders");
const { CLUB_NAME } = require("../lib/club-config");
const { scoreResponses, summarise, normaliseCategory, CATEGORIES } = require("../lib/event-scores");
const eventInsight = require("../lib/event-insight");

const CLUB_ID = process.env.CLUB_ID;
const SURVEY_BASE_URL = process.env.SURVEY_BASE_URL;
function baseUrl(req) {
  if (SURVEY_BASE_URL) return SURVEY_BASE_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

// GET /api/events — list events, newest first
router.get("/", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  let query = supabase
    .from("events")
    .select("*", { count: "exact" })
    .order("event_date", { ascending: false })
    .range(offset, offset + limit - 1);

  if (CATEGORIES.includes(req.query.category)) query = query.eq("category", req.query.category);

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ events: data, total: count });
});

// GET /api/events/scores?from=&to= — the Events department's own numbers.
//
// Declared before /:id so "scores" is not read as an event id. Events are
// scored here and nowhere else: they are kept out of CHI, SSI and OHI on
// purpose, because those are benchmarked from what members say about an
// outlet they visited and an event is a different operation entirely.
router.get("/scores", async (req, res) => {
  let q = supabase.from("events").select("event_id, name, event_date, category");
  if (req.query.from) q = q.gte("event_date", req.query.from);
  if (req.query.to) q = q.lte("event_date", req.query.to);

  const { data: events, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  if (!events?.length) return res.json(summarise([]));

  const { data: attendees, error: attErr } = await supabase
    .from("event_attendees")
    .select("event_id, survey_responses(q1_nps, q2_overall_stars, submitted_at)")
    .in("event_id", events.map((e) => e.event_id))
    .not("survey_response_id", "is", null);

  if (attErr) return res.status(500).json({ error: attErr.message });

  const byEvent = new Map(events.map((e) => [e.event_id, []]));
  for (const a of attendees || []) {
    if (a.survey_responses) byEvent.get(a.event_id)?.push(a.survey_responses);
  }

  res.json(summarise(events.map((e) => ({ ...e, responses: byEvent.get(e.event_id) || [] }))));
});

// GET /api/events/:id — single event with attendee stats
router.get("/:id", async (req, res) => {
  const { data: event, error } = await supabase
    .from("events")
    .select("*")
    .eq("event_id", req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!event) return res.status(404).json({ error: "Event not found" });

  const { count: totalAttendees } = await supabase
    .from("event_attendees")
    .select("attendee_id", { count: "exact", head: true })
    .eq("event_id", req.params.id);

  const { count: surveysSent } = await supabase
    .from("event_attendees")
    .select("attendee_id", { count: "exact", head: true })
    .eq("event_id", req.params.id)
    .not("survey_sent_at", "is", null);

  const { count: responsesReceived } = await supabase
    .from("event_attendees")
    .select("attendee_id", { count: "exact", head: true })
    .eq("event_id", req.params.id)
    .not("survey_response_id", "is", null);

  // Pull completed response data for averages
  const { data: responses } = await supabase
    .from("event_attendees")
    .select("survey_responses(q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, submitted_at)")
    .eq("event_id", req.params.id)
    .not("survey_response_id", "is", null);

  const rows = (responses || []).map((r) => r.survey_responses).filter(Boolean);
  // A proper NPS, not the mean of the 0-10 answers — averaging those reads
  // like a score out of ten and is not comparable to anybody else's NPS.
  const scores = scoreResponses(rows);

  // Latest AI insight, if one has been generated.
  let insight = null;
  try {
    const { data } = await supabase
      .from("event_insights")
      .select("*")
      .eq("event_id", req.params.id)
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    insight = data || null;
  } catch (_) { /* table added by migrations/events-module.sql */ }

  res.json({
    ...event,
    category: normaliseCategory(event.category),
    total_attendees: totalAttendees || 0,
    surveys_sent: surveysSent || 0,
    responses_received: scores.responses,
    scores,
    insight,
    // Kept for anything still reading the old field names.
    avg_nps: scores.nps,
    avg_overall: scores.csat,
  });
});

// POST /api/events — create an event
router.post("/", async (req, res) => {
  const { name, event_date, description, category, template_id } = req.body;
  if (!name || !event_date) {
    return res.status(400).json({ error: "name and event_date are required" });
  }
  if (category != null && !CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(", ")}` });
  }

  const payload = {
    name, event_date, description: description || null,
    category: category || "general",
    template_id: template_id || null,
  };

  let { data, error } = await supabase.from("events").insert(payload).select().single();

  // A database that has not had migrations/events-module.sql run yet still
  // creates events — it simply cannot categorise them.
  if (error && /category|template_id/i.test(error.message || "")) {
    delete payload.category; delete payload.template_id;
    ({ data, error } = await supabase.from("events").insert(payload).select().single());
  }

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /api/events/:id — change the category, the survey template, or the
// details. The category decides nothing about delivery; it decides how the
// event is scored and reported within the Events department.
router.patch("/:id", async (req, res) => {
  const updates = {};
  for (const field of ["name", "event_date", "description"]) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }
  if (req.body.category !== undefined) {
    if (!CATEGORIES.includes(req.body.category)) {
      return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(", ")}` });
    }
    updates.category = req.body.category;
  }
  if (req.body.template_id !== undefined) {
    const templateId = req.body.template_id || null;
    if (templateId) {
      const { data: tpl } = await supabase
        .from("survey_templates")
        .select("template_id, survey_type")
        .eq("template_id", templateId)
        .maybeSingle();
      if (!tpl) return res.status(400).json({ error: "That survey template no longer exists" });
      if (tpl.survey_type !== "events") {
        return res.status(400).json({ error: "Only an Events template can be used for an event" });
      }
    }
    updates.template_id = templateId;
  }

  if (!Object.keys(updates).length) return res.status(400).json({ error: "Nothing to update" });

  const { data, error } = await supabase
    .from("events").update(updates).eq("event_id", req.params.id).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/events/:id/attendees — add attendees (members and/or guests)
// Body: { member_ids: ["R272", ...], guests: [{ name, phone, email }, ...] }
router.post("/:id/attendees", async (req, res) => {
  const { member_ids, guests } = req.body;
  const hasMemberIds = Array.isArray(member_ids) && member_ids.length;
  const hasGuests = Array.isArray(guests) && guests.length;
  if (!hasMemberIds && !hasGuests) {
    return res.status(400).json({ error: "member_ids array or guests array is required" });
  }

  const eventId = req.params.id;
  const { data: event } = await supabase
    .from("events")
    .select("event_id")
    .eq("event_id", eventId)
    .maybeSingle();
  if (!event) return res.status(404).json({ error: "Event not found" });

  const result = { added: 0, skipped_not_found: [], skipped_duplicate: 0, guests_added: 0 };
  const toInsert = [];

  // Process member IDs
  if (hasMemberIds) {
    const uniqueIds = [...new Set(member_ids.map(id => String(id).trim()).filter(Boolean))];

    const { data: existingMembers } = await supabase
      .from("members")
      .select("member_id")
      .in("member_id", uniqueIds);
    const validIds = new Set((existingMembers || []).map(m => m.member_id));

    const { data: alreadyAdded } = await supabase
      .from("event_attendees")
      .select("member_id")
      .eq("event_id", eventId)
      .in("member_id", uniqueIds);
    const dupeIds = new Set((alreadyAdded || []).map(a => a.member_id));

    for (const id of uniqueIds) {
      if (!validIds.has(id)) {
        result.skipped_not_found.push(id);
        continue;
      }
      if (dupeIds.has(id)) {
        result.skipped_duplicate++;
        continue;
      }
      toInsert.push({ event_id: eventId, member_id: id });
    }
  }

  // Process guest attendees
  if (hasGuests) {
    for (const g of guests) {
      const name = (g.name || "").trim();
      const phone = (g.phone || "").trim();
      const email = (g.email || "").trim();
      if (!name) continue;
      if (!phone && !email) continue;
      toInsert.push({
        event_id: eventId,
        member_id: null,
        guest_name: name,
        guest_phone: phone || null,
        guest_email: email || null,
      });
      result.guests_added++;
    }
  }

  if (toInsert.length) {
    const { error: insertErr } = await supabase.from("event_attendees").insert(toInsert);
    if (insertErr) return res.status(500).json({ error: insertErr.message });
    result.added = toInsert.length;
  }

  res.json(result);
});

// GET /api/events/:id/attendees — list attendees with survey status
router.get("/:id/attendees", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  // The whole response travels with the attendee, template and all, so the
  // list can expand into the answers the way the survey log does. Only NPS
  // and the overall stars came back before, which is why an event response
  // could be opened nowhere: the rest of it was never sent to the browser.
  const RESPONSE = "survey_responses(response_id, survey_token, q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, q5_comment, answers, submitted_at, survey_templates(template_id, name, survey_type, questions))";
  const RESPONSE_LEGACY = "survey_responses(response_id, survey_token, q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, q5_comment, submitted_at)";
  const MEMBERS = "members(member_id, first_name, last_name, phone_number, email_address, comm_preference, opt_out)";

  function attendeeQuery(responseSelect) {
    return supabase
      .from("event_attendees")
      .select(`*, ${MEMBERS}, ${responseSelect}`, { count: "exact" })
      .eq("event_id", req.params.id)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
  }

  let { data, count, error } = await attendeeQuery(RESPONSE);

  // Databases predating the template work still get their attendee list; they
  // simply fall back to the fixed question labels.
  if (error && /template_id|answers|survey_templates/i.test(error.message || "")) {
    ({ data, count, error } = await attendeeQuery(RESPONSE_LEGACY));
  }

  if (error) return res.status(500).json({ error: error.message });
  res.json({ attendees: data, total: count });
});

// POST /api/events/:id/send-surveys — blast surveys to all attendees who haven't been sent one
router.post("/:id/send-surveys", async (req, res) => {
  const eventId = req.params.id;

  const { data: event, error: eventErr } = await supabase
    .from("events")
    .select("*")
    .eq("event_id", eventId)
    .maybeSingle();
  // A failed lookup is not a missing event. Reporting it as 404 sent people
  // hunting for a deleted event when the real answer was in the error.
  if (eventErr) return res.status(500).json({ error: `Could not load the event: ${eventErr.message}` });
  if (!event) return res.status(404).json({ error: "Event not found" });

  const { data: attendees, error: attErr } = await supabase
    .from("event_attendees")
    .select("attendee_id, member_id, guest_name, guest_phone, guest_email, members(member_id, first_name, last_name, phone_number, email_address, comm_preference, opt_out)")
    .eq("event_id", eventId)
    .is("survey_sent_at", null);

  // This error used to be discarded, and a failed query is indistinguishable
  // from an empty one once you drop it: the route answered "0 sent, no
  // errors", the attendee list still showed everyone as Pending, and there
  // was nothing anywhere saying why. Say what the database said.
  if (attErr) {
    return res.status(500).json({
      sent: 0, skipped: 0, errors: [attErr.message],
      error: `Could not work out who still needs a survey: ${attErr.message}`,
    });
  }

  if (!attendees.length) {
    return res.json({ sent: 0, skipped: 0, errors: [] });
  }

  const creds = await loadCredentials(CLUB_ID);
  const result = { sent: 0, skipped: 0, errors: [] };

  // The event's own template wins — a golf event asks about the course, a
  // wine dinner about the wine. Only when it has none does the live Events
  // template apply. Same precedence outlets already use.
  let templateId = req.body.template_id || event.template_id || null;
  if (!templateId) {
    try {
      const { data: evtTpl } = await supabase
        .from("survey_templates")
        .select("template_id")
        .eq("survey_type", "events")
        .eq("active", true)
        .limit(1)
        .maybeSingle();
      if (evtTpl) templateId = evtTpl.template_id;
    } catch (_) { /* survey_templates table may not exist yet */ }
  }

  for (const att of attendees) {
    const member = att.members;

    // Determine contact info: member or guest
    let sendChannel, recipient, firstName, lastName, logId, displayId;
    if (member) {
      if (member.opt_out) { result.skipped++; continue; }
      sendChannel = member.comm_preference === "sms" ? "sms" : "email";
      recipient = sendChannel === "sms" ? member.phone_number : member.email_address;
      firstName = member.first_name; lastName = member.last_name;
      logId = member.member_id; displayId = member.member_id;
    } else {
      // Guest attendee
      sendChannel = att.guest_phone ? "sms" : "email";
      recipient = sendChannel === "sms" ? att.guest_phone : att.guest_email;
      const parts = (att.guest_name || "").split(" ");
      firstName = parts[0] || ""; lastName = parts.slice(1).join(" ") || "";
      logId = null; displayId = att.guest_name || att.attendee_id;
    }

    if (!recipient) {
      result.errors.push(`No contact method for ${displayId}`);
      continue;
    }

    const token = crypto.randomUUID();
    const insertPayload = { survey_token: token };
    if (templateId) insertPayload.template_id = templateId;
    let surveyResp, insertErr;
    ({ data: surveyResp, error: insertErr } = await supabase
      .from("survey_responses")
      .insert(insertPayload)
      .select("response_id")
      .single());

    if (insertErr) {
      result.errors.push(`${displayId}: ${insertErr.message}`);
      continue;
    }

    // Link the response now, but do not stamp survey_sent_at until the
    // message has actually gone: attendees are selected by that column being
    // empty, so stamping it up front excluded failed sends from every retry.
    await supabase
      .from("event_attendees")
      .update({ survey_response_id: surveyResp.response_id })
      .eq("attendee_id", att.attendee_id);

    const link = `${baseUrl(req)}/s/${token}`;
    // Hyphen, not an em dash: an em dash is outside GSM-7 and re-encodes the
    // whole message as UCS-2, tripling its segment cost. See lib/sms-billing.js.
    const message = `${CLUB_NAME}: How was ${event.name}? We'd love your quick feedback - takes under a minute: ${link}`;

    try {
      if (sendChannel === "sms") {
        await sendSms(recipient, message, creds, logId, { kind: "event_survey" });
      } else {
        await sendEmail(recipient, `How was ${event.name}?`, message, creds, logId, {
          first_name: firstName,
          last_name: lastName,
          survey_url: link,
          unsubscribe_url: `${baseUrl(req)}/u/${token}`,
          event_name: event.name,
          is_reminder: false,
        });
      }
      const { error: stampErr } = await supabase
        .from("event_attendees")
        .update({ survey_sent_at: new Date().toISOString() })
        .eq("attendee_id", att.attendee_id);
      // The message has gone. If we cannot record that, say so loudly: the
      // attendee will keep showing as Pending and the next click will send
      // them a second survey.
      if (stampErr) {
        result.errors.push(`${displayId}: message sent, but recording it failed — ${stampErr.message}. Do not re-send or they will get it twice.`);
      }
      result.sent++;
    } catch (e) {
      result.errors.push(`${displayId}: ${String(e)}`);
    }
  }

  // Nothing went out and every attempt failed — report it as a failure rather
  // than a success with a quiet errors array the screen may not surface.
  if (result.sent === 0 && result.errors.length) {
    return res.status(502).json({
      ...result,
      error: `No surveys were sent. ${result.errors[0]}`,
    });
  }

  res.json(result);
});

// GET /api/events/:id/insights — the stored analyses, newest first.
router.get("/:id/insights", async (req, res) => {
  const { data, error } = await supabase
    .from("event_insights")
    .select("*")
    .eq("event_id", req.params.id)
    .order("generated_at", { ascending: false })
    .limit(10);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ insights: data || [] });
});

// POST /api/events/:id/insights — analyse this event's feedback.
//
// One event, one occasion. Run on demand rather than on a weekly schedule:
// an event's feedback arrives over a couple of days and then stops, so there
// is a point at which the analysis is finished rather than perpetually stale.
router.post("/:id/insights", async (req, res) => {
  const { data: event, error: eventErr } = await supabase
    .from("events")
    .select("*")
    .eq("event_id", req.params.id)
    .maybeSingle();

  if (eventErr) return res.status(500).json({ error: `Could not load the event: ${eventErr.message}` });
  if (!event) return res.status(404).json({ error: "Event not found" });

  const { data: attendees, error: attErr } = await supabase
    .from("event_attendees")
    .select("survey_responses(q1_nps, q2_overall_stars, q3_food_stars, q4_service_stars, q5_comment, submitted_at)")
    .eq("event_id", req.params.id)
    .not("survey_response_id", "is", null);

  if (attErr) return res.status(500).json({ error: `Could not load the responses: ${attErr.message}` });

  const rows = (attendees || []).map((a) => a.survey_responses).filter((r) => r?.submitted_at);
  if (!rows.length) {
    return res.status(400).json({ error: "Nobody has answered this event's survey yet, so there is nothing to analyse." });
  }

  const scores = scoreResponses(rows);

  let result;
  try {
    result = await eventInsight.generate({
      event: { ...event, category: normaliseCategory(event.category) },
      scores, rows,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }

  const record = {
    event_id: event.event_id,
    urgency: result.urgency,
    headline: result.headline,
    themes: result.themes,
    what_worked: result.what_worked,
    response_count: scores.responses,
    nps: scores.nps,
    csat: scores.csat,
  };

  // The analysis is worth returning even if storing it fails — say so rather
  // than throwing away a run that cost a model call.
  const { data: saved, error: saveErr } = await supabase
    .from("event_insights").insert(record).select().single();

  res.json({
    ...(saved || record),
    scores,
    ...(saveErr ? { warning: `Generated, but could not be saved — ${saveErr.message}` } : {}),
  });
});

module.exports = router;
