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

// The one caveat both renderings carry. Said the same way in each, because a
// spreadsheet and a PDF hedging differently about the same number is how a
// reader decides neither can be trusted.
function rrSettlingNote(rr) {
  const answered = rr.settling.responded;
  return `${rr.settling.sent} of these were sent in the last ${rr.settling.hours} hours and have had `
    + `little time to be answered${answered ? ` (${answered} already have)` : ""}. `
    + `Excluding them, the rate is ${rr.settling.settled_rate == null ? "—" : rr.settling.settled_rate + "%"}.`;
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

  // --- NPS composition
  //
  // The net score alone cannot tell a club with few detractors from one with
  // many of both, and those need different work.
  if (model.nps_breakdown && model.nps_breakdown.responses) {
    const n = wb.addWorksheet("NPS composition");
    headerRow(n, ["Group", "Responses", "Share"], [18, 12, 10]);
    const b = model.nps_breakdown;
    n.addRow(["Promoters (9-10)", b.promoters, b.promoter_pct == null ? "—" : b.promoter_pct + "%"]).commit();
    n.addRow(["Passives (7-8)", b.passives, b.passive_pct == null ? "—" : b.passive_pct + "%"]).commit();
    n.addRow(["Detractors (0-6)", b.detractors, b.detractor_pct == null ? "—" : b.detractor_pct + "%"]).commit();
    n.addRow([]).commit();
    n.addRow(["Net Promoter Score", b.nps ?? "—", ""]).commit();
    n.commit();
  }

  // --- The finer trend
  if (model.periods && model.periods.length) {
    const title = model.granularity === "day" ? "Day by day"
      : model.granularity === "month" ? "Month by month" : "Week by week";
    const t = wb.addWorksheet(title);
    headerRow(t, [title.split(" ")[0], "Responses", "NPS", "Promoters", "Detractors", "CSAT", "Food", "Service", "Comments"],
      [18, 12, 9, 11, 11, 9, 9, 9, 11]);
    model.periods.forEach((r) => t.addRow([
      r.label, r.responses, r.nps ?? "—", r.promoters, r.detractors,
      r.csat ?? "—", r.food ?? "—", r.service ?? "—", r.comments,
    ]).commit());
    t.commit();
  }

  // --- Each outlet's own trend, one long table rather than a sheet per outlet
  if (model.outlet_periods && model.outlet_periods.length) {
    const op = wb.addWorksheet("Outlet trends");
    headerRow(op, ["Outlet", "Period", "Responses", "NPS", "CSAT", "Food", "Service"], [24, 18, 12, 9, 9, 9, 9]);
    model.outlet_periods.forEach((o) => {
      o.periods.forEach((r) => op.addRow([
        o.outlet, r.label, r.responses, r.nps ?? "—", r.csat ?? "—", r.food ?? "—", r.service ?? "—",
      ]).commit());
    });
    op.commit();
  }

  // --- Response rate
  //
  // The one section built from the surveys that were SENT rather than from the
  // ones that came back — see lib/response-rate.js for why the two sets are
  // not interchangeable.
  if (model.response_rate && model.response_rate.sent) {
    const rr = model.response_rate;
    const w = wb.addWorksheet("Response rate");
    w.columns = [{ width: 26 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 10 }];

    const rrBlock = (heading, list) => {
      if (!list || !list.length) return;
      w.addRow([heading]).font = { bold: true, size: 11, color: { argb: FOREST } };
      const h = w.addRow(["", "Sent", "Answered", "No answer", "Rate"]);
      h.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
      h.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FOREST } };
      list.forEach((r) => w.addRow([
        r.label, r.sent, r.responded, r.sent - r.responded, r.rate == null ? "—" : r.rate + "%",
      ]));
      w.addRow([]);
    };

    rrBlock("The club", [{ label: "All surveys", sent: rr.sent, responded: rr.responded, rate: rr.rate }]);
    rrBlock("By outlet", rr.by_outlet);
    rrBlock("By period", rr.by_period);
    rrBlock("By survey", rr.by_template);
    rrBlock("By type of member", rr.by_visitor_type);

    if (rr.speed && rr.speed.answers) {
      w.addRow(["How quickly they answer"]).font = { bold: true, size: 11, color: { argb: FOREST } };
      w.addRow(["Typical time to answer", `${rr.speed.median_hours} hours`]);
      w.addRow(["Answered the same day", `${rr.speed.same_day_pct}%`]);
      w.addRow(["Answered within two days", `${rr.speed.within_48h_pct}%`]);
      w.addRow([]);
    }
    if (rr.settling && rr.settling.sent) {
      w.addRow([rrSettlingNote(rr)]).font = { italic: true, size: 9, color: { argb: SOFT } };
    }
    w.commit();
  }

  // --- Segments
  if (model.segments && model.segments.visitor_type.length) {
    const sg = wb.addWorksheet("Segments");
    const block = (heading, rows) => {
      if (!rows.length) return;
      sg.addRow([heading]).font = { bold: true, size: 11, color: { argb: FOREST } };
      const h = sg.addRow(["Segment", "Responses", "NPS", "Promoters", "Detractors", "CSAT", "Food", "Service"]);
      h.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
      h.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FOREST } };
      rows.forEach((r) => sg.addRow([
        r.label, r.responses, r.nps ?? "—", r.promoters, r.detractors,
        r.csat ?? "—", r.food ?? "—", r.service ?? "—",
      ]));
      sg.addRow([]);
    };
    sg.columns = [{ width: 22 }, { width: 12 }, { width: 9 }, { width: 11 }, { width: 11 }, { width: 9 }, { width: 9 }, { width: 9 }];
    block("By visitor type", model.segments.visitor_type);
    block("By day of week", model.segments.weekday);
    if (model.segments.daypart_available) {
      block("By service", model.segments.daypart);
    } else {
      sg.addRow(["Lunch and dinner cannot be split: visits are recorded with a date but no time."])
        .font = { italic: true, size: 9, color: { argb: SOFT } };
    }
    sg.commit();
  }

  // --- Question by question
  //
  // The sheet that did not exist before: a club could add a question in the
  // Builder and never see it in a report.
  if (model.questions && model.questions.length) {
    const q = wb.addWorksheet("Question detail");
    q.columns = [{ width: 44 }, { width: 12 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 30 }];
    model.questions.forEach((tpl) => {
      q.addRow([`${tpl.template} — ${tpl.responses} response${tpl.responses === 1 ? "" : "s"}`])
        .font = { bold: true, size: 12, color: { argb: FOREST } };
      const h = q.addRow(["Question", "Answered", "Average", "Out of 100", "Index", "Spread"]);
      h.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
      h.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FOREST } };
      tpl.questions.forEach((qq) => {
        const spread = qq.type === "text"
          ? (qq.average_length == null ? "—" : `avg ${qq.average_length} characters`)
          : (qq.distribution || []).filter((d) => d.count).map((d) => `${d.value}×${d.count}`).join("  ");
        q.addRow([
          qq.title,
          qq.answered,
          qq.type === "text" ? "—" : (qq.average ?? "—"),
          qq.type === "text" ? "—" : (qq.normalised ?? "—"),
          qq.index_label || "Not benchmarked",
          spread || "—",
        ]);
      });
      q.addRow([]);
    });
    q.commit();
  }

  // --- Events
  if (model.events && model.events.list.length) {
    const e = wb.addWorksheet("Events");
    headerRow(e, ["Event", "Date", "Type", "Responses", "NPS", "CSAT"], [30, 14, 12, 12, 9, 9]);
    model.events.list.forEach((r) => e.addRow([
      r.name, r.date, r.category === "golf" ? "Golf" : "General", r.responses, r.nps ?? "—", r.csat ?? "—",
    ]).commit());
    e.addRow([]).commit();
    e.addRow(["All events", "", "", model.events.responses, model.events.nps ?? "—", model.events.csat ?? "—"]).commit();
    e.addRow([]).commit();
    e.addRow(["Events are scored separately and do not feed the club indices."])
      .font = { italic: true, size: 9, color: { argb: SOFT } };
    e.commit();
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
  // 140pt is a heading, a table header and two or three rows. At the old 90pt
  // a section could start at the foot of a page with a single row under it and
  // continue overleaf under a repeated column header, which reads as two
  // unrelated tables.
  if (doc.y > PAGE.height - PAGE.margin - 140) doc.addPage();
  doc.moveDown(0.8);
  doc.fillColor("#16302A").fontSize(size).text(text);
  doc.moveDown(0.35);
  const y = doc.y;
  doc.moveTo(PAGE.margin, y).lineTo(PAGE.width - PAGE.margin, y).lineWidth(0.75).strokeColor("#E4DFD1").stroke();
  doc.moveDown(0.55);
}

// A table that measures its columns and paginates, rather than running off the
// page. Values are already strings from the model.
// A table whose rows are as tall as their contents.
//
// This used to draw every row at a fixed 15pt and ask pdfkit not to wrap. It
// wraps anyway — heightOfString reports two lines for a long question title
// whether lineBreak is set or not — so a wrapped cell ran straight through the
// row beneath it, and the question titles are exactly the cells long enough to
// do it. Two lines of text in a one-line row is the "text running into each
// other" a reader sees.
//
// So each row is measured before it is drawn: the tallest cell decides the
// height, the zebra stripe is drawn to that height, and the page break uses it
// too. Wrapping rather than truncating is deliberate — "Was the background
// music at a comfortabl…" tells a reader nothing, and a board pack is read for
// the words as much as the numbers.
// The small label above a table — "By outlet", "By day of week", the template
// name in Question detail. Its own function so the gap under it is the same
// everywhere, and so it cannot be left stranded at the foot of a page above a
// table that has moved on without it.
function pdfSubLabel(doc, text) {
  if (doc.y > PAGE.height - PAGE.margin - 90) doc.addPage();
  doc.x = PAGE.margin;
  doc.fillColor("#5B6259").fontSize(9).text(text);
  doc.moveDown(0.25);
}

function pdfTable(doc, columns, rows, opts = {}) {
  const usable = PAGE.width - PAGE.margin * 2;
  const totalWeight = columns.reduce((a, c) => a + (c.weight || 1), 0);
  const widths = columns.map((c) => (usable * (c.weight || 1)) / totalWeight);
  const PAD_X = 5;          // left and right inside a cell
  const PAD_Y = 2.5;        // above the first line
  const MIN_ROW = opts.rowHeight || 15;
  const FONT = 8.5;

  // A blank body cell reads as "no value here", which is what the em dash is
  // for. A blank *header* is a column with no name — several tables have one —
  // and printing "—" there invents a column called em dash.
  const cellText = (v, head = false) => (v == null || v === "" ? (head ? "" : "—") : String(v));

  // How tall a row has to be to hold its tallest cell. Measured at the same
  // font size and width the cell is drawn at, or the measurement is fiction.
  function heightOf(cells) {
    doc.fontSize(FONT);
    const tallest = cells.reduce((h, v, i) => Math.max(
      h, doc.heightOfString(cellText(v), { width: widths[i] - PAD_X * 2 })
    ), 0);
    return Math.max(MIN_ROW, Math.ceil(tallest + PAD_Y * 2));
  }

  function drawRow(cells, y, height, { head = false } = {}) {
    let x = PAGE.margin;
    doc.fontSize(FONT).fillColor(head ? "#FFFFFF" : "#20241F");
    columns.forEach((c, i) => {
      doc.text(cellText(cells[i], head), x + PAD_X, y + PAD_Y, {
        width: widths[i] - PAD_X * 2,
        align: c.align || "left",
        // Headers stay on one line: a wrapped header makes the band ragged and
        // they are short enough to fit by design.
        lineBreak: !head,
        ellipsis: head,
      });
      x += widths[i];
    });
    // Put the cursor back at the left margin.
    //
    // Every cell is drawn at an explicit x, and pdfkit leaves doc.x wherever
    // the last one was — which is the right-hand column. The next plain
    // doc.text() then starts from there with only the remaining width to wrap
    // into, so every section heading after the first table printed hard against
    // the right edge, and "Month on month" broke over two lines doing it. It
    // looked like an alignment choice; it was a cursor nobody put back.
    doc.x = PAGE.margin;
  }

  const headCells = columns.map((c) => c.label);
  const headHeight = Math.max(MIN_ROW, heightOf(headCells));

  function header() {
    const y = doc.y;
    doc.rect(PAGE.margin, y - 2, usable, headHeight).fill("#16302A");
    drawRow(headCells, y, headHeight, { head: true });
    doc.y = y + headHeight + 2;
  }

  // Start on a new page rather than showing a column header with one row under
  // it and the rest overleaf. Two rows is the minimum that reads as a table.
  const opening = headHeight + rows.slice(0, 2).reduce((h, r) => h + heightOf(r), 0);
  if (rows.length && doc.y + opening > PAGE.height - PAGE.margin) doc.addPage();

  header();

  rows.forEach((row, ri) => {
    const height = heightOf(row);

    // Repeat the header on a new page; a continued table with no header is a
    // grid of unlabelled numbers. Measured against this row's own height, so a
    // three-line row does not start 12pt from the bottom of the page.
    if (doc.y + height > PAGE.height - PAGE.margin) {
      doc.addPage();
      header();
    }

    const y = doc.y;
    if (ri % 2 === 1) doc.rect(PAGE.margin, y - 2, usable, height).fill("#F5F2EA");
    drawRow(row, y, height);
    doc.y = y + height;
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

  if (model.nps_breakdown && model.nps_breakdown.responses) {
    pdfHeading(doc, "NPS composition");
    const b = model.nps_breakdown;
    pdfTable(doc,
      [{ label: "Group", weight: 2.2 }, { label: "Responses", weight: 1, align: "right" },
       { label: "Share", weight: 1, align: "right" }],
      [["Promoters (9-10)", b.promoters, b.promoter_pct == null ? "—" : b.promoter_pct + "%"],
       ["Passives (7-8)", b.passives, b.passive_pct == null ? "—" : b.passive_pct + "%"],
       ["Detractors (0-6)", b.detractors, b.detractor_pct == null ? "—" : b.detractor_pct + "%"]]);
  }

  if (model.periods && model.periods.length) {
    const title = model.granularity === "day" ? "Day by day"
      : model.granularity === "month" ? "Month by month" : "Week by week";
    pdfHeading(doc, title);
    pdfTable(doc,
      [{ label: "Period", weight: 1.8 }, { label: "Responses", weight: 1, align: "right" },
       { label: "NPS", weight: 0.8, align: "right" }, { label: "Promoters", weight: 1, align: "right" },
       { label: "Detractors", weight: 1, align: "right" }, { label: "CSAT", weight: 0.9, align: "right" }],
      model.periods.map((r) => [r.label, r.responses, r.nps ?? "—", r.promoters, r.detractors, r.csat ?? "—"]));
  }

  if (model.response_rate && model.response_rate.sent) {
    const rr = model.response_rate;
    pdfHeading(doc, "Response rate");
    const rrCols = [{ label: "", weight: 2 }, { label: "Sent", weight: 1, align: "right" },
      { label: "Answered", weight: 1, align: "right" }, { label: "No answer", weight: 1, align: "right" },
      { label: "Rate", weight: 1, align: "right" }];
    const rrRows = (list) => list.map((r) => [r.label, r.sent, r.responded, r.sent - r.responded,
      r.rate == null ? "—" : r.rate + "%"]);
    const rrSub = (t) => pdfSubLabel(doc, t);

    pdfTable(doc, rrCols, rrRows([{ label: "All surveys", sent: rr.sent, responded: rr.responded, rate: rr.rate }]));
    if (rr.by_outlet.length) { rrSub("By outlet"); pdfTable(doc, rrCols, rrRows(rr.by_outlet)); }
    if (rr.by_period.length) { rrSub("By period"); pdfTable(doc, rrCols, rrRows(rr.by_period)); }
    if (rr.by_template.length) { rrSub("By survey"); pdfTable(doc, rrCols, rrRows(rr.by_template)); }
    if (rr.by_visitor_type.length) { rrSub("By type of member"); pdfTable(doc, rrCols, rrRows(rr.by_visitor_type)); }

    if (rr.speed && rr.speed.answers) {
      doc.fillColor("#5B6259").fontSize(8.5).text(
        `Typically answered within ${rr.speed.median_hours} hours — ${rr.speed.same_day_pct}% the same day, `
        + `${rr.speed.within_48h_pct}% within two days.`);
      doc.moveDown(0.3);
    }
    if (rr.settling && rr.settling.sent) {
      doc.fillColor("#5B6259").fontSize(8.5).text(rrSettlingNote(rr));
      doc.moveDown(0.4);
    }
  }

  if (model.segments && model.segments.visitor_type.length) {
    pdfHeading(doc, "Segments");
    const cols = [{ label: "Segment", weight: 2 }, { label: "Responses", weight: 1, align: "right" },
      { label: "NPS", weight: 0.8, align: "right" }, { label: "CSAT", weight: 0.9, align: "right" },
      { label: "Food", weight: 0.9, align: "right" }, { label: "Service", weight: 1, align: "right" }];
    const rows = (list) => list.map((r) => [r.label, r.responses, r.nps ?? "—", r.csat ?? "—", r.food ?? "—", r.service ?? "—"]);

    pdfSubLabel(doc, "By visitor type");
    pdfTable(doc, cols, rows(model.segments.visitor_type));
    pdfSubLabel(doc, "By day of week");
    pdfTable(doc, cols, rows(model.segments.weekday));
    if (model.segments.daypart_available) {
      pdfSubLabel(doc, "By service");
      pdfTable(doc, cols, rows(model.segments.daypart));
    } else {
      doc.fillColor("#5B6259").fontSize(8.5)
        .text("Lunch and dinner cannot be separated: a visit is recorded with a date but no time.");
      doc.moveDown(0.4);
    }
  }

  // Question detail, one table per template. The full answer spread lives in
  // the spreadsheet — a board pack wants the averages, not every histogram.
  if (model.questions && model.questions.length) {
    pdfHeading(doc, "Question detail");
    model.questions.forEach((tpl) => {
      pdfSubLabel(doc, `${tpl.template} — ${tpl.responses} response${tpl.responses === 1 ? "" : "s"}`);
      pdfTable(doc,
        [{ label: "Question", weight: 3.4 }, { label: "Answered", weight: 1, align: "right" },
         { label: "Average", weight: 1, align: "right" }, { label: "Out of 100", weight: 1.1, align: "right" },
         { label: "Index", weight: 1.4 }],
        tpl.questions.map((q) => [
          q.title, q.answered,
          q.type === "text" ? "—" : (q.average ?? "—"),
          q.type === "text" ? "—" : (q.normalised ?? "—"),
          q.index_label || "Not benchmarked",
        ]));
    });
  }

  if (model.events && model.events.list.length) {
    pdfHeading(doc, "Events");
    pdfTable(doc,
      [{ label: "Event", weight: 2.6 }, { label: "Date", weight: 1.2 },
       { label: "Type", weight: 0.9 }, { label: "Responses", weight: 1, align: "right" },
       { label: "NPS", weight: 0.8, align: "right" }, { label: "CSAT", weight: 0.9, align: "right" }],
      model.events.list.map((e) => [e.name, e.date, e.category === "golf" ? "Golf" : "General", e.responses, e.nps ?? "—", e.csat ?? "—"]));
    doc.fillColor("#5B6259").fontSize(8.5)
      .text("Events are scored separately and do not feed the club indices.");
    doc.moveDown(0.4);
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
