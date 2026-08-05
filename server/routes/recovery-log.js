// One-tap call logging, reached from the link in an escalation email.
//
// This exists because of where the act happens. A manager rings a member from
// the car park, hangs up, and has about thirty seconds of willingness left. A
// dashboard they have to find a laptop for collects nothing, and a feature
// that collects nothing produces a recovery metric made of guesses.
//
// Keyed on a token minted per alert, in the same shape as the survey and
// unsubscribe links. The worst anyone can do with a guessed token is record a
// call on somebody else's alert, and every row records that it came in this
// way, so it can be told apart from a deliberate dashboard entry.

const express = require("express");
const router = express.Router();
const { CLUB_NAME } = require("../lib/club-config");
const recovery = require("../lib/recovery");
const store = require("../lib/recovery-store");

const esc = (v) => String(v ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function page(title, body, tone = "ok") {
  const colour = tone === "ok" ? "#16302A" : "#9C4A34";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title></head>
<body style="margin:0;background:#F5F2EA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;">
<div style="background:#fff;border-radius:10px;max-width:460px;width:100%;padding:28px;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
  <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#B08A4E;margin-bottom:8px;">${esc(CLUB_NAME)}</div>
  <h1 style="margin:0 0 14px;font-size:20px;color:${colour};line-height:1.3;">${esc(title)}</h1>
  ${body}
</div></body></html>`;
}

const BTN = (bg, fg) =>
  `display:block;width:100%;box-sizing:border-box;margin:0 0 10px;padding:15px 18px;` +
  `font-size:16px;font-weight:600;text-align:left;border:0;border-radius:8px;cursor:pointer;` +
  `background:${bg};color:${fg};`;

// GET /c/:token — the three buttons.
//
// Nothing is recorded on GET. Mail scanners and link previewers fetch every
// URL in an email; a GET that logged a call would fill the record with calls
// nobody made, and those would count towards the club's headline metric.
router.get("/:token", async (req, res) => {
  const ready = await store.recoveryReady();
  if (!ready.ok) return res.status(503).send(page("Not available yet", `<p style="margin:0;font-size:15px;line-height:1.55;color:#3a3a3a;">${esc(ready.error)}</p>`, "err"));

  const { alert } = await store.alertByToken(req.params.token);
  if (!alert) {
    return res.status(404).send(page("Link not recognised",
      `<p style="margin:0;font-size:15px;line-height:1.55;color:#3a3a3a;">This link has expired or was mistyped. Open the dashboard to log the call instead.</p>`, "err"));
  }

  const who = alert.member_name || "this member";
  const already = alert.first_contact_at
    ? `<div style="background:#E4EBE5;border-radius:6px;padding:11px 13px;margin-bottom:16px;font-size:13.5px;color:#16302A;">
         Already logged as contacted on ${esc(new Date(alert.first_contact_at).toUTCString())}.
         Logging again adds another attempt to the record.
       </div>` : "";

  const action = `/c/${encodeURIComponent(req.params.token)}`;
  res.send(page(`Did you speak to ${who}?`, `
    ${already}
    <p style="margin:0 0 18px;font-size:14px;line-height:1.55;color:#5B6259;">
      ${alert.outlet_name ? `Alert raised at ${esc(alert.outlet_name)}. ` : ""}One tap and it is on the record.
    </p>
    <form method="POST" action="${action}">
      <input type="hidden" name="channel" value="phone">
      <button type="submit" name="outcome" value="reached" style="${BTN("#16302A", "#F5F2EA")}">
        Yes — I spoke to them
      </button>
      <button type="submit" name="outcome" value="left_message" style="${BTN("#F5F2EA", "#16302A")}">
        Left a message
      </button>
      <button type="submit" name="outcome" value="no_answer" style="${BTN("#F5F2EA", "#16302A")}">
        No answer
      </button>
    </form>
    <span style="display:block;margin-top:14px;font-size:12.5px;color:#8a8a8a;">
      This records that the call happened. It sends nothing to the member.
    </span>`));
});

// POST /c/:token — record it.
router.post("/:token", async (req, res) => {
  const ready = await store.recoveryReady();
  if (!ready.ok) return res.status(503).send(page("Not available yet", `<p>${esc(ready.error)}</p>`, "err"));

  const { alert } = await store.alertByToken(req.params.token);
  if (!alert) {
    return res.status(404).send(page("Link not recognised",
      `<p style="margin:0;font-size:15px;color:#3a3a3a;">This link has expired or was mistyped.</p>`, "err"));
  }

  const outcome = String(req.body?.outcome || "");
  if (!recovery.OUTCOMES.includes(outcome)) {
    return res.status(400).send(page("That didn't register",
      `<p style="margin:0;font-size:15px;color:#3a3a3a;">Go back and pick one of the three options.</p>`, "err"));
  }

  const result = await store.logOutreach(alert, { channel: "phone", outcome }, {
    staff_id: alert.assigned_to_staff_id || null,
    name: alert.assigned_to || null,
    via: "one_tap",
  });

  if (result.error) {
    return res.status(500).send(page("Couldn't save that",
      `<p style="margin:0;font-size:15px;color:#3a3a3a;">${esc(result.error)} Please log it in the dashboard.</p>`, "err"));
  }

  const who = alert.member_name || "the member";
  const copy = {
    reached: `Logged. ${who} has been spoken to, and the clock on this alert has stopped.`,
    left_message: `Logged as a message left for ${who}. The alert stays on your list until you speak to them.`,
    no_answer: `Logged as no answer. The alert stays on your list so you get another prompt.`,
  }[outcome];

  // Offer the one thing worth adding, without requiring it. Most people stop
  // here, and that is fine — the timestamp was the part that mattered.
  const noteForm = outcome === "reached" ? `
    <form method="POST" action="/c/${encodeURIComponent(req.params.token)}/note" style="margin-top:20px;">
      <label style="display:block;font-size:12.5px;color:#5B6259;margin-bottom:6px;">How did they sound?</label>
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
        ${recovery.SENTIMENTS.map((s) => `
          <button type="submit" name="member_sentiment" value="${s}"
            style="flex:1;min-width:110px;padding:11px 8px;font-size:13.5px;border:1px solid #E4DFD1;border-radius:7px;background:#fff;color:#16302A;cursor:pointer;">
            ${esc({ recovered: "Happy again", neutral: "Neutral", still_unhappy: "Still unhappy" }[s])}
          </button>`).join("")}
      </div>
      <input type="hidden" name="outreach_id" value="${esc(result.outreach.outreach_id)}">
    </form>` : "";

  res.send(page("Thank you", `
    <p style="margin:0;font-size:15px;line-height:1.55;color:#3a3a3a;">${esc(copy)}</p>
    ${noteForm}`));
});

// POST /c/:token/note — the optional second tap.
router.post("/:token/note", async (req, res) => {
  const { alert } = await store.alertByToken(req.params.token);
  const sentiment = String(req.body?.member_sentiment || "");
  const outreachId = String(req.body?.outreach_id || "");

  if (alert && recovery.SENTIMENTS.includes(sentiment) && outreachId) {
    const { supabase } = require("../lib/supabase");
    await supabase.from("alert_outreach")
      .update({ member_sentiment: sentiment })
      .eq("outreach_id", outreachId)
      .eq("alert_id", alert.alert_id);   // a token only edits its own alert's rows
  }

  res.send(page("Noted", `<p style="margin:0;font-size:15px;line-height:1.55;color:#3a3a3a;">
    That's on the record. Nothing else needed.</p>`));
});

module.exports = router;
