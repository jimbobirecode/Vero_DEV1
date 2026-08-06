const { routeAlert } = require("./alert-routing");

let pass = 0, fail = 0;
function check(label, cond, detail = "") {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "\n      " + detail : ""}`); }
}

const OUTLET = { outlet_id: "o1", name: "Main Dining Room", owner_staff_id: "s1" };
const OWNER = { staff_id: "s1", name: "Dana Reed", email: "dana@club.com", active: true };

console.log("\n--- the rule: location decides the owner ---");
let r = routeAlert({ outlet: OUTLET, owner: OWNER });
check("assigned to the outlet's owner", r.assignedTo === "s1", JSON.stringify(r));
check("and the owner is the one notified", r.notify === "owner");
check("the reason names the outlet and the person",
  /Main Dining Room/.test(r.reason) && /Dana Reed/.test(r.reason), r.reason);

console.log("\n--- an outlet with no owner set ---");
r = routeAlert({ outlet: OUTLET, owner: null });
check("left unassigned", r.assignedTo === null);
check("managers are told instead, so it never goes nowhere", r.notify === "managers");
check("and the reason says how to fix it", /Settings → Outlets/.test(r.reason), r.reason);

console.log("\n--- a response with no outlet at all ---");
// Event surveys carry no visit and therefore no outlet.
r = routeAlert({ outlet: null, owner: null });
check("unassigned", r.assignedTo === null);
check("managers notified", r.notify === "managers");
check("reason explains there is nothing to route by", /no outlet/.test(r.reason), r.reason);

console.log("\n--- an owner who has left ---");
r = routeAlert({ outlet: OUTLET, owner: { ...OWNER, active: false } });
check("not assigned to a deactivated account", r.assignedTo === null, JSON.stringify(r));
check("managers pick it up", r.notify === "managers");
check("and are told to reassign the outlet", /reassign/.test(r.reason), r.reason);

console.log("\n--- an owner with no email ---");
r = routeAlert({ outlet: OUTLET, owner: { ...OWNER, email: null } });
check("still assigned to them, because they do run the outlet", r.assignedTo === "s1");
check("but managers are notified, since the owner cannot be", r.notify === "managers");
check("reason says why", /no email/.test(r.reason), r.reason);

console.log("\n--- somebody is always told ---");
for (const [label, args] of [
  ["everything present", { outlet: OUTLET, owner: OWNER }],
  ["no owner", { outlet: OUTLET, owner: null }],
  ["no outlet", { outlet: null, owner: null }],
  ["inactive owner", { outlet: OUTLET, owner: { ...OWNER, active: false } }],
  ["owner without email", { outlet: OUTLET, owner: { ...OWNER, email: "" } }],
  ["called with nothing", {}],
  ["outlet with no name", { outlet: { outlet_id: "o2" }, owner: null }],
]) {
  const out = routeAlert(args);
  check(`${label}: notify is owner or managers, never neither`,
    out.notify === "owner" || out.notify === "managers", JSON.stringify(out));
  check(`${label}: a reason is always given`, Boolean(out.reason));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
