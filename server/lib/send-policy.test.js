const { applyMemberCap, parseCapSettings } = require("./send-policy.js");

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
