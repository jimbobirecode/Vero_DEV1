const P = require("./pos-parse.js");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// Lines taken verbatim from a real NorthStar export, including the wrapped
// rows in GP BAR ONLY and the rows where the covers column is omitted.
const FIXTURE = [
  "Aronimink Golf Club",
  "Sales By Location",
  "Dates : From 07/29/2026 To 07/30/2026",
  "Check#\tCheck Date Server Member # Member Name Cvrs. Item Total Sub Total Gratutity\tAdd On Total Inclusive Tips Total",
  "Location Name: Golf Patio",
  // covers present
  "07/29/2026 608539 4 $67.00 $0.00\t$18.21 $0.00 $0.00\t$67.00 $85.21\tK273\tAva Del Viscio Krietsch, Karl",
  // same member, same outlet, same day -> should merge
  "07/29/2026 608760 4 $33.00 $0.00\t$7.00 $0.00 $0.00\t$33.00 $40.00\tK273\tSabrina Swope Krietsch, Karl",
  // covers OMITTED — the shape the old parser tripped on
  "07/29/2026 608890 $23.00 $0.00\t$5.29 $0.00 $0.00\t$23.00 $28.29\tN102\tPriyanka Norton, Robert",
  // spouse suffix on the member number
  "07/29/2026 608658 $17.00 $0.00\t$4.62 $0.00 $0.00\t$17.00 $21.62\tP111-S\tPriyanka Pettit, Cynthia",
  "Printed On July 30, 2026 at 04:00 AM",
  "Page 1 of 12 Sales By Location",
  "-- 1 of 12 --",
  "$3,834.50 $3,834.50 $943.71 $0.00\t$0.00 $4,778.21\t$0.00\t152\tGolf Patio\tTotal for:",
  "Location Name: GP BAR ONLY",
  // wrapped row: member # on the data line, server split over two more lines
  "07/29/2026 608531 $12.00 $0.00\t$2.54 $0.00 $0.00\t$12.00 $14.54\tW135-S",
  "Patrick",
  "McDermott Wilson, Keith",
  "Note:",
  "* Add On includes Service Charge, Surcharge and Sales Tax.",
  "Grand Total: 372 $13,204.75 $13,175.75 $3,256.03 $0.00\t$0.00 $0.00 $16,431.78",
];

// --- format detection (the regression: the report is titled "Sales By
// Location", but detection only matched "Daily Sales By Location")
check("detects 'Sales By Location'", P.isSalesByLocation(FIXTURE), true);
check("still detects 'Daily Sales By Location'",
  P.isSalesByLocation(["Daily Sales By Location", "Location Name: Bar"]), true);
check("ignores unrelated reports",
  P.isSalesByLocation(["Membership Roster", "Name  Email"]), false);

const { rows, stats } = P.parseSalesByLocation(FIXTURE);

check("parses every data row", stats.rows_parsed, 5);
check("no row loses its member number", stats.rows_without_member_id, 0);
check("tracks both locations", stats.locations, ["Golf Patio", "GP BAR ONLY"]);

// --- totals reconcile against the report's own subtotal line
const golf = rows.filter(r => r.outlet_name === "Golf Patio");
const golfSum = golf.reduce((a, r) => a + parseFloat(r.spend_amount.replace(/[$,]/g, "")), 0);
check("Golf Patio Item Total sums correctly", golfSum, 67 + 33 + 23 + 17);

// --- row with covers
check("row with covers", {
  id: rows[0].member_id, spend: rows[0].spend_amount, total: rows[0].check_total,
  date: rows[0].visit_date, covers: rows[0].covers, server: rows[0].server_name,
}, { id: "K273", spend: "$67.00", total: "$85.21", date: "2026-07-29", covers: 4, server: "Ava Del Viscio" });

// --- row with the covers column missing
check("row without covers", {
  id: rows[2].member_id, spend: rows[2].spend_amount, covers: rows[2].covers, member: rows[2].member_name,
}, { id: "N102", spend: "$23.00", covers: null, member: "Norton, Robert" });

check("keeps spouse suffix", rows[3].member_id, "P111-S");

// --- wrapped row reassembled from three separate lines
check("wrapped row", {
  id: rows[4].member_id, outlet: rows[4].outlet_name,
  server: rows[4].server_name, member: rows[4].member_name,
}, { id: "W135-S", outlet: "GP BAR ONLY", server: "Patrick McDermott", member: "Wilson, Keith" });

// --- boilerplate must never become a row
check("no subtotal/grand-total rows leak in",
  rows.filter(r => !r.member_id).length, 0);

// --- spend uses Item Total, not the gratuity-inflated check total
check("spend excludes gratuity", rows[0].spend_amount !== rows[0].check_total, true);

// --- aggregation
const agg = P.aggregateRows(rows);
check("merges repeat checks by member+outlet+date", agg.merged, 1);
check("one visit per member per outlet per day", agg.rows.length, 4);
const k273 = agg.rows.find(r => r.member_id === "K273");
check("merged spend is the day's total", k273.spend_amount, "100.00");
check("merged visit records the check count", k273.checks, 2);

// --- name splitting
check("splits server from member name",
  P.splitServerAndMember("Ava Del Viscio Krietsch, Karl"),
  { server: "Ava Del Viscio", member: "Krietsch, Karl" });
check("handles a single-word server",
  P.splitServerAndMember("Priyanka Norton, Robert"),
  { server: "Priyanka", member: "Norton, Robert" });

check("converts dates to ISO", P.toIsoDate("07/29/2026"), "2026-07-29");
check("pads single-digit dates", P.toIsoDate("7/4/2026"), "2026-07-04");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
