// POS module registry.
//
// One entry point for every end-of-shift report the system can read, whatever
// the vendor and whatever the file type. Adding a POS means writing a profile
// (see jonas.js for the shape) and listing it here — nothing in the route or
// the dashboard needs to change.
//
// Detection is by confidence rather than by first match: every module scores
// the document and the highest wins, with the generic reader as the floor. A
// club can always override from the dropdown when the file is unbranded.

const { PDFParse } = require("pdf-parse");
const ExcelJS = require("exceljs");
const { cellToString } = require("../xlsx-read");
const { parseDelimited, normalizeOutlet } = require("./shared");
const { extractRows } = require("./table");
const posParse = require("../pos-parse");

const jonas = require("./jonas");
const lightspeed = require("./lightspeed");
const generic = require("./generic");

// NorthStar's PDF wraps a single check across several lines, so it is parsed
// line-by-line rather than by the column engine. It is wrapped as a module
// here so callers see one uniform interface.
const northstar = {
  id: "northstar",
  label: "NorthStar Sales By Location",
  detect(doc) {
    return posParse.isSalesByLocation(doc.lines) ? 0.95 : 0;
  },
  parse(doc, options) {
    const parsed = posParse.parseSalesByLocation(doc.rawLines, options.outletName);
    return {
      rows: parsed.rows,
      diagnostics: {
        format: "NorthStar Sales By Location",
        vendor: "northstar",
        stats: {
          rows_read: parsed.stats.rows_parsed,
          rows_without_member: parsed.stats.rows_without_member_id,
          rows_skipped_summary: 0,
          rows_skipped_no_amount: parsed.stats.unparsed_lines,
          negative_rows: 0,
        },
        locations: parsed.stats.locations,
      },
    };
  },
};

// Order is presentational only — detect() decides. Generic stays last.
const MODULES = [northstar, jonas, lightspeed, generic];

// ------------------------------------------------------------ file input ----

const SHEET_RE = /\.(xlsx|xlsm|xls)$/i;
const CSV_RE = /\.(csv|tsv|txt)$/i;
const PDF_RE = /\.pdf$/i;

function supportedFileTypes() {
  return [".pdf", ".csv", ".tsv", ".xlsx", ".xls"];
}

// Turns an uploaded file into the document shape the modules read:
//   kind    "pdf" | "sheet"
//   grid    rows of cells — present for CSV and Excel, null for PDF
//   lines   trimmed non-empty text lines
//   rawLines untrimmed lines, which the NorthStar parser needs for its tabs
//   headText the first stretch of the file, used by detect()
async function readDocument(file) {
  const name = file.originalname || "";

  if (PDF_RE.test(name)) {
    let text;
    try {
      const parsed = await new PDFParse({ data: file.buffer }).getText();
      text = parsed.text;
    } catch (e) {
      return { error: "Could not read this PDF: " + String(e) };
    }
    if (!text || text.trim().length < 10) {
      return { error: "This PDF has no extractable text — it is probably a scan. Export the report as CSV or Excel instead." };
    }
    const rawLines = text.split(/\r?\n/);
    const lines = rawLines.map((l) => l.trim()).filter(Boolean);
    return { kind: "pdf", grid: null, lines, rawLines, headText: lines.slice(0, 60).join("\n") };
  }

  if (SHEET_RE.test(name)) {
    let grid;
    try {
      grid = await readSheetGrid(file.buffer);
    } catch (e) {
      return { error: "Could not read this Excel file: " + String(e) };
    }
    if (!grid.length) return { error: "This spreadsheet is empty." };
    return gridDocument(grid, "sheet");
  }

  if (CSV_RE.test(name)) {
    const text = file.buffer.toString("utf-8").replace(/^﻿/, "");
    if (!text.trim()) return { error: "This file is empty." };
    const grid = parseDelimited(text);
    if (!grid.length) return { error: "This file has no rows." };
    return gridDocument(grid, "sheet");
  }

  return { error: `Unsupported file type. Upload one of: ${supportedFileTypes().join(", ")}.` };
}

function gridDocument(grid, kind) {
  const lines = grid.map((r) => r.join(" ").trim()).filter(Boolean);
  return {
    kind,
    grid,
    lines,
    rawLines: grid.map((r) => r.join("\t")),
    headText: grid.slice(0, 60).map((r) => r.join(" ")).join("\n"),
  };
}

// readFirstSheet() treats row 1 as the header, which is wrong for reports that
// carry a title block above the table. We need the raw grid so the engine can
// find the header itself.
async function readSheetGrid(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return [];

  const grid = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    const cells = [];
    for (let i = 0; i < values.length; i++) cells.push(cellToString(values[i]).trim());
    if (cells.some((c) => c !== "")) grid.push(cells);
  });
  return grid;
}

// -------------------------------------------------------------- dispatch ----

function detectModule(doc, forcedVendor) {
  if (forcedVendor) {
    const forced = MODULES.find((m) => m.id === forcedVendor);
    if (forced) return { module: forced, confidence: 1, forced: true };
  }

  let best = null;
  const scores = {};
  for (const m of MODULES) {
    const score = m.detect(doc) || 0;
    scores[m.id] = Math.round(score * 100) / 100;
    if (!best || score > best.confidence) best = { module: m, confidence: score, forced: false };
  }
  return { ...best, scores };
}

// Parses an uploaded POS report into visit rows.
//
//   { rows, summary }        on success
//   { error, summary }       when the file cannot be read
//
// `rows` are one visit per member per outlet per day — repeat checks are
// folded together, because survey eligibility is about what a member spent at
// an outlet that day, not per check.
async function parseUpload(file, options = {}) {
  const doc = await readDocument(file);
  if (doc.error) return { error: doc.error, summary: null };

  const { module: mod, confidence, forced, scores } = detectModule(doc, options.vendor);

  const parsed = mod.parse
    ? mod.parse(doc, options)
    : extractRows(doc, mod, options);

  if (parsed.error) {
    // The failure summary carries the same fields as a successful one, so the
    // dashboard can always show which module was tried and what it found —
    // that is the whole diagnostic trail when a club's real export does not
    // match and we need to tune the module.
    return {
      error: parsed.error,
      summary: {
        ...(parsed.diagnostics || {}),
        vendor: mod.id,
        format: mod.label,
        file_type: doc.kind,
        detected: forced ? "chosen by you" : "auto-detected",
        confidence: Math.round(confidence * 100) / 100,
        candidates: scores,
      },
    };
  }

  const merged = posParse.aggregateRows(parsed.rows);
  const d = parsed.diagnostics || {};
  const variant = mod.variant ? mod.variant(doc) : null;

  return {
    rows: merged.rows,
    summary: {
      ...d,
      format: variant ? `${d.format} ${variant}` : d.format,
      vendor: mod.id,
      file_type: doc.kind,
      detected: forced ? "chosen by you" : "auto-detected",
      confidence: Math.round(confidence * 100) / 100,
      candidates: scores,
      checks_parsed: d.stats?.rows_read ?? parsed.rows.length,
      checks_without_member: d.stats?.rows_without_member ?? 0,
      checks_merged: merged.merged,
      visits: merged.rows.length,
      locations: d.locations || [...new Set(merged.rows.map((r) => r.outlet_name).filter(Boolean))],
    },
  };
}

// What the dashboard offers in its "POS system" dropdown.
function listModules() {
  return MODULES.map((m) => ({
    id: m.id,
    label: m.label,
    file_types: m.id === "northstar" ? [".pdf"] : supportedFileTypes(),
  }));
}

module.exports = {
  parseUpload, readDocument, detectModule, listModules, supportedFileTypes,
  normalizeOutlet,
  MODULES,
};
