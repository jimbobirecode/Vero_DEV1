// The settings a club may not write.
//
// PUT /api/settings/:key writes whatever key it is handed — that is what makes
// it useful, and it is also why the billing keys have to be refused by name.
// Without that, a general manager could set sms_credit_enabled or a rate of
// their own choosing straight into club_settings, and on any deployment where
// the matching environment variable is unset that row is what takes effect.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://stub.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "stub";

const Module = require("module");
const realLoad = Module._load;
const SUPABASE = require.resolve("../lib/supabase");

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "\n      " + detail : ""}`); }
}

// Every write the route attempts, so a refusal that still wrote is visible.
const written = [];

const supabaseStub = {
  supabase: {
    from() {
      return {
        select: () => Promise.resolve({ data: [], error: null }),
        upsert: (row) => { written.push(row); return Promise.resolve({ error: null }); },
      };
    },
  },
};

Module._load = function (request, parent, isMain) {
  if (parent && require.resolve.paths(request) && request.includes("supabase")) {
    try { if (require.resolve(request, { paths: [parent.path] }) === SUPABASE) return supabaseStub; }
    catch (_) { /* not that module */ }
  }
  if (request.includes("/audit") || request.endsWith("audit")) {
    return { log: () => {}, ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }) };
  }
  return realLoad.apply(this, arguments);
};

const router = require("./settings");
Module._load = realLoad;

// Drive the router directly: find the PUT layer and call its handler.
function put(key, value) {
  return new Promise((resolve) => {
    const layer = router.stack.find((l) => l.route && l.route.methods.put);
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    layer.route.stack[0].handle({ params: { key }, body: { value }, headers: {} }, res, () => {});
  });
}

(async () => {
  const { OPERATOR_SETTING_KEYS } = require("../lib/sms-credit");

  for (const key of OPERATOR_SETTING_KEYS) {
    const r = await put(key, "true");
    check(`"${key}" is refused`, r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
    check(`  and says where it is set instead`,
      /environment variable/i.test(r.body.error || ""), JSON.stringify(r.body));
  }
  check("nothing was written despite the refusals", written.length === 0, JSON.stringify(written));

  // The settings a club does own still save, or this would be a regression
  // dressed up as a security fix.
  const ok = await put("survey_send_time", "18:00");
  check("an ordinary setting still saves", ok.status === 200 && ok.body.saved === true,
    `${ok.status} ${JSON.stringify(ok.body)}`);
  check("and reaches the database", written.length === 1 && written[0].key === "survey_send_time",
    JSON.stringify(written));

  // A missing value is still the first thing checked, refused key or not.
  const empty = await put("survey_send_time", undefined);
  check("a missing value is still rejected", empty.status === 400, JSON.stringify(empty));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
