// Locks down the SendGrid link-tracking rules. Both call sites — member
// messages in senders.js and internal staff mail in notify.js — must set
// these, or SendGrid applies the account default and rewrites every link
// through the branded tracking domain.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://stub.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "stub";

const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function check(label, cond, detail = "") {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "\n      " + detail : ""}`); }
}

function load(clickFlag) {
  if (clickFlag === undefined) delete process.env.SENDGRID_CLICK_TRACKING;
  else process.env.SENDGRID_CLICK_TRACKING = clickFlag;
  delete require.cache[require.resolve("./senders")];
  return require("./senders").trackingSettings;
}

console.log("\n--- default: click tracking off, so survey links survive ---");
let t = load(undefined);
check("member click tracking off", t().click_tracking.enable === false);
check("plain-text links too", t().click_tracking.enable_text === false);
check("open tracking still on for member mail", t().open_tracking.enable === true);

console.log("\n--- the flag re-enables it for member mail only ---");
t = load("true");
check("member click tracking on", t().click_tracking.enable === true);
check("internal mail stays off regardless", t({ internal: true }).click_tracking.enable === false,
  JSON.stringify(t({ internal: true })));
check("and is not open-tracked either", t({ internal: true }).open_tracking.enable === false);

console.log("\n--- anything other than exactly 'true' leaves it off ---");
for (const v of ["TRUE", "1", "yes", ""]) {
  t = load(v);
  check(`"${v}" does not enable click tracking`, t().click_tracking.enable === false);
}

console.log("\n--- both SendGrid call sites set tracking_settings ---");
// A regression guard: notify.js was written without them, so alert and digest
// emails kept rewriting their dashboard links long after surveys stopped.
for (const file of ["senders.js", "notify.js"]) {
  const src = fs.readFileSync(path.join(__dirname, file), "utf8");
  const callsSendGrid = /api\.sendgrid\.com\/v3\/mail\/send/.test(src);
  check(`${file} calls SendGrid`, callsSendGrid);
  check(`${file} sets tracking_settings`, /tracking_settings/.test(src),
    "a SendGrid payload without it inherits the account default and rewrites links");
}

console.log("\n--- one-click unsubscribe headers ---");
delete require.cache[require.resolve("./senders")];
const { unsubscribeHeaders } = require("./senders");
const h = unsubscribeHeaders("https://club.example/u/abc123");
check("List-Unsubscribe is angle-bracketed per RFC", h["List-Unsubscribe"] === "<https://club.example/u/abc123>", JSON.stringify(h));
check("one-click POST is declared", h["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click");
check("no URL means no headers at all, rather than a broken one",
  unsubscribeHeaders(undefined) === null && unsubscribeHeaders("") === null);

const sendersSrc = fs.readFileSync(path.join(__dirname, "senders.js"), "utf8");
check("the send path attaches them", /payload\.headers\s*=\s*\{[^}]*listHeaders/.test(sendersSrc) || /listHeaders/.test(sendersSrc));
check("and they are built from the unsubscribe_url the sender passes",
  /unsubscribeHeaders\(templateData\?\.unsubscribe_url\)/.test(sendersSrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
