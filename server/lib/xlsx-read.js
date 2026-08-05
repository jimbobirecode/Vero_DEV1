// Excel reading via exceljs.
//
// Replaces the `xlsx` (SheetJS) package, which carries unfixed advisories for
// prototype pollution (GHSA-4r6h-8v6p-xvw6) and ReDoS (GHSA-5pgg-2g8v-p4x9).
// Exposes just the two shapes the tee sheet parser needs: row objects keyed by
// header, and a CSV rendering used for date sniffing.

const ExcelJS = require("exceljs");

// Excel cells can hold rich text, formula results, hyperlinks or dates rather
// than plain values; flatten them all to a trimmed string.
function cellToString(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().split("T")[0];
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join("");
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return String(value.result);
    if (value.hyperlink !== undefined) return String(value.hyperlink);
    return "";
  }
  return String(value);
}

function csvEscape(s) {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Reads the first worksheet and returns { rows, csv }.
// `rows` are objects keyed by the header row, mirroring sheet_to_json with
// defval:"" — every header key is present on every row.
async function readFirstSheet(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const sheet = wb.worksheets[0];
  if (!sheet) return { rows: [], csv: "" };

  const grid = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    // row.values is 1-based with a leading hole; drop it.
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    for (let i = 0; i < values.length; i++) cells.push(cellToString(values[i]).trim());
    grid.push(cells);
  });

  if (!grid.length) return { rows: [], csv: "" };

  const width = Math.max(...grid.map((r) => r.length));
  const headers = [];
  for (let i = 0; i < width; i++) {
    const h = (grid[0][i] || "").trim();
    headers.push(h || `column_${i + 1}`);
  }

  const rows = grid.slice(1)
    .filter((cells) => cells.some((c) => c !== ""))
    .map((cells) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cells[i] ?? ""; });
      return obj;
    });

  const csv = grid.map((cells) => {
    const padded = [];
    for (let i = 0; i < width; i++) padded.push(csvEscape(cells[i] ?? ""));
    return padded.join(",");
  }).join("\n");

  return { rows, csv };
}

module.exports = { readFirstSheet, cellToString };
