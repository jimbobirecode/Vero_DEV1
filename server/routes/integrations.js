const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabase");
const { createSecret } = require("../lib/vault");

// POST /api/integrations/save
// Body: { club_id, provider: 'sendly'|'sendgrid', ...fields }
router.post("/save", async (req, res) => {
  const body = req.body;
  if (!body.club_id || !body.provider) {
    return res.status(400).json({ error: "club_id and provider are required" });
  }

  try {
    if (body.provider === "sendly") {
      if (!body.sendly_api_key) {
        return res.status(400).json({ error: "Missing Sendly API key" });
      }
      const secretId = await createSecret(body.sendly_api_key, `sendly_api_key_${body.club_id}`);
      const update = {
        club_id: body.club_id,
        sendly_api_key_secret_id: secretId,
        updated_at: new Date().toISOString(),
      };
      if (body.sendly_from_number) update.sendly_from_number = body.sendly_from_number;
      const { error } = await supabase.from("club_integrations").upsert(update);
      if (error) throw error;
    }

    if (body.provider === "sendgrid") {
      if (!body.sendgrid_api_key || !body.sendgrid_from_email) {
        return res.status(400).json({ error: "Missing SendGrid fields" });
      }
      const secretId = await createSecret(body.sendgrid_api_key, `sendgrid_api_key_${body.club_id}`);
      const { error } = await supabase.from("club_integrations").upsert({
        club_id: body.club_id,
        sendgrid_api_key_secret_id: secretId,
        sendgrid_from_email: body.sendgrid_from_email,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
    }

    res.json({ saved: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/integrations/status?club_id=...
router.get("/status", async (req, res) => {
  const { club_id } = req.query;
  if (!club_id) return res.status(400).json({ error: "club_id is required" });

  const { data } = await supabase
    .from("club_integrations")
    .select("sendly_api_key_secret_id, sendly_from_number, sendgrid_from_email, sendgrid_api_key_secret_id")
    .eq("club_id", club_id)
    .maybeSingle();

  res.json({
    sendly: {
      connected: Boolean(data?.sendly_api_key_secret_id),
      from_number: data?.sendly_from_number ?? null,
    },
    sendgrid: {
      connected: Boolean(data?.sendgrid_api_key_secret_id),
      from_email: data?.sendgrid_from_email ?? null,
    },
  });
});

// POST /api/integrations/test  { club_id, provider, to }
router.post("/test", async (req, res) => {
  const { club_id, provider, to } = req.body;
  if (!club_id || !provider || !to) {
    return res.status(400).json({ error: "club_id, provider, and a destination (to) are required" });
  }

  const { sendSms, sendEmail } = require("../lib/senders");
  const { loadCredentials } = require("../lib/senders");

  try {
    const creds = await loadCredentials(club_id);
    if (provider === "sendly") {
      await sendSms(to, "This is a test message from Vero. Your Sendly integration is working.", creds, null, { kind: "integration_test" });
    } else if (provider === "sendgrid") {
      await sendEmail(to, "Vero test email", "This is a test message from Vero. Your SendGrid integration is working.", creds);
    } else {
      return res.status(400).json({ error: "provider must be sendly or sendgrid" });
    }
    res.json({ sent: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

module.exports = router;
