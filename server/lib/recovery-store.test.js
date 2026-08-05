// Covers the writes service recovery makes, against a stub Supabase.
//
// The rules themselves are tested in recovery.test.js. What matters here is
// that logging a call actually moves the alert, that it does the same thing
// whichever door it comes through, and that the follow-up score used for the
// recovery rate is the survey the member submitted *after* the call — not the
// one that raised the alert in the first place.
process.env.SUPABASE_URL = "https://p";
process.env.SUPABASE_SERVICE_ROLE_KEY = "s";

let ALERTS = [], OUTREACH = [], SETTINGS = [], RESPONSES = [], RESOLUTIONS = [];
const WRITES = { alert_outreach: [], case_alerts: [], case_resolutions: [] };

const Module = require("module");
const rr = Module._resolveFilename;
Module._resolveFilename = function (r, ...x) {
  if (r.endsWith("lib/supabase") || r === "./supabase" || r === "../lib/supabase") return "SB";
  return rr.call(this, r, ...x);
};

function tableData(table) {
  return { case_alerts: ALERTS, alert_outreach: OUTREACH, club_settings: SETTINGS, survey_responses: RESPONSES, case_resolutions: RESOLUTIONS }[table] || [];
}

function from(table) {
  const eqs = [];
  const api = {
    select: () => api,
    eq: (c, v) => { eqs.push([c, v]); return api; },
    neq: () => api, gte: () => api, not: () => api, is: () => api,
    like: () => api, in: () => api, order: () => api, limit: () => api,
    maybeSingle: () => Promise.resolve({ data: rows()[0] || null, error: null }),
    single: () => Promise.resolve({ data: rows()[0] || null, error: null }),
    insert: (row) => {
      WRITES[table]?.push({ op: "insert", row });
      const stored = { outreach_id: "o" + (OUTREACH.length + 1), resolution_id: "r" + (RESOLUTIONS.length + 1), ...row };
      if (table === "alert_outreach") OUTREACH.push(stored);
      if (table === "case_resolutions") RESOLUTIONS.push(stored);
      return {
        select: () => ({ single: () => Promise.resolve({ data: stored, error: null }) }),
        then: (res) => res({ data: stored, error: null }),
      };
    },
    // Filters can be added after update(), and in any order — .eq().is() is
    // what supersedeResolution builds. The write is applied on await, once
    // every filter has been collected, rather than on each chained call.
    update: (patch) => {
      const chain = {
        eq: (c, v) => { eqs.push([c, v]); return chain; },
        is: (c, v) => { eqs.push([c, v]); return chain; },
        then: (res) => {
          WRITES[table]?.push({ op: "update", patch, where: [...eqs] });
          for (const row of tableData(table)) {
            const matches = eqs.every(([c, v]) =>
              v === null ? (row[c] === null || row[c] === undefined) : String(row[c]) === String(v));
            if (matches) Object.assign(row, patch);
          }
          return res({ error: null });
        },
      };
      return chain;
    },
    then: (res) => res({ data: rows(), error: null }),
  };
  const rows = () => tableData(table).filter((r) => eqs.every(([c, v]) => String(r[c]) === String(v)));
  return api;
}

require.cache["SB"] = { id: "SB", filename: "SB", loaded: true, exports: { supabase: { from } } };

const store = require("./recovery-store.js");
const recovery = require("./recovery.js");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const H = 3600000;
const T0 = Date.parse("2026-08-01T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

const baseAlert = (over = {}) => ({
  alert_id: "a1", severity: "high", status: "open",
  created_at: iso(T0), contact_due_at: iso(T0 + 24 * H),
  first_contact_at: null, first_reached_at: null, outreach_count: 0,
  recovery_token: null, assigned_to_staff_id: null,
  survey_responses: { q1_nps: 2, q2_overall_stars: 1, q5_comment: "Cold food, slow service.",
    visits: { visit_date: "2026-08-01", member_id: "M1",
      members: { first_name: "Karl", last_name: "Krietsch", phone_number: "+15551234", email_address: null } } },
  outlets: { name: "Grill Room" },
  ...over,
});

const reset = () => {
  ALERTS = [baseAlert()];
  OUTREACH = []; RESPONSES = []; RESOLUTIONS = [];
  SETTINGS = [{ key: "recovery_sla_high_minutes", value: "1440" }];
  WRITES.alert_outreach = []; WRITES.case_alerts = []; WRITES.case_resolutions = [];
  store.resetReadyCache();
};

(async () => {
  reset();

  // --- the join is flattened into the shape the rules expect
  const { alert } = await store.alertForRecovery("a1");
  check("member is lifted out of the nested join", alert.member_id, "M1");
  check("member name is assembled", alert.member_name, "Karl Krietsch");
  check("phone is lifted for the call sheet", alert.member_phone, "+15551234");
  check("outlet is flattened", alert.outlet_name, "Grill Room");
  check("the score that raised the alert is kept for the recovery comparison", alert.alert_nps, 2);

  // --- settings
  check("sla settings load keyed by name",
    await store.loadSlaSettings(), { recovery_sla_high_minutes: "1440" });

  // --- logging a call moves the alert
  reset();
  const { alert: a1 } = await store.alertForRecovery("a1");
  const logged = await store.logOutreach(a1, { channel: "phone", outcome: "reached", member_sentiment: "recovered",
    notes: "Apologised, comped their next lunch." }, { staff_id: "s1", name: "Sarah Kim", via: "dashboard" });

  check("the call is recorded", logged.error || null, null);
  check("it names who logged it", WRITES.alert_outreach[0].row.logged_by_name, "Sarah Kim");
  check("and which door it came through", WRITES.alert_outreach[0].row.logged_via, "dashboard");
  check("it carries the member for later analysis", WRITES.alert_outreach[0].row.member_id, "M1");

  const patch = WRITES.case_alerts[0].patch;
  check("the clock stops", Boolean(patch.first_contact_at), true);
  check("the conversation is recorded", Boolean(patch.first_reached_at), true);
  check("the alert moves to contacted", patch.status, "contacted");
  check("the attempt is counted", patch.outreach_count, 1);

  // --- a second attempt does not rewrite the first
  reset();
  ALERTS = [baseAlert({ first_contact_at: iso(T0 + 2 * H), status: "contacted", outreach_count: 1 })];
  const { alert: a2 } = await store.alertForRecovery("a1");
  await store.logOutreach(a2, { channel: "phone", outcome: "reached" }, { via: "one_tap" });
  const patch2 = WRITES.case_alerts[0].patch;
  check("first contact is preserved", patch2.first_contact_at, undefined);
  check("the later conversation is still recorded", Boolean(patch2.first_reached_at), true);
  check("attempts accumulate", patch2.outreach_count, 2);

  // --- a wrong number is logged but does not stop the clock
  reset();
  const { alert: a3 } = await store.alertForRecovery("a1");
  await store.logOutreach(a3, { channel: "phone", outcome: "wrong_number" }, {});
  check("a wrong number is still recorded", WRITES.alert_outreach.length, 1);
  check("but the member is not marked as contacted",
    WRITES.case_alerts[0].patch.first_contact_at, undefined);

  // --- invalid input never reaches the table
  reset();
  const { alert: a4 } = await store.alertForRecovery("a1");
  const bad = await store.logOutreach(a4, { channel: "carrier_pigeon", outcome: "reached" }, {});
  check("an unknown channel is refused", bad.status, 400);
  check("and nothing is written", WRITES.alert_outreach.length, 0);

  const bad2 = await store.logOutreach(a4, { channel: "phone", outcome: "no_answer", member_sentiment: "recovered" }, {});
  check("a read on how somebody sounded needs a call that connected", bad2.status, 400);

  // --- an alert raised before this shipped gets a clock on the way past
  reset();
  ALERTS = [baseAlert({ contact_due_at: null })];
  const { alert: a5 } = await store.alertForRecovery("a1");
  const dated = await store.ensureDueDate(a5, { recovery_sla_high_minutes: "1440" });
  check("a missing due date is filled in", Boolean(dated.contact_due_at), true);
  check("and it is written back", WRITES.case_alerts[0].patch.contact_due_at, dated.contact_due_at);

  // A resolved alert is left alone: inventing a due date for closed history
  // would corrupt the metric this exists to report.
  reset();
  ALERTS = [baseAlert({ contact_due_at: null, status: "resolved" })];
  const { alert: a6 } = await store.alertForRecovery("a1");
  await store.ensureDueDate(a6, {});
  check("resolved history is not back-dated", WRITES.case_alerts.length, 0);

  // --- one-tap token
  reset();
  const token = await store.ensureRecoveryToken("a1", null);
  check("a token is minted when there isn't one", typeof token, "string");
  check("an existing token is reused", await store.ensureRecoveryToken("a1", "keep-me"), "keep-me");

  // --- the recovery rate uses the survey that came AFTER the call
  reset();
  const alerts = [{
    alert_id: "a1", member_id: "M1", created_at: iso(T0),
    first_reached_at: iso(T0 + 5 * H), alert_nps: 2,
  }];
  RESPONSES = [
    // the response that raised the alert — must not be read as recovery
    { q1_nps: 2, submitted_at: iso(T0 - H), visits: { member_id: "M1" } },
    // their next visit, after the call
    { q1_nps: 9, submitted_at: iso(T0 + 200 * H), visits: { member_id: "M1" } },
  ];
  const follow = await store.followUpScores(alerts);
  check("the follow-up score is the one after the call", follow.get("M1"), 9);

  // A member who has not come back yet has no follow-up score at all, which
  // is different from having come back and scored badly.
  reset();
  RESPONSES = [{ q1_nps: 2, submitted_at: iso(T0 - H), visits: { member_id: "M1" } }];
  const none = await store.followUpScores(alerts);
  check("no return visit yet means no score", none.has("M1"), false);
  check("and the metric reports it as unmeasurable, not as a failure",
    recovery.recoveryMetrics(
      [{ ...alerts[0], contact_due_at: iso(T0 + 24 * H), first_contact_at: iso(T0 + 5 * H) }],
      none).pct_recovered, null);

  // Members nobody spoke to are never queried for a follow-up score — a
  // recovery rate must only count people who were actually reached.
  reset();
  check("members never reached are not counted",
    (await store.followUpScores([{ alert_id: "a2", member_id: "M2", created_at: iso(T0), first_reached_at: null }])).size, 0);

  // ------------------------------------------------------- resolution ---

  reset();
  const { alert: ra } = await store.alertForRecovery("a1");
  const contacted = { ...ra, first_contact_at: iso(T0 + 2 * H) };

  const savedRes = await store.saveResolution(contacted,
    { root_cause: "service_speed", action_taken: "coached_staff",
      notes: "Spoke to the section. Extra cover on Fridays.",
      goodwill_type: "comped_visit", goodwill_amount: 84.5 },
    { staff_id: "s1", name: "Sarah Kim" });

  check("the resolution saves", savedRes.error || null, null);
  const rrow = WRITES.case_resolutions[0].row;
  check("it records what went wrong", rrow.root_cause, "service_speed");
  check("and what was done", rrow.action_taken, "coached_staff");
  check("and what it cost", rrow.goodwill_amount, 84.5);
  check("and who closed it", rrow.resolved_by_name, "Sarah Kim");
  // Snapshotted at the time of closing, so a later call cannot rewrite the
  // record of whether the loop was closed when the decision was made.
  check("it snapshots that the member had been contacted", rrow.contacted_member, true);
  check("so no no-contact reason is stored", rrow.no_contact_reason, null);

  // Closing without contact stores the reason instead.
  reset();
  const { alert: ra2 } = await store.alertForRecovery("a1");
  await store.saveResolution(ra2,
    { root_cause: "member_expectation", action_taken: "explained_only", no_contact_reason: "member_declined" },
    { name: "Tom Reyes" });
  check("an uncontacted case records that", WRITES.case_resolutions[0].row.contacted_member, false);
  check("with the reason", WRITES.case_resolutions[0].row.no_contact_reason, "member_declined");

  // Reopening supersedes rather than deletes: when the same complaint comes
  // back, what was tried last time is the most useful thing on file.
  reset();
  RESOLUTIONS = [{ resolution_id: "r1", alert_id: "a1", root_cause: "service_speed",
                   action_taken: "coached_staff", superseded_at: null }];
  await store.supersedeResolution("a1");
  check("reopening marks the resolution superseded",
    Boolean(WRITES.case_resolutions[0].patch.superseded_at), true);
  check("it does not delete it", RESOLUTIONS.length, 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
