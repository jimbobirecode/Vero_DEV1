// Audit trail for access to personal data and for privileged changes.
//
// Records who did what, when, and from where. Writes are best-effort and never
// block or fail the request they describe — a logging outage must not take the
// dashboard down — but every failure is reported to the server log so a silent
// gap in the trail is noticeable.

const { supabase } = require("./supabase");

// Categories a reviewer will ask about: who read member data, who exported it,
// who changed access, who sent messages to members.
const ACTIONS = {
  MEMBER_LIST_VIEWED: "member_list_viewed",
  MEMBER_EXPORTED: "member_exported",
  MEMBER_IMPORTED: "member_imported",
  MEMBER_UPDATED: "member_updated",
  MEMBER_DELETED: "member_deleted",
  // A roster import assigns roles, so it changes who can reach member data —
  // recorded under its own action rather than folded in with member imports.
  STAFF_IMPORTED: "staff_imported",
  USER_CREATED: "user_created",
  USER_DELETED: "user_deleted",
  PASSWORD_RESET: "password_reset",
  ROLE_CHANGED: "role_changed",
  SURVEY_SENT: "survey_sent",
  SETTINGS_CHANGED: "settings_changed",
  LOGIN: "login",
  // SMS credit. A manual adjustment moves money without Stripe having anything
  // to say about it, so it belongs in the same trail as role changes rather
  // than in a server log nobody reads.
  SMS_TOPUP_STARTED: "sms_topup_started",
  SMS_CREDIT_ADJUSTED: "sms_credit_adjusted",
  SMS_CREDIT_SETTINGS_CHANGED: "sms_credit_settings_changed",
  // An export leaves the building — a spreadsheet of member scores lands in
  // someone's inbox and is out of our control from there, so who took one and
  // for what period belongs in the same trail as who read the member list.
  REPORT_EXPORTED: "report_exported",
  // Who was made responsible for a training plan, and by whom. "Nobody told me
  // it was mine" is the argument this settles, and the plan itself only ever
  // shows the current owner.
  TRAINING_ASSIGNED: "training_assigned",
};

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.ip || null;
}

// record(req, action, details?) — details should describe scope (how many
// records, which entity) and must never contain the personal data itself.
async function record(req, action, details = {}) {
  const entry = {
    action,
    actor_staff_id: req.user?.staff_id || null,
    actor_email: req.user?.email || null,
    actor_role: req.user?.role || null,
    ip_address: clientIp(req),
    user_agent: (req.headers["user-agent"] || "").slice(0, 300) || null,
    details,
    created_at: new Date().toISOString(),
  };

  try {
    const { error } = await supabase.from("audit_log").insert(entry);
    if (error) console.error("[audit] could not write entry:", action, error.message);
  } catch (e) {
    console.error("[audit] could not write entry:", action, String(e));
  }
}

// Fire-and-forget wrapper for use inside request handlers.
function log(req, action, details) {
  record(req, action, details).catch(() => {});
}

// Middleware that logs a successful read of a collection, with the row count
// taken from the response body so the trail shows how much was exposed.
function auditRead(action, countFrom) {
  return (req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        let count = null;
        try {
          const target = countFrom ? body?.[countFrom] : body;
          if (Array.isArray(target)) count = target.length;
        } catch { /* count is advisory */ }
        log(req, action, { record_count: count, query: req.query?.q ? "search" : "all" });
      }
      return json(body);
    };
    next();
  };
}

module.exports = { log, record, auditRead, ACTIONS };
