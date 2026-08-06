const { applyMemberCap, parseCapSettings, modalityOf, nextModality } = require("./send-policy.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const v = (id, member, spend, outlet) => ({ visit_id: id, member_id: member, spend_amount: spend, outlets: { name: outlet } });

// A80's real shape: two outlets in one day after same-outlet merging
const a80 = [v("x", "A80", 122.00, "Golf Patio"), v("y", "A80", 41.50, "Belmont Bar")];

const r1 = applyMemberCap(a80, { cap: 1, windowDays: 1 });
eq("cap 1 sends one survey", r1.send.length, 1);
eq("cap 1 keeps the highest-spend visit", r1.send[0].visit_id, "x");
eq("the other is deferred", r1.deferred.length, 1);
eq("deferred names the reason", /highest-spend/.test(r1.deferred[0].reason), true);

const r2 = applyMemberCap(a80, { cap: 2, windowDays: 1 });
eq("cap 2 sends both", r2.send.length, 2);

const r0 = applyMemberCap(a80, { cap: 0, windowDays: 1 });
eq("cap 0 means no limit", r0.send.length, 2);

// members are capped independently of each other
const mixed = [...a80, v("z", "B625", 313, "Golf Patio"), v("w", "B625", 1257.50, "Gary Player Lounge")];
const r3 = applyMemberCap(mixed, { cap: 1, windowDays: 1 });
eq("each member gets their own allowance", r3.send.length, 2);
eq("and each keeps their biggest visit", r3.send.map(x => x.visit_id).sort(), ["w", "x"]);

// the cap must hold across uploads, not just within one batch
const r4 = applyMemberCap(a80, { cap: 1, windowDays: 7, alreadySent: { A80: 1 } });
eq("already surveyed in the window -> nothing sends", r4.send.length, 0);
eq("both deferred", r4.deferred.length, 2);
eq("reason cites the earlier survey", /already received 1 survey/.test(r4.deferred[0].reason), true);

const r5 = applyMemberCap(a80, { cap: 3, windowDays: 7, alreadySent: { A80: 2 } });
eq("partial allowance remaining", r5.send.length, 1);

// guests have no identity to cap against
const guests = [v("g1", null, 90, "Belmont Bar"), v("g2", null, 60, "Golf Patio")];
eq("guests are never capped", applyMemberCap(guests, { cap: 1, windowDays: 1 }).send.length, 2);

// a single visit is unaffected whatever the cap
eq("one visit passes through", applyMemberCap([v("s", "K273", 40, "Golf Patio")], { cap: 1, windowDays: 1 }).send.length, 1);

// settings parsing
eq("defaults when unset", parseCapSettings({}), { cap: 1, windowDays: 1 });
eq("reads configured values", parseCapSettings({ member_survey_cap: "2", member_survey_cap_days: "7" }), { cap: 2, windowDays: 7 });
eq("garbage falls back to defaults", parseCapSettings({ member_survey_cap: "abc", member_survey_cap_days: "-3" }), { cap: 1, windowDays: 1 });

console.log("\n--- \"No limit\" in Settings means no limit ---");
{
  const two = [{ member_id: "M", spend_amount: 100 }, { member_id: "M", spend_amount: 40 }];
  const uncapped = parseCapSettings({ member_survey_cap: "0" });
  eq("cap 0 is carried through, not replaced by the default", uncapped.cap, 0);
  eq("and every visit sends", applyMemberCap(two, uncapped).send.length, 2);
  eq("a blank setting falls back to 1", parseCapSettings({}).cap, 1);
  eq("nonsense falls back to 1", parseCapSettings({ member_survey_cap: "abc" }).cap, 1);
  eq("an explicit 2 is honoured", parseCapSettings({ member_survey_cap: "2" }).cap, 2);
  eq("a negative is treated as no limit rather than an error",
    applyMemberCap(two, { cap: -1 }).send.length, 2);
}


// ---------------------------------------------------------- golf / dining ---
//
// A member who plays and then eats generated two surveys. The cap cut it to
// one, but it chose by spend — and a round is recorded with a spend of zero,
// so dining won every time and the golf was never once asked about.

const golf   = (id, member) => ({ visit_id: id, member_id: member, spend_amount: 0, visitor_type: "golf",   outlets: { name: "Golf" } });
const dining = (id, member, spend) => ({ visit_id: id, member_id: member, spend_amount: spend, visitor_type: "member", outlets: { name: "Grill Room" } });

eq("a round is golf", modalityOf({ visitor_type: "golf" }), "golf");
eq("a member visit is dining", modalityOf({ visitor_type: "member" }), "dining");
eq("so is a guest sitting in a restaurant", modalityOf({ visitor_type: "other" }), "dining");

eq("the rotation starts on golf", nextModality(undefined), "golf");
eq("after golf comes dining", nextModality("golf"), "dining");
eq("and back to golf", nextModality("dining"), "golf");

const day = [golf("g1", "M1"), dining("d1", "M1", 145.00)];

// No history: the round wins, even though the meal is worth £145 and the golf
// nothing. This is the case that was broken.
const first = applyMemberCap(day, { cap: 1, windowDays: 1 });
eq("one survey for a day that spans both", first.send.length, 1);
eq("and with no history it asks about the golf", first.send[0].visit_id, "g1");
eq("the meal is deferred, not sent", first.deferred[0].visit.visit_id, "d1");
eq("and the reason says why",
  /same day — asked about golf/.test(first.deferred[0].reason), true);

// Next time, the other one.
const second = applyMemberCap(day, { cap: 1, windowDays: 1, lastModality: { M1: "golf" } });
eq("having last been asked about golf, they get dining", second.send[0].visit_id, "d1");
eq("and the golf is deferred", second.deferred[0].visit.visit_id, "g1");

const third = applyMemberCap(day, { cap: 1, windowDays: 1, lastModality: { M1: "dining" } });
eq("and it loops back to golf", third.send[0].visit_id, "g1");

// The rotation only arbitrates between the two. A day of dining only is still
// settled by spend, as before.
const twoMeals = [dining("m1", "M1", 40), dining("m2", "M1", 180)];
eq("two meals in a day still keeps the larger",
  applyMemberCap(twoMeals, { cap: 1, windowDays: 1 }).send[0].visit_id, "m2");
eq("and the rotation does not claim to have decided it",
  applyMemberCap(twoMeals, { cap: 1, windowDays: 1 }).chosen.length, 0);

// Within the winning side, spend still leads: golf plus two meals, rotation
// says dining, so the bigger meal goes.
const busy = [golf("g2", "M1"), dining("d2", "M1", 30), dining("d3", "M1", 210)];
eq("the larger meal wins once dining is chosen",
  applyMemberCap(busy, { cap: 1, windowDays: 1, lastModality: { M1: "golf" } }).send[0].visit_id, "d3");
eq("and both the round and the smaller meal are deferred",
  applyMemberCap(busy, { cap: 1, windowDays: 1, lastModality: { M1: "golf" } }).deferred.length, 2);

// What the rotation decided, for the caller to record and report.
eq("the choice is reported", first.chosen.length, 1);
eq("naming the modality", first.chosen[0].modality, "golf");
eq("and what the day spanned", first.chosen[0].spanned.sort(), ["dining", "golf"]);

// One member's rotation must not move another's.
const twoMembers = [golf("g3", "M1"), dining("d4", "M1", 90), golf("g4", "M2"), dining("d5", "M2", 90)];
const mixed2 = applyMemberCap(twoMembers, { cap: 1, windowDays: 1, lastModality: { M1: "golf" } });
eq("each member rotates independently",
  mixed2.send.map((x) => x.visit_id).sort(), ["d4", "g4"]);

// A member already at their cap gets nothing, whatever the rotation says —
// the cap is the harder rule.
const capped = applyMemberCap(day, { cap: 1, windowDays: 7, alreadySent: { M1: 1 } });
eq("the cap still overrides the rotation", capped.send.length, 0);
eq("and the reason is the cap, not the rotation",
  /already received/.test(capped.deferred[0].reason), true);

// A raised cap lets both through — the rotation is about choosing when only
// one may go, not about suppressing the second on principle.
eq("a cap of two lets both go",
  applyMemberCap(day, { cap: 2, windowDays: 1 }).send.length, 2);

// Guests carry no identity across days, so there is nothing to rotate.
const guestDay = [
  { visit_id: "gg1", member_id: null, spend_amount: 0, visitor_type: "golf" },
  { visit_id: "gg2", member_id: null, spend_amount: 60, visitor_type: "other" },
];
eq("guests are not rotated", applyMemberCap(guestDay, { cap: 1, windowDays: 1 }).send.length, 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
