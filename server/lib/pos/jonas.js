// Jonas Club Software (Jonas Club Management / Encore).
//
// The reports clubs actually export for this are "Member Charge Detail",
// "POS Sales Journal", "Ticket Detail" and "Sales Analysis by Department".
// They differ in which columns they carry but agree on the vocabulary, so one
// dictionary covers all of them.
//
// Two Jonas habits drive the choices below:
//
//   1. Canadian spelling. "Revenue Centre" and "Cost Centre" appear as often
//      as the American spellings, and a dictionary that only knows "Center"
//      silently loses the outlet column.
//   2. Amounts are split across Net/Food/Beverage, Gratuity, Service Charge
//      and Tax columns, with "Total" meaning the member's full charge. We take
//      the net figure for the same reason the NorthStar parser takes Item
//      Total: an 18% auto-gratuity would otherwise lift every check over the
//      club's spend threshold.

const { normalizeOutlet, toIsoDate } = require("./shared");

// Jonas account numbers run "1234", "1234-00", "1234.1" for a spouse or
// dependant, sometimes zero-padded to a fixed width. Trailing suffixes are
// kept — the visits route already knows how to fall back to the base account.
function cleanMemberId(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (/^(n\/?a|none|cash|guest|walk[\s-]?in|0+)$/i.test(s)) return "";
  return s.replace(/\s+/g, "");
}

const profile = {
  id: "jonas",
  label: "Jonas Club Software",
  outletLabel: "department / revenue centre",

  // Confidence that a document is a Jonas export. Anything above 0 is a
  // candidate; the registry takes the highest.
  detect(doc) {
    const head = doc.headText;
    let score = 0;

    if (/\bjonas\b/i.test(head)) score += 0.6;
    if (/\bencore\b/i.test(head) && /\bclub\b/i.test(head)) score += 0.2;
    if (/member\s+charge\s+detail|sales\s+journal|ticket\s+detail|sales\s+analysis\s+by\s+department/i.test(head)) score += 0.4;
    if (/revenue\s+cent(er|re)|cost\s+cent(er|re)/i.test(head)) score += 0.25;
    if (/\bchit\s*#?\b/i.test(head)) score += 0.25;

    // Column shape, for exports whose branding was stripped on the way out of
    // the report writer: a member account plus a department plus an amount.
    const hasAccount = /member\s*(#|no\.?|num|number|id)|account\s*(#|no\.?|number)|\bacct\b/i.test(head);
    const hasDept = /\bdepartment\b|\bdept\b|revenue\s+cent(er|re)/i.test(head);
    const hasAmount = /net\s+(sales|amount)|charge\s+amount|\bamount\b/i.test(head);
    if (hasAccount && hasDept && hasAmount) score += 0.35;

    return Math.min(score, 1);
  },

  cleanMemberId,

  columns: {
    // Strongest matchers first — mapColumns takes the earliest match and will
    // not give one column to two fields.
    member_id: [
      /^member\s*(#|no|num|number|id)$/,
      /^(acct|account)\s*(#|no|num|number)?$/,
      /^membership\s*(#|no|number)$/,
      (h) => /^(member|account|acct|membership)\b/.test(h) && /\b(no|num|number|id|code)\b/.test(h) && !/name/.test(h),
    ],
    member_name: [
      /^member\s*name$/,
      /^account\s*name$/,
      /^(name|member|customer|patron)$/,
      (h) => /member|customer|patron/.test(h) && /name/.test(h),
    ],
    outlet_name: [
      /^(revenue|cost)\s*cent(er|re)$/,
      /^(department|dept)\s*(name)?$/,
      /^(outlet|location|venue|facility|area)$/,
      (h) => /\b(department|dept|outlet|revenue cent|cost cent)\b/.test(h),
    ],
    // Net of tax and gratuity — the club's threshold is set against food and
    // beverage sales, not against what the member's statement will show.
    spend_amount: [
      /^net\s*(sales|amount|total)$/,
      /^(food\s*(and|&)?\s*beverage|f\s*b)\s*(sales|amount|total)?$/,
      /^(sub\s*total|subtotal|item\s*total|sales\s*amount)$/,
      /^(net|sales)$/,
    ],
    // What the member was actually charged, kept for reporting only.
    check_total: [
      /^(charge\s*amount|total\s*charge|member\s*charge)$/,
      /^(grand\s*total|total\s*amount|total\s*incl.*|gross\s*(sales|amount))$/,
      /^(amount|total)$/,
    ],
    visit_date: [
      /^(trans(action)?|business|post(ing)?|charge|sale|check)\s*date$/,
      /^date$/,
      (h) => /\bdate\b/.test(h) && !/print|run|range|from|to/.test(h),
    ],
    check_number: [
      /^(chit|ticket|check|invoice|trans(action)?|receipt)\s*(#|no|num|number)?$/,
      (h) => /\b(chit|ticket|check)\b/.test(h) && /\b(no|num|number|id)\b/.test(h),
    ],
    server_name: [
      /^(server|waiter|waitress|employee|clerk|cashier|staff)\s*(name)?$/,
      (h) => /\b(server|waiter|employee|clerk|cashier)\b/.test(h),
    ],
    covers: [/^(covers|cvrs|guests|pax|seats|no of guests)$/, (h) => /^cover/.test(h)],
  },

  // Jonas prints the department above its block on some report layouts rather
  // than as a column. Only trusted when there is exactly one in the preamble —
  // more than one and we would be guessing which block a row belongs to.
  outletFromPreamble(doc) {
    const source = doc.grid
      ? doc.grid.slice(0, 40).map((r) => r.join(" "))
      : doc.lines.slice(0, 40);
    const found = new Set();
    for (const line of source) {
      const m = String(line).match(/(?:revenue\s+cent(?:er|re)|department|dept|outlet)\s*[:\-]\s*(.+?)\s*$/i);
      if (m && m[1].trim() && normalizeOutlet(m[1])) found.add(m[1].trim());
    }
    return found.size === 1 ? [...found][0] : null;
  },

  // "Dates: 07/01/2026 to 07/01/2026" — a single-day report lets rows with a
  // blank date column still land on the right day.
  dateFromPreamble(doc) {
    const source = doc.grid
      ? doc.grid.slice(0, 40).map((r) => r.join(" "))
      : doc.lines.slice(0, 40);
    for (const line of source) {
      const m = String(line).match(/\b(?:date|for|period|from)\b[^0-9]{0,12}(\d{1,2}\/\d{1,2}\/\d{2,4})(?:\s*(?:to|-|through|thru)\s*(\d{1,2}\/\d{1,2}\/\d{2,4}))?/i);
      if (!m) continue;
      if (m[2] && m[2] !== m[1]) return null;   // a range tells us nothing per row
      return toIsoDate(m[1]);
    }
    return null;
  },
};

module.exports = profile;
