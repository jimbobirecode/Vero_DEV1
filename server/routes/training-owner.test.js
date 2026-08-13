// Making somebody responsible for a training plan.
//
// A plan generated on a Friday and owned by nobody is read by everybody as
// somebody else's job, and sits at 0/4 for a month. The assignment itself is
// one column; what has to be right is everything around it — that the person
// exists, that they still work here, that they are told, and that a database
// which has not run the migration yet says so instead of failing obscurely.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://stub.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "stub";
process.env.SURVEY_BASE_URL = "https://vero.example.com";

const Module = require("module");
const realLoad = Module._load;
const SUPABASE = require.resolve("../lib/supabase");

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "\n      " + detail : ""}`); }
}

// --- the database, as much of it as this route touches ---------------------
const db = {
  staff: [
    { staff_id: "s1", name: "Priya Anand", email: "panand@x.com", role: "dept_head", active: true },
    { staff_id: "s2", name: "Gone Person", email: "gone@x.com", role: "dept_head", active: false },
  ],
  plans: [{
    plan_id: "p1", week_start: "2026-08-03", basis_summary: "Service slowed at the pass",
    steps: [{ text: "Re-brief the pass", done: false }, { text: "Check covers", done: true }],
    outlets: { name: "Grill Room" },
  }],
  // Set true to make every training_plans query behave like a database that
  // has not run migrations/training-owner.sql.
  noOwnerColumn: false,
  updates: [],
};

const emails = [];

const OWNER_ERR = { message: `column training_plans.owner_staff_id does not exist` };

function plansQuery() {
  const state = { filters: [] };
  const chain = {
    select(cols) { state.cols = cols; return chain; },
    order: () => chain,
    is: (col, v) => { state.filters.push([col, v]); return chain; },
    eq: (col, v) => { state.filters.push([col, v]); return chain; },
    range: () => {
      if (db.noOwnerColumn && String(state.cols).includes("owner_staff_id")) {
        return Promise.resolve({ data: null, count: null, error: OWNER_ERR });
      }
      return Promise.resolve({ data: db.plans, count: db.plans.length, error: null });
    },
    update(values) {
      state.values = values;
      return {
        eq: (_c, id) => {
          state.id = id;
          const done = (r) => r;
          const result = () => {
            if (db.noOwnerColumn) return { data: null, error: OWNER_ERR };
            const plan = db.plans.find((p) => p.plan_id === state.id);
            if (!plan) return { data: null, error: null };
            Object.assign(plan, state.values);
            db.updates.push({ id: state.id, values: state.values });
            return { data: plan, error: null };
          };
          return { select: () => ({ maybeSingle: () => Promise.resolve(done(result())) }) };
        },
      };
    },
  };
  return chain;
}

const supabaseStub = {
  supabase: {
    from(table) {
      if (table === "training_plans") return plansQuery();
      if (table === "staff") {
        const st = {};
        return {
          select: () => st.chain, ...(st.chain = {
            select: () => st.chain,
            eq: (_c, v) => { st.id = v; return st.chain; },
            maybeSingle: () => Promise.resolve({ data: db.staff.find((s) => s.staff_id === st.id) || null, error: null }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }) };
    },
  },
};

Module._load = function (request, parent) {
  if (parent && request.includes("supabase")) {
    try { if (require.resolve(request, { paths: [parent.path] }) === SUPABASE) return supabaseStub; }
    catch (_) { /* not that module */ }
  }
  if (request.endsWith("/notify")) {
    return {
      notifyStaffMember: async (staffId, subject, body) => { emails.push({ staffId, subject, body }); return { sent: true }; },
      dashboardUrl: () => "https://vero.example.com",
    };
  }
  if (request.endsWith("/audit")) {
    return { log: () => {}, auditRead: () => (_q, _r, n) => n(), ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }) };
  }
  return realLoad.apply(this, arguments);
};

const router = require("./training");
Module._load = realLoad;

// Drive the router directly.
function call(method, path, body = {}, query = {}) {
  return new Promise((resolve) => {
    const layer = router.stack.find((l) => l.route && l.route.methods[method] && l.route.path === path);
    if (!layer) return resolve({ status: 0, body: { error: `no ${method} ${path}` } });
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    const handlers = layer.route.stack.map((s) => s.handle);
    const req = { params: { id: "p1" }, body, query, headers: {} };
    let i = 0;
    const next = () => { const h = handlers[i++]; h ? h(req, res, next) : resolve({ status: 0, body: {} }); };
    next();
  });
}

(async () => {
  console.log("--- assigning ---");
  let r = await call("put", "/:id/owner", { staff_id: "s1" });
  check("a plan can be handed to somebody", r.status === 200 && r.body.updated === true, JSON.stringify(r));
  check("and the reply names them", r.body.owner_name === "Priya Anand", JSON.stringify(r.body));
  check("the name is stored beside the id", db.plans[0].owner_name === "Priya Anand" &&
    db.plans[0].owner_staff_id === "s1", JSON.stringify(db.plans[0]));
  check("and when it happened", Boolean(db.plans[0].assigned_at), JSON.stringify(db.plans[0].assigned_at));

  console.log("\n--- and told ---");
  check("they are emailed", emails.length === 1, JSON.stringify(emails));
  check("the subject names the outlet", emails[0].subject.includes("Grill Room"), emails[0].subject);
  // An email that only says "you have a plan" makes them go and look for it.
  check("the outstanding step is in the email itself",
    emails[0].body.includes("Re-brief the pass"), emails[0].body);
  check("the finished one is not", !emails[0].body.includes("Check covers"), emails[0].body);
  check("it says why the plan exists",
    emails[0].body.includes("Service slowed at the pass"), emails[0].body);
  check("and links to where the steps are ticked off",
    emails[0].body.includes("https://vero.example.com"), emails[0].body);

  console.log("\n--- who may be given work ---");
  r = await call("put", "/:id/owner", { staff_id: "nobody" });
  check("an unknown person is refused", r.status === 404, JSON.stringify(r));
  r = await call("put", "/:id/owner", { staff_id: "s2" });
  check("somebody who has left is refused", r.status === 400, JSON.stringify(r));
  check("and the refusal names them", /Gone Person/.test(r.body.error || ""), r.body.error);
  check("neither was emailed", emails.length === 1, JSON.stringify(emails.map((e) => e.staffId)));

  r = await call("put", "/:id/owner", {});
  check("omitting staff_id entirely is a bad request", r.status === 400, JSON.stringify(r));

  console.log("\n--- handing it back ---");
  r = await call("put", "/:id/owner", { staff_id: null });
  check("null unassigns", r.status === 200 && r.body.owner_name === null, JSON.stringify(r.body));
  check("the owner is cleared", db.plans[0].owner_staff_id === null && db.plans[0].owner_name === null,
    JSON.stringify(db.plans[0]));
  check("nobody is emailed about being unassigned", emails.length === 1);

  console.log("\n--- filtering ---");
  r = await call("get", "/", {}, { owner: "unassigned" });
  check("the list can be filtered to what nobody owns", r.status === 200, JSON.stringify(r).slice(0, 120));
  check("and reports that assignment is available", r.body.assignable === true, JSON.stringify(r.body.assignable));

  console.log("\n--- a database that has not run the migration ---");
  db.noOwnerColumn = true;
  // The cache in the route is per-process, so this is the first time it asks.
  r = await call("get", "/");
  check("the plain list still works", r.status === 200 && Array.isArray(r.body.plans), JSON.stringify(r).slice(0, 150));
  check("and says assignment is not available yet", r.body.assignable === false, JSON.stringify(r.body.assignable));

  r = await call("get", "/", {}, { owner: "unassigned" });
  check("a filter it cannot honour is refused rather than answered wrongly",
    r.status === 503, JSON.stringify(r));
  check("and names the migration to run",
    /training-owner\.sql/.test(r.body.error || ""), r.body.error);

  r = await call("put", "/:id/owner", { staff_id: "s1" });
  check("assigning says the same thing", r.status === 503 && /training-owner\.sql/.test(r.body.error || ""),
    JSON.stringify(r));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
