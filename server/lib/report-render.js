// Rendering the report model to a spreadsheet and to a PDF.
//
// Neither does arithmetic. Every number arrives already computed and already
// formatted by lib/report.js, because the moment a renderer starts rounding
// things itself the PDF and the spreadsheet begin disagreeing with each other
// and with the screen.
//
// Both stream. A club with two years of history produces a workbook large
// enough that buffering it whole costs real memory on a starter instance, and
// streaming means the download starts immediately rather than after the server
// has finished thinking.

const report = require("./report");

// Vero's brand, not the chart palette: this is a document, and forest reads as
// a heading here in a way it cannot as a data series.
const INK = "FF20241F";
const FOREST = "FF16302A";
const SOFT = "FF5B6259";
const LINE = "FFE4DFD1";
const IVORY = "FFF5F2EA";

// ------------------------------------------------------------------ excel --

function money(cents, currency) {
  const symbol = { USD: "$", GBP: "£", EUR: "€", CAD: "$", AUD: "$" }[currency] || "$";
  return symbol + ((Number(cents) || 0) / 100).toFixed(2);
}

function headerRow(sheet, labels, widths) {
  sheet.columns = labels.map((l, i) => ({ header: l, key: "c" + i, width: widths[i] || 16 }));
  const row = sheet.getRow(1);
  row.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FOREST } };
  row.alignment = { vertical: "middle" };
  row.height = 20;
  // Frozen, so a 400-row outlet sheet still tells you which column you are in.
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  return row;
}

function zebra(sheet, from) {
  for (let i = from; i <= sheet.rowCount; i++) {
    if (i % 2 === 0) {
      sheet.getRow(i).fill = { type: "pattern", pattern: "solid", fgColor: { argb: IVORY } };
    }
  }
}

async function toExcel(model, stream) {
  const ExcelJS = require("exceljs");
  // The streaming writer: rows are flushed as they are added rather than held.
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true });
  wb.creator = "Vero";
  wb.created = model.generated_at ? new Date(model.generated_at) : new Date();

  // --- Summary
  const s = wb.addWorksheet("Summary");
  s.columns = [{ width: 30 }, { width: 18 }, { width: 18 }, { width: 16 }];

  s.addRow([model.club]).font = { bold: true, size: 16, color: { argb: FOREST } };
  s.addRow([model.period.label]).font = { size: 11, color: { argb: SOFT } };
  if (model.generated_at) {
    s.addRow(["Generated " + new Date(model.generated_at).toLocaleString("en-US", { timeZone: "UTC" }) + " UTC"])
      .font = { size: 9, color: { argb: SOFT } };
  }
  s.addRow([]);

  const hh = s.addRow(["Measure", "This period", "Previous", "Change"]);
  hh.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
  hh.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FOREST } };

  model.headline.forEach((h) => {
    s.addRow([
      h.label,
      h.value == null ? "—" : h.value,
      h.previous == null ? "—" : h.previous,
      h.delta ? h.delta.label : "—",
    ]);
  });

  if (model.indices.length) {
    s.addRow([]);
    const ih = s.addRow(["Club index", "This period", "Previous", "Change"]);
    ih.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
    ih.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FOREST } };
    model.indices.forEach((i) => {
      s.addRow([i.label, i.value ?? "—", i.previous ?? "—", i.delta ? i.delta.label : "—"]);
    });
  }

  if (model.empty_sections.length) {
    s.addRow([]);
    s.addRow(["Not included: no data for " + model.empty_sections.join(", ") + " in this period."])
      .font = { italic: true, size: 9, color: { argb: SOFT } };
  }
  s.commit();

  // --- By outlet
  if (model.outlets.length) {
    const o = wb.addWorksheet("By outlet");
    headerRow(o, ["Outlet", "Responses", "NPS", "CSAT", "Food", "Service"], [26, 12, 10, 10, 10, 10]);
    model.outlets.forEach((r) => o.addRow([r.outlet, r.responses, r.nps ?? "—", r.csat ?? "—", r.food ?? "—", r.service ?? "—"]).commit());
    o.commit();
  }

  // --- Month on month
  if (model.months.length) {
    const m = wb.addWorksheet("Month on month");
    headerRow(m, ["Month", "Responses", "NPS", "CSAT"], [14, 12, 10, 10]);
    model.months.forEach((r) => m.addRow([r.month, r.responses, r.nps ?? "—", r.csat ?? "—"]).commit());
    m.commit();
  }

  // --- Servers
  if (model.servers.length) {
    const sv = wb.addWorksheet("Server performance");
    headerRow(sv, ["#", "Server", "Surveys", "Composite", "NPS", "Overall", "Food", "Service"], [5, 24, 10, 11, 9, 9, 9, 9]);
    model.servers.forEach((r) => sv.addRow([r.rank, r.name, r.surveys, r.composite, r.nps, r.overall, r.food, r.service]).commit());
    sv.commit();
  }

  // --- Alerts
  if (model.alerts.length) {
    const a = wb.addWorksheet("Case alerts");
    headerRow(a, ["Severity", "Raised", "Resolved", "Still open"], [14, 10, 11, 11]);
    model.alerts.forEach((r) => a.addRow([r.label, r.raised, r.resolved, r.open]).commit());
    a.addRow([]).commit();
    a.addRow(["Total", model.alerts_total, model.alerts_total - model.alerts_open, model.alerts_open]).commit();
    a.commit();
  }

  // --- Credit
  if (model.credit && model.credit.usage.length) {
    const c = wb.addWorksheet("SMS credit");
    headerRow(c, ["Date", "Type", "Messages", "Cost"], [14, 24, 12, 12]);
    model.credit.usage.forEach((r) =>
      c.addRow([r.date, r.type, r.messages, money(r.cost_cents, model.credit.currency)]).commit());
    c.addRow([]).commit();
    c.addRow(["Total", "", model.credit.messages, money(model.credit.spend_cents, model.credit.currency)]).commit();
    c.addRow(["Balance remaining", "", "", money(model.credit.balance_cents, model.credit.currency)]).commit();
    c.commit();
  }

  await wb.commit();
}

// -------------------------------------------------------------------- pdf --

const PAGE = { margin: 46, width: 595.28, height: 841.89 };   // A4 portrait

function pdfHeading(doc, text, size = 13) {
  // Keep a heading with at least a couple of rows of what it introduces —
  // a section title alone at the foot of a page is the classic generated-PDF
  // tell, and it makes a board pack look automated in the bad sense.
  if (doc.y > PAGE.height - PAGE.margin - 90) doc.addPage();
  doc.moveDown(0.8);
  doc.fillColor("#16302A").fontSize(size).text(text);
  doc.moveDown(0.35);
  const y = doc.y;
  doc.moveTo(PAGE.margin, y).lineTo(PAGE.width - PAGE.margin, y).lineWidth(0.75).strokeColor("#E4DFD1").stroke();
  doc.moveDown(0.55);
}

// A table that measures its columns and paginates, rather than running off the
// page. Values are already strings from the model.
function pdfTable(doc, columns, rows, opts = {}) {
  const usable = PAGE.width - PAGE.margin * 2;
  const totalWeight = columns.reduce((a, c) => a + (c.weight || 1), 0);
  const widths = columns.map((c) => (usable * (c.weight || 1)) / totalWeight);
  const rowHeight = opts.rowHeight || 15;

  function header() {
    const y = doc.y;
    doc.rect(PAGE.margin, y - 2, usable, rowHeight).fill("#16302A");
    let x = PAGE.margin;
    doc.fontSize(8.5).fillColor("#FFFFFF");
    columns.forEach((c, i) => {
      doc.text(c.label, x + 5, y + 2.5, { width: widths[i] - 10, align: c.align || "left", lineBreak: false });
      x += widths[i];
    });
    doc.y = y + rowHeight + 2;
  }

  header();
  doc.fontSize(8.5);

  rows.forEach((row, ri) => {
    // Repeat the header on a new page; a continued table with no header is a
    // grid of unlabelled numbers.
    if (doc.y > PAGE.height - PAGE.margin - rowHeight * 2) {
      doc.addPage();
      header();
      doc.fontSize(8.5);
    }
    const y = doc.y;
    if (ri % 2 === 1) doc.rect(PAGE.margin, y - 2, usable, rowHeight).fill("#F5F2EA");
    let x = PAGE.margin;
    doc.fillColor("#20241F");
    columns.forEach((c, i) => {
      const v = row[i];
      doc.text(v == null || v === "" ? "—" : String(v), x + 5, y + 2.5,
        { width: widths[i] - 10, align: c.align || "left", lineBreak: false, ellipsis: true });
      x += widths[i];
    });
    doc.y = y + rowHeight;
  });
  doc.moveDown(0.5);
}

function toPdf(model, stream) {
  const PDFDocument = require("pdfkit");
  const doc = new PDFDocument({
    size: "A4", margin: PAGE.margin,
    info: {
      Title: `${model.club} — member experience report`,
      Author: "Vero",
      Subject: model.period.label,
      CreationDate: model.generated_at ? new Date(model.generated_at) : new Date(),
    },
  });
  doc.pipe(stream);

  // --- Cover
  doc.fillColor("#16302A").fontSize(26).text(model.club);
  doc.moveDown(0.15);
  doc.fillColor("#5B6259").fontSize(13).text("Member experience report");
  doc.moveDown(0.5);
  doc.fillColor("#20241F").fontSize(11).text(model.period.label);
  if (model.generated_at) {
    doc.fillColor("#5B6259").fontSize(8.5)
      .text("Generated " + new Date(model.generated_at).toLocaleString("en-US", { timeZone: "UTC" }) + " UTC");
  }

  // --- Headline
  pdfHeading(doc, "Headline");
  pdfTable(doc,
    [{ label: "Measure", weight: 2.2 }, { label: "This period", weight: 1.2, align: "right" },
     { label: "Previous", weight: 1.2, align: "right" }, { label: "Change", weight: 1.2, align: "right" }],
    model.headline.map((h) => [
      h.label,
      h.value == null ? "—" : (h.format === "percent" ? h.value + "%" : String(h.value)),
      h.previous == null ? "—" : (h.format === "percent" ? h.previous + "%" : String(h.previous)),
      h.delta ? h.delta.label : "—",
    ]));

  if (model.indices.length) {
    pdfHeading(doc, "Club indices");
    pdfTable(doc,
      [{ label: "Index", weight: 2.6 }, { label: "This period", weight: 1.2, align: "right" },
       { label: "Previous", weight: 1.2, align: "right" }, { label: "Change", weight: 1.2, align: "right" }],
      model.indices.map((i) => [i.label, i.value ?? "—", i.previous ?? "—", i.delta ? i.delta.label : "—"]));
  }

  if (model.outlets.length) {
    pdfHeading(doc, "By outlet");
    pdfTable(doc,
      [{ label: "Outlet", weight: 2.4 }, { label: "Responses", weight: 1, align: "right" },
       { label: "NPS", weight: 0.8, align: "right" }, { label: "CSAT", weight: 0.8, align: "right" },
       { label: "Food", weight: 0.8, align: "right" }, { label: "Service", weight: 0.9, align: "right" }],
      model.outlets.map((o) => [o.outlet, o.responses, o.nps, o.csat, o.food, o.service]));
  }

  if (model.months.length) {
    pdfHeading(doc, "Month on month");
    pdfTable(doc,
      [{ label: "Month", weight: 1.6 }, { label: "Responses", weight: 1, align: "right" },
       { label: "NPS", weight: 1, align: "right" }, { label: "CSAT", weight: 1, align: "right" }],
      model.months.map((m) => [m.month, m.responses, m.nps, m.csat]));
  }

  if (model.servers.length) {
    pdfHeading(doc, "Server performance");
    pdfTable(doc,
      [{ label: "#", weight: 0.4, align: "right" }, { label: "Server", weight: 2.2 },
       { label: "Surveys", weight: 0.9, align: "right" }, { label: "Composite", weight: 1, align: "right" },
       { label: "NPS", weight: 0.8, align: "right" }, { label: "Overall", weight: 0.8, align: "right" },
       { label: "Food", weight: 0.8, align: "right" }, { label: "Service", weight: 0.9, align: "right" }],
      model.servers.map((s) => [s.rank, s.name, s.surveys, s.composite, s.nps, s.overall, s.food, s.service]));
  }

  if (model.alerts.length) {
    pdfHeading(doc, "Case alerts");
    pdfTable(doc,
      [{ label: "Severity", weight: 2 }, { label: "Raised", weight: 1, align: "right" },
       { label: "Resolved", weight: 1, align: "right" }, { label: "Still open", weight: 1, align: "right" }],
      model.alerts.map((a) => [a.label, a.raised, a.resolved, a.open]));
    doc.fontSize(8.5).fillColor("#5B6259")
      .text(`${model.alerts_total} raised in this period · ${model.alerts_open} still open`);
  }

  if (model.credit && model.credit.usage.length) {
    pdfHeading(doc, "SMS credit");
    doc.fontSize(9).fillColor("#20241F").text(
      `${model.credit.messages.toLocaleString()} messages · ` +
      `${money(model.credit.spend_cents, model.credit.currency)} spent · ` +
      `${money(model.credit.balance_cents, model.credit.currency)} remaining`);
    doc.moveDown(0.5);
    pdfTable(doc,
      [{ label: "Date", weight: 1.4 }, { label: "Type", weight: 2.4 },
       { label: "Messages", weight: 1, align: "right" }, { label: "Cost", weight: 1, align: "right" }],
      model.credit.usage.map((u) => [u.date, u.type, u.messages, money(u.cost_cents, model.credit.currency)]));
  }

  if (model.empty_sections.length) {
    doc.moveDown(0.8);
    doc.fontSize(8.5).fillColor("#5B6259")
      .text("Not included: no data for " + model.empty_sections.join(", ") + " in this period.");
  }

  // Page numbers, added after the fact so the total is known. A board pack
  // without them cannot be referred to in a meeting.
  const range = doc.bufferedPageRange ? doc.bufferedPageRange() : null;
  if (range && range.count > 1) {
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.fontSize(8).fillColor("#5B6259").text(
        `${i + 1} of ${range.count}`,
        PAGE.margin, PAGE.height - PAGE.margin + 12,
        { width: PAGE.width - PAGE.margin * 2, align: "center", lineBreak: false });
    }
  }

  doc.end();
  return doc;
}

module.exports = { toExcel, toPdf, money };
