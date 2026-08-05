// Primitives shared by every POS vendor module.
//
// Each vendor writes money, dates and CSV differently enough that doing this
// per-parser produced three subtly different bugs the first time round. These
// are the one implementation everything goes through.

// ---------------------------------------------------------------- money ----

// Handles "$1,234.56", "(45.00)" for a credit, "-12.00", "12.00-" (trailing
// minus, which Jonas emits on voids), bare "1234.56", and the European
// "1.234,56" some Lightspeed locales export.
function parseMoney(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  let s = String(value).trim();
  if (!s) return null;

  const negative = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s);
  s = s.replace(/[^0-9.,]/g, "");
  if (!s || !/\d/.test(s)) return null;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) {
    // A comma after the last dot is a decimal separator only when exactly two
    // digits follow it. "1,234" is a thousands group; "1.234,56" is not.
    if (/,\d{2}$/.test(s)) s = s.replace(/\./g, "").replace(/,(?=\d{2}$)/, ".");
    else s = s.replace(/,/g, "");
  } else {
    s = s.replace(/,/g, "");
  }

  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// True when the text looks like a money field at all, used to score header
// rows and to reject "Table 12" style columns that parseMoney would happily
// turn into 12.
function looksLikeMoney(value) {
  const s = String(value ?? "").trim();
  if (!s) return false;
  return /^[($-]?\s*[\d,. ]+\)?-?$/.test(s) && /\d/.test(s);
}

// ----------------------------------------------------------------- dates ----

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n) => String(n).padStart(2, "0");

function iso(y, m, d) {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const year = y < 100 ? (y >= 70 ? 1900 + y : 2000 + y) : y;
  return `${year}-${pad(m)}-${pad(d)}`;
}

// Normalises whatever the vendor put in the date column to YYYY-MM-DD.
// Numeric dates are read month-first (every club on these systems is US or
// Canadian) unless `dayFirst` is set or the first part cannot be a month.
function toIsoDate(value, { dayFirst = false } = {}) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }

  // Drop a trailing clock time: Lightspeed exports "2026-07-29 14:32:11" and
  // "2026-07-29T14:32:11Z" in the same column depending on the report.
  let s = String(value).trim().replace(/[T ]\d{1,2}:\d{2}(:\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?\s*(?:Z|[+-]\d{2}:?\d{2})?$/, "").trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    // 13+ in the first slot can only be a day, whatever the locale claims.
    const monthFirst = a <= 12 && (!dayFirst || b > 12);
    return monthFirst ? iso(+m[3], a, b) : iso(+m[3], b, a);
  }

  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{2,4})$/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mon ? iso(+m[3], mon, +m[1]) : null;
  }

  m = s.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mon ? iso(+m[3], mon, +m[2]) : null;
  }

  return null;
}

function looksLikeDate(value) {
  return toIsoDate(value) !== null;
}

// ------------------------------------------------------------------- CSV ----

// A real CSV reader. The old inline `line.split(",")` broke on every Jonas and
// Lightspeed export, because member names are written "Smith, John" and land
// inside quotes — every row after that column shifted by one.
function parseDelimited(text, delimiter) {
  const delim = delimiter || sniffDelimiter(text);
  const grid = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }

    if (c === '"' && field.trim() === "") { quoted = true; field = ""; continue; }
    if (c === delim) { row.push(field.trim()); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field.trim()); grid.push(row); row = []; field = ""; continue; }
    field += c;
  }
  row.push(field.trim());
  grid.push(row);

  return grid.filter((r) => r.some((c) => c !== ""));
}

// Picks the delimiter that yields the most consistent column count across the
// first few lines, rather than whichever character happens to appear first.
function sniffDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  if (!lines.length) return ",";

  let best = ",";
  let bestScore = -1;
  for (const d of ["\t", ",", ";", "|"]) {
    const counts = lines.map((l) => l.split(d).length);
    const max = Math.max(...counts);
    if (max < 2) continue;
    // Reward many columns, punish rows that disagree about how many there are.
    const modal = counts.filter((c) => c === max).length;
    const score = max * 2 + modal;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

// --------------------------------------------------------------- headers ----

// "#" carries the whole meaning of "Member #" — it is what separates the
// account number from the member's name. Stripping it as punctuation left
// "member", which matched neither, so the column was silently dropped.
function normalizeHeader(h) {
  return String(h ?? "")
    .toLowerCase()
    .replace(/#/g, " num ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Outlet names have to survive "GRILL ROOM" vs "Grill Room" vs "The Grill
// Room" vs "Grill-Room". Matching is still exact after this — never fuzzy,
// because mapping a check to the wrong outlet applies the wrong threshold.
function normalizeOutlet(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^the\s+/, "")
    .trim();
}

// Resolves each field to the best-scoring header cell, never handing the same
// column to two fields. `spec` maps a field name to an array of matchers,
// earliest matcher = strongest.
function mapColumns(headers, spec) {
  const normalized = headers.map(normalizeHeader);
  const claims = [];

  for (const [field, matchers] of Object.entries(spec)) {
    for (let i = 0; i < normalized.length; i++) {
      const h = normalized[i];
      if (!h) continue;
      for (let rank = 0; rank < matchers.length; rank++) {
        const m = matchers[rank];
        const hit = typeof m === "function" ? m(h, headers[i]) : m.test(h);
        if (hit) { claims.push({ field, index: i, rank }); break; }
      }
    }
  }

  claims.sort((a, b) => a.rank - b.rank || a.index - b.index);

  const map = {};
  const taken = new Set();
  for (const c of claims) {
    if (map[c.field] !== undefined || taken.has(c.index)) continue;
    map[c.field] = c.index;
    taken.add(c.index);
  }
  return map;
}

// Scores a row's plausibility as the header of the data table. Used to skip
// the title/date/filter preamble both vendors put above their tables.
function scoreHeaderRow(cells, spec) {
  const nonEmpty = cells.filter((c) => String(c ?? "").trim()).length;
  if (nonEmpty < 2) return 0;
  const map = mapColumns(cells, spec);
  const fields = Object.keys(map).length;
  if (!fields) return 0;
  // A header row is words, not numbers — a data row can otherwise out-score it.
  const numeric = cells.filter((c) => looksLikeMoney(c) || looksLikeDate(c)).length;
  return fields * 10 + nonEmpty - numeric * 8;
}

module.exports = {
  parseMoney, looksLikeMoney,
  toIsoDate, looksLikeDate,
  parseDelimited, sniffDelimiter,
  normalizeHeader, normalizeOutlet, mapColumns, scoreHeaderRow,
};
