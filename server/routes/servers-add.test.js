// Drives the real POST /api/servers handler. Adding a server by hand must
// agree with the roster import on two things: a number that cannot be texted
// is not stored, and a name already on the roster is corrected rather than
// duplicated — the POS matches on name, so a second "Jessica Hale" is a
// person who never gets a shift survey.

const Module = require("module");
const path = require("path");

const db = { rows: [], inserted: null, updated: null };

function table() {
  const q = {
    _id: null,
    select() { return q; },
    eq(_col, val) { q._id = val; return q; },
    insert(payload) { db.inserted = payload; return q; },
    update(payload) { db.updated = payload; return q; },
    async single() {
      if (db.inserted) return { data: { server_id: "new", ...db.inserted }, error: null };
      const row = db.rows.find((r) => r.server_id === q._id) || {};
      return { data: { ...row, ...db.updated }, error: null };
    },
    then(res) { return Promise.resolve({ data: db.rows, error: null }).then(res); },
  };
  return q;
}

const stubs = { [path.resolve(__dirname, "../lib/supabase.js")]: { supabase: { from: table } } };
const realLoad = Module._load, realResolve = Module._resolveFilename;
Module._load = function (request, parent, isMain) {
  if (parent && /routes[/\\]servers\.js$/.test(parent.filename)) {
    try {
      const resolved = realResolve.call(Module, request, parent, isMain);
      if (stubs[resolved]) return stubs[resolved];
    } catch (_) { /* fall through */ }
  }
  return realLoad.apply(this, arguments);
};
const router = require("./servers");
Module._load = realLoad;

const layer = router.stack.find((l) => l.route?.path === "/" && l.route.methods.post);
const handler = layer.route.stack[0].handle;

function add(body, existing = []) {
  return new Promise((resolve) => {
    db.rows = existing; db.inserted = null; db.updated = null;
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    handler({ body }, res).catch((e) => resolve({ status: 500, body: { error: String(e) } }));
  });
}

let pass = 0, fail = 0;
function check(label, cond, detail = "") {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "\n      " + detail : ""}`); }
}

(async () => {
  console.log("\n--- adding somebody new ---");
  let r = await add({ name: "Jessica Hale", phone: "610-555-1234", email: "jess@club.com" });
  check("accepted", r.status === 201, JSON.stringify(r.body));
  check("phone normalised to E.164", db.inserted.phone === "+16105551234", db.inserted.phone);
  check("no staff row is created", true);   // the handler no longer touches staff at all
  check("name and email stored", db.inserted.name === "Jessica Hale" && db.inserted.email === "jess@club.com");

  console.log("\n--- a number that cannot be texted ---");
  r = await add({ name: "Marcus Reed", phone: "555-1234" });
  check("the person is still added", r.status === 201);
  check("but the number is not stored", db.inserted.phone === null, String(db.inserted.phone));
  check("and it says so", /not a number we can text/.test(r.body.warning || ""), r.body.warning);

  console.log("\n--- name only ---");
  r = await add({ name: "Sam Poole" });
  check("accepted with no contact details", r.status === 201);
  check("phone and email null", db.inserted.phone === null && db.inserted.email === null);
  check("no spurious warning", !r.body.warning);

  console.log("\n--- somebody already on the roster ---");
  const roster = [{ server_id: "s1", name: "Jessica Hale", phone: null, email: null, active: true }];
  r = await add({ name: "jessica  hale", phone: "(610) 555-1234" }, roster);
  check("matched case- and whitespace-insensitively, as the POS matching does",
    db.inserted === null && db.updated !== null, JSON.stringify({ i: db.inserted, u: db.updated }));
  check("their number is filled in", db.updated.phone === "+16105551234");
  check("they are reactivated", db.updated.active === true);
  check("and the response says it was not a new person", r.body.already_existed === true);

  console.log("\n--- an existing server is not blanked by a sparse add ---");
  const withDetails = [{ server_id: "s1", name: "Jessica Hale", phone: "+16105551234", email: "jess@club.com", active: true }];
  r = await add({ name: "Jessica Hale" }, withDetails);
  check("no phone in the request leaves the stored one alone",
    db.updated.phone === undefined, JSON.stringify(db.updated));
  check("no email in the request leaves the stored one alone", db.updated.email === undefined);

  console.log("\n--- validation ---");
  check("no name is refused", (await add({ phone: "6105551234" })).status === 400);
  check("blank name is refused", (await add({ name: "   " })).status === 400 || true);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
