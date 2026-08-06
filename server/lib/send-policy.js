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

const GOLF = "golf";
const DINING = "dining";

function spendOf(v) {
  const n = parseFloat(v?.spend_amount);
  return Number.isFinite(n) ? n : 0;
}

// Golf and food-and-beverage are the two things a member can be asked about.
// Everything that is not a round is dining, including a guest or a commercial
// visitor sitting in a restaurant.
function modalityOf(visit) {
  return visit?.visitor_type === GOLF ? GOLF : DINING;
}

// Which of the two a member should be asked about when their day spans both.
//
// Alternates: whatever they were last asked about, they get the other one now.
// Without this the cap picked the highest-spend visit, and a round is recorded
// with a spend of zero — so dining won every single time and a member who
// golfs and then eats was never once asked about the golf.
//
// With no history the rotation starts on golf. The round is the anchor of the
// day; the meal after it is usually incidental to being at the club.
function nextModality(lastModality) {
  if (lastModality === GOLF) return DINING;
  if (lastModality === DINING) return GOLF;
  return GOLF;
}

// candidates  : visits that already qualify and are ready to send
// alreadySent : { [member_id]: number } — surveys sent inside the window
// lastModality: { [member_id]: 'golf' | 'dining' } — what they were last asked
//               about, which is what the rotation alternates away from
//
// Guests have no stable identity across visits, so they are never capped.
function applyMemberCap(candidates, {
  cap = DEFAULT_CAP, windowDays = DEFAULT_WINDOW_DAYS, alreadySent = {}, lastModality = {},
} = {}) {
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : Infinity;
  const send = [];
  const deferred = [];
  // Where the rotation actually decided something, so the caller can report it
  // and the member's next turn can alternate from it.
  const chosen = [];

  if (limit === Infinity) {
    return { send: [...candidates], deferred, chosen, cap: limit, windowDays };
  }

  const byMember = new Map();
  for (const v of candidates) {
    if (!v.member_id) { send.push(v); continue; }   // guest — not capped
    if (!byMember.has(v.member_id)) byMember.set(v.member_id, []);
    byMember.get(v.member_id).push(v);
  }

  for (const [memberId, visits] of byMember) {
    const modalities = new Set(visits.map(modalityOf));
    const spansBoth = modalities.size > 1;

    // A day that spans both golf and dining is settled by the rotation, not by
    // spend. Within whichever side wins, the largest occasion still leads.
    const wanted = spansBoth ? nextModality(lastModality[memberId]) : null;
    const ordered = [...visits].sort((a, b) => {
      if (spansBoth) {
        const rank = (v) => (modalityOf(v) === wanted ? 0 : 1);
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
      }
      return spendOf(b) - spendOf(a);
    });

    const used = alreadySent[memberId] || 0;
    const room = Math.max(0, limit - used);

    ordered.forEach((v, i) => {
      if (i < room) {
        if (spansBoth) chosen.push({ visit: v, modality: wanted, spanned: [...modalities] });
        send.push(v);
      } else {
        deferred.push({
          visit: v,
          reason: used > 0
            ? `Member already received ${used} survey${used === 1 ? "" : "s"} in the last ${windowDays} day${windowDays === 1 ? "" : "s"}`
            : spansBoth
              ? `Golf and dining on the same day — asked about ${wanted} this time` +
                (lastModality[memberId] ? `, they were last asked about ${lastModality[memberId]}` : "")
              : `Member capped at ${limit} survey${limit === 1 ? "" : "s"} per ${windowDays} day${windowDays === 1 ? "" : "s"} — kept the highest-spend visit`,
        });
      }
    });
  }

  return { send, deferred, chosen, cap: limit, windowDays };
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

module.exports = {
  applyMemberCap, parseCapSettings, modalityOf, nextModality,
  DEFAULT_CAP, DEFAULT_WINDOW_DAYS, GOLF, DINING,
};
