// CLUB_ID normalisation.
//
// message_log.club_id and the credit tables are all typed `uuid`. A CLUB_ID set
// to a human label — "DEV", a club name, a slug — is rejected by Postgres on
// every insert that carries it. That is exactly what happened on the demo
// deployment: CLUB_ID was "DEV", so message_log stopped recording sends
// entirely and the credit account could never be created, with the only trace a
// line in the server log.
//
// A label is a reasonable thing to put in an env var, and the app is
// single-club regardless, so a non-uuid value is ignored rather than allowed to
// poison every write — but loudly, never silently.

const path = require("path");
const CONFIG = path.join(__dirname, "club-config.js");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// Reload with a given CLUB_ID, capturing anything written to the console.
function withClubId(value) {
  delete require.cache[require.resolve(CONFIG)];
  if (value === undefined) delete process.env.CLUB_ID;
  else process.env.CLUB_ID = value;

  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    return { ...require(CONFIG), errors };
  } finally {
    console.error = original;
  }
}

const REAL = "0f8c2a41-7b6e-4c19-9a3d-1e5b7c2d4f60";

// --------------------------------------------------------------- accepted ---

check("a real uuid is kept", withClubId(REAL).CLUB_UUID, REAL);
check("and is not flagged", withClubId(REAL).CLUB_ID_INVALID, false);
check("an uppercase uuid is still a uuid", withClubId(REAL.toUpperCase()).CLUB_UUID, REAL.toUpperCase());
check("surrounding whitespace is trimmed, not rejected", withClubId(`  ${REAL}  `).CLUB_UUID, REAL);

// ---------------------------------------------------------------- unset ----

check("unset means no club id", withClubId(undefined).CLUB_UUID, null);
check("which is a normal single-club setup, not a fault", withClubId(undefined).CLUB_ID_INVALID, false);
check("and says nothing", withClubId(undefined).errors, []);
check("an empty string is the same as unset", withClubId("").CLUB_ID_INVALID, false);
check("as is whitespace", withClubId("   ").CLUB_ID_INVALID, false);

// --------------------------------------------------------------- rejected --
// The live failure.

check("a label is not used as a uuid", withClubId("DEV").CLUB_UUID, null);
check("and is flagged as a misconfiguration", withClubId("DEV").CLUB_ID_INVALID, true);
check("the raw value is kept so it can be shown back", withClubId("DEV").RAW_CLUB_ID, "DEV");
check("and it is announced rather than swallowed",
  withClubId("DEV").errors.some((e) => e.includes("not a UUID")), true);
check("the warning quotes the offending value",
  withClubId("DEV").errors.some((e) => e.includes('"DEV"')), true);
check("and says what to do about it",
  withClubId("DEV").errors.some((e) => e.includes("club_integrations")), true);

check("a slug is rejected too", withClubId("aronimink-gc").CLUB_UUID, null);
check("as is a nearly-right uuid", withClubId(REAL.slice(0, -1)).CLUB_UUID, null);
check("and one with a bad character", withClubId(REAL.replace("0f", "zz")).CLUB_UUID, null);

// The human-facing identifier is a different setting and must be untouched by
// any of this — it is never written to a uuid column.
check("the slug setting is unaffected by an invalid CLUB_ID",
  typeof withClubId("DEV").CLUB_ID_SLUG, "string");
check("and so is the club name", typeof withClubId("DEV").CLUB_NAME, "string");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
