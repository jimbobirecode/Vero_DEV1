// Tests for turning parsed POS rows into visits: outlet matching, member
// resolution, and the eligibility rules.
//
// Runs against a stub Supabase rather than a live one, so it exercises the
// decisions this module makes without needing a database.

const { ingestRows, resolveMember, normalizeDate } = require("./ingest");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// --- a Supabase stand-in covering the query shapes this module builds -------

function stubSupabase({ members = [], outlets = [] }) {
  const inserts = [];

  const api = {
    inserts,
    from(table) {
      const eqs = [];
      let orExpr = null;

      const run = () => {
        if (table === "outlets") {
          return outlets.filter((o) => o.active !== false);
        }
        if (table === "members") {
          if (orExpr) {
            // and(first_name.ilike.A,last_name.ilike.B),and(first_name.ilike.B,last_name.ilike.A)
            const names = [...orExpr.matchAll(/ilike\.([^,)]+)/g)].map((m) => m[1].toLowerCase());
            const wanted = new Set(names);
            return members.filter((m) =>
              wanted.has(String(m.first_name).toLowerCase()) &&
              wanted.has(String(m.last_name).toLowerCase()));
          }
          return members.filter((m) => eqs.every(([c, v]) => String(m[c]) === String(v)));
        }
        return [];
      };

      const builder = {
        select() { return builder; },
        eq(col, val) { eqs.push([col, val]); return builder; },
        or(expr) { orExpr = expr; return builder; },
        limit() { return Promise.resolve({ data: run(), error: null }); },
        maybeSingle() { return Promise.resolve({ data: run()[0] || null, error: null }); },
        insert(obj) { inserts.push(obj); return Promise.resolve({ error: null }); },
        then(res, rej) { return Promise.resolve({ data: run(), error: null }).then(res, rej); },
      };
      return builder;
    },
  };
  return api;
}

const MEMBERS = [
  { member_id: "1042", first_name: "Karl", last_name: "Krietsch" },
  { member_id: "876", first_name: "Robert", last_name: "Norton" },
  { member_id: "1155", first_name: "Cynthia", last_name: "Pettit" },
  { member_id: "W135", first_name: "Keith", last_name: "Wilson" },
  // Two members sharing a name — a name lookup must refuse to guess.
  { member_id: "2001", first_name: "John", last_name: "Smith" },
  { member_id: "2002", first_name: "John", last_name: "Smith" },
];

const OUTLETS = [
  { outlet_id: "o1", name: "Grill Room", min_spend_threshold: "50.00", frequency_limit_days: 30 },
  { outlet_id: "o2", name: "Halfway House", min_spend_threshold: "15.00", frequency_limit_days: 30 },
  { outlet_id: "o3", name: "Bar & Grill", min_spend_threshold: "20.00", frequency_limit_days: 30 },
];

const db = () => stubSupabase({ members: MEMBERS, outlets: OUTLETS });

(async () => {
  // ------------------------------------------------------ member matching ---

  const s = db();
  check("member: exact number",
    (await resolveMember(s, { memberId: "1042" }))?.member_id, "1042");

  // Jonas and NorthStar both suffix a spouse's charge onto the base account.
  check("member: spouse suffix falls back to the base account",
    (await resolveMember(s, { memberId: "1155-S" }))?.member_id, "1155");
  check("member: dotted dependant suffix falls back too",
    (await resolveMember(s, { memberId: "1155.1" }))?.member_id, "1155");

  // Jonas zero-pads account numbers in some report layouts but not others.
  check("member: zero-padded number matches the unpadded record",
    (await resolveMember(s, { memberId: "0876" }))?.member_id, "876");

  // Lightspeed often carries a name and no customer record.
  check("member: name only, 'Last, First'",
    (await resolveMember(s, { memberName: "Krietsch, Karl" }))?.member_id, "1042");
  check("member: name only, 'First Last'",
    (await resolveMember(s, { memberName: "Karl Krietsch" }))?.member_id, "1042");

  // The guard that matters: two members share a name, so surveying either one
  // is a coin flip. Refuse.
  check("member: an ambiguous name is not matched",
    await resolveMember(s, { memberName: "John Smith" }), null);

  check("member: an unknown number is not matched",
    await resolveMember(s, { memberId: "9999" }), null);
  check("member: a single word is not enough to match",
    await resolveMember(s, { memberName: "Krietsch" }), null);

  // A name carrying PostgREST's own delimiters must not break out of the
  // or() filter it is interpolated into.
  check("member: a name with filter syntax in it is neutralised",
    await resolveMember(s, { memberName: "Smith,John),or(member_id.eq.1042" }), null);

  // --------------------------------------------------------------- dates ---

  check("date: ISO passes through", normalizeDate("2026-07-29"), "2026-07-29");
  check("date: US slashes convert", normalizeDate("07/29/2026"), "2026-07-29");
  check("date: a blank date falls back to today",
    normalizeDate(""), new Date().toISOString().split("T")[0]);

  // ------------------------------------------------------------- ingest ----

  const s2 = db();
  const result = await ingestRows([
    // over the Grill Room's $50 threshold
    { member_id: "1042", member_name: "Krietsch, Karl", outlet_name: "Grill Room", spend_amount: "100.00", visit_date: "2026-07-29", server_name: "Ava", checks: 2 },
    // under it
    { member_id: "876", member_name: "Norton, Robert", outlet_name: "Grill Room", spend_amount: "14.00", visit_date: "2026-07-29" },
    // over the Halfway House's $15, and via the spouse suffix
    { member_id: "1155-S", member_name: "Pettit, Cynthia", outlet_name: "Halfway House", spend_amount: "17.00", visit_date: "2026-07-29" },
    // the outlet is spelled differently by the POS than by the club
    { member_id: "W135", member_name: "Wilson, Keith", outlet_name: "THE BAR AND GRILL", spend_amount: "40.00", visit_date: "2026-07-29" },
    // a member the club does not have
    { member_id: "9999", member_name: "Nobody, Ann", outlet_name: "Grill Room", spend_amount: "88.00", visit_date: "2026-07-29" },
    // an outlet the club has not set up
    { member_id: "1042", member_name: "Krietsch, Karl", outlet_name: "Cigar Terrace", spend_amount: "60.00", visit_date: "2026-07-29" },
    // three small checks that still do not reach the threshold together
    { member_id: "W135", member_name: "Wilson, Keith", outlet_name: "Grill Room", spend_amount: "31.00", visit_date: "2026-07-29", checks: 3 },
  ], s2);

  check("ingest: creates a visit per resolvable row", result.created, 6);
  check("ingest: queues only the ones over threshold", result.qualified, 3);
  check("ingest: skips the unknown outlet", result.skipped.length, 1);
  check("ingest: says which outlet was unknown",
    result.skipped[0].reason, "Unknown outlet: Cigar Terrace");
  check("ingest: counts the unrecognised member", result.unknown_members, 1);
  check("ingest: no insert errors", result.errors.length, 0);

  const ins = s2.inserts;
  check("ingest: resolves the spouse charge onto the base account",
    ins.find((v) => v.spend_amount === 17).member_id, "1155");
  check("ingest: matches an outlet the POS spells differently",
    ins.find((v) => v.spend_amount === 40).outlet_id, "o3");
  check("ingest: an under-threshold visit is recorded but not queued",
    [ins.find((v) => v.spend_amount === 14).qualifies, ins.find((v) => v.spend_amount === 14).member_id],
    [false, "876"]);

  // The rule that keeps the queue sendable: an unknown member has no phone or
  // email anywhere in the system, so queueing them guarantees a stuck row.
  const stranger = ins.find((v) => v.spend_amount === 88);
  check("ingest: an unrecognised member is never queued",
    [stranger.qualifies, stranger.visitor_type, stranger.member_id, stranger.guest_name],
    [false, "other", null, "Nobody, Ann"]);
  check("ingest: and the reason says so",
    /not in your member list/.test(result.details.find((d) => d.spend === "88.00").reason), true);

  // When several checks were folded into one visit and it still misses the
  // threshold, the manager needs to see that the figure is already a total.
  check("ingest: a merged visit says how many checks it combined",
    result.details.find((d) => d.spend === "31.00").reason,
    "Below $50.00 threshold (3 checks combined)");

  // Two outlets that normalise to the same name must not be silently picked
  // between — the club has to be the one to disambiguate.
  const ambiguous = stubSupabase({
    members: MEMBERS,
    outlets: [
      { outlet_id: "a", name: "Grill Room", min_spend_threshold: "10.00" },
      { outlet_id: "b", name: "GRILL-ROOM", min_spend_threshold: "90.00" },
    ],
  });
  const amb = await ingestRows(
    [{ member_id: "1042", outlet_name: "the grill room", spend_amount: "50.00", visit_date: "2026-07-29" }],
    ambiguous);
  check("ingest: refuses to guess between two outlets that normalise alike",
    amb.skipped.length, 1);
  // An exact spelling still resolves, even while its twin exists.
  const exact = await ingestRows(
    [{ member_id: "1042", outlet_name: "Grill Room", spend_amount: "50.00", visit_date: "2026-07-29" }],
    ambiguous);
  check("ingest: an exact outlet name still resolves", exact.created, 1);

  // A negative day — every check reversed — must not be queued as a visit
  // worth surveying.
  const negative = db();
  const neg = await ingestRows(
    [{ member_id: "1042", outlet_name: "Grill Room", spend_amount: "-25.00", visit_date: "2026-07-29" }],
    negative);
  check("ingest: a net-negative day is recorded but not queued", neg.qualified, 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
