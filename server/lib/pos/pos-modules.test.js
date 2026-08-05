// Tests for the POS module registry and the Jonas, Lightspeed and Club V1
// uploaders.
//
// The fixtures are built from the export layouts each vendor documents, with
// the awkward shapes deliberately included: a title block above the header,
// member names carrying commas, subtotal rows, a voided check, a spouse
// suffix, VAT and pound signs, and a day-first date column.

const { parseUpload, detectModule, readDocument, listModules } = require("./index");
const shared = require("./shared");
const { extractRows } = require("./table");
const jonas = require("./jonas");
const lightspeed = require("./lightspeed");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const file = (name, text) => ({ originalname: name, buffer: Buffer.from(text, "utf-8") });

// ============================================================ primitives ====

check("money: plain", shared.parseMoney("67.00"), 67);
check("money: currency and thousands", shared.parseMoney("$1,234.56"), 1234.56);
check("money: parenthesised credit", shared.parseMoney("(45.00)"), -45);
check("money: trailing minus", shared.parseMoney("12.00-"), -12);
check("money: european decimal", shared.parseMoney("1.234,56"), 1234.56);
// The regression this guards: "1,234" is a thousands group, not 1.234.
check("money: comma as thousands, no decimals", shared.parseMoney("1,234"), 1234);
check("money: rejects non-money", shared.parseMoney("Table 12"), 12);
check("money: rejects empty", shared.parseMoney(""), null);

check("date: ISO passthrough", shared.toIsoDate("2026-07-29"), "2026-07-29");
check("date: US slashes", shared.toIsoDate("07/29/2026"), "2026-07-29");
check("date: pads single digits", shared.toIsoDate("7/4/2026"), "2026-07-04");
check("date: strips a timestamp", shared.toIsoDate("2026-07-29 14:32:11"), "2026-07-29");
check("date: strips an ISO timestamp", shared.toIsoDate("2026-07-29T14:32:11Z"), "2026-07-29");
check("date: day-first when told", shared.toIsoDate("07/08/2026", { dayFirst: true }), "2026-08-07");
// 29 cannot be a month, so it is a day whatever the flag says.
check("date: unambiguous day", shared.toIsoDate("29/07/2026"), "2026-07-29");
check("date: DD-Mon-YYYY", shared.toIsoDate("29-Jul-2026"), "2026-07-29");
check("date: Month DD, YYYY", shared.toIsoDate("July 29, 2026"), "2026-07-29");
check("date: rejects rubbish", shared.toIsoDate("Grill Room"), null);

// The bug the old inline `line.split(",")` had: a quoted "Last, First" shifted
// every column after it by one.
check("csv: quoted comma stays one field",
  shared.parseDelimited('a,b,c\n1,"Krietsch, Karl",3')[1],
  ["1", "Krietsch, Karl", "3"]);
check("csv: escaped quotes", shared.parseDelimited('a\n"say ""hi"""')[1], ['say "hi"']);
check("csv: sniffs semicolons", shared.sniffDelimiter("a;b;c\n1;2;3"), ";");
check("csv: sniffs tabs", shared.sniffDelimiter("a\tb\tc\n1\t2\t3"), "\t");

check("outlet normalisation folds case and punctuation",
  shared.normalizeOutlet("The Grill-Room") === shared.normalizeOutlet("GRILL ROOM"), true);
check("outlet normalisation expands ampersand",
  shared.normalizeOutlet("Bar & Grill"), "bar and grill");

// ================================================================= Jonas ====

const JONAS_CSV = `Aronimink Golf Club
Member Charge Detail
Dates: 07/29/2026 to 07/29/2026
Printed by: J. Kenny

Member #,Member Name,Trans Date,Revenue Centre,Chit #,Server,Covers,Net Sales,Gratuity,Tax,Charge Amount
1042,"Krietsch, Karl",07/29/2026,Grill Room,608539,Ava Del Viscio,4,67.00,12.06,4.15,83.21
1042,"Krietsch, Karl",07/29/2026,Grill Room,608760,Sabrina Swope,2,33.00,5.94,2.05,40.99
0876,"Norton, Robert",07/29/2026,Grill Room,608890,Priyanka,,23.00,4.14,1.43,28.57
1155-S,"Pettit, Cynthia",07/29/2026,Halfway House,608658,Priyanka,,17.00,3.06,1.05,21.11
0876,"Norton, Robert",07/29/2026,Grill Room,608901,Priyanka,,(9.00),0.00,0.00,(9.00)
,,,,,,,140.00,25.20,8.68,164.87
Department Total,,,,,,,140.00,25.20,8.68,164.87
`;

(async () => {
  // --- detection
  const jonasDoc = await readDocument(file("member-charge-detail.csv", JONAS_CSV));
  const jonasDetected = detectModule(jonasDoc);
  check("Jonas: detected from a CSV export", jonasDetected.module.id, "jonas");

  const jonasResult = await parseUpload(file("member-charge-detail.csv", JONAS_CSV));
  check("Jonas: parses without error", jonasResult.error || null, null);

  const js = jonasResult.summary;
  check("Jonas: reports the vendor", js.vendor, "jonas");
  check("Jonas: finds the header past the title block", js.header_row, 5);
  check("Jonas: takes Net Sales as spend, not the gratuity-inflated charge",
    js.spend_column, "Net Sales");
  check("Jonas: maps the Canadian spelling of Revenue Centre",
    js.columns_mapped.outlet_name, "Revenue Centre");
  check("Jonas: reads every check", js.stats.rows_read, 5);
  check("Jonas: drops the subtotal rows", js.stats.rows_skipped_summary, 2);
  check("Jonas: counts the credit", js.stats.negative_rows, 1);

  const jr = jonasResult.rows;
  // 1042 ran two checks in the Grill Room; 0876 ran a sale and a reversal.
  check("Jonas: one visit per member per outlet per day", jr.length, 3);

  const karl = jr.find((r) => r.member_id === "1042");
  check("Jonas: merges a member's repeat checks", karl.spend_amount, "100.00");
  check("Jonas: records the check count", karl.checks, 2);
  check("Jonas: keeps the member name", karl.member_name, "Krietsch, Karl");
  check("Jonas: keeps the outlet", karl.outlet_name, "Grill Room");
  check("Jonas: converts the date", karl.visit_date, "2026-07-29");
  check("Jonas: keeps the server", karl.server_name, "Ava Del Viscio");
  check("Jonas: reads covers", karl.covers, 4);

  // The reversal has to net out, or the club surveys somebody on a sale that
  // was taken back.
  const robert = jr.find((r) => r.member_id === "0876");
  check("Jonas: a voided check nets against the sale", robert.spend_amount, "14.00");

  check("Jonas: keeps the spouse suffix for the member lookup",
    jr.find((r) => r.member_name === "Pettit, Cynthia").member_id, "1155-S");
  check("Jonas: separates outlets", jr.find((r) => r.member_id === "1155-S").outlet_name, "Halfway House");

  // --- the single-department layout, where the outlet is in the preamble
  const JONAS_BLOCK = `Jonas Club Management
POS Sales Journal
Revenue Centre: Poolside Cafe
Date: 07/30/2026

Account #,Name,Chit,Net Amount
1042,"Krietsch, Karl",700123,44.50
`;
  const blockResult = await parseUpload(file("journal.csv", JONAS_BLOCK));
  check("Jonas: takes the outlet from the preamble when there is no column",
    blockResult.rows[0].outlet_name, "Poolside Cafe");
  check("Jonas: takes the date from a single-day preamble",
    blockResult.rows[0].visit_date, "2026-07-30");

  // ======================================================== Lightspeed ====

  const LS_CSV = `Receipt number,Business day,Shop,Employee,Customer,Customer ID,Covers,Total excl. tax,Tax,Total incl. tax
R-10041,2026-07-29,Main Dining Room,Ava D,"Krietsch, Karl",M1042,4,67.00,4.15,71.15
R-10042,2026-07-29,Main Dining Room,Sabrina S,"Krietsch, Karl",M1042,2,33.00,2.05,35.05
R-10043,2026-07-29,Terrace Bar,Priyanka,"Norton, Robert",,2,23.00,1.43,24.43
R-10044,2026-07-29,Terrace Bar,Priyanka,John Smith (M1155),,2,52.00,3.20,55.20
`;

  const lsDoc = await readDocument(file("sales.csv", LS_CSV));
  check("Lightspeed: detected from the excl./incl. tax pair",
    detectModule(lsDoc).module.id, "lightspeed");

  const lsResult = await parseUpload(file("sales.csv", LS_CSV));
  check("Lightspeed: parses without error", lsResult.error || null, null);

  const ls = lsResult.summary;
  check("Lightspeed: reports the vendor", ls.vendor, "lightspeed");
  check("Lightspeed: labels the Restaurant side", ls.format, "Lightspeed Restaurant");
  check("Lightspeed: takes the net figure as spend", ls.spend_column, "Total excl. tax");
  check("Lightspeed: maps Shop to the outlet", ls.columns_mapped.outlet_name, "Shop");
  check("Lightspeed: maps the receipt number", ls.columns_mapped.check_number, "Receipt number");

  const lr = lsResult.rows;
  check("Lightspeed: one visit per member per outlet per day", lr.length, 3);
  const lsKarl = lr.find((r) => r.member_id === "M1042");
  check("Lightspeed: merges repeat receipts", lsKarl.spend_amount, "100.00");
  check("Lightspeed: keeps the tax-inclusive total separately", lsKarl.check_total, "106.20");
  check("Lightspeed: quoted name survives the comma", lsKarl.member_name, "Krietsch, Karl");

  // Customer ID blank — the name is the only identification, which is the
  // normal case when staff skip the customer record at the till.
  check("Lightspeed: falls back to the name when there is no customer ID",
    lr.find((r) => r.member_name === "Norton, Robert").member_id, "");

  // Member number typed into the name field.
  const smith = lr.find((r) => r.member_name === "John Smith");
  check("Lightspeed: lifts a member number out of the name", smith.member_id, "M1155");

  // --- Golf variant
  const LS_GOLF = `Lightspeed Golf — Chronogolf
Green fee and F&B export

Order number,Date,Location,Member,Membership #,Net,Total incl. tax
1001,2026-07-29,Pro Shop,"Wilson, Keith",W135,88.00,93.28
`;
  const golfResult = await parseUpload(file("chronogolf.csv", LS_GOLF));
  check("Lightspeed: recognises the Golf side", golfResult.summary.format, "Lightspeed Golf");
  check("Lightspeed Golf: maps Membership # to the member", golfResult.rows[0].member_id, "W135");
  check("Lightspeed Golf: maps Location to the outlet", golfResult.rows[0].outlet_name, "Pro Shop");

  // --- day-first dates, which Lightspeed emits outside North America
  const LS_EURO = `Receipt number,Date,Shop,Customer,Total excl. tax
1,29/07/2026,Terrace Bar,"Norton, Robert",23.00
2,30/07/2026,Terrace Bar,"Norton, Robert",25.00
3,13/07/2026,Terrace Bar,"Norton, Robert",25.00
`;
  const euro = await parseUpload(file("euro.csv", LS_EURO));
  check("Lightspeed: reads a day-first date column", euro.summary.date_order, "day-first");
  check("Lightspeed: day-first dates convert correctly",
    euro.rows.map((r) => r.visit_date).sort(), ["2026-07-13", "2026-07-29", "2026-07-30"]);

  // A month-first file must not be flipped by the same logic.
  const LS_US = `Receipt number,Date,Shop,Customer,Total excl. tax
1,07/29/2026,Terrace Bar,"Norton, Robert",23.00
`;
  const us = await parseUpload(file("us.csv", LS_US));
  check("Lightspeed: leaves a month-first column alone", us.rows[0].visit_date, "2026-07-29");

  // ============================================================ registry ====

  // A Jonas file must not be claimed by Lightspeed and vice versa.
  check("registry: Jonas outscores Lightspeed on a Jonas file",
    jonas.detect(jonasDoc) > lightspeed.detect(jonasDoc), true);
  check("registry: Lightspeed outscores Jonas on a Lightspeed file",
    lightspeed.detect(lsDoc) > jonas.detect(lsDoc), true);

  // An unbranded export still parses, via the generic module.
  const PLAIN = `member_id,outlet_name,spend_amount,visit_date,server_name
M1042,Grill Room,67.00,07/29/2026,Ava
`;
  const plain = await parseUpload(file("plain.csv", PLAIN));
  check("registry: an unbranded export falls back to generic", plain.summary.vendor, "generic");
  check("registry: the generic module still parses it", plain.rows[0].spend_amount, "67.00");

  // Forcing a module overrides detection. Lightspeed can read the Jonas file —
  // its Net Sales / Revenue Centre matchers cover those columns — so this
  // proves the override took effect rather than detection quietly winning.
  const forced = await parseUpload(file("member-charge-detail.csv", JONAS_CSV), { vendor: "lightspeed" });
  check("registry: the club can force a module", forced.summary.vendor, "lightspeed");
  check("registry: a forced module says so", forced.summary.detected, "chosen by you");
  check("registry: the forced module still parses the file", forced.rows.length, 3);

  // Forcing a module that cannot read the file fails loudly rather than
  // producing empty or wrong visits.
  const wrongForce = await parseUpload(file("plain.csv", PLAIN), { vendor: "jonas" });
  check("registry: forcing the wrong module reports why",
    /no amount column/i.test(wrongForce.error || ""), true);
  check("registry: a failure still says which module was tried",
    [wrongForce.summary.vendor, wrongForce.summary.detected], ["jonas", "chosen by you"]);

  // --- tab-separated and Excel-shaped input
  const TSV = JONAS_CSV.split("\n").map((l) => shared.parseDelimited(l, ",")[0]?.join("\t") ?? "").join("\n");
  const tsv = await parseUpload(file("export.tsv", TSV));
  check("registry: reads a tab-separated export", tsv.error || tsv.summary.vendor, "jonas");

  // ============================================================ Club V1 ====

  // £, VAT, sections and DD/MM/YYYY. The dates here are the whole point: read
  // month-first, 07/08/2026 silently becomes 7 August instead of 8 July.
  const CV1_CSV = `Club Systems — Club V1
Till Sales Analysis
Date: 08/07/2026

Member No,Member Name,Trans Date,Section,Operator,Docket No,Covers,Net,VAT,Gross
001042,"Krietsch, Karl",08/07/2026,Members Bar,A Dunne,551201,2,£67.00,£13.40,£80.40
001042,"Krietsch, Karl",08/07/2026,Members Bar,A Dunne,551288,2,£33.00,£6.60,£39.60
000876,"Norton, Robert",08/07/2026,Spike Bar,P Shaw,551302,,£23.00,£4.60,£27.60
001155-J,"Pettit, Cynthia",08/07/2026,Halfway House,P Shaw,551340,,£17.00,£3.40,£20.40
000876,"Norton, Robert",08/07/2026,Spike Bar,P Shaw,551355,,(£9.00),(£1.80),(£10.80)
Section Total,,,,,,,£131.00,£26.20,£157.20
`;

  const cv1Doc = await readDocument(file("till-sales.csv", CV1_CSV));
  check("Club V1: detected from a Club V1 export", detectModule(cv1Doc).module.id, "clubv1");

  const cv1 = await parseUpload(file("till-sales.csv", CV1_CSV));
  check("Club V1: parses without error", cv1.error || null, null);
  check("Club V1: reports the vendor", cv1.summary.vendor, "clubv1");
  check("Club V1: takes Net, not the VAT-inclusive Gross", cv1.summary.spend_column, "Net");
  check("Club V1: maps Section to the outlet", cv1.summary.columns_mapped.outlet_name, "Section");
  check("Club V1: maps Operator to the server", cv1.summary.columns_mapped.server_name, "Operator");
  check("Club V1: maps Docket No to the check number", cv1.summary.columns_mapped.check_number, "Docket No");
  check("Club V1: drops the section total", cv1.summary.stats.rows_skipped_summary, 1);

  // The regression this module exists to prevent.
  check("Club V1: reads dates day-first", cv1.summary.date_order, "day-first");
  check("Club V1: 08/07/2026 is 8 July, not 7 August",
    cv1.rows[0].visit_date, "2026-07-08");

  check("Club V1: strips the pound sign", cv1.rows.find((r) => r.member_id === "001042").spend_amount, "100.00");
  check("Club V1: a parenthesised credit nets against the sale",
    cv1.rows.find((r) => r.member_id === "000876").spend_amount, "14.00");
  check("Club V1: keeps a junior suffix for the member lookup",
    cv1.rows.find((r) => r.member_name === "Pettit, Cynthia").member_id, "001155-J");
  check("Club V1: separates sections",
    [...new Set(cv1.rows.map((r) => r.outlet_name))].sort(),
    ["Halfway House", "Members Bar", "Spike Bar"]);

  // A club that has configured an American date format still parses: 25 in
  // the second position can only be a day, so day-first is turned off.
  const CV1_US = `Club V1 Till Sales
Member No,Trans Date,Section,Net
001042,07/25/2026,Members Bar,£40.00
001042,07/26/2026,Members Bar,£10.00
`;
  const cv1us = await parseUpload(file("us-dates.csv", CV1_US));
  check("Club V1: an American date column overrules the day-first default",
    cv1us.rows[0].visit_date, "2026-07-25");

  // An all-ambiguous column keeps the UK default rather than guessing.
  const CV1_AMBIG = `Club V1 Till Sales
Member No,Trans Date,Section,Net
001042,03/04/2026,Members Bar,£40.00
`;
  const cv1amb = await parseUpload(file("ambig.csv", CV1_AMBIG));
  check("Club V1: an ambiguous date stays day-first", cv1amb.rows[0].visit_date, "2026-04-03");

  // Section in the preamble rather than as a column.
  const CV1_BLOCK = `Club Systems Club V1
EPOS Sales
Section: Members Bar
Date: 08/07/2026

Membership No,Name,Docket,Net
001042,"Krietsch, Karl",551201,£44.50
`;
  const cv1block = await parseUpload(file("epos.csv", CV1_BLOCK));
  check("Club V1: takes the section from the preamble when there is no column",
    cv1block.rows[0].outlet_name, "Members Bar");
  check("Club V1: takes the date from a single-day preamble, day-first",
    cv1block.rows[0].visit_date, "2026-07-08");

  // Club V1 must not steal the North American vendors' files, or lose its own.
  check("registry: Club V1 does not claim a Jonas file",
    require("./clubv1").detect(jonasDoc) < jonas.detect(jonasDoc), true);
  check("registry: Club V1 does not claim a Lightspeed file",
    require("./clubv1").detect(lsDoc) < lightspeed.detect(lsDoc), true);
  check("registry: Jonas does not claim a Club V1 file",
    jonas.detect(cv1Doc) < require("./clubv1").detect(cv1Doc), true);
  check("registry: Lightspeed does not claim a Club V1 file",
    lightspeed.detect(cv1Doc) < require("./clubv1").detect(cv1Doc), true);

  // --- the PDF path, where there is no grid and columns are runs of spaces
  // rather than delimiters. Built as a document directly, since the input is
  // pdf-parse's text layer rather than a file we can fabricate.
  const pdfLines = [
    "Aronimink Golf Club",
    "Jonas Club Management — Member Charge Detail",
    "Dates: 07/29/2026 to 07/29/2026",
    "Member #    Member Name        Trans Date    Revenue Centre    Net Sales    Gratuity    Charge Amount",
    "1042        Krietsch, Karl     07/29/2026    Grill Room        67.00        12.06       83.21",
    "0876        Norton, Robert     07/29/2026    Grill Room        23.00        4.14        28.57",
    "Department Total                                               90.00        16.20       111.78",
    "Page 1 of 3",
  ];
  const pdfDoc = {
    kind: "pdf", grid: null, lines: pdfLines, rawLines: pdfLines,
    headText: pdfLines.join("\n"),
  };
  check("PDF: a Jonas PDF is detected", jonas.detect(pdfDoc) > 0.5, true);

  const pdfParsed = extractRows(pdfDoc, jonas, {});
  check("PDF: parses without error", pdfParsed.error || null, null);
  check("PDF: splits columns on runs of spaces", pdfParsed.rows.length, 2);
  check("PDF: a name containing a space is not split",
    pdfParsed.rows[0].member_name, "Krietsch, Karl");
  check("PDF: an outlet containing a space is not split",
    pdfParsed.rows[0].outlet_name, "Grill Room");
  check("PDF: takes the net figure", pdfParsed.rows[0].spend_amount, "67.00");
  check("PDF: drops the total and the page furniture",
    pdfParsed.diagnostics.stats.rows_skipped_summary, 2);

  // --- failure reporting
  const NOTHING = `Some Club\nNothing useful here\nJust prose about the weather\n`;
  const bad = await parseUpload(file("junk.csv", NOTHING));
  check("failure: says it could not find a header", /header row/i.test(bad.error || ""), true);

  const NO_MEMBER = `Shop,Business day,Total excl. tax\nTerrace Bar,2026-07-29,23.00\n`;
  const noMember = await parseUpload(file("nomember.csv", NO_MEMBER));
  check("failure: explains that nobody is identified",
    /identifies nobody/i.test(noMember.error || ""), true);

  const NO_AMOUNT = `Member #,Member Name,Revenue Centre,Trans Date\n1042,"K, K",Grill Room,07/29/2026\n`;
  const noAmount = await parseUpload(file("noamount.csv", NO_AMOUNT));
  check("failure: explains that there is no amount column",
    /no amount column/i.test(noAmount.error || ""), true);

  const NO_OUTLET = `Member #,Member Name,Trans Date,Net Sales\n1042,"K, K",07/29/2026,67.00\n`;
  const noOutlet = await parseUpload(file("nooutlet.csv", NO_OUTLET));
  check("failure: asks for an outlet when the file has none",
    /pick an outlet/i.test(noOutlet.error || ""), true);
  // ...and accepts one from the dropdown.
  const withOutlet = await parseUpload(file("nooutlet.csv", NO_OUTLET), { outletName: "Grill Room" });
  check("failure: the dropdown outlet resolves it", withOutlet.rows[0].outlet_name, "Grill Room");

  const unsupported = await parseUpload(file("report.docx", "x"));
  check("failure: rejects an unsupported file type",
    /unsupported file type/i.test(unsupported.error || ""), true);

  // --- diagnostics are what we tune the next real export against
  check("diagnostics: lists the columns it ignored",
    js.columns_ignored.includes("Gratuity") && js.columns_ignored.includes("Tax"), true);

  check("registry: lists its modules for the dashboard",
    listModules().map((m) => m.id), ["northstar", "jonas", "lightspeed", "clubv1", "generic"]);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
