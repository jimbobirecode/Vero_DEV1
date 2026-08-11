// The report renders, with the granular sections in it.
//
// The model has its own tests; this is about the two files a club actually
// receives. A renderer that throws halfway through a stream produces a
// truncated download rather than an error page, so "it opens at all" is worth
// asserting, and so is "the new sections are actually in there" — a section
// that silently renders nothing looks identical to one that has no data.

const { Writable } = require("stream");
const report = require("./report");
const render = require("./report-render");

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "\n      " + detail : ""}`); }
}

function collect() {
  const chunks = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  stream.done = new Promise((res) => stream.on("finish", () => res(Buffer.concat(chunks))));
  return stream;
}

// A period with something in every section.
const response = (nps, date, extra = {}) => ({
  template_id: "t1", submitted_at: `${date}T12:00:00Z`,
  q1_nps: nps, q2_overall_stars: 4, q3_food_stars: 4, q4_service_stars: 3,
  q5_comment: nps <= 6 ? "Slow service." : null,
  answers: { q1: nps, q2: 4, q3: 4, q4: 3, q6: nps <= 6 ? 1 : 4 },
  visits: { visit_date: date, visitor_type: "member", outlets: { name: "Grill" } },
  ...extra,
});

const model = report.build({
  clubName: "Aronimink Golf Club",
  from: "2026-08-01T00:00:00Z", to: "2026-08-14T00:00:00Z",
  generatedAt: "2026-08-14T09:00:00Z",
  granularity: "week",
  scores: { overall: { nps: 40, csat: 4.2, CHI: 78, SSI: 71, OHI: 66 }, response_count: 6,
            by_outlet: [{ outlet: "Grill", response_count: 6, nps: 40, csat: 4.2, food: 4, service: 3 }],
            by_month: [{ month: "2026-08", response_count: 6, nps: 40, csat: 4.2 }] },
  previousScores: { overall: { nps: 30, csat: 4.0 }, response_count: 5 },
  surveys: { sent: 12, responded: 6 },
  responses: [
    response(10, "2026-08-03"), response(9, "2026-08-04"),
    response(6, "2026-08-05", { visits: { visit_date: "2026-08-05", visitor_type: "commercial", outlets: { name: "Poolside" }, visit_time: "19:30:00" } }),
    response(8, "2026-08-10"), response(10, "2026-08-11"),
    response(3, "2026-08-12", { visits: { visit_date: "2026-08-12", visitor_type: "golf", outlets: { name: "Grill" }, visit_time: "12:15:00" } }),
  ],
  templates: [{
    template_id: "t1", name: "Food & Beverage", survey_type: "food_bev",
    questions: [
      { key: "q1", title: "How likely are you to recommend us?", type: "nps", index: "CHI" },
      { key: "q2", title: "Overall experience", type: "stars", index: "SSI" },
      { key: "q6", title: "Was the music too loud?", type: "stars", index: null },
    ],
  }],
  events: {
    nps: 50, csat: 4.4, responses: 12,
    events: [{ name: "Member-Guest", event_date: "2026-08-08", category: "golf", responses: 12, nps: 50, csat: 4.4 }],
  },
  leaderboard: [{ server_name: "Alex", survey_count: 6, avg_nps: 8, avg_overall: 4, avg_food: 4, avg_service: 3.5, composite_score: 3.9 }],
  alerts: { by_severity: [{ severity: "high", count: 2 }], open_by_severity: [{ severity: "high", count: 1 }], total: 2, open: 1 },
});

(async () => {
  console.log("--- the model carries the granular sections ---");
  check("NPS is broken into its parts", model.nps_breakdown.responses === 6,
    JSON.stringify(model.nps_breakdown));
  check("promoters and detractors are counted separately",
    model.nps_breakdown.promoters === 3 && model.nps_breakdown.detractors === 2,
    JSON.stringify(model.nps_breakdown));
  check("the trend is weekly, not just monthly", model.periods.length === 2,
    JSON.stringify(model.periods.map((p) => p.label)));
  check("each outlet has its own trend", model.outlet_periods.length === 2,
    JSON.stringify(model.outlet_periods.map((o) => o.outlet)));
  check("segments split by visitor type", model.segments.visitor_type.length === 3,
    JSON.stringify(model.segments.visitor_type.map((v) => v.label)));
  check("and by day of week", model.segments.weekday.length > 0);
  check("lunch and dinner are split where a time exists", model.segments.daypart_available === true,
    JSON.stringify(model.segments.daypart));
  check("every question is reported, including the untagged one",
    model.questions[0].questions.length === 3 &&
    model.questions[0].questions.some((q) => q.key === "q6" && q.index === null),
    JSON.stringify(model.questions[0]?.questions.map((q) => q.key)));
  check("events appear, which they never did before", model.events.list.length === 1);

  console.log("\n--- the sections list names them ---");
  const keys = report.sections(model).map((s) => s.key);
  for (const k of ["nps_breakdown", "periods", "outlet_periods", "segments", "questions", "events"]) {
    check(`"${k}" is offered as a section`, keys.includes(k), keys.join(", "));
  }

  console.log("\n--- the spreadsheet ---");
  const xs = collect();
  await render.toExcel(model, xs);
  const xlsx = await xs.done;
  check("a workbook is produced", xlsx.length > 5000, `${xlsx.length} bytes`);
  check("and it is a zip, as xlsx is", xlsx.slice(0, 2).toString() === "PK");
  {
    // Read the workbook back rather than trusting that addWorksheet was
    // reached — a sheet that throws while writing still leaves a valid zip.
    const ExcelJS = require("exceljs");
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(xlsx);
    const names = back.worksheets.map((w) => w.name);
    for (const sheet of ["NPS composition", "Week by week", "Outlet trends", "Segments", "Question detail", "Events"]) {
      check(`the "${sheet}" sheet exists`, names.includes(sheet), names.join(", "));
    }

    const q = back.getWorksheet("Question detail");
    const text = q.getSheetValues().flat().filter((v) => typeof v === "string").join(" | ");
    check("the untagged question is in the spreadsheet",
      text.includes("Was the music too loud?"), text.slice(0, 300));
    check("and is labelled as not benchmarked rather than left blank",
      text.includes("Not benchmarked"), text.slice(0, 300));

    const seg = back.getWorksheet("Segments");
    const segText = seg.getSheetValues().flat().filter((v) => typeof v === "string").join(" | ");
    check("segments name the visitor types in plain words",
      segText.includes("Members") && segText.includes("Corporate") && segText.includes("Golf"),
      segText.slice(0, 300));
    check("and the days of the week", segText.includes("Monday"), segText.slice(0, 300));
  }

  console.log("\n--- the PDF ---");
  const ps = collect();
  render.toPdf(model, ps);
  const pdf = await ps.done;
  check("a PDF is produced", pdf.length > 5000, `${pdf.length} bytes`);
  check("and it starts with the PDF marker", pdf.slice(0, 5).toString() === "%PDF-");
  check("and ends properly, rather than truncating mid-stream",
    pdf.slice(-1024).toString("latin1").includes("%%EOF"));

  console.log("\n--- the figures /api/scores does not carry ---");
  {
    // /api/scores answers "what are CHI, SSI and OHI" and returns only those —
    // no nps, no csat, nothing per outlet beyond a count. A report that read
    // them from there printed a dash in every one of those columns.
    const { aggregate } = require("./scoring");
    check("the scores payload really has no NPS or CSAT",
      !("nps" in aggregate([])) && !("csat" in aggregate([])),
      Object.keys(aggregate([])).join(", "));

    const realistic = report.build({
      clubName: "Club", from: "2026-08-01T00:00:00Z", to: "2026-08-14T00:00:00Z",
      granularity: "week",
      // Exactly what the route gets back: indices only.
      scores: {
        overall: { CHI: 78, SSI: 71, OHI: 66 },
        response_count: 3,
        by_outlet: [{ outlet: "Grill", response_count: 3 }],
        by_month: [{ month: "2026-08", response_count: 3 }],
      },
      previousScores: { overall: { CHI: 70 }, response_count: 2 },
      responses: [response(10, "2026-08-03"), response(9, "2026-08-04"), response(3, "2026-08-05")],
      previousResponses: [response(6, "2026-07-28"), response(7, "2026-07-29")],
      templates: [],
    });

    const nps = realistic.headline.find((h) => h.key === "nps");
    const csat = realistic.headline.find((h) => h.key === "csat");
    check("the headline NPS is a number, not a dash", nps.value != null, JSON.stringify(nps));
    check("and it matches the composition below it", nps.value === realistic.nps_breakdown.nps,
      `${nps.value} vs ${realistic.nps_breakdown.nps}`);
    check("the headline CSAT is a number too", csat.value != null, JSON.stringify(csat));
    check("and it compares against the preceding period", nps.previous != null, JSON.stringify(nps));
    check("the outlet row carries scores, not just a count",
      realistic.outlets[0].nps != null && realistic.outlets[0].csat != null,
      JSON.stringify(realistic.outlets[0]));
    check("and so does the month row", realistic.months[0].nps != null,
      JSON.stringify(realistic.months[0]));
    check("the indices still come from the scores payload", realistic.indices[0].value === 78,
      JSON.stringify(realistic.indices[0]));
  }

  console.log("\n--- a club with no time recorded says so rather than inventing a split ---");
  const noTime = report.build({
    clubName: "Club", from: "2026-08-01T00:00:00Z", to: "2026-08-14T00:00:00Z",
    responses: [response(9, "2026-08-03")],
    templates: [], granularity: "week",
  });
  check("daypart is empty", noTime.segments.daypart.length === 0);
  check("and listed as unavailable", noTime.empty_sections.includes("daypart"));
  const ps2 = collect();
  render.toPdf(noTime, ps2);
  check("the PDF still renders", (await ps2.done).slice(0, 5).toString() === "%PDF-");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
