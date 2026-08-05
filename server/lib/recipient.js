// Who a survey would actually go to, and how.
//
// This used to be written twice: once in the send path and once in the queue
// screen that claims to preview it. They disagreed. The queue fell back across
// channels — prefer SMS, else email, else phone — while the send path took the
// member's stated preference and nothing else, so a member who prefers email
// but has only a phone number showed as "ready · SMS" and then failed at send
// time with "No contact method". One function, used by both, is the only way
// that stays true.
//
// The rule: honour the stated preference when we can reach them that way,
// otherwise use whatever contact detail we do have. A wrong channel beats no
// survey, and it is what the CSV import already assumes when it rewrites a
// preference of "sms" to "email" for a member with no phone.

// visit carries guest_phone / guest_email for non-member visitors.
// member is the joined members row, or null for a guest.
function resolveRecipient({ member, visit = {} } = {}) {
  const phone = member ? member.phone_number : visit.guest_phone;
  const email = member ? member.email_address : visit.guest_email;

  if (member && member.opt_out) {
    return { channel: null, recipient: null, blocked_reason: "Member has opted out" };
  }

  const prefersSms = (member?.comm_preference || (visit.guest_phone ? "sms" : "email")) === "sms";

  if (prefersSms && phone) return { channel: "sms", recipient: phone, blocked_reason: null };
  if (!prefersSms && email) return { channel: "email", recipient: email, blocked_reason: null };

  // Preference cannot be honoured — use the detail we have rather than
  // reporting them as reachable and then failing.
  if (email) return { channel: "email", recipient: email, blocked_reason: null };
  if (phone) return { channel: "sms", recipient: phone, blocked_reason: null };

  return { channel: null, recipient: null, blocked_reason: "No phone number or email on file" };
}

module.exports = { resolveRecipient };
