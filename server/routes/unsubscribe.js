const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");
const { CLUB_NAME } = require("../lib/club-config");

// Unsubscribe, reached from the footer of a survey email.
//
// Keyed on the survey token the member already holds, so there is nothing new
// to mint and no way to unsubscribe somebody else by guessing an id. Setting
// members.opt_out is what actually stops future sends — every send path checks
// it — so the link genuinely works rather than only appearing to.

function page(title, body, tone = "ok") {
  const colour = tone === "ok" ? "#1f4d3a" : "#b04a34";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title></head>
<body style="margin:0;background:#f2f4f1;font-family:Arial,Helvetica,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;">
<div style="background:#fff;border-radius:8px;max-width:440px;width:100%;padding:32px;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
  <div style="font-size:13px;color:#6b6b6b;margin-bottom:6px;">${CLUB_NAME}</div>
  <h1 style="margin:0 0 12px;font-size:20px;color:${colour};">${title}</h1>
  <p style="margin:0;font-size:15px;line-height:1.55;color:#3a3a3a;">${body}</p>
</div></body></html>`;
}

// GET /u/:token — confirmation page, so a mail scanner prefetching links
// cannot unsubscribe somebody by accident.
router.get("/:token", async (req, res) => {
  const { data } = await supabase
    .from("survey_responses")
    .select("response_id, visits(member_id, members(first_name, opt_out))")
    .eq("survey_token", req.params.token)
    .maybeSingle();

  const member = data?.visits?.members;
  if (!data || !data.visits?.member_id) {
    return res.status(404).send(page("Link not recognised",
      "We couldn't match this link to a membership record. If you'd like to stop receiving feedback requests, reply to any club email and we'll take care of it.", "err"));
  }

  if (member?.opt_out) {
    return res.send(page("You're already unsubscribed",
      "You won't receive any further feedback requests from us."));
  }

  res.send(page("Stop receiving feedback requests?",
    `<form method="POST" action="/u/${encodeURIComponent(req.params.token)}" style="margin:18px 0 0;">
       <button type="submit" style="background:#1f4d3a;color:#fff;border:0;border-radius:6px;padding:13px 26px;font-size:15px;font-weight:bold;cursor:pointer;">
         Yes, unsubscribe me
       </button>
     </form>
     <span style="display:block;margin-top:14px;font-size:13px;color:#8a8a8a;">
       This only stops feedback requests. It does not affect any other club communication.
     </span>`));
});

// POST /u/:token — the actual opt-out.
router.post("/:token", async (req, res) => {
  const { data } = await supabase
    .from("survey_responses")
    .select("visits(member_id)")
    .eq("survey_token", req.params.token)
    .maybeSingle();

  const memberId = data?.visits?.member_id;
  if (!memberId) {
    return res.status(404).send(page("Link not recognised",
      "We couldn't match this link to a membership record.", "err"));
  }

  const { error } = await supabase
    .from("members")
    .update({ opt_out: true, updated_at: new Date().toISOString() })
    .eq("member_id", memberId);

  if (error) {
    return res.status(500).send(page("Something went wrong",
      "We couldn't update your preferences just now. Please reply to any club email and we'll do it for you.", "err"));
  }

  res.send(page("You've been unsubscribed",
    "You won't receive any further feedback requests. Thank you for the time you've already given us."));
});

module.exports = router;
