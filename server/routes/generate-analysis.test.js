// "Generate analysis" on Server Performance produces no results.
//
// The button reported success and the task list stayed empty, which is the
// worst combination: nothing to search for in a log, and no reason to suspect
// the run rather than the data. Two independent causes, both reproduced here.
//
//   1. The insert failed and nobody was told. server_tasks.title is NOT NULL.
//      When the model call returns anything the parser turns into an empty
//      object — an API error body, a rate-limit response, a refusal — every
//      field comes back undefined, the insert is rejected, and the error goes
//      to the server console. The route still reported tasks_generated, which
//      counts what it *meant* to insert, and the screen showed that number.
//
//   2. The tasks were written under a month the screen never asked for. Tasks
//      are stamped with the month the analysed period starts in; the list is
//      filtered by the month picker, which defaults to today. Analysing "last
//      month" therefore files every task one month back and then queries the
//      current one.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://stub.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "stub";
process.env.ANTHROPIC_API_KEY = "test-key";

const Module = require("module");
const path = require("path");
const realLoad = Module._load;
const SUPABASE = require.resolve("../lib/supabase");

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "\n      " + detail : ""}`); }
}

// --- the database, as much of it as this route touches ---------------------
const db = { responses: [], inserted: [], insertError: null };

function responseQuery() {
  // Every filter the route applies is a no-op here — the fixture is already
  // the set the query would return. What matters is that .select() resolves.
  const chain = {
    select: () => chain, gte: () => chain, lte: () => chain,
    not: () => chain, neq: () => chain,
    then: (resolve) => resolve({ data: db.responses, error: null }),
  };
  return chain;
}

const supabaseStub = {
  supabase: {
    from(table) {
      if (table === "survey_responses") return responseQuery();
      if (table === "server_tasks") {
        return {
          insert(rows) {
            // Postgres rejects a NOT NULL violation; the stub does the same,
            // because the whole point is what the route does with that error.
            const bad = rows.find((r) => r.title == null || r.title === "");
            if (bad) {
              return { select: () => Promise.resolve({ data: null, error: { message: 'null value in column "title" violates not-null constraint' } }) };
            }
            if (db.insertError) {
              return { select: () => Promise.resolve({ data: null, error: { message: db.insertError } }) };
            }
            db.inserted.push(...rows);
            return { select: () => Promise.resolve({ data: rows, error: null }) };
          },
        };
      }
      throw new Error("unexpected table: " + table);
    },
  },
};

Module._load = function (request, parent) {
  if (parent && /server[/\\](lib|routes)[/\\]/.test(parent.filename)) {
    try {
      if (Module._resolveFilename(request, parent) === SUPABASE) return supabaseStub;
    } catch (_) { /* fall through */ }
  }
  return realLoad.apply(this, arguments);
};
const router = require("./staff");
Module._load = realLoad;

// --- calling the route without standing up a server ------------------------
function handlerFor(routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods.post
  );
  if (!layer) throw new Error("route not found: " + routePath);
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1];
}
const generateAnalysis = handlerFor("/generate-analysis");

function call(body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    generateAnalysis({ body, headers: {}, ip: "127.0.0.1" }, res).catch((e) =>
      resolve({ status: 500, body: { error: String(e && e.message || e) } })
    );
  });
}

// A server whose scores are bad enough to earn a training task.
const strugglingServer = (n = 4) =>
  Array.from({ length: n }, () => ({
    q1_nps: 2, q2_overall_stars: 2, q3_food_stars: 2, q4_service_stars: 1,
    q5_comment: "Slow and inattentive.",
    visits: { server_name: "Alex Server", spend_amount: 90, visit_date: "2026-07-08" },
  }));

(async () => {
  console.log("--- 1. the model call fails, and the run reports success anyway ---");
  db.responses = strugglingServer();
  db.inserted = [];
  // What an API error actually looks like coming back: no content array.
  global.fetch = async () => ({
    json: async () => ({ type: "error", error: { type: "not_found_error", message: "model not found" } }),
  });

  let r = await call({ start_date: "2026-07-01", end_date: "2026-07-31", label: "July 2026" });
  check("the run does not claim to have generated a task it could not save",
    !(r.body.tasks_generated > 0 && r.body.tasks_inserted === 0),
    `generated=${r.body.tasks_generated} inserted=${r.body.tasks_inserted}`);
  check("a task is still produced when the model is unavailable",
    r.body.tasks_inserted > 0,
    JSON.stringify(r.body));
  check("and it carries a title, which the column requires",
    db.inserted.every((t) => t.title),
    JSON.stringify(db.inserted.map((t) => t.title)));
  check("the failure is reported to the caller rather than only the console",
    Array.isArray(r.body.errors) ? true : r.body.tasks_inserted === r.body.tasks_generated,
    JSON.stringify(r.body));

  console.log("\n--- 2. a genuine insert failure is not reported as success ---");
  db.responses = strugglingServer();
  db.inserted = [];
  db.insertError = "relation \"server_tasks\" does not exist";
  global.fetch = async () => ({
    json: async () => ({ content: [{ text: '{"title":"Coach Alex","description":"d","key_metric":"k"}' }] }),
  });
  r = await call({ start_date: "2026-07-01", end_date: "2026-07-31", label: "July 2026" });
  check("the caller is told the tasks could not be saved",
    r.status >= 400 || (r.body.errors && r.body.errors.length > 0),
    `status=${r.status} body=${JSON.stringify(r.body)}`);
  db.insertError = null;

  console.log("\n--- 3. the month a task is filed under is the month the screen asks for ---");
  db.responses = strugglingServer();
  db.inserted = [];
  global.fetch = async () => ({
    json: async () => ({ content: [{ text: '{"title":"Coach Alex","description":"d","key_metric":"k"}' }] }),
  });
  r = await call({ start_date: "2026-07-01", end_date: "2026-07-31", label: "July 2026" });
  check("the response says which month the tasks were filed under",
    typeof r.body.month === "string" && /^\d{4}-\d{2}$/.test(r.body.month),
    JSON.stringify(r.body));
  check("and it matches what was written", db.inserted.every((t) => t.month === r.body.month),
    JSON.stringify(db.inserted.map((t) => t.month)));

  console.log("\n--- 4. nothing to report is said plainly, not as a bare zero ---");
  db.responses = [{
    q1_nps: 8, q2_overall_stars: 4, q3_food_stars: 4, q4_service_stars: 4, q5_comment: "Fine.",
    visits: { server_name: "Mid Server", spend_amount: 90, visit_date: "2026-07-08" },
  }];
  db.inserted = [];
  r = await call({ start_date: "2026-07-01", end_date: "2026-07-31", label: "July 2026" });
  check("a server who is simply doing fine is counted as analysed",
    r.body.servers_analyzed === 1, JSON.stringify(r.body));
  check("and the run explains why no task came out of it",
    typeof r.body.note === "string" && r.body.note.length > 0, JSON.stringify(r.body));

  console.log("\n--- 5. no responses at all ---");
  db.responses = [];
  r = await call({ start_date: "2026-07-01", end_date: "2026-07-31", label: "July 2026" });
  check("says so rather than reporting a silent zero",
    r.body.servers_analyzed === 0 && typeof r.body.note === "string",
    JSON.stringify(r.body));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
