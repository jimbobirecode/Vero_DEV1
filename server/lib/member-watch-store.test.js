// Reading the club's history into the shape the grading expects.
//
// The rules are tested in member-watch.test.js against plain objects. What is
// worth testing here is the joining, because a response does not know who gave
// it — it hangs off a visit, and the visit knows. Get that wrong and feedback
// lands on the wrong member's row, which is worse than no watchlist at all.
process.env.SUPABASE_URL = "https://p";
process.env.SUPABASE_SERVICE_ROLE_KEY = "s";

let VISITS = [], RESPONSES = [], ALERTS = [], MEMBERS = [];
const QUERIES = [];

const Module = require("module");
const rr = Module._resolveFilename;
Module._resolveFilename = function (r, ...x) {
  if (r === "./supabase" || r === "../lib/supabase" || r.endsWith("lib/supabase")) return "SB";
  return rr.call(this, r, ...x);
};

const tableData = (t) =>
  ({ visits: VISITS, survey_responses: RESPONSES, case_alerts: ALERTS, members: MEMBERS }[t] || []);

// Honours only the filters this module actually uses. .in() is honoured
// because narrowing to one member is the whole point of the per-member read,
// and a stub that ignored it would pass whatever the code did.
function from(table) {
  const ins = [];
  const gtes = [];
  const api = {
    select: () => api,
    not: () => api,
    gte: (c, v) => { gtes.push([c, v]); return api; },
    in: (c, vals) => { ins.push([c, new Set(vals)]); return api; },
    limit: () => api,
    then: (res) => {
      const rows = tableData(table).filter((r) =>
        ins.every(([c, set]) => set.has(r[c])) &&
        gtes.every(([c, v]) => String(r[c] ?? "") >= String(v)));
      QUERIES.push({ table, in: ins.map(([c, s]) => [c, s.size]) });
      return res({ data: rows, error: null });
    },
  };
  return api;
}

require.cache["SB"] = {
  id: "SB", filename: "SB", loaded: true,
  exports: { supabase: { from }, rawSupabase: { from } },
};

const store = require("./member-watch-store.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const dayAgo = (d) => ago(d).slice(0, 10);

VISITS = [
  { visit_id: "v1", member_id: "M1", visit_date: dayAgo(40), outlet_id: "o1" },
  { visit_id: "v2", member_id: "M1", visit_date: dayAgo(10), outlet_id: "o2" },
  { visit_id: "v3", member_id: "M2", visit_date: dayAgo(30), outlet_id: "o1" },
  { visit_id: "v4", member_id: "M3", visit_date: dayAgo(20), outlet_id: "o1" },
  // A guest. The visits query excludes these, so it is not in the list —
  // but their response is, below, and must not land on anybody.
];
RESPONSES = [
  { response_id: "r1", visit_id: "v1", submitted_at: ago(40), q1_nps: 2, q2_overall_stars: 1 },
  { response_id: "r2", visit_id: "v2", submitted_at: ago(9),  q1_nps: 9, q2_overall_stars: 5 },
  { response_id: "r3", visit_id: "v3", submitted_at: ago(30), q1_nps: 1, q2_overall_stars: 1 },
  { response_id: "r4", visit_id: "v4", submitted_at: ago(20), q1_nps: 10, q2_overall_stars: 5 },
  // The guest's — its visit is not in the member visit set.
  { response_id: "rG", visit_id: "vG", submitted_at: ago(15), q1_nps: 0, q2_overall_stars: 1 },
];
ALERTS = [
  { alert_id: "a1", response_id: "r3", outlet_id: "o1", severity: "high", status: "resolved",
    created_at: ago(30), resolved_at: ago(29) },
  // Raised by hand, against nothing. Nobody to attach it to.
  { alert_id: "a2", response_id: null, outlet_id: "o1", severity: "low", status: "open", created_at: ago(5) },
];
MEMBERS = [
  { member_id: "M1", first_name: "Ann", last_name: "Lim", phone_number: "+66", email_address: "a@x.invalid" },
  // M2 has been removed from the roster since their bad visit.
  { member_id: "M3", first_name: "Cara", last_name: "Ong" },
];

(async () => {
  const loaded = await store.loadWatchData({ days: 180 });

  eq("only members with something to grade are loaded",
    loaded.members.map((m) => m.member_id).sort(), ["M1", "M2"]);
  eq("a member whose only feedback was good is not on the list",
    Object.keys(loaded.dataByMember).includes("M3"), false);

  // The guest's one-star response is the trap. It is real feedback and it is
  // in the window, but no member gave it, so tracking a "next visit" for them
  // is impossible and attaching it to anyone is a fabrication.
  const allResponseIds = Object.values(loaded.dataByMember)
    .flatMap((d) => d.responses.map((r) => r.response_id));
  eq("a guest's response is attached to nobody", allResponseIds.includes("rG"), false);

  eq("M1's feedback follows their visits", loaded.dataByMember.M1.responses.map((r) => r.response_id), ["r1", "r2"]);
  eq("and carries the outlet it came from, which the response does not store",
    loaded.dataByMember.M1.responses[0].outlet_id, "o1");

  eq("the alert lands on the member whose response caused it",
    loaded.dataByMember.M2.alerts.map((a) => a.alert_id), ["a1"]);
  eq("and an alert with no response behind it lands on nobody",
    Object.values(loaded.dataByMember).flatMap((d) => d.alerts.map((a) => a.alert_id)).includes("a2"), false);

  eq("a member since removed from the roster still has a row",
    loaded.members.find((m) => m.member_id === "M2").off_roster, true);

  // --- what the list says -------------------------------------------------
  const list = await store.watchlist({ days: 180, watchDays: 180 });

  eq("M1 came back and rated it well, so they are settled",
    list.settled.map((r) => r.member_id), ["M1"]);
  eq("M2's case was closed but they have not been back",
    list.watching.map((r) => r.member_id), ["M2"]);
  eq("the club closing its own case did not clear them",
    list.watching[0].incident.alert_resolved, true);
  eq("one recovered out of one graded", list.summary.recovery_rate, 100);

  // --- one member --------------------------------------------------------
  QUERIES.length = 0;
  const one = await store.standingFor("M1", { days: 180 });

  eq("a member's own timeline comes back", one.standing.member_id, "M1");
  eq("with the incident and the visit that answered it", one.standing.status, "recovered");
  eq("named from the roster", one.standing.name, "Ann Lim");

  // Narrowed at the database, not in JavaScript. This runs when a member is
  // checked in, so reading the club's whole survey history to answer it would
  // make the feature too expensive to put where it is useful.
  const narrowed = QUERIES.filter((q) => q.in.length);
  eq("visits, responses and alerts are all narrowed to that member",
    narrowed.map((q) => q.table), ["visits", "survey_responses", "case_alerts", "members"]);

  const none = await store.standingFor("M3", { days: 180 });
  eq("a member with no bad visit has no standing, and that is not an error",
    none.standing, null);

  const stranger = await store.standingFor("NOBODY", { days: 180 });
  eq("nor does someone with no history at all", stranger.standing, null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
