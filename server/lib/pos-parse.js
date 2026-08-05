// Parser for NorthStar POS "Sales By Location" / "Daily Sales By Location"
// exports, as produced by the end-of-shift report.
//
// The PDF text layer gives us lines shaped like:
//
//   Location Name: Golf Patio
//   07/29/2026 608539 4 $67.00 $0.00 \t $18.21 $0.00 $0.00 \t $67.00 $85.21 \t K273 \t Ava Del Viscio Krietsch, Karl
//   |          |      | └ covers (OMITTED on many rows)         |            |       └ server + "MemberLast, MemberFirst"
//   |          └ check#                                          |            └ member #
//   └ check date                                                 └ 7 money columns
//
// Money columns in order: Item Total, Sub Total, Gratuity, Add On, Inclusive,
// Tips, Total. We take Item Total as the spend figure — it is the actual food
// and beverage sales, excluding the auto-added gratuity that would otherwise
// inflate every check by ~18% and quietly lower the club's spend thresholds.
//
// Long rows wrap, putting the server and member name on following lines, so a
// row stays "pending" until the next row, location, or boilerplate line.

const MONEY_RE = /\$[\d,]+\.\d{2}/g;
const LOCATION_RE = /^Location\s+Name:\s*(.+)$/i;
const MEMBER_ID_RE = /^([A-Z]{1,3}\d{1,5}(?:-[A-Z])?)$/;

// Boilerplate that appears on every page, plus the report's own preamble and
// footnotes. Anything matching this can never be part of a row.
const NOISE_RE = new RegExp([
  /^Check#/, /^Printed\s/, /^©/, /^Page\s+\d/, /^--\s*\d/,
  /Total\s+for:/i, /^Grand\s+Total/i, /^Note:/i, /^\*/,
  /^Location$/i, /^Detail\s+View$/i, /^Sorted\s+By/i, /^Filtered\s+By/i,
  /^Grouped\s+By/i, /^Dates\s*:/i, /^From\s+Date/i, /^N\/A\b/,
  /^Sales\s+By\s+Location$/i, /^Daily\s+Sales\s+By\s+Location$/i,
].map((r) => r.source).join("|"), "i");

// A row line: date, check number, then an optional covers count, then money.
const ROW_RE = /^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d+)\s+(?:(\d+)\s+)?(?=\$)/;

function isSalesByLocation(lines) {
  const head = lines.slice(0, 40).join("\n");
  return /sales\s+by\s+location/i.test(head) && /location\s+name\s*:/i.test(lines.join("\n"));
}

// "Ava Del Viscio Krietsch, Karl" -> server "Ava Del Viscio", member "Krietsch, Karl".
// The member name is always "Last, First", so the word immediately before the
// comma is the member's surname and everything before it belongs to the server.
function splitServerAndMember(text) {
  const comma = text.indexOf(",");
  if (comma === -1) return { server: "", member: "" };
  const before = text.slice(0, comma).trim();
  const after = text.slice(comma + 1).trim();
  const words = before.split(/\s+/).filter(Boolean);
  if (words.length < 2) return { server: "", member: text.trim() };
  const surname = words.pop();
  return { server: words.join(" "), member: `${surname}, ${after}` };
}

function toIsoDate(mdy) {
  const m = mdy.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

function parseSalesByLocation(allLines, userOutlet) {
  const rows = [];
  const stats = { rows_parsed: 0, rows_without_member_id: 0, locations: [], unparsed_lines: 0 };
  let location = userOutlet || null;
  let pending = null;

  const flush = () => {
    if (!pending) return;
    if (!pending.member_id) stats.rows_without_member_id++;
    rows.push(pending);
    pending = null;
  };

  for (const raw of allLines) {
    const line = (raw || "").trim();
    if (!line) continue;

    const loc = line.match(LOCATION_RE);
    if (loc) {
      flush();
      if (!userOutlet) location = loc[1].trim();
      if (location && !stats.locations.includes(location)) stats.locations.push(location);
      continue;
    }

    if (NOISE_RE.test(line)) { flush(); continue; }

    const row = line.match(ROW_RE);
    if (row) {
      flush();
      const money = line.match(MONEY_RE) || [];
      if (!money.length) { stats.unparsed_lines++; continue; }

      // Everything past the final money value holds the member # and, when the
      // row didn't wrap, the server and member name.
      const lastMoney = money[money.length - 1];
      const tail = line.slice(line.lastIndexOf(lastMoney) + lastMoney.length);
      const parts = tail.split("\t").map((s) => s.trim()).filter(Boolean);

      let memberId = "";
      let server = "";
      let memberName = "";
      for (const part of parts) {
        const id = part.match(MEMBER_ID_RE);
        if (id && !memberId) { memberId = id[1]; continue; }
        if (part.includes(",")) {
          const split = splitServerAndMember(part);
          server = split.server;
          memberName = split.member;
        }
      }

      pending = {
        member_id: memberId,
        member_name: memberName,
        outlet_name: location || "",
        spend_amount: money[0],              // Item Total
        check_total: money[money.length - 1],
        visit_date: toIsoDate(row[1]) || row[1],
        check_number: row[2],
        covers: row[3] ? parseInt(row[3], 10) : null,
        server_name: server,
      };
      stats.rows_parsed++;
      continue;
    }

    // Continuation of a wrapped row: a bare member #, a lone server forename,
    // or "ServerSurname MemberLast, MemberFirst".
    if (pending) {
      const idOnly = line.match(MEMBER_ID_RE);
      if (idOnly) { if (!pending.member_id) pending.member_id = idOnly[1]; continue; }

      if (line.includes(",")) {
        const split = splitServerAndMember(line);
        // Never overwrite a name we already have — an orphaned continuation
        // (its own row lost in extraction) would otherwise be misattributed.
        if (!pending.member_name) pending.member_name = split.member;
        if (split.server) pending.server_name = pending.server_name
          ? `${pending.server_name} ${split.server}`.trim()
          : split.server;
        continue;
      }

      if (/^[A-Z][a-z]+$/.test(line) && !pending.server_name) {
        pending.server_name = line;
        continue;
      }
    }
  }
  flush();

  return { rows, stats };
}

// One member can run several checks at the same outlet in a day. Survey
// eligibility is about what they spent there that day, so fold them together
// rather than creating a visit per check.
function aggregateRows(rows) {
  const byKey = new Map();
  let merged = 0;

  for (const r of rows) {
    const spend = parseFloat(String(r.spend_amount).replace(/[$,]/g, "")) || 0;
    const total = parseFloat(String(r.check_total).replace(/[$,]/g, "")) || 0;
    const key = [r.member_id || `guest:${r.member_name}`, r.outlet_name, r.visit_date].join("|");

    const existing = byKey.get(key);
    if (existing) {
      existing.spend += spend;
      existing.check_total += total;
      existing.checks += 1;
      if (!existing.server_name && r.server_name) existing.server_name = r.server_name;
      merged++;
    } else {
      byKey.set(key, { ...r, spend, check_total: total, checks: 1 });
    }
  }

  return {
    rows: [...byKey.values()].map((r) => ({
      ...r,
      spend_amount: r.spend.toFixed(2),
      check_total: r.check_total.toFixed(2),
    })),
    merged,
  };
}

module.exports = {
  isSalesByLocation,
  parseSalesByLocation,
  aggregateRows,
  splitServerAndMember,
  toIsoDate,
};
