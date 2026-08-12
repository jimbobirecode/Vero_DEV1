// What happened the next time they came in.
//
// A member has a bad visit. Somebody rings them, the case alert is marked
// resolved, and the club's numbers say the recovery worked. But the alert
// being closed only records what the club did — it says nothing about the
// member, who is the only one who can settle it. The evidence is their next
// visit, and until then the club is guessing.
//
// So this pairs each incident with what followed it:
//
//   incident   a survey that scored badly enough to raise an alert, or a case
//              alert raised against them
//   return     their first visit after it
//   verdict    their first survey after it
//
// and grades the outcome. A member stays on the watchlist from the incident
// until that verdict arrives — closing the alert does not clear them, because
// "we called and they seemed fine" is exactly the belief this exists to test.
//
// Everything here is pure and works on plain rows, so the grading can be
// tested without a database.

const { severityFor } = require("./severity");

const DAY = 86400000;

const DEFAULTS = {
  // How long a member stays on the watchlist without returning. Past this they
  // are not a recovery problem any more, they are a retention one — which is
  // lib/member-health.js's job, and duplicating them here would put the same
  // person on two lists with two different recommended actions.
  watchDays: 180,

  // A visit inside this window of the incident is treated as part of the same
  // occasion rather than as a return. Without it, a member who ate in two
  // outlets on the same evening "returned" before anybody could have acted.
  sameTripHours: 36,
};

// Did this response score badly enough to count as an incident?
//
// The same rule that decides whether to raise a case alert, so the watchlist
// and the alerts screen cannot disagree about what a bad visit is.
function isBad(response) {
  if (!response || !response.submitted_at) return false;
  return severityFor({
    nps: response.q1_nps,
    overall: response.q2_overall_stars,
  }) !== null;
}

const at = (v) => (v ? Date.parse(v) : NaN);

// Every incident for one member, newest first.
//
// An alert and the response that caused it are the same event, so an alert
// carrying a response_id is folded into that response rather than listed
// again — otherwise every bad visit would appear on the list twice, once as
// feedback and once as a case.
function incidentsFor({ responses = [], alerts = [] }) {
  const out = [];
  const claimed = new Set();

  for (const a of alerts) {
    if (a.response_id) claimed.add(a.response_id);
    const response = a.response_id
      ? responses.find((r) => r.response_id === a.response_id)
      : null;
    out.push({
      kind: "alert",
      at: a.created_at,
      severity: a.severity || null,
      alert_id: a.alert_id,
      response_id: a.response_id || null,
      outlet_id: a.outlet_id || response?.outlet_id || null,
      // Whether the club closed its own case. Recorded, but deliberately not
      // used to clear the member — see the note at the top.
      alert_resolved: a.status === "resolved" || Boolean(a.resolved_at),
      nps: response?.q1_nps ?? null,
      comment: response?.q5_comment || null,
    });
  }

  for (const r of responses) {
    if (!isBad(r) || claimed.has(r.response_id)) continue;
    out.push({
      kind: "feedback",
      at: r.submitted_at,
      severity: severityFor({ nps: r.q1_nps, overall: r.q2_overall_stars }),
      alert_id: null,
      response_id: r.response_id,
      outlet_id: r.outlet_id || null,
      alert_resolved: null,          // no case was ever opened
      nps: r.q1_nps ?? null,
      comment: r.q5_comment || null,
    });
  }

  return out.sort((a, b) => at(b.at) - at(a.at));
}

// Grade one incident against what came after it.
function outcomeFor(incident, { responses = [], visits = [] }, opts = {}) {
  const { sameTripHours } = { ...DEFAULTS, ...opts };
  const when = at(incident.at);
  const settled = when + sameTripHours * 3600_000;

  // Their first visit that is genuinely a return rather than the rest of the
  // same evening.
  const returnVisit = visits
    .filter((v) => v.visit_date && Date.parse(`${String(v.visit_date).slice(0, 10)}T23:59:59Z`) > settled)
    .sort((a, b) => String(a.visit_date).localeCompare(String(b.visit_date)))[0] || null;

  // Their first survey after it. This is the verdict — the member's own answer
  // to whether it was put right.
  const verdict = responses
    .filter((r) => r.submitted_at && at(r.submitted_at) > settled)
    .sort((a, b) => at(a.submitted_at) - at(b.submitted_at))[0] || null;

  let status;
  if (verdict) status = isBad(verdict) ? "still_unhappy" : "recovered";
  else if (returnVisit) status = "returned_unmeasured";
  else status = "not_returned";

  const daysSince = Math.floor((Date.now() - when) / DAY);

  return {
    status,
    days_since_incident: daysSince,
    returned_on: returnVisit?.visit_date || null,
    days_to_return: returnVisit
      ? Math.max(0, Math.round((Date.parse(`${String(returnVisit.visit_date).slice(0, 10)}T12:00:00Z`) - when) / DAY))
      : null,
    return_outlet_id: returnVisit?.outlet_id || null,
    verdict_on: verdict?.submitted_at || null,
    verdict_nps: verdict?.q1_nps ?? null,
    // The movement the club actually cares about: did their score go up.
    nps_change:
      verdict && Number.isFinite(Number(verdict.q1_nps)) && Number.isFinite(Number(incident.nps))
        ? Number(verdict.q1_nps) - Number(incident.nps)
        : null,
  };
}

// Is this member still one to watch for?
//
// Only while the answer is genuinely unknown. Once they have been back and
// told us how it went, the question is answered either way and keeping them on
// a list of things to do makes the list untrustworthy.
function isOnWatch(outcome, opts = {}) {
  const { watchDays } = { ...DEFAULTS, ...opts };
  if (outcome.days_since_incident > watchDays) return false;
  return outcome.status === "not_returned" || outcome.status === "returned_unmeasured";
}

// One member's standing.
//
// The row shown is their most recent incident and what followed it: a member
// with three bad visits is one person to look after, not three rows, and the
// newest is the one that describes where they actually stand.
//
// But every incident is graded, and the history comes back with it. A member
// who had a bad visit, came back, and had another bad visit is *both* a failed
// recovery and an open case — and reporting only the newest would drop the
// failure from the recovery rate entirely, which is the one number this exists
// to produce. Grading only the latest made the rate read 100% on a member who
// had plainly not been recovered.
function memberStanding(member, data, opts = {}) {
  const incidents = incidentsFor(data);
  if (!incidents.length) return null;

  const history = incidents.map((incident) => ({
    incident,
    ...outcomeFor(incident, data, opts),
  }));

  const latest = history[0];

  return {
    member_id: member.member_id,
    name: [member.first_name, member.last_name].filter(Boolean).join(" ").trim() || member.member_id,
    email: member.email_address || null,
    phone: member.phone_number || null,
    opted_out: Boolean(member.opt_out),
    incident: latest.incident,
    incident_count: incidents.length,
    ...outcomeFor(latest.incident, data, opts),
    on_watch: isOnWatch(latest, opts),
    // Oldest first, so a timeline reads the way it happened.
    history: [...history].reverse(),
  };
}

// The whole club's watchlist, worst first.
//
// Ordered by how long they have been waiting rather than by severity. A
// high-severity case from this morning is already in somebody's hands; the one
// that has been open three weeks is the one nobody picked up.
function buildWatchlist(members, dataByMember, opts = {}) {
  const rows = [];
  for (const m of members) {
    const data = dataByMember[m.member_id];
    if (!data) continue;
    const standing = memberStanding(m, data, opts);
    if (standing) rows.push(standing);
  }

  const waiting = rows.filter((r) => r.on_watch)
    .sort((a, b) => b.days_since_incident - a.days_since_incident);

  const settled = rows.filter((r) => !r.on_watch)
    .sort((a, b) => a.days_since_incident - b.days_since_incident);

  return {
    watching: waiting,
    settled,
    summary: summarise(rows, opts),
  };
}

// Does recovery actually work here?
//
// The number the club is really asking for. Only the settled cases count
// toward it: a member who has not been back yet is not evidence either way,
// and folding them in as a failure would make the rate a measure of how
// recently the incidents happened.
function summarise(rows, opts = {}) {
  const { watchDays } = { ...DEFAULTS, ...opts };

  // Every incident, not one per member. A member given three chances to be
  // recovered contributes three, which is what a rate is measuring.
  const all = rows.flatMap((r) => r.history || []);

  const graded = all.filter((r) => r.status === "recovered" || r.status === "still_unhappy");
  const recovered = graded.filter((r) => r.status === "recovered").length;

  const returns = all.filter((r) => r.days_to_return != null).map((r) => r.days_to_return);
  returns.sort((a, b) => a - b);

  const lapsed = all.filter(
    (r) => r.status === "not_returned" && r.days_since_incident > watchDays
  ).length;

  return {
    incidents: all.length,
    members: rows.length,
    still_watching: rows.filter((r) => r.on_watch).length,
    returned_and_measured: graded.length,
    recovered,
    still_unhappy: graded.length - recovered,
    // Null rather than 0% when nothing has been graded yet — "0% recovered"
    // and "nobody has been back yet" are very different things to show a GM.
    recovery_rate: graded.length ? Math.round((recovered / graded.length) * 1000) / 10 : null,
    median_days_to_return: returns.length
      ? returns[Math.floor(returns.length / 2)]
      : null,
    // Never came back at all, and now past the watch window.
    lapsed_after_incident: lapsed,
  };
}

module.exports = {
  DEFAULTS,
  isBad,
  incidentsFor,
  outcomeFor,
  isOnWatch,
  memberStanding,
  buildWatchlist,
  summarise,
};
