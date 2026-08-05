// Exercises the real /api/staff/import handler against a stub database. The
// point of interest is the role gate: an import assigns roles in bulk, and
// the router it lives on is reachable by a department head.

const Module = require("module");
const path = require("path");

const db = { staff: [], inserted: [], servers: [] };

function table(name) {
  const q = {
    _updates: null,
    select() { return q; },
    eq() { return q; },
    insert(payload) {
      if (name === "staff") db.inserted.push(payload);
      if (name === "servers") db.servers.push(payload);
      return q;
    },
    update(payload) { q._updates = payload; return q; },
    async single() { return { data: { staff_id: "new-id" }, error: null }; },
    async maybeSingle() { return { data: null, error: null }; },
    then(res) {
      const data = name === "staff" ? db.staff : [];
      return Promise.resolve({ data, error: null }).then(res);
    },
  };
  return q;
}

const stubs = {
  [path.resolve(__dirname, "../lib/supabase.js")]: { supabase: { from: table } },
  [path.resolve(__dirname, "../lib/audit.js")]: { log: () => {}, ACTIONS: { STAFF_IMPORTED: "staff_imported", ROLE_CHANGED: "role_changed" } },
  [path.resolve(__dirname, "../lib/notify.js")]: { notifyManagers: async () => [], dashboardUrl: () => "" },
};
const realLoad = Module._load;
const realResolve = Module._resolveFilename;
Module._load = function (request, parent, isMain) {
  if (parent && /routes[/\\]staff\.js$/.test(parent.filename)) {
    try {
      const resolved = realResolve.call(Module, request, parent, isMain);
      if (stubs[resolved]) return stubs[resolved];
    } catch (_) { /* fall through */ }
  }
  return realLoad.apply(this, arguments);
};
const router = require("./staff");
Module._load = realLoad;

const layer = router.stack.find((l) => l.route?.path === "/import" && l.route.methods.post);
const handler = layer.route.stack[0].handle;

function call(role, body) {
  return new Promise((resolve) => {
    db.inserted = []; db.servers = [];
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    handler({ user: { role, staff_id: "me" }, body, headers: {}, ip: "127.0.0.1" }, res)
      .catch((e) => resolve({ status: 500, body: { error: String(e) } }));
  });
}

let pass = 0, fail = 0;
function check(label, cond, detail = "") {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "\n      " + detail : ""}`); }
}

(async () => {
  const ROSTER = "name,email,role\nJane Doe,jane@club.com,Shift Manager\nBob Ray,bob@club.com,Department Head";

  console.log("\n--- the role gate ---");
  let r = await call("dept_head", { text: ROSTER });
  check("a department head cannot import team members", r.status === 403, JSON.stringify(r.body));
  check("and nothing was written", db.inserted.length === 0);

  r = await call("fb_director", { text: ROSTER });
  check("nor can an F&B director", r.status === 403, JSON.stringify(r.body));

  r = await call("general_manager", { text: ROSTER });
  check("a general manager can", r.status === 200, JSON.stringify(r.body));
  check("both rows written", db.inserted.length === 2, JSON.stringify(db.inserted));
  check("roles resolved from the file", db.inserted.map(i => i.role).join(",") === "shift_manager,dept_head");
  // Importing a management roster must not populate the Server dropdown on
  // the visit form: staff is who can use the dashboard, servers is who is
  // credited with a cheque. They used to be the same list.
  check("no servers rows are created", db.servers.length === 0, JSON.stringify(db.servers));

  console.log("\n--- nobody grants a role above their own ---");
  r = await call("general_manager", { text: "name,email,role\nJane Doe,jane@club.com,Super Admin" });
  check("a GM cannot import a super_admin", r.status === 403, JSON.stringify(r.body));
  check("the refusal names the person", /Jane Doe/.test(r.body.error || ""), r.body.error);
  check("nothing was written — not even the rows before it", db.inserted.length === 0);

  r = await call("super_admin", { text: "name,email,role\nJane Doe,jane@club.com,Super Admin" });
  check("a super_admin can", r.status === 200, JSON.stringify(r.body));

  console.log("\n--- the whole file is rejected, not half of it ---");
  r = await call("general_manager", {
    text: "name,email,role\nOK Person,ok@club.com,Shift Manager\nToo High,high@club.com,Super Admin",
  });
  check("one ungrantable row stops the import", r.status === 403);
  check("including the row that was fine", db.inserted.length === 0);

  console.log("\n--- ordinary validation ---");
  check("empty input", (await call("general_manager", { text: "  " })).status === 400);
  check("no body at all", (await call("general_manager", {})).status === 400);
  r = await call("general_manager", { text: "email,role\nj@c.com,gm" });
  check("a file with no name column is refused", r.status === 400 && /name column/i.test(r.body.error), r.body.error);
  r = await call("general_manager", { text: ROSTER, default_role: "wizard" });
  check("an invalid default role is refused", r.status === 400);

  console.log("\n--- rows the file got wrong are reported, not dropped silently ---");
  r = await call("general_manager", {
    text: "name,email,role\nJane Doe,jane@club.com,Shift Manager\n,orphan@club.com,Shift Manager\nBad Email,nope,Shift Manager",
  });
  check("the good row imports", r.status === 200 && r.body.created === 1, JSON.stringify(r.body));
  check("the two bad rows come back with reasons", r.body.skipped.length === 2, JSON.stringify(r.body.skipped));
  check("each carries the line number", r.body.skipped.every(s => typeof s.line === "number"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
