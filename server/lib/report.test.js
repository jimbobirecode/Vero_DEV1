// The report model, and that both renderers produce real files from it.
//
// The model is where a board pack goes wrong quietly: a response rate divided
// by a zero send, a "previous period" that is not the same length, an empty
// section rendered as a heading with nothing under it. All of that is arithmetic
// and shape, so it is tested without a database.
const fs = require("fs");
const os = require("os");
const path = require("path");
const R = require("../lib/report.js");
const render = require("../lib/report-render.js");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const FROM = "2026-07-01T00:00:00.000Z";
const TO = "2026-08-01T00:00:00.000Z";

const SCORES = {
  response_count: 412,
  overall: { nps: 54.4, csat: 4.37, chi: 82.1, ssi: 79.4, ohi: 71.2 },
  by_outlet: [
    { outlet: "Belmont Dining Room", response_count: 210, nps: 58.2, csat: 4.4, food: 4.3, service: 4.5 },
    { outlet: "Golf Patio", response_count: 202, nps: 50.1, csat: 4.3, food: 4.2, service: 4.4 },
  ],
  by_month: [
    { month: "2026-07", response_count: 412, nps: 54.4, csat: 4.37 },
  ],
};

const PREVIOUS = { response_count: 388, overall: { nps: 49.1, csat: 4.21, chi: 79.8, ssi: 78.0, ohi: 70.4 } };

const model = () => R.build({
  clubName: "Aronimink Golf Club", from: FROM, to: TO,
  scores: SCORES, previousScores: PREVIOUS,
  leaderboard: [{ server_name: "Jessica McGarrey", survey_count: 41, avg_nps: 8.8, avg_overall: 4.6, avg_food: 4.4, avg_service: 4.7, composite_score: 4.51 }],
  alerts: { total: 12, open: 3, by_severity: [{ severity: "high", count: 4 }, { severity: "medium", count: 6 }, { severity: "low", count: 2 }],
            open_by_severity: [{ severity: "high", count: 1 }, { severity: "medium", count: 2 }, { severity: "low", count: 0 }] },
  credit: { balance_cents: 4210, currency: "USD", usage: [{ date: "2026-07-30", kind: "survey", label: "Survey", messages: 412, amount_cents: 824 }] },
  surveys: { sent: 900, responded: 412 },
  generatedAt: "2026-08-07T12:00:00.000Z",
});

// ----------------------------------------------------------------- period --

check("a period reads as a person would say it", R.period(FROM, TO).label, "July 1, 2026 — August 1, 2026");
check("and knows its own length", R.period(FROM, TO).days, 31);

// ------------------------------------------------------------------ delta --

check("a rise is signed", R.delta(54, 49, 0).label, "+5");
check("a fall carries its minus", R.delta(49, 54, 0).label, "-5");
// "0" beside every other row reads as a measured zero; "no change" reads as
// what it is.
check("no movement says so rather than showing a zero", R.delta(50, 50, 0).label, "no change");
check("direction is stated, not left to the sign", R.delta(54, 49, 0).direction, "up");
check("a missing previous gives no delta rather than a fake one", R.delta(54, null), null);
check("a missing current gives none either", R.delta(null, 49), null);

// ---------------------------------------------------------- response rate --

check("a response rate is a percentage", R.responseRate(412, 900), 45.8);
// Zero sent is "no rate", not "0%" — dividing by it gives NaN or Infinity, and
// both render as something alarming on a board pack.
check("no sends means no rate, not zero percent", R.responseRate(0, 0), null);
check("nothing sent but something responded is still no rate", R.responseRate(5, 0), null);
check("a full response rate is a hundred", R.responseRate(10, 10), 100);

// ------------------------------------------------------------------ model --

const m = model();
check("the club is named", m.club, "Aronimink Golf Club");
check("headline covers the four figures", m.headline.map((h) => h.key),
  ["nps", "csat", "responses", "response_rate"]);
check("NPS is rounded to a whole number", m.headline[0].value, 54);
check("and carries its change", m.headline[0].delta.label, "+5");
check("CSAT keeps two places, because a hundredth is a real movement", m.headline[1].value, 4.37);
check("the response rate is computed from sends", m.headline[3].value, 45.8);

check("all three indices appear when they are fed", m.indices.map((i) => i.key), ["chi", "ssi", "ohi"]);
check("an index carries its change", m.indices[0].delta.label, "+2.3");

check("outlets come through", m.outlets.length, 2);
check("with their responses", m.outlets[0].responses, 210);
check("servers are ranked", m.servers[0].rank, 1);
check("alerts state what was resolved rather than making the reader subtract",
  m.alerts.find((a) => a.severity === "high").resolved, 3);
check("credit totals its own spend", m.credit.spend_cents, 824);
check("and its messages", m.credit.messages, 412);

// A new club, or a quiet period. This must produce a report, not an exception.
const bare = R.build({ clubName: "New Club", from: FROM, to: TO });
check("a club with no data still produces a report", typeof bare.period.label, "string");
check("with its headline present but empty", bare.headline.length, 4);
check("no invented values", bare.headline[0].value, null);
check("and it says which sections are absent",
  bare.empty_sections.sort(), ["alerts", "credit", "outlets", "servers", "trend"]);
check("no indices when nothing feeds them", bare.indices.length, 0);

check("sections list only what has data", R.sections(bare).map((s) => s.key), ["summary"]);
check("and everything that does",
  R.sections(m).map((s) => s.key), ["summary", "indices", "outlets", "trend", "servers", "alerts", "credit"]);

// --------------------------------------------------------------- filename --

check("a filename is dated and slugged", R.filename(m, "pdf"),
  "aronimink-golf-club-report-2026-07-01-to-2026-08-01.pdf");
check("a club name with punctuation still yields a safe filename",
  R.filename(R.build({ clubName: "St. Andrews / Old Course", from: FROM, to: TO }), "xlsx"),
  "st-andrews-old-course-report-2026-07-01-to-2026-08-01.xlsx");

// -------------------------------------------------------------- renderers --
// Not a golden-file comparison — just proof that each produces a real, openable
// file of the right type, which is what a "download did nothing" bug looks like.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vero-report-"));

(async () => {
  // --- Excel
  const xlsxPath = path.join(tmp, "r.xlsx");
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(xlsxPath);
    out.on("finish", resolve); out.on("error", reject);
    render.toExcel(m, out).catch(reject);
  });
  const xlsx = fs.readFileSync(xlsxPath);
  check("the workbook is written", xlsx.length > 2000, true);
  // xlsx is a zip; PK is its magic number. A truncated stream fails this.
  check("and is a real xlsx, not a truncated stream",
    xlsx[0] === 0x50 && xlsx[1] === 0x4b, true);

  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  check("it opens again", wb.worksheets.length > 0, true);
  check("with a sheet per section",
    wb.worksheets.map((w) => w.name),
    ["Summary", "By outlet", "Month on month", "Server performance", "Case alerts", "SMS credit"]);
  const summary = wb.getWorksheet("Summary");
  check("the summary names the club", summary.getCell("A1").value, "Aronimink Golf Club");
  const outletSheet = wb.getWorksheet("By outlet");
  check("outlet rows survive the round trip", outletSheet.getCell("A2").value, "Belmont Dining Room");
  check("and their numbers stay numbers, not text", typeof outletSheet.getCell("B2").value, "number");

  // A club with nothing must still produce an openable file rather than a
  // zero-byte download.
  const barePath = path.join(tmp, "bare.xlsx");
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(barePath);
    out.on("finish", resolve); out.on("error", reject);
    render.toExcel(bare, out).catch(reject);
  });
  const bareWb = new ExcelJS.Workbook();
  await bareWb.xlsx.readFile(barePath);
  check("an empty club still yields an openable workbook", bareWb.worksheets.map((w) => w.name), ["Summary"]);

  // --- PDF
  const pdfPath = path.join(tmp, "r.pdf");
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(pdfPath);
    out.on("finish", resolve); out.on("error", reject);
    render.toPdf(m, out);
  });
  const pdf = fs.readFileSync(pdfPath);
  check("the pdf is written", pdf.length > 2000, true);
  check("and starts with the PDF magic number", pdf.slice(0, 5).toString(), "%PDF-");
  check("and is properly terminated, not cut off mid-stream",
    pdf.slice(-1024).toString().includes("%%EOF"), true);

  const barePdf = path.join(tmp, "bare.pdf");
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(barePdf);
    out.on("finish", resolve); out.on("error", reject);
    render.toPdf(bare, out);
  });
  check("an empty club still yields a valid pdf",
    fs.readFileSync(barePdf).slice(0, 5).toString(), "%PDF-");

  check("money is formatted once, in the renderer", render.money(824, "USD"), "$8.24");
  check("and honours the currency", render.money(824, "GBP"), "£8.24");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
