// How many surveys one member may receive, across every outlet.
//
// Repeat cheques at the same outlet on the same day are already folded into a
// single visit by the POS parser, so this covers the remaining case: a member
// who used several different outlets and would otherwise get one survey each.
//
// Where a member is over the cap the highest-spend visit wins, on the grounds
// that the larger occasion is the one worth asking about. The rest are
// deferred rather than sent, and the caller decides whether to drop them.

const DEFAULT_CAP = 1;        // surveys per member
const DEFAULT_WINDOW_DAYS = 1; // ...per this many days

function spendOf(v) {
  const n = parseFloat(v?.spend_amount);
  return Number.isFinite(n) ? n : 0;
}

// candidates : visits that already qualify and are ready to send
// alreadySent: { [member_id]: number } — surveys sent inside the window
//
// Guests have no stable identity across visits, so they are never capped.
function applyMemberCap(candidates, { cap = DEFAULT_CAP, windowDays = DEFAULT_WINDOW_DAYS, alreadySent = {} } = {}) {
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : Infinity;
  const send = [];
  const deferred = [];

  if (limit === Infinity) {
    return { send: [...candidates], deferred, cap: limit, windowDays };
  }

  const byMember = new Map();
  for (const v of candidates) {
    if (!v.member_id) { send.push(v); continue; }   // guest — not capped
    if (!byMember.has(v.member_id)) byMember.set(v.member_id, []);
    byMember.get(v.member_id).push(v);
  }

  for (const [memberId, visits] of byMember) {
    // Largest occasion first, so the cap keeps the most substantial visit.
    const ordered = [...visits].sort((a, b) => spendOf(b) - spendOf(a));
    const used = alreadySent[memberId] || 0;
    const room = Math.max(0, limit - used);

    ordered.forEach((v, i) => {
      if (i < room) {
        send.push(v);
      } else {
        deferred.push({
          visit: v,
          reason: used > 0
            ? `Member already received ${used} survey${used === 1 ? "" : "s"} in the last ${windowDays} day${windowDays === 1 ? "" : "s"}`
            : `Member capped at ${limit} survey${limit === 1 ? "" : "s"} per ${windowDays} day${windowDays === 1 ? "" : "s"} — kept the highest-spend visit`,
        });
      }
    });
  }

  return { send, deferred, cap: limit, windowDays };
}

function parseCapSettings(settings = {}) {
  const cap = parseInt(settings.member_survey_cap, 10);
  const days = parseInt(settings.member_survey_cap_days, 10);
  return {
    // 0 means no limit — that is what the Settings screen offers, and what it
    // tells you it saved. Treating 0 as invalid quietly applied a cap of one
    // instead, so a member who used three outlets got one survey while the
    // screen said they would get three.
    cap: Number.isFinite(cap) && cap >= 0 ? cap : DEFAULT_CAP,
    windowDays: Number.isFinite(days) && days > 0 ? days : DEFAULT_WINDOW_DAYS,
  };
}

module.exports = { applyMemberCap, parseCapSettings, DEFAULT_CAP, DEFAULT_WINDOW_DAYS };
