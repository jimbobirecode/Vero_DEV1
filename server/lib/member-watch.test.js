// Tracking a member from a bad visit to their next one.
//
// The thing worth getting right is what counts as an answer. A closed case
// alert is the club saying it dealt with something; a member coming back and
// rating the visit well is the member saying so. Only the second settles it,
// and a watchlist that clears on the first is a watchlist that quietly stops
// finding anybody.
process.env.SUPABASE_URL = "https://p";
process.env.SUPABASE_SERVICE_ROLE_KEY = "s";

const w = require("./member-watch.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const dayAgo = (d) => ago(d).slice(0, 10);

const member = { member_id: "R100", first_name: "Somchai", last_name: "Srisuk", email_address: "s@x.invalid" };

// --- what counts as a bad visit ---------------------------------------
// The same rule the alerts screen uses, so the two cannot disagree.
eq("one star is an incident", w.isBad({ submitted_at: ago(1), q2_overall_stars: 1 }), true);
eq("a detractor is an incident", w.isBad({ submitted_at: ago(1), q1_nps: 3 }), true);
eq("a passive is not", w.isBad({ submitted_at: ago(1), q1_nps: 8, q2_overall_stars: 4 }), false);
eq("a promoter is not", w.isBad({ submitted_at: ago(1), q1_nps: 10, q2_overall_stars: 5 }), false);
eq("an unsubmitted response is not an incident", w.isBad({ q1_nps: 1 }), false);
eq("nothing at all is not an incident", w.isBad(null), false);

// --- an alert and the survey that caused it are one event --------------
{
  const responses = [{ response_id: "r1", submitted_at: ago(30), q1_nps: 2, q2_overall_stars: 1 }];
  const alerts = [{ alert_id: "a1", response_id: "r1", created_at: ago(30), severity: "high", status: "resolved" }];
  const list = w.incidentsFor({ responses, alerts });
  eq("the bad survey and its alert are one incident, not two", list.length, 1);
  eq("and it is recorded as the case", list[0].kind, "alert");
  eq("carrying the score that caused it", list[0].nps, 2);
  eq("and whether the club closed its own case", list[0].alert_resolved, true);
}

// Feedback that never became a case still counts — plenty of bad visits sit
// under the alert threshold for severity but above nothing.
{
  const list = w.incidentsFor({
    responses: [{ response_id: "r1", submitted_at: ago(5), q1_nps: 5 }],
    alerts: [],
  });
  eq("bad feedback with no case raised is still an incident", list.length, 1);
  eq("marked as feedback", list[0].kind, "feedback");
  eq("with no case to have resolved", list[0].alert_resolved, null);
}

// --- the four outcomes -------------------------------------------------
const incident = { at: ago(30), nps: 2 };

{
  const o = w.outcomeFor(incident, { responses: [], visits: [] });
  eq("no visit since: not returned", o.status, "not_returned");
  eq("nothing to report on the return", [o.returned_on, o.verdict_on], [null, null]);
  eq("and they are on the watchlist", w.isOnWatch(o), true);
}
{
  const o = w.outcomeFor(incident, { responses: [], visits: [{ visit_date: dayAgo(10), outlet_id: "o1" }] });
  eq("came back but was not surveyed", o.status, "returned_unmeasured");
  eq("the return is dated", o.returned_on, dayAgo(10));
  eq("and about twenty days after the incident", o.days_to_return, 20);
  eq("still on the watchlist — nobody has heard from them",
    w.isOnWatch(o), true);
}
{
  const o = w.outcomeFor(incident, {
    responses: [{ submitted_at: ago(9), q1_nps: 9 }],
    visits: [{ visit_date: dayAgo(10) }],
  });
  eq("came back and rated it well: recovered", o.status, "recovered");
  eq("the movement is recorded", o.nps_change, 7);
  eq("and they come off the watchlist", w.isOnWatch(o), false);
}
{
  const o = w.outcomeFor(incident, {
    responses: [{ submitted_at: ago(9), q1_nps: 3 }],
    visits: [{ visit_date: dayAgo(10) }],
  });
  eq("came back and it was bad again: still unhappy", o.status, "still_unhappy");
  eq("the movement is recorded even when it is small", o.nps_change, 1);
  eq("and they come off the watchlist — the question is answered",
    w.isOnWatch(o), false);
}

// --- the same evening is not a return ----------------------------------
//
// A member who ate in two outlets on one night has not "come back", and
// treating it as a return means the club is judged on a visit nobody could
// have acted on.
{
  const o = w.outcomeFor(
    { at: ago(10), nps: 2 },
    { responses: [], visits: [{ visit_date: dayAgo(10) }] }
  );
  eq("a visit the same day is not a return", o.status, "not_returned");
}
{
  const o = w.outcomeFor(
    { at: ago(10), nps: 2 },
    { responses: [], visits: [{ visit_date: dayAgo(8) }] }
  );
  eq("two days later is", o.status, "returned_unmeasured");
}

// --- a closed case does not clear the member ---------------------------
//
// This is the whole point. The club ringing somebody and closing the case is
// the club's own account of it; the member's next visit is the evidence.
{
  const standing = w.memberStanding(member, {
    responses: [{ response_id: "r1", submitted_at: ago(20), q1_nps: 1, q2_overall_stars: 1 }],
    alerts: [{ alert_id: "a1", response_id: "r1", created_at: ago(20), status: "resolved", resolved_at: ago(19) }],
    visits: [],
  });
  eq("a resolved case still leaves them on the watchlist", standing.on_watch, true);
  eq("because they have not been back", standing.status, "not_returned");
  eq("the club's own case is shown as closed", standing.incident.alert_resolved, true);
}

// --- one member, one row ------------------------------------------------
{
  const standing = w.memberStanding(member, {
    responses: [
      { response_id: "r1", submitted_at: ago(120), q1_nps: 2 },
      { response_id: "r2", submitted_at: ago(40),  q1_nps: 1 },
    ],
    alerts: [],
    visits: [],
  });
  eq("three bad visits are one person to look after", standing.incident_count, 2);
  eq("and the newest incident is the one that describes where they stand",
    standing.days_since_incident, 40);
}

// --- the watch expires --------------------------------------------------
{
  const o = w.outcomeFor({ at: ago(200), nps: 2 }, { responses: [], visits: [] });
  eq("after the watch window they are a retention problem, not a recovery one",
    w.isOnWatch(o), false);
  eq("which member-health handles — this list stays actionable",
    w.isOnWatch(o, { watchDays: 365 }), true);
}

// --- a member with no incidents is not on the list ---------------------
eq("a member who has never had a bad visit has no standing",
  w.memberStanding(member, { responses: [{ response_id: "r", submitted_at: ago(3), q1_nps: 10 }], alerts: [], visits: [] }),
  null);

// --- the club-level list ------------------------------------------------
{
  const members = [
    { member_id: "A", first_name: "Ann",  last_name: "Lim" },
    { member_id: "B", first_name: "Ben",  last_name: "Tan" },
    { member_id: "C", first_name: "Cara", last_name: "Ong" },
    { member_id: "D", first_name: "Dee",  last_name: "Foo" },
  ];
  const data = {
    // waiting three weeks, nobody has picked it up
    A: { responses: [{ response_id: "a", submitted_at: ago(21), q1_nps: 2 }], alerts: [], visits: [] },
    // waiting two days
    B: { responses: [{ response_id: "b", submitted_at: ago(2), q1_nps: 1 }], alerts: [], visits: [] },
    // came back and was happy
    C: { responses: [
          { response_id: "c1", submitted_at: ago(30), q1_nps: 3 },
          { response_id: "c2", submitted_at: ago(5),  q1_nps: 10 },
        ], alerts: [], visits: [{ visit_date: dayAgo(6) }] },
    // came back and it was bad again: a failed recovery AND a fresh open case
    D: { responses: [
          { response_id: "d1", submitted_at: ago(30), q1_nps: 3 },
          { response_id: "d2", submitted_at: ago(5),  q1_nps: 2 },
        ], alerts: [], visits: [{ visit_date: dayAgo(6) }] },
  };
  const list = w.buildWatchlist(members, data);

  // D's second bad visit answers the first incident and opens a new one, so
  // they are on the list *and* counted as a failed recovery.
  eq("everyone with an unanswered incident is being watched",
    list.watching.map((r) => r.member_id), ["A", "D", "B"]);
  eq("longest wait first — the one nobody picked up",
    list.watching[0].member_id, "A");
  eq("only the fully answered one is settled",
    list.settled.map((r) => r.member_id), ["C"]);

  // A=1, B=1, C=1, D=2. D's return was itself bad, so it both answers their
  // first incident and opens a second one.
  eq("five incidents across four members", list.summary.incidents, 5);
  eq("over four members", list.summary.members, 4);
  eq("three still open", list.summary.still_watching, 3);
  eq("two of them graded", list.summary.returned_and_measured, 2);
  eq("one recovered", list.summary.recovered, 1);
  eq("one not", list.summary.still_unhappy, 1);
  eq("so the recovery rate is fifty per cent", list.summary.recovery_rate, 50);

  // The rate must be measured only on people who came back. Counting those
  // who have not yet would make it a measure of how recent the incidents are.
  eq("and the ones who have not returned are not counted against it",
    list.summary.returned_and_measured, 2);
}

// Nothing graded yet is null, not zero — "0% recovered" and "nobody has been
// back yet" are very different things to put in front of a GM.
{
  const list = w.buildWatchlist(
    [{ member_id: "A" }],
    { A: { responses: [{ response_id: "a", submitted_at: ago(3), q1_nps: 2 }], alerts: [], visits: [] } }
  );
  eq("no verdicts yet gives no rate, rather than nought per cent",
    list.summary.recovery_rate, null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
