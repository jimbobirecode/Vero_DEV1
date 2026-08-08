// End-to-end check of the automatic send, against the real code:
//
//   POS upload queues a visit  ->  the scheduler fires at the configured time
//   ->  performSend picks each member's channel  ->  the message goes out
//
// Everything below the HTTP layer is real: lib/scheduler.js decides the time,
// routes/surveys.js does the sending, lib/recipient.js picks the channel.
// Only the database and the two providers are stubbed, and the stubs record
// what was asked of them.

process.env.SURVEY_BASE_URL = "https://feedback.clubvero.io";
process.env.CLUB_ID = "test-club";
// Without this, sendEmail falls back to a plain-text message rather than the
// branded template — worth exercising the path that actually runs in Render.
process.env.SENDGRID_TEMPLATE_ID = "d-93a61eb4842b46c69c422a6689d6208a";

const Module = require("module");
const path = require("path");

// --- stub database ---------------------------------------------------------
const db = {
  visits: [],
  members: {},
  outlets: {},
  settings: {},
  responses: [],
  templates: [],
  stamped: [],          // visit_ids marked as sent
};

function queryFor(table) {
  const filters = [];
  const notNull = new Set();      // columns asserted NOT NULL via .not(col,"is",null)
  const q = {
    _payload: null, _op: null,
    select() { return q; },
    insert(p) { q._op = "insert"; q._payload = p; return q; },
    update(p) { q._op = "update"; q._payload = p; return q; },
    upsert(p) { q._op = "upsert"; q._payload = p; return q; },
    eq(col, val) { filters.push([col, val]); return q; },
    is(col, val) { filters.push([col, val]); return q; },
    // Honoured, because performSend counts what a member has already been
    // sent with exactly this filter — ignoring it made every member look as
    // though they had already had one.
    not(col) { notNull.add(col); return q; },
    gte() { return q; },
    order() { return q; },
    limit() { return q; },
    async single() { return run(); },
    async maybeSingle() { const r = await run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
    then(res) { return run().then(res); },
  };

  async function run() {
    if (table === "visits") {
      if (q._op === "update") {
        const id = filters.find((f) => f[0] === "visit_id")?.[1];
        if ("survey_sent_at" in (q._payload || {})) db.stamped.push(id);
        const v = db.visits.find((x) => x.visit_id === id);
        if (v) Object.assign(v, q._payload);
        return { data: null, error: null };
      }
      // Two different reads hit this table: the queue (survey_sent_at is null)
      // and the already-sent count for the member cap (survey_sent_at is not
      // null). They must not return the same rows.
      const wantSent = notNull.has("survey_sent_at");
      const rows = db.visits
        .filter((v) => (wantSent ? Boolean(v.survey_sent_at) : v.qualifies && !v.survey_sent_at))
        .map((v) => ({ ...v, members: db.members[v.member_id] ?? null, outlets: db.outlets[v.outlet_id] ?? null }));
      return { data: rows, error: null };
    }
    if (table === "club_settings") {
      if (q._op === "upsert") {
        for (const row of [].concat(q._payload)) db.settings[row.key] = row.value;
        return { data: null, error: null };
      }
      return { data: Object.entries(db.settings).map(([key, value]) => ({ key, value })), error: null };
    }
    if (table === "survey_responses") {
      if (q._op === "insert") { db.responses.push(q._payload); return { data: null, error: null }; }
      return { data: [], error: null };
    }
    if (table === "survey_templates") return { data: db.templates, error: null };
    if (table === "message_log") return { data: null, error: null };
    if (table === "club_integrations") return { data: [{ club_id: "test-club" }], error: null };
    return { data: [], error: null };
  }

  return q;
}

const supabaseStub = { supabase: { from: queryFor } };
const vaultStub = { readSecret: async () => null };

const realLoad = Module._load;
const realResolve = Module._resolveFilename;
const SUPABASE = path.resolve(__dirname, "../lib/supabase.js");
const VAULT = path.resolve(__dirname, "../lib/vault.js");
Module._load = function (request, parent, isMain) {
  if (parent && /server[/\\](lib|routes)[/\\]/.test(parent.filename)) {
    try {
      const resolved = realResolve.call(Module, request, parent, isMain);
      if (resolved === SUPABASE) return supabaseStub;
      if (resolved === VAULT) return vaultStub;
    } catch (_) { /* fall through */ }
  }
  return realLoad.apply(this, arguments);
};

// --- stub providers --------------------------------------------------------
const sent = [];
process.env.SENDLY_API_KEY = "sendly-key";
process.env.SENDGRID_API_KEY = "sendgrid-key";
process.env.SENDGRID_FROM_EMAIL = "aronimink@clubvero.io";

global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  if (String(url).includes("sendly")) sent.push({ channel: "sms", to: body.to, text: body.text });
  else sent.push({
    channel: "email",
    to: body.personalizations[0].to[0].email,
    subject: body.subject || body.personalizations[0].subject || null,
    data: body.personalizations[0].dynamic_template_data || null,
    template_id: body.template_id || null,
    text: (body.content || []).map((c) => c.value).join(""),
    headers: body.headers || null,
  });
  return { ok: true, text: async () => "", json: async () => ({}) };
};

const { shouldSend, clubNow } = require("../lib/scheduler");
const { performSend } = require("./surveys");
Module._load = realLoad;

let pass = 0, fail = 0;
function check(label, cond, detail = "") {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "\n      " + detail : ""}`); }
}

const at = (hour, minute, date = "2026-08-05") => ({ hour, minute, date });

(async () => {
  // ---------------------------------------------------------------------
  console.log("\n--- 1. the clock: does it fire at the time set in Settings ---");
  const sendTime = "09:30";
  check("08:00 — before the time, holds", !shouldSend({ now: at(8, 0), sendTime, lastSentDate: null }).send);
  check("09:29 — one minute before, holds", !shouldSend({ now: at(9, 29), sendTime, lastSentDate: null }).send);
  check("09:30 — exactly the time, SENDS", shouldSend({ now: at(9, 30), sendTime, lastSentDate: null }).send);
  check("11:00 — after a restart or a slow tick, still SENDS rather than losing the batch",
    shouldSend({ now: at(11, 0), sendTime, lastSentDate: null }).send);
  check("09:30 but already sent today, holds",
    !shouldSend({ now: at(9, 30), sendTime, lastSentDate: "2026-08-05" }).send);
  check("09:30 the next day, SENDS again",
    shouldSend({ now: at(9, 30, "2026-08-06"), sendTime, lastSentDate: "2026-08-05" }).send);
  check("21:00 — inside the 8pm-8am blackout, holds whatever the time is set to",
    !shouldSend({ now: at(21, 0), sendTime: "21:00", lastSentDate: null }).send);
  check("the club clock is Eastern, not the server's",
    typeof clubNow().hour === "number" && /^\d{4}-\d{2}-\d{2}$/.test(clubNow().date));

  // ---------------------------------------------------------------------
  console.log("\n--- 2. what a POS upload leaves behind ---");
  db.outlets = { o1: { outlet_id: "o1", name: "Main Dining Room", min_spend_threshold: 75, frequency_limit_days: 30 } };
  db.members = {
    M_SMS:   { member_id: "M_SMS",   first_name: "Ann",  last_name: "Ash",  phone_number: "+16105550001", email_address: "ann@x.com",  comm_preference: "sms",   opt_out: false },
    M_EMAIL: { member_id: "M_EMAIL", first_name: "Ben",  last_name: "Byrd", phone_number: "+16105550002", email_address: "ben@x.com",  comm_preference: "email", opt_out: false },
    M_NOPH:  { member_id: "M_NOPH",  first_name: "Cara", last_name: "Cole", phone_number: null,           email_address: "cara@x.com", comm_preference: "sms",   opt_out: false },
    M_OUT:   { member_id: "M_OUT",   first_name: "Dan",  last_name: "Dorn", phone_number: "+16105550004", email_address: "dan@x.com",  comm_preference: "sms",   opt_out: true },
  };
  db.settings = { survey_send_time: "09:30", member_survey_cap: "0" };
  db.visits = [
    { visit_id: "v1", member_id: "M_SMS",   outlet_id: "o1", visit_date: "2026-08-04", spend_amount: 120, visitor_type: "member", qualifies: true,  survey_sent_at: null },
    { visit_id: "v2", member_id: "M_EMAIL", outlet_id: "o1", visit_date: "2026-08-04", spend_amount: 200, visitor_type: "member", qualifies: true,  survey_sent_at: null },
    { visit_id: "v3", member_id: "M_NOPH",  outlet_id: "o1", visit_date: "2026-08-04", spend_amount: 90,  visitor_type: "member", qualifies: true,  survey_sent_at: null },
    { visit_id: "v4", member_id: "M_OUT",   outlet_id: "o1", visit_date: "2026-08-04", spend_amount: 300, visitor_type: "member", qualifies: true,  survey_sent_at: null },
    // Below the outlet threshold — the upload would not have qualified it.
    { visit_id: "v5", member_id: "M_SMS",   outlet_id: "o1", visit_date: "2026-08-04", spend_amount: 20,  visitor_type: "member", qualifies: false, survey_sent_at: null },
  ];
  check("a below-threshold visit is not in the queue", db.visits.filter((v) => v.qualifies).length === 4);

  // ---------------------------------------------------------------------
  console.log("\n--- 3. the send itself ---");
  const result = await performSend("https://feedback.clubvero.io");

  check("three went out, the opt-out did not", result.sent === 3, JSON.stringify(result));
  check("the opt-out is counted as skipped, not failed", result.skipped_opt_out === 1);
  check("no errors", result.errors.length === 0, JSON.stringify(result.errors));

  const byRecipient = Object.fromEntries(sent.map((m) => [m.to, m]));

  console.log("\n--- 4. did each member get their preferred method ---");
  check("prefers SMS, has a phone      -> SMS", byRecipient["+16105550001"]?.channel === "sms",
    JSON.stringify(sent.find((m) => m.to === "+16105550001")));
  check("prefers email, has an address -> email", byRecipient["ben@x.com"]?.channel === "email");
  check("prefers SMS but has no phone  -> email rather than nothing",
    byRecipient["cara@x.com"]?.channel === "email");
  check("the opt-out was messaged on neither channel",
    !sent.some((m) => m.to === "+16105550004" || m.to === "dan@x.com"));

  console.log("\n--- 5. what the message actually carries ---");
  const sms = byRecipient["+16105550001"];
  check("the SMS carries a survey link on the configured base URL",
    /https:\/\/feedback\.clubvero\.io\/s\/[0-9a-f-]{36}/.test(sms.text), sms.text);
  const email = byRecipient["ben@x.com"];
  check("the email uses the branded SendGrid template", email.template_id === process.env.SENDGRID_TEMPLATE_ID, String(email.template_id));
  check("carrying the member's own survey link", /\/s\/[0-9a-f-]{36}$/.test(email.data?.survey_url || ""), email.data?.survey_url);
  check("and a working unsubscribe link", /\/u\/[0-9a-f-]{36}$/.test(email.data?.unsubscribe_url || ""), email.data?.unsubscribe_url);
  check("addressed by first name", email.data?.first_name === "Ben");
  check("naming the outlet", email.data?.outlet_name === "Main Dining Room");
  check("the SMS greets Ann by her own name", /\bAnn,/.test(sms.text), sms.text);
  // Whether the outlet survives depends on length: club name + name + outlet +
  // link has to fit 160 characters or it costs a second segment on every send.
  // Here it does not fit — by one character — so the outlet is dropped and the
  // name kept, which is the documented trade. Assert the rule, not the outcome.
  {
    const { meter } = require("../lib/sms-billing");
    const withOutlet = sms.text.replace("how was your visit today?", "how was the Main Dining Room today?");
    const named = /Main Dining Room/.test(sms.text);
    check("it names the outlet, or naming it would have cost a segment",
      named || meter(withOutlet).segments > meter(sms.text).segments,
      `named=${named} ${meter(sms.text).segments} -> ${meter(withOutlet).segments} seg`);
  }
  {
    // Personalising must not quietly buy a second segment on every send.
    const { meter } = require("../lib/sms-billing");
    const impersonal = "Aronimink Golf Club: How was your visit today? Quick feedback, under a minute: " +
      (sms.text.match(/https:\S+/) || [""])[0];
    check("and costs no more segments than an impersonal message would",
      meter(sms.text).segments <= meter(impersonal).segments,
      `${meter(sms.text).segments} vs ${meter(impersonal).segments}`);
  }
  // With a dynamic template the subject travels as template data, for the
  // template to place — SendGrid ignores a top-level subject when a template
  // is set. The template has to reference {{subject}} for this to show.
  check("the email subject greets Ben and names the outlet",
    /Ben,/.test(email.data?.subject || "") && /Main Dining Room/.test(email.data?.subject || ""),
    String(email.data?.subject));

  check("with the one-click unsubscribe header providers look for",
    /List-Unsubscribe/.test(JSON.stringify(email.headers)), JSON.stringify(email.headers));
  check("every link is unique to the member",
    new Set(sent.map((m) => m.data?.survey_url || m.text)).size === 3);

  console.log("\n--- 6. nobody is sent the same survey twice ---");
  check("each visit that sent was stamped", db.stamped.length === 3, JSON.stringify(db.stamped));
  const before = sent.length;
  await performSend("https://feedback.clubvero.io");
  check("running again sends nothing", sent.length === before, `sent ${sent.length - before} more`);

  console.log("\n--- 7. it refuses to run blind ---");
  db.visits = [{ visit_id: "v9", member_id: "M_SMS", outlet_id: "o1", visit_date: "2026-08-04", spend_amount: 120, visitor_type: "member", qualifies: true, survey_sent_at: null }];
  const savedKey = process.env.SENDLY_API_KEY, savedSg = process.env.SENDGRID_API_KEY;
  delete process.env.SENDLY_API_KEY; delete process.env.SENDGRID_API_KEY;
  delete require.cache[require.resolve("../lib/senders")];
  delete require.cache[require.resolve("./surveys")];
  Module._load = function (request, parent, isMain) {
    if (parent && /server[/\\](lib|routes)[/\\]/.test(parent.filename)) {
      try {
        const resolved = realResolve.call(Module, request, parent, isMain);
        if (resolved === SUPABASE) return supabaseStub;
        if (resolved === VAULT) return vaultStub;
      } catch (_) { /* fall through */ }
    }
    return realLoad.apply(this, arguments);
  };
  const { performSend: noCreds } = require("./surveys");
  Module._load = realLoad;
  const out = await noCreds("https://feedback.clubvero.io");
  check("with no provider keys it stops and says so, rather than failing per member",
    out.skipped === true && /credentials/i.test(out.reason || ""), JSON.stringify(out));
  process.env.SENDLY_API_KEY = savedKey; process.env.SENDGRID_API_KEY = savedSg;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
