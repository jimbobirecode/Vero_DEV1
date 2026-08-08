// The shared type vocabulary.
//
// This list was written out three times — VALID_TYPES in routes/visits.js, a
// check constraint in schema.sql, and <option> tags in the dashboard — and had
// already drifted: the dropdown omitted 'golf' with nothing recording whether
// that was deliberate. These tests hold the copies that remain in agreement.
const fs = require("fs");
const path = require("path");
const T = require("./person-types.js");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// ------------------------------------------------------------- the list ----

check("the vocabulary is the one visits already used",
  T.VALUES, ["member", "visitor", "commercial", "other", "golf"]);
check("every type has a label", T.TYPES.every((t) => !!t.label), true);
check("and says what it is for", T.TYPES.every((t) => !!t.describes), true);

// The distinction the dropdown was making silently: golf visits are created by
// the tee sheet importer, never typed into a form.
check("golf is valid but not offered as an option", T.isValid("golf"), true);
check("and is excluded from the selectable list",
  T.selectableOptions().some((o) => o.value === "golf"), false);
check("the four selectable types are what a form shows",
  T.selectableOptions().map((o) => o.value), ["member", "visitor", "commercial", "other"]);

// ---------------------------------------------------------- normalising ----

check("a known value passes through", T.normalise("commercial"), "commercial");
check("case and padding are forgiven", T.normalise("  Commercial "), "commercial");
// A CRM export decides its own vocabulary; mapping beats discarding.
check("guest means visitor", T.normalise("guest"), "visitor");
check("corporate means commercial", T.normalise("corporate"), "commercial");
check("company means commercial", T.normalise("Company"), "commercial");
// Losing a member import over a spelling is worse than filing them commonly.
check("something unrecognised falls back rather than failing", T.normalise("vip"), "member");
check("nothing falls back too", T.normalise(null), "member");
check("an empty string falls back", T.normalise(""), "member");
check("a caller may choose its own fallback", T.normalise("nonsense", "other"), "other");

check("an invalid value is reported as invalid", T.isValid("vip"), false);
check("and so is nothing", T.isValid(undefined), false);

check("a label is available for a stored value", T.labelFor("commercial"), "Commercial");
check("including one no form offers", T.labelFor("golf"), "Golf");
check("an unknown value labels as itself rather than blank", T.labelFor("vip"), "vip");

// ------------------------------------------------ the copies that remain ----
//
// Two definitions still have to exist: SQL cannot import a JS module. These
// assert they say the same thing, so a type added here without a matching
// constraint change fails a test rather than a production insert.

const migration = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "member-types.sql"), "utf8");

function constraintValues(sql, constraintName) {
  const re = new RegExp(constraintName + "[\\s\\S]*?check\\s*\\(([\\s\\S]*?)\\);", "i");
  const m = re.exec(sql);
  if (!m) return null;
  return (m[1].match(/'([a-z_]+)'/g) || []).map((s) => s.replace(/'/g, ""));
}

check("the members constraint allows exactly the shared list",
  constraintValues(migration, "members_member_type_check"), T.VALUES);
check("and the visits constraint allows the same",
  constraintValues(migration, "visits_visitor_type_check"), T.VALUES);

// The route must validate against the shared list rather than a local copy.
const visitsRoute = fs.readFileSync(path.join(__dirname, "..", "routes", "visits.js"), "utf8");
check("visits validates against the shared list, not its own array",
  /VALID_TYPES\s*=\s*personTypes\.VALUES/.test(visitsRoute), true);
check("and no longer carries a hardcoded copy",
  /VALID_TYPES\s*=\s*\[/.test(visitsRoute), false);

const membersRoute = fs.readFileSync(path.join(__dirname, "..", "routes", "members.js"), "utf8");
check("members normalises the type through the shared list",
  /personTypes\.normalise/.test(membersRoute), true);

// The dashboard must build its selects rather than hardcode options.
const dashboard = fs.readFileSync(path.join(__dirname, "..", "..", "vero-dashboard.html"), "utf8");
// Counts <select> elements carrying the marker, not every mention of the
// string — the querySelectorAll that fills them contains it too.
check("all three type selects are marked for filling from the server",
  (dashboard.match(/<select[^>]*data-person-types/g) || []).length, 3);
check("and something actually fills them",
  /querySelectorAll\('select\[data-person-types\]'\)/.test(dashboard), true);
check("and no hardcoded visitor-type options remain",
  /<option value="commercial">/.test(dashboard), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
