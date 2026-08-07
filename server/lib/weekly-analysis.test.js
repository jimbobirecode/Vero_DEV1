process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://stub.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "stub";

const { shouldRunWeekly, clubNow } = require("./scheduler");

let pass = 0, fail = 0;
function check(label, got, want) {
  if (got === want) { pass++; console.log(`PASS  ${label.padEnd(56)} -> ${got ? "RUN" : "hold"}`); }
  else { fail++; console.log(`FAIL  ${label}\n      got ${got}, want ${want}`); }
}

// weekday: 0 = Sunday. Friday is 5.
const at = (weekday, hour, minute, date = "2026-08-07") => ({ weekday, hour, minute, date });
const FRI = 5, THU = 4, SAT = 6;

console.log("\n--- the configured day ---");
check("Friday 07:00, nothing run yet", shouldRunWeekly({ now: at(FRI, 7, 0), day: 5, runTime: "07:00", lastRunDate: null }).run, true);
check("Thursday, same time", shouldRunWeekly({ now: at(THU, 7, 0), day: 5, runTime: "07:00", lastRunDate: null }).run, false);
check("Saturday, same time", shouldRunWeekly({ now: at(SAT, 7, 0), day: 5, runTime: "07:00", lastRunDate: null }).run, false);
check("configured to Monday, and it is Monday", shouldRunWeekly({ now: at(1, 7, 0), day: 1, runTime: "07:00", lastRunDate: null }).run, true);
check("configured to Sunday, day 0 is not treated as unset",
  shouldRunWeekly({ now: at(0, 7, 0), day: 0, runTime: "07:00", lastRunDate: null }).run, true);

console.log("\n--- the configured time ---");
check("06:59, one minute early", shouldRunWeekly({ now: at(FRI, 6, 59), day: 5, runTime: "07:00", lastRunDate: null }).run, false);
check("07:00 exactly", shouldRunWeekly({ now: at(FRI, 7, 0), day: 5, runTime: "07:00", lastRunDate: null }).run, true);
check("11:00 — a restart or a slow tick delays, never skips the week",
  shouldRunWeekly({ now: at(FRI, 11, 0), day: 5, runTime: "07:00", lastRunDate: null }).run, true);
check("23:59 on the day still counts", shouldRunWeekly({ now: at(FRI, 23, 59), day: 5, runTime: "07:00", lastRunDate: null }).run, true);

console.log("\n--- once a week, not once a tick ---");
check("already run today", shouldRunWeekly({ now: at(FRI, 9, 0), day: 5, runTime: "07:00", lastRunDate: "2026-08-07" }).run, false);
check("run last Friday, not this one",
  shouldRunWeekly({ now: at(FRI, 9, 0), day: 5, runTime: "07:00", lastRunDate: "2026-07-31" }).run, true);

console.log("\n--- defaults and bad input ---");
check("no day set defaults to Friday", shouldRunWeekly({ now: at(FRI, 8, 0), runTime: "07:00", lastRunDate: null }).run, true);
check("no day set, and it is Thursday", shouldRunWeekly({ now: at(THU, 8, 0), runTime: "07:00", lastRunDate: null }).run, false);
check("no time set defaults to 07:00", shouldRunWeekly({ now: at(FRI, 7, 0), day: 5, lastRunDate: null }).run, true);
check("no time set, and it is 06:30", shouldRunWeekly({ now: at(FRI, 6, 30), day: 5, lastRunDate: null }).run, false);
check("a nonsense time never runs", shouldRunWeekly({ now: at(FRI, 12, 0), day: 5, runTime: "half seven", lastRunDate: null }).run, false);
check("a day out of range never runs", shouldRunWeekly({ now: at(FRI, 12, 0), day: 9, runTime: "07:00", lastRunDate: null }).run, false);
check("a negative day never runs", shouldRunWeekly({ now: at(FRI, 12, 0), day: -1, runTime: "07:00", lastRunDate: null }).run, false);

console.log("\n--- every decision explains itself ---");
for (const [label, args] of [
  ["wrong day", { now: at(THU, 8, 0), day: 5, runTime: "07:00", lastRunDate: null }],
  ["too early", { now: at(FRI, 6, 0), day: 5, runTime: "07:00", lastRunDate: null }],
  ["already run", { now: at(FRI, 8, 0), day: 5, runTime: "07:00", lastRunDate: "2026-08-07" }],
  ["bad time", { now: at(FRI, 8, 0), day: 5, runTime: "nope", lastRunDate: null }],
  ["ready", { now: at(FRI, 8, 0), day: 5, runTime: "07:00", lastRunDate: null }],
]) {
  const r = shouldRunWeekly(args);
  if (r.reason) { pass++; console.log(`PASS  ${label.padEnd(56)} -> ${r.reason}`); }
  else { fail++; console.log(`FAIL  ${label}: no reason given`); }
}

console.log("\n--- the weekday comes from the club's clock, not the server's ---");
{
  // 03:00 UTC on Saturday is still Friday evening in New York. A weekly run
  // keyed on the server's day would fire a day early, or miss entirely.
  const n = clubNow(new Date("2026-08-08T03:00:00Z"));
  check("Sat 03:00 UTC reads as Friday at the club", n.weekday, 5);
  check("and as the 7th, not the 8th", n.date, "2026-08-07");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
