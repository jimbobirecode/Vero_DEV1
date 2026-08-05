const { supabase } = require("./supabase");
const { loadCredentials, trackingSettings } = require("./senders");
const { CLUB_NAME } = require("./club-config");

const CLUB_ID = process.env.CLUB_ID;
const SURVEY_BASE_URL = process.env.SURVEY_BASE_URL || "";

async function sendPlainEmail(to, subject, body, creds) {
  if (!creds.sendgridKey) {
    console.error("Notification email skipped: SENDGRID_API_KEY not configured");
    return false;
  }
  if (!creds.sendgridFrom) {
    console.error("Notification email skipped: SENDGRID_FROM_EMAIL not configured — set it to a verified sender address");
    return false;
  }

  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: creds.sendgridFrom, name: CLUB_NAME },
    subject,
    content: [{ type: "text/plain", value: body }],
    // These go to your own managers, and the only link in them is the one
    // back into the dashboard. This call site was written without any
    // tracking settings, so SendGrid applied the account default and kept
    // rewriting that link through the branded tracking domain — which is why
    // an alert email arrived pointing at url6367.clubvero.io and the link did
    // not work. Internal mail is never click-tracked; there is nothing to
    // learn from it that would justify breaking the link.
    tracking_settings: trackingSettings({ internal: true }),
  };

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.sendgridKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Notification email failed for ${to}: ${errText}`);
    return false;
  }
  return true;
}

async function getManagers() {
  const { data } = await supabase
    .from("staff")
    .select("staff_id, name, email, role")
    .eq("active", true)
    .in("role", ["general_manager", "fb_director"]);
  return (data || []).filter((s) => s.email);
}

async function getStaffById(staffId) {
  const { data } = await supabase
    .from("staff")
    .select("staff_id, name, email, role")
    .eq("staff_id", staffId)
    .maybeSingle();
  return data;
}

async function notifyManagers(subject, body) {
  const creds = await loadCredentials(CLUB_ID);
  const managers = await getManagers();
  const results = [];
  for (const mgr of managers) {
    const ok = await sendPlainEmail(mgr.email, subject, body, creds);
    results.push({ name: mgr.name, email: mgr.email, sent: ok });
  }
  return results;
}

async function notifyStaffMember(staffId, subject, body) {
  const creds = await loadCredentials(CLUB_ID);
  const staff = await getStaffById(staffId);
  if (!staff?.email) return { sent: false, reason: "no email on file" };
  const ok = await sendPlainEmail(staff.email, subject, body, creds);
  return { name: staff.name, sent: ok };
}

function dashboardUrl() {
  return SURVEY_BASE_URL ? SURVEY_BASE_URL.replace(/\/+$/, "") : "";
}

module.exports = {
  notifyManagers,
  notifyStaffMember,
  getManagers,
  getStaffById,
  dashboardUrl,
};
