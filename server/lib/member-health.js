// Member health: who is quietly on their way out.
//
// A member who stops coming rarely resigns first. They just come less, and
// then not at all, and the club finds out when the subscription lapses — by
// which point the conversation that would have kept them is a year late.
//
// Everything here is pure and works on plain visit rows.
//
// Two decisions do all the work, and both are about not crying wolf:
//
//   1. A member is measured against THEIR OWN baseline, not a club-wide rule.
//      "Hasn't visited in 30 days" flags the member who always came monthly
//      and misses the one who came three times a week and now comes once —
//      which is exactly backwards. The second is the resignation.
//
//   2. The comparison is adjusted for the club's own seasonal movement. A golf
//      club in January is not a golf club in July. Without this, every member
//      is "at risk" every winter, the list is ignored by February, and the
//      feature is dead. So a member is compared against what the rest of the
//      membership did over the same weeks, not against their own summer.

const DEFAULTS = {
  recentDays: 90,          // the window being judged
  baselineDays: 365,       // how far back their established rhythm is read from
  minBaselineVisits: 4,    // below this there is no rhythm to compare against
  seasonalAdjust: true,
};

// Thresholds are shortfall against the member's seasonally-expected rate.
const BANDS = {
  at_risk: 0.6,   // coming 60%+ less than expected
  slipping: 0.3,
  growing: -0.2,  // coming 20%+ more
};

const DAY = 86400000;
const round = (n, dp = 1) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const money = (n) => (n == null ? null : Math.round(n * 100) / 100);

const spendOf = (v) => {
  const n = parseFloat(v?.spend_amount);
  return Number.isFinite(n) ? n : 0;
};

// Visit dates are plain 'YYYY-MM-DD'. Parsed through new Date() they become
// UTC midnight, which lands on the previous day for any club west of
// Greenwich — the same trap as in crossover.js.
function dateMs(value) {
  const [y, m, d] = String(value || "").split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).getTime();
}

// One record per member, split into the two windows.
//
// A member-day is the unit, not a visit: somebody who plays and then eats has
// been to the club once that day, and counting it twice would make their
// rhythm look busier than it is — and then make them look like they collapsed
// when they stop doing both.
function memberWindows(visits, { now, recentDays, baselineDays }) {
  const recentStart = now - recentDays * DAY;
  const baselineStart = now - baselineDays * DAY;

  const byMember = new Map();
  const seenDays = new Set();

  for (const v of visits) {
    if (!v.member_id) continue;                 // guests have no rhythm to read
    const t = dateMs(v.visit_date);
    if (t == null || t < baselineStart || t > now) continue;

    let m = byMember.get(v.member_id);
    if (!m) {
      m = {
        member_id: v.member_id,
        recent_days: 0, baseline_days: 0,
        recent_spend: 0, baseline_spend: 0,
        last_visit: null, first_visit: null,
      };
      byMember.set(v.member_id, m);
    }

    const inRecent = t >= recentStart;
    const dayKey = `${v.member_id}|${v.visit_date}`;
    if (!seenDays.has(dayKey)) {
      seenDays.add(dayKey);
      if (inRecent) m.recent_days++; else m.baseline_days++;
    }

    // Spend is per visit, not per day — two cheques on one day is two lots of
    // revenue even though it is one occasion.
    if (inRecent) m.recent_spend += spendOf(v);
    else m.baseline_spend += spendOf(v);

    if (m.last_visit == null || t > m.last_visit) m.last_visit = t;
    if (m.first_visit == null || t < m.first_visit) m.first_visit = t;
  }

  return [...byMember.values()];
}

// How the club as a whole moved between the two windows.
//
// Two choices here, both about not letting one member define the season.
//
// It is computed over the members who HAVE a baseline. Including this
// quarter's new joiners would make the club look busier than it was and then
// make every established member look like they had dropped off.
//
// And it is the MEDIAN of each member's own ratio, not the ratio of the club's
// totals.
//
// A total is volume-weighted, so one member who used to come four times a week
// and stopped moves the club figure further than fifty members who did not
// change at all — and then everybody steady reads as "growing" against a
// season that one person invented. The season is a behavioural pattern, and
// the median is the member in the middle of it.
function memberRatio(r, recentDays, baselineWindowDays) {
  const baseline = r.baseline_days / baselineWindowDays;
  if (!baseline) return null;
  return (r.recent_days / recentDays) / baseline;
}

function medianOfSorted(sorted) {
  const n = sorted.length;
  if (!n) return null;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

// Median of a sorted array with one index removed, without rebuilding it.
function medianOfSortedExcluding(sorted, k) {
  const n = sorted.length - 1;
  if (n <= 0) return null;
  const at = (p) => sorted[p < k ? p : p + 1];
  return n % 2 ? at((n - 1) / 2) : (at(n / 2 - 1) + at(n / 2)) / 2;
}

function seasonalContext(records, { recentDays, baselineWindowDays, minBaselineVisits }) {
  const panel = records
    .filter((r) => r.baseline_days >= minBaselineVisits)
    .map((r) => ({ member_id: r.member_id, ratio: memberRatio(r, recentDays, baselineWindowDays) }))
    .filter((x) => Number.isFinite(x.ratio))
    .sort((a, b) => a.ratio - b.ratio);

  const sorted = panel.map((x) => x.ratio);
  const indexOf = new Map(panel.map((x, i) => [x.member_id, i]));

  return { size: panel.length, sorted, indexOf, overall: medianOfSorted(sorted) };
}

// The season as seen by everybody EXCEPT this member.
//
// Leaving them in means a member is partly compared against themselves: their
// own collapse drags the club average down, which then makes the collapse look
// normal. In a club of four hundred that is a rounding error; in a club of
// thirty it hides exactly the people the list exists to surface, and it gets
// worse the more of them there are — a genuine wave of resignations would be
// the hardest thing for it to see.
function ratioExcluding(ctx, record) {
  if (ctx.size < 2) return null;      // no rest of the club to compare against
  const k = ctx.indexOf.get(record.member_id);
  // Not in the panel — too little history to be part of the season, but the
  // season still applies to them.
  if (k === undefined) return ctx.overall;
  return medianOfSortedExcluding(ctx.sorted, k);
}

// Kept for callers that want the club figure on its own.
function seasonalRatio(records, opts) {
  return seasonalContext(records, opts).overall;
}

function bandFor(record, shortfall) {
  if (record.recent_days === 0) return "lapsed";
  if (shortfall >= BANDS.at_risk) return "at_risk";
  if (shortfall >= BANDS.slipping) return "slipping";
  if (shortfall <= BANDS.growing) return "growing";
  return "steady";
}

function memberHealth(visits = [], options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const now = opts.now ?? Date.now();
  const { recentDays, baselineDays, minBaselineVisits } = opts;
  const baselineWindowDays = Math.max(baselineDays - recentDays, 1);

  const records = memberWindows(visits, { now, recentDays, baselineDays });

  const ctx = seasonalContext(records, { recentDays, baselineWindowDays, minBaselineVisits });
  // With no usable panel the club cannot be seasonally adjusted. Falling back
  // to "assume flat" is honest, and the response says which it did.
  const clubRatio = opts.seasonalAdjust && Number.isFinite(ctx.overall) ? ctx.overall : 1;
  const canAdjust = opts.seasonalAdjust && ctx.size >= 2 && Number.isFinite(ctx.overall);

  const members = [];
  const notScored = [];

  for (const r of records) {
    const baselineRate30 = (r.baseline_days / baselineWindowDays) * 30;
    const recentRate30 = (r.recent_days / recentDays) * 30;
    const daysSince = r.last_visit == null ? null : Math.floor((now - r.last_visit) / DAY);

    const base = {
      member_id: r.member_id,
      recent_visits: r.recent_days,
      baseline_visits: r.baseline_days,
      baseline_rate_30d: round(baselineRate30, 2),
      recent_rate_30d: round(recentRate30, 2),
      days_since_last_visit: daysSince,
      recent_spend: money(r.recent_spend),
    };

    // Too little history to say anything. Reported separately rather than
    // scored as healthy — a club with mostly new members should see that it
    // cannot yet be told, not a page of reassuring green.
    if (r.baseline_days < minBaselineVisits) {
      const joinedRecently = r.first_visit != null && r.first_visit >= now - recentDays * DAY;
      notScored.push({ ...base, band: joinedRecently ? "new" : "infrequent" });
      continue;
    }

    // Each member is measured against the season as everybody else lived it.
    const ex = opts.seasonalAdjust ? ratioExcluding(ctx, r) : null;
    const seasonal = Number.isFinite(ex) ? ex : (opts.seasonalAdjust ? clubRatio : 1);
    const expectedRate30 = baselineRate30 * seasonal;
    const shortfall = expectedRate30 > 0 ? (expectedRate30 - recentRate30) / expectedRate30 : 0;

    // Annualised from the baseline window, then scaled by how much of their
    // custom has actually gone. For a lapsed member that is all of it.
    const baselineAnnualSpend = (r.baseline_spend / baselineWindowDays) * 365;
    const atRisk = baselineAnnualSpend * Math.max(0, Math.min(shortfall, 1));

    members.push({
      ...base,
      band: bandFor(r, shortfall),
      expected_rate_30d: round(expectedRate30, 2),
      shortfall_pct: round(shortfall * 100, 1),
      baseline_annual_spend: money(baselineAnnualSpend),
      value_at_risk: money(atRisk),
    });
  }

  // Ranked by money, not by percentage. A member down 90% who spent £300 a
  // year is a worse use of the GM's morning than one down 50% who spent
  // £9,000 — and the GM has one morning.
  members.sort((a, b) => (b.value_at_risk || 0) - (a.value_at_risk || 0));

  const count = (band) => members.filter((m) => m.band === band).length;
  const declining = members.filter((m) => m.band === "lapsed" || m.band === "at_risk");

  return {
    window: {
      recent_days: recentDays,
      baseline_days: baselineDays,
      min_baseline_visits: minBaselineVisits,
    },
    club: {
      // Below 1 the club is quieter than it was; above, busier. Every member's
      // expectation is scaled by this, which is what stops a seasonal club
      // flagging its entire membership every winter.
      seasonal_ratio: round(clubRatio, 3),
      seasonal_adjusted: canAdjust,
      // Each member is actually scored against this figure recomputed without
      // them, so their own decline cannot excuse itself.
      seasonal_basis: canAdjust ? "leave-one-out" : "none",
      panel_size: ctx.size,
      scored_members: members.length,
      unscored_members: notScored.length,
    },
    summary: {
      lapsed: count("lapsed"),
      at_risk: count("at_risk"),
      slipping: count("slipping"),
      steady: count("steady"),
      growing: count("growing"),
      new: notScored.filter((m) => m.band === "new").length,
      infrequent: notScored.filter((m) => m.band === "infrequent").length,
      value_at_risk: money(declining.reduce((a, m) => a + (m.value_at_risk || 0), 0)),
    },
    members,
    not_scored: notScored,
  };
}

// The call list: the most valuable declining members, in the order to ring
// them. `limit` is what makes this usable — a GM can ring ten people, not a
// hundred and forty.
function callList(result, { limit = 10, bands = ["lapsed", "at_risk"] } = {}) {
  return result.members.filter((m) => bands.includes(m.band)).slice(0, limit);
}

module.exports = {
  memberHealth, callList, memberWindows, seasonalRatio, seasonalContext, ratioExcluding,
  BANDS, DEFAULTS,
};
