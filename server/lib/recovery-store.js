// Database work for service recovery.
//
// Split from lib/recovery.js so the rules stay pure and testable, and split
// from the routes because three callers need the same writes: the dashboard,
// the one-tap link in an escalation email, and the hourly sweep. Logging a
// call must do exactly the same thing whichever door it comes through, or the
// numbers stop agreeing with each other.

const crypto = require("crypto");
const { supabase } = require("./supabase");
const recovery = require("./recovery");

// The columns and table this feature needs. Everything degrades to a clear
// "run the migration" rather than half-working, because a recovery metric
// computed against missing columns is worse than no metric.
let readyCache = null;

async function recoveryReady() {
  if (readyCache !== null) return readyCache;

  const [{ error: colErr }, { error: tblErr }] = await Promise.all([
    supabase.from("case_alerts").select("contact_due_at").limit(1),
    supabase.from("alert_outreach").select("outreach_id").limit(1),
  ]);

  const missing = [];
  if (colErr && /contact_due_at|column/i.test(colErr.message || "")) missing.push("case_alerts recovery columns");
  if (tblErr && /alert_outreach|relation|does not exist/i.test(tblErr.message || "")) missing.push("alert_outreach");

  readyCache = missing.length
    ? { ok: false, missing, error: `Service recovery needs migrations/service-recovery.sql to be run — missing: ${missing.join(", ")}.` }
    : { ok: true };
  return readyCache;
}

// Exposed so a test or a deploy check can force a re-probe after migrating.
function resetReadyCache() { readyCache = null; }

async function loadSlaSettings() {
  const { data } = await supabase
    .from("club_settings")
    .select("key, value")
    .like("key", "recovery_sla_%");
  return Object.fromEntries((data || []).map((r) => [r.key, r.value]));
}

const ALERT_FIELDS =
  "alert_id, response_id, outlet_id, severity, status, assigned_to, assigned_to_staff_id, created_at, resolved_at, " +
  "contact_due_at, first_contact_at, first_reached_at, outreach_count, no_contact_reason, recovery_token, escalated_stage, escalated_at";

const ALERT_WITH_MEMBER =
  `${ALERT_FIELDS}, outlets(name), ` +
  "survey_responses(q1_nps, q2_overall_stars, q5_comment, submitted_at, " +
  "visits(visit_date, member_id, guest_name, members(first_name, last_name, phone_number, email_address)))";

// Flattens the nested join into the shape lib/recovery.js expects, so the
// rules never have to know how the query was written.
function shapeAlert(row) {
  if (!row) return null;
  const sr = row.survey_responses || {};
  const visit = sr.visits || {};
  const member = visit.members || null;
  return {
    ...row,
    member_id: visit.member_id || null,
    member_name: member ? `${member.first_name} ${member.last_name}` : (visit.guest_name || null),
    member_phone: member?.phone_number || null,
    member_email: member?.email_address || null,
    outlet_name: row.outlets?.name || null,
    alert_nps: sr.q1_nps ?? null,
    alert_stars: sr.q2_overall_stars ?? null,
    comment: sr.q5_comment || null,
    visit_date: visit.visit_date || null,
  };
}

async function alertForRecovery(alertId) {
  const { data, error } = await supabase
    .from("case_alerts").select(ALERT_WITH_MEMBER).eq("alert_id", alertId).maybeSingle();
  if (error) return { error: error.message };
  return { alert: shapeAlert(data) };
}

async function alertByToken(token) {
  const { data, error } = await supabase
    .from("case_alerts").select(ALERT_WITH_MEMBER).eq("recovery_token", token).maybeSingle();
  if (error) return { error: error.message };
  return { alert: shapeAlert(data) };
}

// Alerts raised before this shipped have no clock. Rather than a one-off
// backfill that goes stale, fill it in the first time we look at one.
async function ensureDueDate(alert, settings) {
  if (alert.contact_due_at || alert.status === "resolved") return alert;
  const due = recovery.contactDueAt(alert.created_at, alert.severity, settings);
  if (!due) return alert;
  await supabase.from("case_alerts").update({ contact_due_at: due }).eq("alert_id", alert.alert_id);
  return { ...alert, contact_due_at: due };
}

async function ensureRecoveryToken(alertId, existing) {
  if (existing) return existing;
  const token = crypto.randomUUID();
  const { error } = await supabase
    .from("case_alerts").update({ recovery_token: token }).eq("alert_id", alertId);
  if (error) return null;
  return token;
}

// Records one attempt to reach the member and moves the alert on.
//
// `actor` is { staff_id, name, via } — who logged it and through which door.
// Returns { outreach, alert } with the alert as it now stands, or { error }.
async function logOutreach(alert, body, actor = {}) {
  const valid = recovery.validateOutreach(body);
  if (!valid.ok) return { error: valid.errors.join("; "), status: 400 };

  const row = {
    alert_id: alert.alert_id,
    member_id: alert.member_id || null,
    channel: body.channel,
    outcome: body.outcome,
    member_sentiment: body.member_sentiment || null,
    notes: body.notes ? String(body.notes).slice(0, 2000) : null,
    occurred_at: valid.occurredAt,
    logged_by: actor.staff_id || null,
    logged_by_name: actor.name || null,
    logged_via: actor.via || "dashboard",
  };

  const { data: outreach, error } = await supabase
    .from("alert_outreach").insert(row).select().single();
  if (error) return { error: error.message, status: 500 };

  // The alert's own bookkeeping. Written after the outreach row so a failure
  // here leaves a recorded call with a stale alert — recoverable — rather than
  // an alert claiming contact that has no call behind it.
  const patch = recovery.alertPatchForOutreach(alert, { ...row, occurred_at: valid.occurredAt });
  if (Object.keys(patch).length) {
    const { error: updErr } = await supabase
      .from("case_alerts").update(patch).eq("alert_id", alert.alert_id);
    if (updErr) return { outreach, alert, warning: `Call logged, but the alert did not update: ${updErr.message}` };
  }

  return { outreach, alert: { ...alert, ...patch } };
}

async function outreachFor(alertId) {
  const { data } = await supabase
    .from("alert_outreach")
    .select("*")
    .eq("alert_id", alertId)
    .order("occurred_at", { ascending: true });
  return data || [];
}

// For the recovery rate: the NPS each member gave on their first survey
// submitted *after* the alert that named them. Anything earlier is the score
// that caused the alert, not evidence of recovery.
async function followUpScores(alerts) {
  const targets = alerts.filter((a) => a.member_id && a.first_reached_at);
  if (!targets.length) return new Map();

  const earliest = targets.reduce(
    (min, a) => (a.created_at < min ? a.created_at : min), targets[0].created_at);

  const { data } = await supabase
    .from("survey_responses")
    .select("q1_nps, submitted_at, visits(member_id)")
    .not("submitted_at", "is", null)
    .not("q1_nps", "is", null)
    .gte("submitted_at", earliest)
    .order("submitted_at", { ascending: true });

  const byMember = new Map();
  for (const r of data || []) {
    const memberId = r.visits?.member_id;
    if (!memberId) continue;
    if (!byMember.has(memberId)) byMember.set(memberId, []);
    byMember.get(memberId).push(r);
  }

  const out = new Map();
  for (const a of targets) {
    const responses = byMember.get(a.member_id) || [];
    const next = responses.find((r) => r.submitted_at > a.first_reached_at);
    if (next) out.set(a.member_id, next.q1_nps);
  }
  return out;
}

module.exports = {
  recoveryReady, resetReadyCache, loadSlaSettings,
  alertForRecovery, alertByToken, ensureDueDate, ensureRecoveryToken,
  logOutreach, outreachFor, followUpScores,
  shapeAlert, ALERT_FIELDS, ALERT_WITH_MEMBER,
};
