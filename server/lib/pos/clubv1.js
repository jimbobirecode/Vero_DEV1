// Club V1 — the Club Systems golf club platform, and the first module here
// aimed at UK clubs rather than North American ones.
//
// The reports clubs export for this are "Till Sales", "Sales Analysis",
// "EPOS Sales" and "Member Spend Analysis". They share Club V1's vocabulary:
// the outlet is a "Section" or a "Till" rather than a department or a shop,
// and the money is split Net / VAT / Gross.
//
// Three things separate this from the North American modules:
//
//   1. Dates are DD/MM/YYYY. Read month-first they are silently wrong for the
//      first twelve days of every month — 07/08 becomes 7 August, not 8 July —
//      and every one of those still parses, so nothing looks broken. This
//      module defaults to day-first and only leaves it on evidence.
//   2. VAT, not tax. It is also the cleanest signal that a file is British,
//      so it doubles as part of the detector.
//   3. Money is in £. parseMoney already strips the symbol, but the point is
//      that spend thresholds are compared against a Net figure that excludes
//      VAT — the same rule the other modules follow for tax and gratuity.

const { toIsoDate } = require("./shared");

// Club V1 member numbers are usually plain digits, often zero-padded, and
// sometimes carry a category prefix ("7/1234") or a suffix for a spouse or
// junior. Suffixes are kept — ingest.js falls back to the base account.
function cleanMemberId(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (/^(n\/?a|none|nil|cash|guest|visitor|non[\s-]?member|walk[\s-]?in|societ(y|ies)|0+)$/i.test(s)) return "";
  return s.replace(/\s+/g, "");
}

const profile = {
  id: "clubv1",
  label: "Club V1",
  outletLabel: "section / till",

  detect(doc) {
    const head = doc.headText;
    let score = 0;

    if (/\bclub\s*v1\b/i.test(head)) score += 0.6;
    if (/\bclub\s*systems\b/i.test(head)) score += 0.5;
    if (/till\s+sales|sales\s+analysis|member\s+spend|epos\s+sales/i.test(head)) score += 0.3;

    // "Section" and "Till" are Club V1's words for an outlet. Neither appears
    // in the Jonas or Lightspeed vocabularies.
    const hasSection = /\bsection\b/i.test(head);
    const hasTill = /\btill\b|\bepos\b/i.test(head);
    if (hasSection) score += 0.25;
    if (hasTill) score += 0.2;

    // Net / VAT / Gross together is a British sales export. On its own that is
    // not proof of Club V1, so it scores below the named signals — but paired
    // with a section or a till it is enough to claim the file.
    const hasVat = /\bvat\b/i.test(head);
    if (hasVat) score += 0.2;
    if (hasVat && (hasSection || hasTill)) score += 0.2;

    const hasMember = /member(ship)?\s*(#|no\.?|num|number)/i.test(head);
    if (hasMember && (hasSection || hasTill) && /\bnet\b|\bgross\b/i.test(head)) score += 0.3;

    return Math.min(score, 1);
  },

  cleanMemberId,

  columns: {
    member_id: [
      /^member(ship)?\s*(#|no|num|number)$/,
      /^(member|account)\s*(id|code|ref|reference)$/,
      /^(cdh|golf\s*link)\s*(#|no|number|id)$/,   // the national handicap id, when that is what the till stores
      (h) => /\b(member|membership|account)\b/.test(h) && /\b(no|num|number|id|code|ref)\b/.test(h) && !/name/.test(h),
    ],
    member_name: [
      /^member(ship)?\s*name$/,
      /^(name|member|customer)$/,
      (h) => /\b(member|customer)\b/.test(h) && /name/.test(h),
    ],
    outlet_name: [
      /^(section|till|outlet|bar|area)\s*(name)?$/,
      /^(department|dept|point\s*of\s*sale|epos)\s*(name)?$/,
      /^(location|venue)$/,
      (h) => /\b(section|till|outlet|epos)\b/.test(h),
    ],
    // Net of VAT. The club's threshold is set against the value of the goods,
    // not against what the member's account was debited.
    spend_amount: [
      /^(net|net\s*(amount|value|sales|total))$/,
      /^(goods|goods\s*(value|total))$/,
      /^(ex\s*vat|excl\s*vat|amount\s*ex\s*vat)$/,
      /^(sub\s*total|subtotal)$/,
    ],
    check_total: [
      /^(gross|gross\s*(amount|value|sales|total))$/,
      /^(inc\s*vat|incl\s*vat|amount\s*inc\s*vat)$/,
      /^(total|amount|value|charged)$/,
    ],
    visit_date: [
      /^(trans(action)?|sale|sales|business|posting|posted)\s*date$/,
      /^date$/,
      (h) => /\bdate\b/.test(h) && !/print|run|export|range|from|to/.test(h),
    ],
    check_number: [
      /^(trans(action)?|receipt|sale|docket|ticket|bill|order)\s*(#|no|num|number|id)$/,
      /^(receipt|docket|trans(action)?)$/,
      (h) => /\b(receipt|docket|trans|ticket)\b/.test(h) && /\b(no|num|number|id)\b/.test(h),
    ],
    server_name: [
      /^(operator|staff|server|steward|bar\s*staff|user|cashier|employee)\s*(name)?$/,
      (h) => /\b(operator|steward|cashier|server|staff)\b/.test(h) && !/\bid\b/.test(h),
    ],
    covers: [/^(covers|guests|pax|seats|party\s*size)$/, (h) => /^cover/.test(h)],
  },

  // Club V1 prints the section above its block when a report is grouped by
  // one, in the same "Section: Bar" form Jonas uses for departments. Only
  // trusted when the preamble names exactly one.
  outletFromPreamble(doc) {
    const source = doc.grid
      ? doc.grid.slice(0, 40).map((r) => r.join(" "))
      : doc.lines.slice(0, 40);
    const found = new Set();
    for (const line of source) {
      const m = String(line).match(/(?:section|till|outlet|point\s*of\s*sale)\s*[:\-]\s*(.+?)\s*$/i);
      if (m && m[1].trim()) found.add(m[1].trim());
    }
    return found.size === 1 ? [...found][0] : null;
  },

  dateFromPreamble(doc) {
    const source = doc.grid
      ? doc.grid.slice(0, 40).map((r) => r.join(" "))
      : doc.lines.slice(0, 40);
    for (const line of source) {
      const m = String(line).match(/\b(?:date|for|period|from)\b[^0-9]{0,12}(\d{1,2}\/\d{1,2}\/\d{2,4})(?:\s*(?:to|-|–|through)\s*(\d{1,2}\/\d{1,2}\/\d{2,4}))?/i);
      if (!m) continue;
      if (m[2] && m[2] !== m[1]) return null;   // a range tells us nothing per row
      return toIsoDate(m[1], { dayFirst: true });
    }
    return null;
  },

  // Day-first is the default here, unlike every other module — Club V1 is a
  // UK product. Evidence in the column can still overrule it: a value with
  // more than 12 in the second position can only be month-first, which means
  // the club has configured an American date format.
  prepare(doc, header, map) {
    if (map.visit_date === undefined) return { dayFirst: true };

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

    // Only an unambiguous month-first column turns the default off, and only
    // when nothing in the column contradicts it.
    return { dayFirst: !(secondOver12 > 0 && firstOver12 === 0) };
  },
};

module.exports = profile;
