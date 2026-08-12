// Reading the club's history into the shape lib/member-watch.js grades.
//
// Split from the grading for the usual reason: the rules are worth testing and
// a database is not worth mocking to test them. This half is the boring half —
// four queries and a group-by — but it carries two decisions that matter.
//
// First, responses have no member_id. They hang off a visit, and the visit
// knows who came. So a member's feedback can only be found through their
// visits, and a response whose visit has no member on it belongs to a guest,
// who has no next visit to track.
//
// Second, the window has to cover the incident AND everything after it. Load
// 90 days and a member whose bad visit was in March is graded against an empty
// April, which reads as "never came back" for somebody who has been in
// weekly. The window is the watch window, and both ends come from it.

const { supabase } = require("./supabase");
const watch = require("./member-watch");

const DAY = 86400000;
const dayString = (ms) => new Date(ms).toISOString().slice(0, 10);

const empty = (days, since) => ({ members: [], dataByMember: {}, window_days: days, since });

// Everything the grading needs, keyed by member.
//
// Returns { members, dataByMember, counts } — members being only those with at
// least one incident, because the rest have nothing to grade and pulling the
// whole roster to throw it away is the difference between one query and a
// membership-sized one.
async function loadWatchData({ days = watch.DEFAULTS.watchDays, memberIds = null } = {}) {
  const since = dayString(Date.now() - days * DAY);
  const sinceTs = new Date(Date.now() - days * DAY).toISOString();

  let visitQuery = supabase
    .from("visits")
    .select("visit_id, member_id, visit_date, outlet_id")
    .not("member_id", "is", null)
    .gte("visit_date", since)
    .limit(100000);
  if (memberIds) visitQuery = visitQuery.in("member_id", memberIds);

  const { data: visits, error: visitErr } = await visitQuery;
  if (visitErr) return { error: visitErr.message };

  const memberOfVisit = new Map();
  const outletOfVisit = new Map();
  for (const v of visits || []) {
    memberOfVisit.set(v.visit_id, v.member_id);
    if (v.outlet_id) outletOfVisit.set(v.visit_id, v.outlet_id);
  }

  // Responses come back through the visit. Anything whose visit is not in the
  // set above is a guest's, or older than the window, and is dropped.
  //
  // Asking for one member reads only their visits' responses; asking for the
  // club reads the window and filters. The first matters because the per-member
  // lookup runs on the Visits screen every time somebody is checked in.
  let respQuery = supabase
    .from("survey_responses")
    .select("response_id, visit_id, submitted_at, q1_nps, q2_overall_stars, q5_comment")
    .not("submitted_at", "is", null)
    .gte("submitted_at", sinceTs)
    .limit(100000);
  if (memberIds) {
    if (!memberOfVisit.size) return empty(days, since);
    respQuery = respQuery.in("visit_id", [...memberOfVisit.keys()]);
  }
  const { data: responses, error: respErr } = await respQuery;
  if (respErr) return { error: respErr.message };

  const mine = (responses || []).filter((r) => memberOfVisit.has(r.visit_id));
  const visitOfResponse = new Map(mine.map((r) => [r.response_id, r.visit_id]));

  // Alerts are matched to the member the same way — through the response,
  // through the visit. An alert whose response is outside the window is not
  // this period's problem.
  let alertQuery = supabase
    .from("case_alerts")
    .select("alert_id, response_id, outlet_id, severity, status, created_at, resolved_at")
    .gte("created_at", sinceTs)
    .limit(100000);
  if (memberIds) {
    if (!visitOfResponse.size) alertQuery = null;
    else alertQuery = alertQuery.in("response_id", [...visitOfResponse.keys()]);
  }
  const { data: alerts, error: alertErr } = alertQuery
    ? await alertQuery
    : { data: [], error: null };
  if (alertErr) return { error: alertErr.message };

  const byMember = new Map();
  const bucket = (id) => {
    let b = byMember.get(id);
    if (!b) { b = { responses: [], alerts: [], visits: [] }; byMember.set(id, b); }
    return b;
  };

  for (const v of visits || []) bucket(v.member_id).visits.push(v);
  for (const r of mine) {
    bucket(memberOfVisit.get(r.visit_id)).responses.push({
      ...r,
      outlet_id: outletOfVisit.get(r.visit_id) || null,
    });
  }
  for (const a of alerts || []) {
    const visitId = a.response_id ? visitOfResponse.get(a.response_id) : null;
    // An alert with no response behind it — raised by hand, or against a
    // response outside the window — has nobody to attach it to here.
    if (!visitId) continue;
    bucket(memberOfVisit.get(visitId)).alerts.push(a);
  }

  // Only the members with something to grade. incidentsFor is cheap and pure,
  // so asking it directly beats naming a second rule for what counts.
  const withIncidents = [];
  for (const [memberId, data] of byMember) {
    if (watch.incidentsFor(data).length) withIncidents.push(memberId);
  }

  const dataByMember = {};
  for (const id of withIncidents) dataByMember[id] = byMember.get(id);

  let members = [];
  if (withIncidents.length) {
    // Chunked: a busy club can exceed what a single .in() will carry in a URL.
    for (let i = 0; i < withIncidents.length; i += 200) {
      const { data, error } = await supabase
        .from("members")
        .select("member_id, first_name, last_name, phone_number, email_address, opt_out")
        .in("member_id", withIncidents.slice(i, i + 200));
      if (error) return { error: error.message };
      members.push(...(data || []));
    }
  }

  // A member since removed from the roster still has history, and their row
  // should say so rather than vanishing — a call list that silently drops
  // people is how a club stops trusting it.
  const known = new Set(members.map((m) => m.member_id));
  for (const id of withIncidents) {
    if (!known.has(id)) members.push({ member_id: id, off_roster: true });
  }

  return {
    members,
    dataByMember,
    window_days: days,
    since,
  };
}

// The club's watchlist.
async function watchlist(opts = {}) {
  const loaded = await loadWatchData(opts);
  if (loaded.error) return loaded;
  const list = watch.buildWatchlist(loaded.members, loaded.dataByMember, opts);
  return { ...list, window_days: loaded.window_days, since: loaded.since };
}

// One member's standing and their whole timeline. Used when a name is opened
// from the list, and — the point of the feature — when they turn up again.
async function standingFor(memberId, opts = {}) {
  const loaded = await loadWatchData({ ...opts, memberIds: [memberId] });
  if (loaded.error) return loaded;
  const member = loaded.members.find((m) => m.member_id === memberId);
  if (!member) return { standing: null };
  return {
    standing: watch.memberStanding(member, loaded.dataByMember[memberId], opts),
    window_days: loaded.window_days,
  };
}

module.exports = { loadWatchData, watchlist, standingFor };
