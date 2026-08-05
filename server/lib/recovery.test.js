const R = require("./recovery.js");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const H = 3600000;
const T0 = Date.parse("2026-08-01T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

// An alert raised at T0 with a 24h window.
const alert = (over = {}) => ({
  alert_id: "a1", severity: "high", status: "open", member_id: "M1",
  created_at: iso(T0), contact_due_at: iso(T0 + 24 * H),
  first_contact_at: null, first_reached_at: null, outreach_count: 0,
  ...over,
});

// ------------------------------------------------------------- the clock ----

check("sla window comes from settings when set",
  R.slaMinutes("high", { recovery_sla_high_minutes: "60" }), 60);
check("sla window falls back to the default", R.slaMinutes("high", {}), 1440);
check("an unknown severity gets the most generous window", R.slaMinutes("nonsense", {}), 10080);
check("a nonsense setting does not override the default",
  R.slaMinutes("high", { recovery_sla_high_minutes: "not a number" }), 1440);

check("due date is created + window",
  R.contactDueAt(iso(T0), "high", {}), iso(T0 + 24 * H));

check("fresh alert is waiting", R.slaState(alert(), T0 + H).state, "waiting");
check("past halfway it is due", R.slaState(alert(), T0 + 13 * H).state, "due");
check("past 90% it is urgent", R.slaState(alert(), T0 + 22 * H).state, "urgent");
check("past the window it is breached", R.slaState(alert(), T0 + 25 * H).state, "breached");

// The clock stops on contact, and records whether it landed inside the window.
check("contact inside the window is met",
  R.slaState(alert({ first_contact_at: iso(T0 + 5 * H) }), T0 + 30 * H).met, true);
check("contact after the window is not met",
  R.slaState(alert({ first_contact_at: iso(T0 + 30 * H) }), T0 + 40 * H).met, false);
check("time to contact is measured from the alert",
  R.slaState(alert({ first_contact_at: iso(T0 + 5 * H) }), T0 + 30 * H).ms_to_contact, 5 * H);

// An alert from before this shipped has no clock. It must not be silently
// counted as met — that would inflate the headline number with old data.
check("an alert with no due date is unscheduled",
  R.slaState(alert({ contact_due_at: null }), T0).state, "unscheduled");
check("an unscheduled alert is not counted as met",
  R.slaState(alert({ contact_due_at: null }), T0).met, null);

// -------------------------------------------------------------- outcomes ----

check("only 'reached' counts as a conversation", R.isConnected("reached"), true);
check("a voicemail is not a conversation", R.isConnected("left_message"), false);
check("a voicemail is still an attempt", R.isAttempt("left_message"), true);
check("no answer is still an attempt", R.isAttempt("no_answer"), true);
// The club never reached the right person, so the clock should not stop.
check("a wrong number is not an attempt", R.isAttempt("wrong_number"), false);

// ------------------------------------------------------------ escalation ----

check("nothing owed early on", R.escalationStage(alert(), T0 + H), null);
check("half-window nudge", R.escalationStage(alert(), T0 + 13 * H), "half");
check("final nudge", R.escalationStage(alert(), T0 + 22 * H), "final");
check("breach nudge", R.escalationStage(alert(), T0 + 25 * H), "breached");

// The sweep runs hourly; it must not re-send what it already sent.
check("the same stage is not sent twice",
  R.escalationStage(alert({ escalated_stage: "half" }), T0 + 13 * H), null);
check("but the next stage still fires",
  R.escalationStage(alert({ escalated_stage: "half" }), T0 + 22 * H), "final");
check("a late sweep skips straight to the stage now owed",
  R.escalationStage(alert({ escalated_stage: "half" }), T0 + 25 * H), "breached");

check("contacted alerts are never escalated",
  R.escalationStage(alert({ first_contact_at: iso(T0 + H) }), T0 + 25 * H), null);
check("resolved alerts are never escalated",
  R.escalationStage(alert({ status: "resolved" }), T0 + 25 * H), null);

// -------------------------------------------------------------- resolving ---

check("an alert cannot be resolved with the member never contacted",
  R.canResolve(alert()).ok, false);
check("the refusal offers the reasons",
  Object.keys(R.canResolve(alert()).reasons).length > 0, true);
check("contacted alerts resolve freely",
  R.canResolve(alert({ first_contact_at: iso(T0 + H) })).ok, true);
check("an explicit reason resolves it",
  R.canResolve(alert(), { noContactReason: "member_declined" }).ok, true);
check("an invented reason does not",
  R.canResolve(alert(), { noContactReason: "cba" }).ok, false);

// ------------------------------------------------------------- validation ---

check("a valid call logs", R.validateOutreach({ channel: "phone", outcome: "reached" }).ok, true);
check("an unknown channel is rejected",
  R.validateOutreach({ channel: "telepathy", outcome: "reached" }).ok, false);
check("an unknown outcome is rejected",
  R.validateOutreach({ channel: "phone", outcome: "vibes" }).ok, false);
// You cannot report how somebody sounded on a call that never connected.
check("sentiment on an unconnected call is rejected",
  R.validateOutreach({ channel: "phone", outcome: "no_answer", member_sentiment: "recovered" }).ok, false);
check("sentiment on a connected call is fine",
  R.validateOutreach({ channel: "phone", outcome: "reached", member_sentiment: "recovered" }).ok, true);
check("a call cannot have happened tomorrow",
  R.validateOutreach({ channel: "phone", outcome: "reached", occurred_at: iso(Date.now() + 86400000) }).ok, false);
check("a call earlier today is fine",
  R.validateOutreach({ channel: "phone", outcome: "reached", occurred_at: iso(Date.now() - 3600000) }).ok, true);

// ------------------------------------------------------- alert bookkeeping ---

const patch1 = R.alertPatchForOutreach(alert(), { outcome: "left_message", occurred_at: iso(T0 + 2 * H) });
check("a voicemail stops the clock", patch1.first_contact_at, iso(T0 + 2 * H));
check("a voicemail does not record a conversation", patch1.first_reached_at, undefined);
check("a voicemail moves the alert to contacted", patch1.status, "contacted");
check("the attempt is counted", patch1.outreach_count, 1);

const patch2 = R.alertPatchForOutreach(
  alert({ first_contact_at: iso(T0 + 2 * H), status: "contacted", outreach_count: 1 }),
  { outcome: "reached", occurred_at: iso(T0 + 6 * H) });
check("first contact is not overwritten by a later call", patch2.first_contact_at, undefined);
check("the conversation is recorded when it happens", patch2.first_reached_at, iso(T0 + 6 * H));
check("attempts accumulate", patch2.outreach_count, 2);

const patch3 = R.alertPatchForOutreach(alert(), { outcome: "wrong_number", occurred_at: iso(T0 + H) });
check("a wrong number does not stop the clock", patch3.first_contact_at, undefined);
check("a wrong number is still logged as an attempt", patch3.outreach_count, 1);

// A resolved alert that gets a late call keeps its status rather than being
// dragged backwards out of resolved.
const patch4 = R.alertPatchForOutreach(alert({ status: "resolved" }), { outcome: "reached", occurred_at: iso(T0 + H) });
check("a call on a resolved alert does not reopen it", patch4.status, undefined);

// ---------------------------------------------------------------- metrics ---

const NOW = T0 + 100 * H;
const metrics = R.recoveryMetrics([
  // contacted in 5h — inside the 24h window
  alert({ alert_id: "a1", member_id: "M1", first_contact_at: iso(T0 + 5 * H), first_reached_at: iso(T0 + 5 * H), alert_nps: 3 }),
  // contacted in 30h — outside it
  alert({ alert_id: "a2", member_id: "M2", first_contact_at: iso(T0 + 30 * H), first_reached_at: iso(T0 + 30 * H), alert_nps: 4 }),
  // never contacted, window long gone
  alert({ alert_id: "a3", member_id: "M3" }),
  // resolved with a recorded reason — out of the denominator entirely
  alert({ alert_id: "a4", member_id: "M4", status: "resolved", no_contact_reason: "member_declined" }),
], new Map([["M1", 9], ["M2", 2]]), NOW);

check("alerts in scope", metrics.alerts_in_scope, 4);
check("a recorded no-contact reason leaves the denominator", metrics.excluded_no_contact, 1);
check("contacted count", metrics.contacted, 2);
check("only one landed inside the window", metrics.contacted_within_sla, 1);
// 1 of the 3 contactable alerts was contacted in time.
check("headline percentage", metrics.pct_contacted_within_sla, 33);
check("median time to contact, in hours", metrics.median_hours_to_contact, 17.5);
check("one alert is still awaiting contact", metrics.awaiting_contact, 1);
check("and it has breached", metrics.breached, 1);

// M1 went 3 -> 9 (recovered), M2 went 4 -> 2 (did not).
check("recovery is measured only for members actually spoken to", metrics.recovery_measurable, 2);
check("recovered count", metrics.recovery_improved, 1);
check("recovery rate", metrics.pct_recovered, 50);

// An alert still inside its window has not been missed — it can yet be called.
// Counting it against the club would drop the headline every time a new alert
// arrived, which punishes them for having a busy Saturday.
const busy = R.recoveryMetrics([
  // called in time
  alert({ alert_id: "b1", member_id: "M1", first_contact_at: iso(T0 + 2 * H) }),
  // raised an hour ago, 23 hours still to run
  alert({ alert_id: "b2", member_id: "M2", created_at: iso(T0 + 99 * H), contact_due_at: iso(T0 + 123 * H) }),
  alert({ alert_id: "b3", member_id: "M3", created_at: iso(T0 + 99 * H), contact_due_at: iso(T0 + 123 * H) }),
], new Map(), NOW);
check("only alerts whose window has closed are scored", busy.decided, 1);
check("fresh alerts are reported separately", busy.still_in_window, 2);
check("a busy day does not drag the headline down", busy.pct_contacted_within_sla, 100);
check("but they are still shown as awaiting a call", busy.awaiting_contact, 2);

// Nobody has come back yet: that is not a 0% recovery rate.
const early = R.recoveryMetrics(
  [alert({ member_id: "M9", first_contact_at: iso(T0 + H), first_reached_at: iso(T0 + H), alert_nps: 2 })],
  new Map(), NOW);
check("no follow-up survey yet reports null, not zero", early.pct_recovered, null);
check("and says how many are measurable", early.recovery_measurable, 0);

check("an empty period does not divide by zero",
  R.recoveryMetrics([], new Map(), NOW).pct_contacted_within_sla, null);

// ------------------------------------------------------------- resolution ---

const RES = { root_cause: "service_speed", action_taken: "coached_staff" };

check("a resolution needs both a cause and an action", R.validateResolution(RES).ok, true);
check("without a cause it is refused", R.validateResolution({ action_taken: "coached_staff" }).ok, false);
check("without an action it is refused", R.validateResolution({ root_cause: "service_speed" }).ok, false);
check("an invented cause is refused", R.validateResolution({ ...RES, root_cause: "gremlins" }).ok, false);

check("goodwill is optional",
  R.validateResolution({ ...RES, goodwill_type: "comped_visit", goodwill_amount: 84.50 }).ok, true);
check("an amount is carried through",
  R.validateResolution({ ...RES, goodwill_type: "comped_visit", goodwill_amount: "84.50" }).resolution.goodwill_amount, 84.5);
// An amount with nothing to attach it to would quietly inflate the total spend.
check("an amount with no goodwill type is refused",
  R.validateResolution({ ...RES, goodwill_amount: 40 }).ok, false);
check("an amount against 'nothing' is refused",
  R.validateResolution({ ...RES, goodwill_type: "none", goodwill_amount: 40 }).ok, false);
check("a negative amount is refused",
  R.validateResolution({ ...RES, goodwill_type: "gift", goodwill_amount: -5 }).ok, false);

// Closing a case nobody rang has to say why, on the same form.
check("an uncontacted case needs a no-contact reason",
  R.validateResolution(RES, { requireNoContactReason: true }).ok, false);
check("and accepts a valid one",
  R.validateResolution({ ...RES, no_contact_reason: "member_declined" }, { requireNoContactReason: true }).ok, true);
check("but not an invented one",
  R.validateResolution({ ...RES, no_contact_reason: "busy" }, { requireNoContactReason: true }).ok, false);

// --- the reporting rollup
const summary = R.resolutionSummary([
  { root_cause: "service_speed",   action_taken: "coached_staff",  goodwill_type: "comped_visit",  goodwill_amount: 80 },
  { root_cause: "service_speed",   action_taken: "staffing_changed" },
  { root_cause: "service_speed",   action_taken: "coached_staff",  goodwill_type: "comped_item",   goodwill_amount: 20 },
  { root_cause: "food_quality",    action_taken: "supplier_or_stock" },
  { root_cause: "cleanliness",     action_taken: "process_changed", goodwill_type: "none" },
]);
check("counts every resolution", summary.resolved, 5);
check("the biggest cause comes first", summary.root_causes[0].key, "service_speed");
check("with its share", summary.root_causes[0].pct, 60);
check("causes are labelled for display", summary.root_causes[0].label, "Slow service");
check("actions are tallied too", summary.actions_taken[0].key, "coached_staff");
check("goodwill totals", summary.goodwill_total, 100);
check("only the cases that cost something are counted", summary.goodwill_cases, 2);
// Averaged over the two that cost money, not over all five — otherwise the
// figure describes how often the club spends, not how much.
check("the average is per paying case", summary.goodwill_average, 50);
check("a period with no spend reports zero, and no average",
  [R.resolutionSummary([{ root_cause: "other", action_taken: "no_action" }]).goodwill_total,
   R.resolutionSummary([{ root_cause: "other", action_taken: "no_action" }]).goodwill_average], [0, null]);
check("an empty period does not divide by zero", R.resolutionSummary([]).resolved, 0);

// -------------------------------------------------------------- the queue ---

const q = [
  alert({ alert_id: "later", contact_due_at: iso(T0 + 48 * H) }),
  alert({ alert_id: "overdue", contact_due_at: iso(T0 - 2 * H) }),
  alert({ alert_id: "done", first_contact_at: iso(T0) }),
  alert({ alert_id: "soon", contact_due_at: iso(T0 + 2 * H) }),
].sort((a, b) => R.queueRank(a, T0) - R.queueRank(b, T0));
check("the queue puts the most overdue first and the contacted last",
  q.map((a) => a.alert_id), ["overdue", "soon", "later", "done"]);

check("remaining time reads in hours", R.formatRemaining(5 * H + 30 * 60000), "5h 30m left");
check("under an hour reads in minutes", R.formatRemaining(45 * 60000), "45m left");
check("over a day reads in days", R.formatRemaining(30 * H), "1d 6h left");
check("overdue says so", R.formatRemaining(-2 * H), "2h 0m overdue");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
