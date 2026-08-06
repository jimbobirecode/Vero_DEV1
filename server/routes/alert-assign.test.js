// Drives the real survey-response handler and checks where the resulting case
// alert lands. The interesting part is not the happy path but the fallbacks:
// an alert that reaches nobody is worse than one that reaches too many people.

const Module = require("module");
const path = require("path");

const db = { response: null, outlets: {}, staff: {}, alerts: [] };
const notified = [];

function table(name) {
  const filters = [];
  const q = {
    _op: null, _payload: null,
    select() { return q; },
    eq(c, v) { filters.push([c, v]); return q; },
    insert(p) { q._op = "insert"; q._payload = p; if (name === "case_alerts") db.alerts.push(p); return q; },
    update(p) { q._op = "update"; q._payload = p; return q; },
    async single() { return { data: null, error: null }; },
    async maybeSingle() {
      if (name === "survey_responses") return { data: db.response, error: null };
      if (name === "staff") {
        const id = filters.find((f) => f[0] === "staff_id")?.[1];
        return { data: db.staff[id] ?? null, error: null };
      }
      return { data: null, error: null };
    },
    then(res) { return Promise.resolve({ data: [], error: null }).then(res); },
  };
  return q;
}

const stubs = {
  [path.resolve(__dirname, "../lib/supabase.js")]: { supabase: { from: table } },
  [path.resolve(__dirname, "../lib/ai.js")]: { tagComment: async () => null, generateAlertSummary: async () => "Cold food, slow service" },
  [path.resolve(__dirname, "../lib/notify.js")]: {
    dashboardUrl: () => "https://dash.example",
    notifyManagers: async (s, b) => { notified.push({ to: "managers", subject: s, body: b }); return []; },
    notifyStaffMember: async (id, s, b) => { notified.push({ to: id, subject: s, body: b }); return {}; },
  },
};
const realLoad = Module._load, realResolve = Module._resolveFilename;
Module._load = function (request, parent, isMain) {
  if (parent && /routes[/\\]survey-response\.js$/.test(parent.filename)) {
    try {
      const r = realResolve.call(Module, request, parent, isMain);
      if (stubs[r]) return stubs[r];
    } catch (_) { /* fall through */ }
  }
  return realLoad.apply(this, arguments);
};
const router = require("./survey-response");
Module._load = realLoad;

const post = router.stack.find((l) => l.route?.methods?.post).route.stack[0].handle;

// A response bad enough to raise an alert: overall 1.
function submit(outlets) {
  return new Promise((resolve) => {
    db.alerts = []; notified.length = 0;
    db.response = {
      response_id: "r1", submitted_at: null, survey_templates: null,
      visits: { outlet_id: outlets?.outlet_id ?? null, outlets, members: { first_name: "Ann", last_name: "Ash" } },
    };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(p) { setTimeout(() => resolve({ status: this.statusCode, body: p }), 20); },
    };
    post({ params: { token: "t" }, body: { q1_nps: 2, q2_overall_stars: 1, q3_food_stars: 1, q5_comment: "Cold food." } }, res)
      .catch((e) => resolve({ status: 500, body: { error: String(e) } }));
  });
}

let pass = 0, fail = 0;
function check(label, cond, detail = "") {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "\n      " + detail : ""}`); }
}

const DINING = { outlet_id: "o1", name: "Main Dining Room", owner_staff_id: "s1" };

(async () => {
  console.log("\n--- an outlet with an owner ---");
  db.staff = { s1: { staff_id: "s1", name: "Dana Reed", email: "dana@club.com", active: true } };
  let r = await submit(DINING);
  check("the response is accepted", r.status === 200, JSON.stringify(r.body));
  check("an alert was raised", db.alerts.length === 1, JSON.stringify(db.alerts));
  check("assigned to the outlet's owner", db.alerts[0]?.assigned_to_staff_id === "s1", JSON.stringify(db.alerts[0]));
  check("and marked assigned rather than open", db.alerts[0]?.status === "assigned");
  check("the owner is emailed, not the managers", notified[0]?.to === "s1", JSON.stringify(notified.map(n => n.to)));
  check("the email says it is theirs and names the outlet",
    /assigned to you/.test(notified[0]?.body || "") && /Main Dining Room/.test(notified[0]?.body || ""));

  console.log("\n--- an outlet with nobody named ---");
  r = await submit({ outlet_id: "o2", name: "Halfway House", owner_staff_id: null });
  check("alert still raised", db.alerts.length === 1);
  check("left unassigned", !db.alerts[0]?.assigned_to_staff_id, JSON.stringify(db.alerts[0]));
  check("status stays open", db.alerts[0]?.status === "open");
  check("managers are notified, so it reaches somebody", notified[0]?.to === "managers");
  check("and the email says how to fix it", /Settings → Outlets/.test(notified[0]?.body || ""), notified[0]?.body);

  console.log("\n--- an event survey, which has no outlet ---");
  r = await submit(null);
  check("alert still raised", db.alerts.length === 1);
  check("unassigned, because there is no location to route by", !db.alerts[0]?.assigned_to_staff_id);
  check("managers notified", notified[0]?.to === "managers");

  console.log("\n--- an owner who has been deactivated ---");
  db.staff = { s1: { staff_id: "s1", name: "Dana Reed", email: "dana@club.com", active: false } };
  r = await submit(DINING);
  check("not assigned to a deactivated account", !db.alerts[0]?.assigned_to_staff_id, JSON.stringify(db.alerts[0]));
  check("managers pick it up", notified[0]?.to === "managers");
  check("and are told to reassign", /reassign/.test(notified[0]?.body || ""), notified[0]?.body);

  console.log("\n--- an owner with no email ---");
  db.staff = { s1: { staff_id: "s1", name: "Dana Reed", email: null, active: true } };
  r = await submit(DINING);
  check("still assigned to them", db.alerts[0]?.assigned_to_staff_id === "s1");
  check("but the managers are the ones told", notified[0]?.to === "managers");

  console.log("\n--- a good response raises nothing at all ---");
  db.staff = { s1: { staff_id: "s1", name: "Dana Reed", email: "dana@club.com", active: true } };
  db.alerts = []; notified.length = 0;
  db.response = { response_id: "r9", submitted_at: null, survey_templates: null,
    visits: { outlet_id: "o1", outlets: DINING, members: { first_name: "Ann", last_name: "Ash" } } };
  await new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json() { setTimeout(resolve, 20); } };
    post({ params: { token: "t" }, body: { q1_nps: 10, q2_overall_stars: 5, q3_food_stars: 5 } }, res).catch(resolve);
  });
  check("no alert", db.alerts.length === 0, JSON.stringify(db.alerts));
  check("nobody emailed", notified.length === 0, JSON.stringify(notified.map(n => n.to)));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
