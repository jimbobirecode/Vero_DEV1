const { parseDelimited, prepareStaff, prepareServers, normalisePhone, canonicalRole } = require("./roster-import");

let pass = 0, fail = 0;
function check(label, cond, detail = "") {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "\n      " + detail : ""}`); }
}

console.log("\n--- delimiters ---");
for (const [name, text] of [
  ["comma", "name,email\nJane Doe,jane@club.com"],
  ["tab", "name\temail\nJane Doe\tjane@club.com"],
  ["semicolon", "name;email\nJane Doe;jane@club.com"],
  ["pipe", "name|email\nJane Doe|jane@club.com"],
]) {
  const p = parseDelimited(text);
  check(`${name}-separated`, p.headers[0] === "name" && p.rows[0].values[1] === "jane@club.com",
    JSON.stringify(p.rows[0]));
}

console.log("\n--- messy files ---");
check("a UTF-8 BOM does not break the first header",
  parseDelimited("﻿name,email\nJane,j@c.com").headers[0] === "name");
check("headers are normalised", parseDelimited("Full Name , E-Mail\nA,b@c.com").headers.join("|") === "full_name|e_mail");
check("blank lines are dropped", parseDelimited("name\n\nJane\n\n\nBob").rows.length === 2);
check("quoted commas survive",
  parseDelimited('name,role\n"Smith, John",gm').rows[0].values[0] === "Smith, John");
check("doubled quotes unescape",
  parseDelimited('name\n"He said ""hi"""').rows[0].values[0] === 'He said "hi"');
check("an empty file is reported", parseDelimited("").error !== undefined);
check("line numbers point at the file, not the row index",
  parseDelimited("name\nA\nB").rows[1].line === 3);

console.log("\n--- team members ---");
let r = prepareStaff(parseDelimited(
  "name,email,role\nJane Doe,jane@club.com,General Manager\nBob Ray,bob@club.com,shift manager"));
check("two rows imported", r.records.length === 2, JSON.stringify(r.skipped));
check("role aliases resolve", r.records[0].role === "general_manager" && r.records[1].role === "shift_manager");

r = prepareStaff(parseDelimited("first_name,last_name,email\nJane,Doe,jane@club.com"));
check("first and last name are joined", r.records[0].name === "Jane Doe");

r = prepareStaff(parseDelimited("name,email\nJane Doe,jane@club.com"));
check("no role column falls back to the least-privileged role", r.records[0].role === "shift_manager");

r = prepareStaff(parseDelimited("name,email,role\nJane Doe,jane@club.com,Supreme Overlord"));
check("an unrecognised role is refused, not guessed", r.records.length === 0 && r.skipped.length === 1);
check("and says which role it did not know", /Supreme Overlord/.test(r.skipped[0].reason), r.skipped[0].reason);

r = prepareStaff(parseDelimited("name,email\nJane Doe,not-an-email"));
check("a bad email is refused", r.records.length === 0 && /not a valid email/.test(r.skipped[0].reason));

r = prepareStaff(parseDelimited("name,email\n,jane@club.com\nBob Ray,bob@club.com"));
check("a nameless row is skipped, the rest still import", r.records.length === 1 && r.skipped.length === 1);

r = prepareStaff(parseDelimited("name,email\nJane Doe,jane@club.com\nJane D,JANE@CLUB.COM"));
check("a duplicate email in the same file is caught, case-insensitively",
  r.records.length === 1 && /more than once/.test(r.skipped[0].reason));

check("a file with no name column is refused outright",
  prepareStaff(parseDelimited("email,role\nj@c.com,gm")).error !== undefined);

console.log("\n--- servers ---");
r = prepareServers(parseDelimited(
  "name,phone,email\nJessica Hale,(610) 555-1234,jess@club.com\nMarcus Reed,,marcus@club.com\nSam Poole,,"));
check("three rows imported", r.records.length === 3, JSON.stringify(r.skipped));
check("a US number is normalised to E.164", r.records[0].phone === "+16105551234", r.records[0].phone);
check("email-only is still reachable", r.records[1].reachable === true && r.records[1].phone === null);
check("neither phone nor email is flagged unreachable", r.records[2].reachable === false);

r = prepareServers(parseDelimited("name,phone\nJessica Hale,12345"));
check("an unusable number is dropped rather than stored", r.records[0].phone === null);
check("the person is still imported", r.records.length === 1);
check("and the dropped number is reported", /not in \+country format/.test(r.records[0].warning || ""), r.records[0].warning);

r = prepareServers(parseDelimited("name\nJessica Hale\njessica hale"));
check("the same name twice is caught, however it is cased",
  r.records.length === 1 && /more than once/.test(r.skipped[0].reason));

console.log("\n--- phone normalisation ---");
for (const [input, want] of [
  ["+16105551234", "+16105551234"],
  ["6105551234", "+16105551234"],
  ["(610) 555-1234", "+16105551234"],
  ["610.555.1234", "+16105551234"],
  ["16105551234", "+16105551234"],
  ["+44 20 7946 0958", "+442079460958"],
  ["555-1234", null],
  ["not a phone", null],
  ["", null],
  [null, null],
]) {
  check(`${JSON.stringify(input)} -> ${want}`, normalisePhone(input) === want, String(normalisePhone(input)));
}

console.log("\n--- role aliases ---");
check("gm", canonicalRole("GM") === "general_manager");
check("f&b", canonicalRole("F&B Director") === "fb_director");
check("golf", canonicalRole("Golf Shift Manager") === "golf_shift_manager");
check("blank is absent, not unrecognised", canonicalRole("") === null);
check("unknown is undefined, so it can be refused", canonicalRole("wizard") === undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
