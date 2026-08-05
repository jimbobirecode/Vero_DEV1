// Lightspeed — Restaurant (K-Series and the older L-Series) and Golf, which
// is Chronogolf under the Lightspeed name since the acquisition.
//
// Both products are covered by one profile because the F&B export is the same
// receipt-per-row shape in each; Golf simply adds tee-sheet vocabulary and
// calls the member a "member" rather than a "customer". The registry reports
// which one it saw so the upload summary can say so.
//
// Three Lightspeed habits drive the choices below:
//
//   1. "Total excl. tax" / "Total incl. tax" is the giveaway pair. Nothing
//      else in this space words it that way, so it doubles as the detector.
//   2. Members are frequently identified by name only — Lightspeed's customer
//      record is optional at the till and staff skip it. So a name column is
//      accepted as identification on its own, and the visits route matches it
//      against the member list.
//   3. Dates arrive as ISO timestamps, and in non-US locales as DD/MM/YYYY.
//      The locale is read off the file rather than assumed.

// Lightspeed writes the customer as "Smith, John", "John Smith", or
// "John Smith (M1234)" when the club has put the member number in the name.
// Pulling the number out of the parenthetical is worth it — it turns a fuzzy
// name match into an exact member lookup.
const ID_IN_NAME_RE = /[([]\s*([A-Za-z]{0,3}\d{2,6}(?:[-.][A-Za-z0-9]{1,3})?)\s*[)\]]/;

function cleanMemberId(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (/^(n\/?a|none|walk[\s-]?in|guest|cash|customer|0+)$/i.test(s)) return "";
  return s.replace(/\s+/g, "");
}

const profile = {
  id: "lightspeed",
  label: "Lightspeed",
  outletLabel: "shop / location",

  detect(doc) {
    const head = doc.headText;
    let score = 0;

    if (/\blightspeed\b/i.test(head)) score += 0.6;
    if (/\bchronogolf\b/i.test(head)) score += 0.6;
    // The distinctive pair. Present in essentially every K-Series sales export.
    if (/total\s+(ex|in)cl\.?\s+tax/i.test(head)) score += 0.45;
    if (/\breceipt\s*(number|#|no)\b/i.test(head) && /\b(shop|sales\s+area|register|device)\b/i.test(head)) score += 0.35;
    if (/\bbusiness\s+day\b/i.test(head)) score += 0.2;
    if (/\bsales\s+area\b|\bprofit\s+cent(er|re)\b/i.test(head)) score += 0.2;
    // Golf-side vocabulary.
    if (/\btee\s*(time|sheet)\b|\bgreen\s*fee\b/i.test(head)) score += 0.15;

    return Math.min(score, 1);
  },

  // Which side of the product line this file came from, for the summary line.
  variant(doc) {
    const head = doc.headText;
    if (/\bchronogolf\b/i.test(head) || /\btee\s*(time|sheet)\b|\bgreen\s*fee\b/i.test(head)) return "Golf";
    return "Restaurant";
  },

  cleanMemberId,

  columns: {
    member_id: [
      /^(customer|member|account)\s*(#|no|num|number|id|code)$/,
      /^(membership|player)\s*(#|no|num|number|id)$/,
      /^(customer|member)\s*reference$/,
      (h) => /\b(customer|member|membership|player|account)\b/.test(h) && /\b(id|no|num|number|code|reference)\b/.test(h) && !/name/.test(h),
    ],
    member_name: [
      /^(customer|member|player|guest)\s*name$/,
      /^(customer|member|player)$/,
      (h) => /\b(customer|member|player|guest)\b/.test(h) && /name/.test(h),
    ],
    outlet_name: [
      /^(shop|sales\s*area|location|store|outlet|venue|restaurant)\s*(name)?$/,
      /^(profit|revenue)\s*cent(er|re)$/,
      /^(floor|register|device|till)\s*(name)?$/,
      (h) => /\b(shop|location|sales area|outlet|venue|store)\b/.test(h),
    ],
    // Net of tax. Lightspeed's own "Total excl. tax" still includes service
    // charge in some configurations, so a plain net/subtotal column wins.
    spend_amount: [
      /^(net|net\s*sales|net\s*amount|net\s*revenue)$/,
      /^(sub\s*total|subtotal)$/,
      /^total\s*excl\.?\s*tax$/,
      /^(sales|revenue|amount\s*excl\.?\s*tax)$/,
    ],
    check_total: [
      /^total\s*incl\.?\s*tax$/,
      /^(gross|gross\s*sales|gross\s*amount|grand\s*total)$/,
      /^(total|amount|paid|amount\s*paid)$/,
    ],
    visit_date: [
      /^(business\s*day|business\s*date)$/,
      /^(closed|opened|created|receipt|sale|order|transaction)\s*(at|date|on|time)?$/,
      /^date(\s*time)?$/,
      (h) => /\bdate\b/.test(h) && !/print|export|range|from|to/.test(h),
    ],
    check_number: [
      /^(receipt|order|bill|ticket|check|transaction|sale)\s*(#|no|num|number|id)$/,
      /^(receipt|order|bill)$/,
      (h) => /\b(receipt|order|bill|ticket|check)\b/.test(h) && /\b(no|num|number|id)\b/.test(h),
    ],
    server_name: [
      /^(employee|server|staff|waiter|user|cashier|operator)\s*(name)?$/,
      (h) => /\b(employee|server|staff|waiter|cashier)\b/.test(h) && !/\bid\b/.test(h),
    ],
    covers: [/^(covers|guests|pax|customers|seats|party\s*size)$/, (h) => /^cover/.test(h)],
  },

  // Lightspeed is sold worldwide and the date column follows the account's
  // locale, so DD/MM/YYYY is as likely as MM/DD/YYYY. Reading the whole column
  // first settles it: any day past the 12th in the first position proves the
  // file is day-first, and a value past the 12th in the second position proves
  // it is month-first.
  prepare(doc, header, map) {
    if (map.visit_date === undefined) return {};

    let firstOver12 = 0;
    let secondOver12 = 0;
    const rows = doc.grid
      ? doc.grid.slice(header.index + 1)
      : doc.lines.slice(header.index + 1).map((l) => l.split(header.split).map((c) => c.trim()));

    for (const cells of rows.slice(0, 500)) {
      const raw = String(cells[map.visit_date] ?? "").trim();
      const m = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/);
      if (!m) continue;
      if (+m[1] > 12) firstOver12++;
      if (+m[2] > 12) secondOver12++;
    }

    // Only flip on positive evidence. An all-ambiguous column stays month-first,
    // which is right for the North American clubs this ships to.
    return { dayFirst: firstOver12 > 0 && secondOver12 === 0 };
  },

  // Staff often type the member number into the customer name rather than
  // attaching a customer record — "John Smith (M1234)". Lifting it out turns a
  // name guess into an exact member lookup.
  refineRow(row) {
    if (row.member_id || !row.member_name) return row;
    const m = row.member_name.match(ID_IN_NAME_RE);
    if (!m) return row;
    return {
      ...row,
      member_id: m[1],
      member_name: row.member_name.replace(ID_IN_NAME_RE, "").trim(),
    };
  },
};

module.exports = profile;
module.exports.ID_IN_NAME_RE = ID_IN_NAME_RE;
