// The engine behind every column-oriented POS export.
//
// Jonas and Lightspeed (and Toast, Square, Clubessential when they arrive) all
// emit the same fundamental thing: a preamble, a header row, then one line per
// check. What differs is the wording of the columns and which of them holds
// the figure we should treat as spend. So the mechanics live here once, and a
// vendor module is just a dictionary plus a detector.
//
// NorthStar is deliberately NOT on this engine — its PDF wraps rows across
// several lines, which is a line-oriented problem, and it already has a
// working parser in ../pos-parse.js.

const {
  parseMoney, toIsoDate, mapColumns, scoreHeaderRow, normalizeHeader,
} = require("./shared");

// How far into the file to look for the header. Jonas reports carry up to a
// dozen preamble lines (club name, report title, date range, filters, the
// operator who ran it); 60 covers a first page of anything we have seen.
const HEADER_SEARCH_DEPTH = 60;

// Splitting PDF text into columns. Tabs and pipes are unambiguous; runs of
// spaces are tried widest-first so "Grill Room" stays one cell.
const PDF_DELIMITERS = [/\t+/, /\s*\|\s*/, /\s{3,}/, /\s{2,}/];

// Finds the header row and, for PDFs, the delimiter that best splits it.
function locateHeader(doc, spec) {
  let best = null;

  if (doc.grid) {
    const depth = Math.min(doc.grid.length, HEADER_SEARCH_DEPTH);
    for (let i = 0; i < depth; i++) {
      const score = scoreHeaderRow(doc.grid[i], spec);
      if (score > 0 && (!best || score > best.score)) {
        best = { index: i, score, cells: doc.grid[i], split: null };
      }
    }
    return best;
  }

  const depth = Math.min(doc.lines.length, HEADER_SEARCH_DEPTH);
  for (let i = 0; i < depth; i++) {
    for (const split of PDF_DELIMITERS) {
      const cells = doc.lines[i].split(split).map((c) => c.trim());
      const score = scoreHeaderRow(cells, spec);
      if (score > 0 && (!best || score > best.score)) {
        best = { index: i, score, cells, split };
      }
    }
  }
  return best;
}

function dataRows(doc, header) {
  if (doc.grid) return doc.grid.slice(header.index + 1);
  return doc.lines.slice(header.index + 1)
    .map((l) => l.split(header.split).map((c) => c.trim()));
}

// Rows that are a report's own subtotal, grand total, page furniture or
// footnote. Left in, they become phantom visits with a huge spend.
const SUMMARY_RE = /^(sub\s*)?total\b|^grand\s+total|^report\s+total|^department\s+total|^location\s+total|total\s+for\b|^page\s+\d|^printed\b|^\s*[-=_*]{3,}\s*$|^note\s*:|^copyright|^©/i;

function isSummaryRow(cells) {
  const filled = cells.filter((c) => String(c ?? "").trim());
  if (!filled.length) return true;
  return filled.some((c) => SUMMARY_RE.test(String(c).trim()));
}

// The other shape a total takes: no label at all, just the figures sitting
// under their columns. Nothing identifies it, so it is recognised by absence —
// a row with no member, no check number and no date is not a check. A real
// walk-in check with no member still carries a check number and a date, so
// this does not swallow one.
function isUnlabelledTotal(cells, map) {
  const has = (field) => map[field] !== undefined && String(cells[map[field]] ?? "").trim() !== "";
  return !has("member_id") && !has("member_name") && !has("check_number") && !has("visit_date");
}

// Reads `field` off a row, tolerating vendors that emit the column but leave
// it blank on some rows.
function cell(cells, map, field) {
  const idx = map[field];
  if (idx === undefined) return "";
  return String(cells[idx] ?? "").trim();
}

// Runs a vendor profile over a document.
//
// Returns { rows, diagnostics } on success, or { error, diagnostics } when the
// file does not carry enough to build a visit from. The diagnostics are
// surfaced in the UI verbatim — when a real export does not match, the club
// should be able to see which columns we found rather than guess.
function extractRows(doc, profile, options = {}) {
  const spec = profile.columns;
  const header = locateHeader(doc, spec);

  if (!header) {
    const preview = (doc.grid ? doc.grid.slice(0, 8).map((r) => r.join(" | ")) : doc.lines.slice(0, 8));
    return {
      error: `Could not find a header row in this ${profile.label} export.`,
      diagnostics: { format: profile.label, preview: preview.map((l) => String(l).slice(0, 200)) },
    };
  }

  const map = mapColumns(header.cells, spec);
  const claimed = new Set(Object.values(map));
  const diagnostics = {
    format: profile.label,
    vendor: profile.id,
    header_row: header.index + 1,
    columns_mapped: Object.fromEntries(
      Object.entries(map).map(([field, i]) => [field, String(header.cells[i] ?? "").trim()]),
    ),
    columns_ignored: header.cells
      .map((h, i) => (claimed.has(i) ? null : String(h ?? "").trim()))
      .filter((h) => h),
  };

  // Spend is the only column with no substitute. Everything else has a
  // fallback: the outlet can come from the dropdown, the date from the report
  // header, the member from a name.
  const spendField = ["spend_amount", "check_total", "gross_amount"].find((f) => map[f] !== undefined);
  if (!spendField) {
    return {
      error: `This ${profile.label} export has no amount column. Found: ${diagnostics.columns_ignored.join(", ") || "nothing recognisable"}.`,
      diagnostics,
    };
  }
  diagnostics.spend_column = String(header.cells[map[spendField]] ?? "").trim();

  const fallbackOutlet = options.outletName || profile.outletFromPreamble?.(doc, header) || null;
  if (map.outlet_name === undefined && !fallbackOutlet) {
    return {
      error: `This ${profile.label} export has no ${profile.outletLabel || "outlet"} column, so its checks cannot be assigned to an outlet. Pick an outlet from the dropdown and upload again.`,
      diagnostics,
    };
  }
  if (map.member_id === undefined && map.member_name === undefined) {
    return {
      error: `This ${profile.label} export identifies nobody — it has neither a member number nor a member name column, so there is no one to survey. Found: ${diagnostics.columns_ignored.join(", ")}.`,
      diagnostics,
    };
  }
  if (fallbackOutlet) diagnostics.outlet_applied = fallbackOutlet;

  // Anything a profile can only decide by looking at the whole column — the
  // date locale, say. Returned rather than stored on the profile, which is a
  // module singleton shared by every in-flight upload.
  const tuning = profile.prepare?.(doc, header, map) || {};
  if (tuning.dayFirst) diagnostics.date_order = "day-first";

  const stats = { rows_read: 0, rows_skipped_summary: 0, rows_skipped_no_amount: 0, rows_without_member: 0, negative_rows: 0 };
  const rows = [];
  const reportDate = options.reportDate || profile.dateFromPreamble?.(doc, header) || null;

  for (const cells of dataRows(doc, header)) {
    if (isSummaryRow(cells) || isUnlabelledTotal(cells, map)) { stats.rows_skipped_summary++; continue; }
    stats.rows_read++;

    const spend = parseMoney(cell(cells, map, spendField));
    if (spend === null) { stats.rows_skipped_no_amount++; continue; }

    // A voided or refunded check comes through negative. Keeping it lets the
    // day's aggregate net out correctly instead of surveying somebody on a
    // sale that was reversed.
    if (spend < 0) stats.negative_rows++;

    const memberId = profile.cleanMemberId
      ? profile.cleanMemberId(cell(cells, map, "member_id"))
      : cell(cells, map, "member_id");
    const memberName = cell(cells, map, "member_name");
    if (!memberId && !memberName) stats.rows_without_member++;

    const covers = parseInt(cell(cells, map, "covers"), 10);
    const checkTotal = map.check_total !== undefined
      ? parseMoney(cell(cells, map, "check_total"))
      : null;

    const row = {
      member_id: memberId,
      member_name: memberName,
      outlet_name: cell(cells, map, "outlet_name") || fallbackOutlet || "",
      spend_amount: spend.toFixed(2),
      check_total: (checkTotal === null ? spend : checkTotal).toFixed(2),
      visit_date: toIsoDate(cell(cells, map, "visit_date"), { dayFirst: tuning.dayFirst }) || reportDate || "",
      check_number: cell(cells, map, "check_number"),
      covers: Number.isFinite(covers) ? covers : null,
      server_name: cell(cells, map, "server_name"),
    };

    rows.push(profile.refineRow ? profile.refineRow(row) : row);
  }

  diagnostics.stats = stats;

  if (!rows.length) {
    return {
      error: `Found the header row in this ${profile.label} export but no usable check rows beneath it.`,
      diagnostics,
    };
  }

  return { rows, diagnostics };
}

module.exports = { extractRows, locateHeader, isSummaryRow, isUnlabelledTotal, normalizeHeader, HEADER_SEARCH_DEPTH };
