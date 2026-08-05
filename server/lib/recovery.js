// Service recovery: the rules for closing a case alert back to the member.
//
// Everything here is pure. The database work lives in routes/alerts.js and the
// hourly sweep; this file decides what the numbers mean, so the definitions
// can be tested and cannot drift between the queue, the escalation email and
// the stats panel — three places that have to agree or the metric is a lie.

const MINUTE = 60 * 1000;

// How long the club has to reach the member, by severity. Overridable per club
// from club_settings; these are the defaults the migration seeds.
const SLA_DEFAULTS = { high: 1440, medium: 4320, low: 10080 };

const CHANNELS = ["phone", "in_person", "sms", "email", "letter"];
const OUTCOMES = ["reached", "left_message", "no_answer", "declined", "wrong_number"];
const SENTIMENTS = ["recovered", "neutral", "still_unhappy"];

// Resolving without contacting the member has to be a deliberate choice, so
// the reasons are a closed list rather than free text — free text becomes
// "n/a" on every row within a week and the metric stops meaning anything.
const NO_CONTACT_REASONS = {
  member_declined: "Member asked not to be contacted",
  already_handled: "Already handled in person at the time",
  not_member_specific: "Not about a specific member's experience",
  no_contact_details: "No phone or email on file",
  duplicate: "Duplicate of another alert",
};

// Only 'reached' means a conversation happened. The others are attempts, and
// the distinction matters: a club that leaves 40 voicemails has not recovered
// 40 members, and a metric that says it has will be believed once and then
// never again.
function isConnected(outcome) {
  return outcome === "reached";
}

// Every outcome except a wrong number is a genuine attempt, and attempts are
// what the SLA clock measures — a manager who rings within the hour and gets
// no answer has done the thing the promise is about. A wrong number means the
// club never actually reached out to the right person.
function isAttempt(outcome) {
  return OUTCOMES.includes(outcome) && outcome !== "wrong_number";
}

function slaMinutes(severity, settings = {}) {
  const key = `recovery_sla_${severity}_minutes`;
  const raw = parseInt(settings[key], 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return SLA_DEFAULTS[severity] ?? SLA_DEFAULTS.low;
}

function contactDueAt(createdAt, severity, settings = {}) {
  const start = new Date(createdAt).getTime();
  if (!Number.isFinite(start)) return null;
  return new Date(start + slaMinutes(severity, settings) * MINUTE).toISOString();
}

// Where an alert stands against its clock.
//
//   contacted  somebody has reached out; the clock has stopped
//   waiting    inside the window, under half elapsed
//   due        past half the window
//   urgent     past 90% of the window
//   breached   the window closed with no contact
//
// `met` on a contacted alert records whether that contact landed inside the
// window, which is what the headline percentage counts.
function slaState(alert, now = Date.now()) {
  const due = alert.contact_due_at ? new Date(alert.contact_due_at).getTime() : null;
  const created = alert.created_at ? new Date(alert.created_at).getTime() : null;
  const contacted = alert.first_contact_at ? new Date(alert.first_contact_at).getTime() : null;
  const at = typeof now === "number" ? now : new Date(now).getTime();

  if (contacted) {
    return {
      state: "contacted",
      met: due ? contacted <= due : null,
      contacted_at: alert.first_contact_at,
      ms_to_contact: created ? contacted - created : null,
      ms_remaining: null,
      pct_elapsed: 1,
    };
  }

  // No clock: an alert raised before this shipped, or one whose severity was
  // never set. Reported as unscheduled rather than silently counted as met.
  if (!due || !created) {
    return { state: "unscheduled", met: null, ms_remaining: null, pct_elapsed: null };
  }

  const total = due - created;
  const elapsed = at - created;
  const pct = total > 0 ? elapsed / total : 1;

  let state = "waiting";
  if (at > due) state = "breached";
  else if (pct >= 0.9) state = "urgent";
  else if (pct >= 0.5) state = "due";

  return { state, met: null, ms_remaining: due - at, pct_elapsed: Math.max(0, Math.min(pct, 1)) };
}

// Which nudge, if any, this alert has newly earned. Returns null when nothing
// is owed or when the stage has already been sent — the sweep runs hourly and
// must not re-send the same escalation every pass.
const STAGE_ORDER = ["half", "final", "breached"];

function escalationStage(alert, now = Date.now()) {
  if (alert.first_contact_at) return null;
  if (alert.status === "resolved") return null;

  const { state } = slaState(alert, now);
  const earned =
    state === "breached" ? "breached" :
    state === "urgent" ? "final" :
    state === "due" ? "half" : null;

  if (!earned) return null;

  const sent = alert.escalated_stage;
  if (sent && STAGE_ORDER.indexOf(sent) >= STAGE_ORDER.indexOf(earned)) return null;
  return earned;
}

// Resolution rules. An alert may be resolved once the member has been
// contacted, or with an explicit reason why they were not. Blocking outright
// would just teach people to log a fake call, so the escape hatch stays — it
// is simply recorded and reported rather than being the silent default.
function canResolve(alert, { noContactReason } = {}) {
  if (alert.first_contact_at) return { ok: true };
  if (noContactReason && NO_CONTACT_REASONS[noContactReason]) return { ok: true, noContactReason };
  return {
    ok: false,
    error: "This alert hasn't been closed back to the member. Log the call, or say why no contact was made.",
    reasons: NO_CONTACT_REASONS,
  };
}

function validateOutreach(body = {}) {
  const errors = [];
  if (!CHANNELS.includes(body.channel)) errors.push(`channel must be one of: ${CHANNELS.join(", ")}`);
  if (!OUTCOMES.includes(body.outcome)) errors.push(`outcome must be one of: ${OUTCOMES.join(", ")}`);
  if (body.member_sentiment && !SENTIMENTS.includes(body.member_sentiment)) {
    errors.push(`member_sentiment must be one of: ${SENTIMENTS.join(", ")}`);
  }
  // Sentiment is a read of how somebody sounded. Recording one for a call that
  // never connected is not a judgement anybody made.
  if (body.member_sentiment && !isConnected(body.outcome)) {
    errors.push("member_sentiment only applies when the outcome is 'reached'");
  }
  if (body.notes && String(body.notes).length > 2000) errors.push("notes must be 2000 characters or fewer");

  const occurredAt = body.occurred_at ? new Date(body.occurred_at) : new Date();
  if (Number.isNaN(occurredAt.getTime())) errors.push("occurred_at is not a valid date");
  // A call cannot have happened tomorrow. Allow a few minutes for clock skew
  // between a manager's phone and the server.
  else if (occurredAt.getTime() > Date.now() + 5 * MINUTE) errors.push("occurred_at is in the future");

  return { ok: !errors.length, errors, occurredAt: occurredAt.toISOString() };
}

// What logging this outreach changes on the alert itself. Kept here so the
// dashboard route and the one-tap route cannot disagree about it.
function alertPatchForOutreach(alert, outreach) {
  const patch = { outreach_count: (alert.outreach_count || 0) + 1 };

  if (isAttempt(outreach.outcome) && !alert.first_contact_at) {
    patch.first_contact_at = outreach.occurred_at;
    // Contact does not close the case — the internal fix may still be open —
    // but it does move it out of the queue of members nobody has spoken to.
    if (alert.status === "open" || alert.status === "assigned") patch.status = "contacted";
  }
  if (isConnected(outreach.outcome) && !alert.first_reached_at) {
    patch.first_reached_at = outreach.occurred_at;
  }
  return patch;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

// The three numbers a GM repeats to another GM.
//
// `alerts` are the alerts in the period. `followUps` maps member_id to the NPS
// they gave on their next survey after the alert, where there was one — the
// route supplies it, because only it can query.
function recoveryMetrics(alerts = [], followUps = new Map(), now = Date.now()) {
  // An alert nobody could have contacted — no clock, or no member behind it —
  // is not a recovery failure, and counting it as one makes the headline
  // number describe data quality rather than service.
  const inScope = alerts.filter((a) => a.contact_due_at && a.created_at);
  const contactable = inScope.filter((a) => !a.no_contact_reason);

  const contacted = contactable.filter((a) => a.first_contact_at);
  const withinSla = contacted.filter((a) => slaState(a, now).met === true);

  const timesToContact = contacted
    .map((a) => new Date(a.first_contact_at).getTime() - new Date(a.created_at).getTime())
    .filter((ms) => Number.isFinite(ms) && ms >= 0);

  // Recovery rate: of the members somebody actually spoke to, how many scored
  // higher next time. This is the only claim here that is about the member's
  // experience rather than the club's process, which is what makes it the one
  // worth quoting.
  const reached = contactable.filter((a) => a.first_reached_at && a.member_id);
  let improved = 0;
  let measurable = 0;
  for (const a of reached) {
    const next = followUps.get(a.member_id);
    if (next == null || a.alert_nps == null) continue;
    measurable++;
    if (next > a.alert_nps) improved++;
  }

  const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);

  return {
    alerts_in_scope: inScope.length,
    excluded_no_contact: inScope.length - contactable.length,
    contacted: contacted.length,
    contacted_within_sla: withinSla.length,
    pct_contacted_within_sla: pct(withinSla.length, contactable.length),
    pct_contacted: pct(contacted.length, contactable.length),
    median_ms_to_contact: median(timesToContact),
    median_hours_to_contact: timesToContact.length
      ? Math.round((median(timesToContact) / 3600000) * 10) / 10
      : null,
    reached: reached.length,
    recovery_measurable: measurable,
    recovery_improved: improved,
    // Null rather than 0 when nobody has come back yet: "0% recovered" and
    // "nobody has returned yet" are very different things to show a GM.
    pct_recovered: pct(improved, measurable),
    awaiting_contact: contactable.filter((a) => !a.first_contact_at && a.status !== "resolved").length,
    breached: contactable.filter((a) => !a.first_contact_at && slaState(a, now).state === "breached").length,
  };
}

// Sort key for the queue: the member closest to being let down comes first.
// Breached alerts stay at the top rather than dropping off, because an
// overdue call is more urgent than one that is merely due, not less.
function queueRank(alert, now = Date.now()) {
  const s = slaState(alert, now);
  if (s.state === "contacted") return Number.MAX_SAFE_INTEGER;
  if (s.state === "unscheduled") return Number.MAX_SAFE_INTEGER - 1;
  return s.ms_remaining;
}

function formatRemaining(ms) {
  if (ms == null) return "";
  const overdue = ms < 0;
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  const text = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h >= 1 ? `${h}h ${m}m` : `${m}m`;
  return overdue ? `${text} overdue` : `${text} left`;
}

module.exports = {
  SLA_DEFAULTS, CHANNELS, OUTCOMES, SENTIMENTS, NO_CONTACT_REASONS,
  isConnected, isAttempt, slaMinutes, contactDueAt, slaState, escalationStage,
  canResolve, validateOutreach, alertPatchForOutreach, recoveryMetrics,
  queueRank, formatRemaining,
};
