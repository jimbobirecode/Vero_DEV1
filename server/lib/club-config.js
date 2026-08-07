const CLUB_NAME = process.env.CLUB_NAME || "Aronimink Golf Club";
const CLUB_ID_SLUG = process.env.CLUB_ID_SLUG || "aronimink-gc";

// CLUB_ID, but only when it is actually a UUID.
//
// Several columns are typed `uuid` — message_log.club_id, the credit account
// and its ledger — and Postgres rejects anything that is not one. A deployment
// with CLUB_ID set to a human label like "DEV" therefore fails every insert
// that carries it, which is exactly what happened: message_log stopped
// recording sends entirely, silently, because the failure was logged to the
// server console and nowhere a person would look.
//
// A label is a perfectly reasonable thing to put in an env var, and the app is
// single-club anyway, so a non-UUID value is treated as "no club id" rather
// than being allowed to poison every write. It is announced loudly once at
// startup, and surfaced on the credit screen, so it reads as a setting to fix
// rather than as a silent downgrade.
//
// CLUB_ID_SLUG above is the human-facing identifier and is unaffected — it is
// never written to a uuid column.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RAW_CLUB_ID = (process.env.CLUB_ID || "").trim();
const CLUB_UUID = UUID_RE.test(RAW_CLUB_ID) ? RAW_CLUB_ID : null;

// Non-empty but not a UUID: the operator meant something by it, and it is not
// going to work. Distinguished from simply unset, which is a normal
// single-club configuration and deserves no warning at all.
const CLUB_ID_INVALID = RAW_CLUB_ID !== "" && CLUB_UUID === null;

if (CLUB_ID_INVALID) {
  console.error(
    `[club-config] CLUB_ID is set to ${JSON.stringify(RAW_CLUB_ID)}, which is not a UUID. ` +
    `Columns typed uuid cannot store it, so it is being ignored and this deployment is treated as single-club. ` +
    `Either set CLUB_ID to the uuid from your club_integrations row, or unset it — but do not leave it as a label.`
  );
}

module.exports = { CLUB_NAME, CLUB_ID_SLUG, CLUB_UUID, CLUB_ID_INVALID, RAW_CLUB_ID };
