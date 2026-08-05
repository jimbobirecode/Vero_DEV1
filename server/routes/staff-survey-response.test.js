// Exercises the real staff-survey route against a stub database, covering the
// path that matters most: a template edited in Survey Builder must still store
// its answers in the right columns.

const Module = require("module");
const path = require("path");

const db = {
  template: null,
  response: { staff_response_id: "r1", shift_date: "2026-08-04", submitted_at: null, servers: { name: "Jessica Hale" } },
  written: null,
};

function chain(table) {
  const q = {
    _table: table,
    select() { return q; },
    eq() { return q; },
    order() { return q; },
    limit() { return q; },
    update(payload) { db.written = payload; return { eq: async () => ({ error: null }) }; },
    async maybeSingle() {
      if (table === "survey_templates") return { data: db.template, error: null };
      return { data: db.response, error: null };
    },
    then(res) { return Promise.resolve({ data: null, error: null }).then(res); },
  };
  return q;
}

// Intercept the route's two requires.
const realResolve = Module._resolveFilename;
const stubs = {
  [path.resolve(__dirname, "../lib/supabase.js")]: { supabase: { from: chain } },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /staff-survey-response\.js$/.test(parent.filename)) {
    try {
      const resolved = realResolve.call(Module, request, parent, isMain);
      if (stubs[resolved]) return stubs[resolved];
    } catch (_) { /* fall through */ }
  }
  return realLoad.apply(this, arguments);
};

const router = require("./staff-survey-response");
Module._load = realLoad;

// Pull the POST handler straight off the router.
const postLayer = router.stack.find((l) => l.route?.methods?.post);
const post = postLayer.route.stack[0].handle;

function call(body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    post({ params: { token: "t" }, body }, res).catch((e) => resolve({ status: 500, body: { error: String(e) } }));
  });
}

let pass = 0, fail = 0;
function check(label, cond, detail = "") {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "\n      " + detail : ""}`); }
}

const RENAMED = [
  { key: "shift_feel", title: "How was the shift?", type: "stars", required: true },
  { key: "backup", title: "Were you backed up?", type: "stars", required: true },
  { key: "pace", title: "Was the pace fair?", type: "stars", required: true },
  { key: "kit", title: "Did you have your kit?", type: "stars", required: false },
  { key: "notes", title: "Anything else?", type: "text", required: false },
];

(async () => {
  console.log("\n--- a template whose questions were renamed in the Builder ---");
  db.template = { template_id: "t1", survey_type: "staff", questions: RENAMED };
  db.response.submitted_at = null; db.written = null;
  let r = await call({ answers: { shift_feel: 4, backup: 2, pace: 3, kit: 5, notes: "Short on glassware." } });
  check("accepted", r.status === 200, JSON.stringify(r.body));
  check("ratings land in column order", db.written?.q1_shift_rating === 4 && db.written?.q2_support === 2
    && db.written?.q3_workload === 3 && db.written?.q4_tools === 5, JSON.stringify(db.written));
  check("free text lands in q5_comment", db.written?.q5_comment === "Short on glassware.");
  check("the raw answers are kept too", db.written?.answers?.shift_feel === 4);

  console.log("\n--- required questions come from the template ---");
  db.response.submitted_at = null; db.written = null;
  r = await call({ answers: { shift_feel: 4, pace: 3 } });
  check("missing a required answer is refused", r.status === 400, JSON.stringify(r.body));
  check("and it names the question", /Were you backed up/.test(r.body.error || ""), r.body.error);

  console.log("\n--- the optional question really is optional ---");
  db.response.submitted_at = null; db.written = null;
  r = await call({ answers: { shift_feel: 5, backup: 5, pace: 5, notes: "" } });
  check("accepted without the optional rating", r.status === 200, JSON.stringify(r.body));
  check("q4_tools stored as null", db.written?.q4_tools === null);
  check("empty comment stored as null", db.written?.q5_comment === null);

  console.log("\n--- no template: the page's built-in questions still work ---");
  db.template = null;
  db.response.submitted_at = null; db.written = null;
  r = await call({ answers: { q1_shift_rating: 3, q2_support: 4, q3_workload: 2, q4_tools: 1, q5_comment: "Fine." } });
  check("accepted", r.status === 200, JSON.stringify(r.body));
  check("stored in the same columns", db.written?.q1_shift_rating === 3 && db.written?.q3_workload === 2);

  console.log("\n--- out-of-range values never reach the check constraint ---");
  db.response.submitted_at = null; db.written = null;
  r = await call({ answers: { q1_shift_rating: 9, q2_support: 4, q3_workload: 2 } });
  check("9 on a 1-5 scale is refused", r.status === 400, JSON.stringify(r.body));

  console.log("\n--- a link cannot be used twice ---");
  db.response.submitted_at = "2026-08-04T20:00:00Z";
  r = await call({ answers: { q1_shift_rating: 3, q2_support: 4, q3_workload: 2 } });
  check("resubmission refused", r.status === 409, JSON.stringify(r.body));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
