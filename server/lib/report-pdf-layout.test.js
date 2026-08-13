// The PDF's layout, checked by reading the finished file back.
//
// Everything else about the report is arithmetic and can be asserted on the
// model. Layout cannot: the model was right the whole time a club was being
// sent a board pack with two lines of text in a one-line row and every section
// heading printed hard against the right margin. Both of those are visible in
// the placed text, so this opens the PDF and looks at where things landed.
//
// Three faults it would have caught:
//
//   - Rows drawn at a fixed height while pdfkit wrapped the text inside them,
//     so a long question title ran into the row beneath it.
//   - doc.x left at the last column after a table, so the next heading started
//     from the right-hand edge and wrapped there.
//   - A table beginning at the foot of a page with one row under its header
//     and the rest overleaf, reading as two unrelated tables.
//
// Skipped, loudly, where pdfjs is not installed — it arrives with pdf-parse
// rather than in its own right, and a layout guard is not worth failing a
// suite over a transitive dependency.

const { Writable } = require("stream");
const path = require("path");
const report = require("./report");
const render = require("./report-render");

const MARGIN = 46;
const PAGE_WIDTH = 595.28;

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "\n      " + detail : ""}`); }
}

// Names as long as the ones clubs actually use. The bug only appears when a
// cell is too long for its column, so a fixture of short strings tests nothing.
const OUTLETS = ["Belmont Dining Room", "Clubhouse Grill & Terrace", "Halfway House at the Turn"];
const LONG_QUESTION = "Was the background music at a comfortable level throughout your meal?";

const response = (nps, date, outlet) => ({
  template_id: "t1", submitted_at: `${date}T12:00:00Z`,
  q1_nps: nps, q2_overall_stars: 4, q3_food_stars: 4, q4_service_stars: 3,
  q5_comment: nps <= 6 ? "Waited a long time between courses." : null,
  answers: { q1: nps, q2: 4, q6: 2 },
  visits: { visit_date: date, visitor_type: "member", outlets: { name: outlet }, visit_time: "19:30:00" },
});

const responses = [];
for (let d = 1; d <= 21; d++) {
  const date = `2026-08-${String(d).padStart(2, "0")}`;
  OUTLETS.forEach((o, i) => responses.push(response((d + i) % 11, date, o)));
}

const model = report.build({
  clubName: "Aronimink Golf Club",
  from: "2026-08-01T00:00:00Z", to: "2026-08-31T00:00:00Z",
  generatedAt: "2026-09-01T09:00:00Z", granularity: "week",
  scores: {
    overall: { nps: 41, csat: 4.2, CHI: 78.4, SSI: 71.2, OHI: 66.9 },
    response_count: responses.length,
    by_outlet: OUTLETS.map((o) => ({ outlet: o, response_count: 21, nps: 41, csat: 4.2, food: 4.1, service: 3.9 })),
    by_month: [{ month: "2026-08", response_count: responses.length, nps: 41, csat: 4.2 }],
  },
  previousScores: { overall: { nps: 33, csat: 4.05 }, response_count: 60 },
  responses,
  sentSurveys: responses.map((r, i) => ({
    response_id: String(i), template_id: "t1", created_at: r.submitted_at,
    submitted_at: i % 3 ? r.submitted_at : null, visits: r.visits,
  })),
  templates: [{
    template_id: "t1", name: "Food & Beverage", survey_type: "food_bev",
    questions: [
      { key: "q1", title: "How likely are you to recommend the club to a friend or colleague?", type: "nps", index: "CHI" },
      { key: "q2", title: "Overall experience this visit", type: "stars", index: "SSI" },
      { key: "q6", title: LONG_QUESTION, type: "stars", index: null },
    ],
  }],
  leaderboard: [{ server_name: "Jessica McGarrey-Fitzwilliam", survey_count: 41, avg_nps: 8.8,
                  avg_overall: 4.6, avg_food: 4.4, avg_service: 4.7, composite_score: 4.51 }],
  alerts: { by_severity: [{ severity: "high", count: 4 }], open_by_severity: [{ severity: "high", count: 1 }], total: 4, open: 1 },
  events: { nps: 50, csat: 4.4, responses: 12,
            events: [{ name: "Member-Guest Invitational Weekend", event_date: "2026-08-08", category: "golf", responses: 12, nps: 50, csat: 4.4 }] },
});

function renderPdf() {
  const chunks = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  const done = new Promise((res) => stream.on("finish", () => res(Buffer.concat(chunks))));
  render.toPdf(model, stream);
  return done;
}

(async () => {
  let pdfjs;
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (_) {
    console.log("SKIP  pdfjs is not installed — layout not checked");
    console.log("\n0 passed, 0 failed");
    process.exit(0);
  }

  const bytes = await renderPdf();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  check("the report renders", doc.numPages > 0, `${doc.numPages} pages`);

  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    pages.push(content.items
      .filter((i) => i.str && i.str.trim())
      .map((i) => ({ text: i.str, x: i.transform[4], y: Math.round(i.transform[5] * 10) / 10,
                     w: i.width, h: i.height || 8 })));
  }
  const every = pages.flat();
  check("and has text on it", every.length > 100, `${every.length} runs`);

  // --- nothing sits on top of anything else -------------------------------
  const sideBySide = [], tooClose = [];
  pages.forEach((items, p) => {
    const lines = new Map();
    for (const it of items) {
      const key = Math.round(it.y);
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push(it);
    }
    for (const row of lines.values()) {
      row.sort((a, b) => a.x - b.x);
      for (let i = 1; i < row.length; i++) {
        const gap = row[i].x - (row[i - 1].x + row[i - 1].w);
        if (gap < -0.5) sideBySide.push(`p${p + 1} "${row[i - 1].text.slice(0, 24)}" / "${row[i].text.slice(0, 24)}"`);
      }
    }
    const ys = [...lines.keys()].sort((a, b) => b - a);
    for (let i = 1; i < ys.length; i++) {
      const gap = ys[i - 1] - ys[i];
      const h = Math.max(...lines.get(ys[i - 1]).map((t) => t.h));
      // Below about three-quarters of the type size, ascenders and descenders
      // touch and it reads as one smeared block.
      if (gap < h * 0.72) tooClose.push(`p${p + 1} ${gap.toFixed(1)}pt for ${h.toFixed(1)}pt text: `
        + `"${lines.get(ys[i - 1]).map((t) => t.text).join(" ").slice(0, 34)}"`);
    }
  });
  check("no two runs overlap on the same line", sideBySide.length === 0, sideBySide.slice(0, 4).join("\n      "));
  check("and no line sits on the one below it", tooClose.length === 0, tooClose.slice(0, 4).join("\n      "));

  // --- headings start where headings start --------------------------------
  //
  // The section titles are known strings, so where they landed is checkable.
  // Left at the margin, and not wrapped: "Month on month" broke over two lines
  // when it was being drawn into whatever width was left beside the cursor.
  const HEADINGS = ["Headline", "Club indices", "By outlet", "Month on month", "Question detail", "Response rate"];
  const misplaced = [];
  for (const h of HEADINGS) {
    // By height, not by first match: "Response rate" is also a row label in the
    // headline table, and the 8.5pt cell version is indented inside its column
    // exactly as it should be.
    const found = every.find((i) => i.text.trim() === h && i.h > 10);
    if (!found) continue;                       // section legitimately absent
    if (Math.abs(found.x - MARGIN) > 1) misplaced.push(`${h} at x=${found.x.toFixed(1)}`);
  }
  check("every section heading starts at the left margin", misplaced.length === 0, misplaced.join(", "));
  check("and 'Month on month' is one run, not broken across lines",
    every.some((i) => i.text.trim() === "Month on month"),
    every.filter((i) => /^Month|month$/.test(i.text.trim())).map((i) => i.text).join(" | "));

  // --- nothing runs off the page ------------------------------------------
  const overflow = every.filter((i) => i.x + i.w > PAGE_WIDTH - MARGIN + 1);
  check("nothing spills past the right margin", overflow.length === 0,
    overflow.slice(0, 3).map((i) => `"${i.text.slice(0, 30)}" ends at ${(i.x + i.w).toFixed(1)}`).join("; "));
  check("and nothing starts left of it", every.every((i) => i.x >= MARGIN - 1),
    every.filter((i) => i.x < MARGIN - 1).slice(0, 3).map((i) => i.text).join("; "));

  // --- long text is wrapped, not cut --------------------------------------
  //
  // A truncated question is worse than a tall row: "Was the background music
  // at a comfortabl…" tells the reader nothing about what was asked.
  const joined = every.map((i) => i.text).join(" ").replace(/\s+/g, " ");
  check("a long question title survives in full", joined.includes(LONG_QUESTION),
    joined.slice(joined.indexOf("Was the background"), joined.indexOf("Was the background") + 90));
  check("nothing was ellipsised away", !joined.includes("…"),
    joined.split(" ").filter((w) => w.includes("…")).slice(0, 3).join(" "));

  // --- a table that starts on a page shows more than one row of itself ----
  const qDetail = every.find((i) => i.text.trim() === "Question detail");
  if (qDetail) {
    const pageOf = pages.findIndex((items) => items.includes(qDetail));
    const after = pages[pageOf].filter((i) => i.y < qDetail.y);
    check("a section heading is never left alone at the foot of a page",
      after.length >= 6, `${after.length} runs under "Question detail" on page ${pageOf + 1}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
