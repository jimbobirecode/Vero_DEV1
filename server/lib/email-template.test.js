// The SendGrid template and the server have to agree on field names.
//
// They are in different places — the template lives in SendGrid's UI, the data
// in the send routes — so nothing forces them to match. A renamed field does
// not error: Handlebars renders {{outlet_name}} as empty and the email simply
// goes out saying "how was your experience?" to somebody who was in the Grill
// Room. Silent, and only visible by reading a real email.
//
// docs/sendgrid-template.html is the copy of record. This checks it against
// what the routes actually pass.

const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "\n      " + detail : ""}`); }
}

const TEMPLATE = path.join(__dirname, "..", "..", "docs", "sendgrid-template.html");
const html = fs.readFileSync(TEMPLATE, "utf8");

// Everything the template asks for, minus Handlebars' own block syntax.
const referenced = new Set(
  [...html.matchAll(/\{\{[#/]?\s*(?:if\s+)?([a-z_][a-z0-9_]*)\s*\}\}/gi)]
    .map((m) => m[1])
    .filter((n) => !["if", "else", "each", "unless"].includes(n))
);

// Everything the server puts on the wire. club_name and subject are added by
// lib/senders.js for every send; the rest come from the send routes.
const ROUTES = ["surveys.js", "survey-log.js", "visits.js", "events.js"];
const provided = new Set(["club_name", "subject"]);
for (const r of ROUTES) {
  const src = fs.readFileSync(path.join(__dirname, "..", "routes", r), "utf8");
  for (const m of src.matchAll(/^\s*([a-z_][a-z0-9_]*)\s*:/gm)) provided.add(m[1]);
}

console.log("--- the template asks for nothing the server does not send ---");
for (const field of [...referenced].sort()) {
  check(`{{${field}}} is sent by the server`, provided.has(field),
    `no route passes "${field}" — the template will render it empty`);
}

console.log("\n--- the fields that make the email work at all ---");
// Without these the email is either unusable or unlawful to send.
for (const field of ["survey_url", "unsubscribe_url"]) {
  check(`the template uses {{${field}}}`, referenced.has(field));
}

console.log("\n--- the personalisation this template exists to carry ---");
for (const field of ["first_name", "outlet_name", "club_name"]) {
  check(`the template uses {{${field}}}`, referenced.has(field));
}

console.log("\n--- the two settings that live in SendGrid, not in the file ---");
// The subject is the one that bites: SendGrid ignores a subject sent alongside
// a template, so unless the template's Subject field is {{subject}} every
// personalised subject the server builds is thrown away.
check("the file tells you to set the Subject field to {{subject}}",
  /Subject field to exactly \{\{subject\}\}/.test(html));
check("...and to fill in the plain-text version",
  /Plain Content/.test(html));
check("a plain-text version is actually provided to paste",
  /PLAIN CONTENT/.test(html) && /\{\{survey_url\}\}/.test(html.split("PLAIN CONTENT")[1] || ""));

console.log("\n--- images must not be http ---");
// An http image in an https inbox is mixed content: blocked or warned about,
// and a broken logo on a survey request reads as a forgery.
const httpImages = [...html.matchAll(/<img[^>]+src="(http:\/\/[^"]+)"/gi)].map((m) => m[1]);
check("every image is served over https", httpImages.length === 0, httpImages.join(", "));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
