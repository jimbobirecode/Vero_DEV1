const { resolveRecipient } = require("./recipient");

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = got.channel === want.channel && got.recipient === want.recipient
    && (got.blocked_reason || null) === (want.blocked_reason || null);
  if (ok) { pass++; console.log(`PASS  ${label.padEnd(52)} -> ${got.channel || "blocked"} ${got.recipient || `(${got.blocked_reason})`}`); }
  else { fail++; console.log(`FAIL  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
}

const M = (over = {}) => ({ comm_preference: "sms", phone_number: "+15551234567", email_address: "m@club.com", opt_out: false, ...over });

console.log("\n--- preference honoured ---");
check("prefers sms, has phone", resolveRecipient({ member: M() }), { channel: "sms", recipient: "+15551234567" });
check("prefers email, has email", resolveRecipient({ member: M({ comm_preference: "email" }) }), { channel: "email", recipient: "m@club.com" });

console.log("\n--- preference impossible: fall back rather than fail at send time ---");
check("prefers sms, no phone", resolveRecipient({ member: M({ phone_number: null }) }), { channel: "email", recipient: "m@club.com" });
check("prefers email, no email", resolveRecipient({ member: M({ comm_preference: "email", email_address: null }) }), { channel: "sms", recipient: "+15551234567" });
check("prefers sms, empty-string phone", resolveRecipient({ member: M({ phone_number: "" }) }), { channel: "email", recipient: "m@club.com" });

console.log("\n--- unreachable ---");
check("no phone, no email", resolveRecipient({ member: M({ phone_number: null, email_address: null }) }),
  { channel: null, recipient: null, blocked_reason: "No phone number or email on file" });
check("opted out, otherwise fully reachable", resolveRecipient({ member: M({ opt_out: true }) }),
  { channel: null, recipient: null, blocked_reason: "Member has opted out" });

console.log("\n--- guests carry their contact details on the visit ---");
check("guest with phone", resolveRecipient({ member: null, visit: { guest_phone: "+15559999999" } }), { channel: "sms", recipient: "+15559999999" });
check("guest with email only", resolveRecipient({ member: null, visit: { guest_email: "g@x.com" } }), { channel: "email", recipient: "g@x.com" });
check("guest with both prefers sms", resolveRecipient({ member: null, visit: { guest_phone: "+1555", guest_email: "g@x.com" } }), { channel: "sms", recipient: "+1555" });
check("guest with neither", resolveRecipient({ member: null, visit: {} }),
  { channel: null, recipient: null, blocked_reason: "No phone number or email on file" });

console.log("\n--- called with nothing at all ---");
check("no arguments", resolveRecipient(), { channel: null, recipient: null, blocked_reason: "No phone number or email on file" });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
