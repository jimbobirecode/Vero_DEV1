const B = require("./sms-billing.js");
const { smsBody, staffSmsBody } = require("./messages.js");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const rep = (ch, n) => ch.repeat(n);

// ------------------------------------------------------------- segmenting ---

check("empty body costs nothing", B.meter("").segments, 0);
check("a short message is one segment", B.meter("Hello").segments, 1);
check("160 GSM characters still fit one segment", B.meter(rep("a", 160)).segments, 1);
check("161 tips into two", B.meter(rep("a", 161)).segments, 2);
// Not 161/153 rounded up as if the header were free — the header is charged
// against every part, including the first.
check("the 153-septet limit applies to both parts", B.meter(rep("a", 306)).segments, 2);
check("307 needs a third part", B.meter(rep("a", 307)).segments, 3);

check("plain ASCII is GSM-7", B.encodingFor("Thanks for visiting"), "gsm7");
check("accented Latin in the GSM table stays GSM-7", B.encodingFor("Café à la carte è"), "gsm7");
check("a curly apostrophe forces UCS-2", B.encodingFor("We’d love your feedback"), "ucs2");
check("an em dash forces UCS-2", B.encodingFor("quick feedback — one minute"), "ucs2");
check("an emoji forces UCS-2", B.encodingFor("Thanks! \u{1F44D}"), "ucs2");

// The whole reason this file exists: one character changes the price of every
// message sent with that wording.
const ascii70 = rep("a", 70);
check("70 GSM characters is one segment", B.meter(ascii70).segments, 1);
check("the same 70 with one curly apostrophe is still one UCS-2 segment",
  B.meter(rep("a", 69) + "’").segments, 1);
check("71 UCS-2 characters need two segments",
  B.meter(rep("a", 70) + "’").segments, 2);
check("155 GSM characters cost 1 segment", B.meter(rep("a", 155)).segments, 1);
check("155 characters with one em dash cost 3", B.meter(rep("a", 154) + "—").segments, 3);

// Extension characters are two septets, which is where naive length checks go
// wrong: 80 of them fill a 160-septet segment exactly.
check("a euro sign costs two septets", B.meter("€").units, 2);
check("80 euro signs exactly fill one segment", B.meter(rep("€", 80)).segments, 1);
check("81 euro signs need two", B.meter(rep("€", 81)).segments, 2);
check("a brace costs two septets", B.meter("{}").units, 4);

// An escape pair is never split across a segment boundary, so the segment ends
// one septet short rather than the pair straddling it. Naive ceil(units/153)
// would say 2 here.
const straddle = rep("a", 152) + rep("€", 77);
check("an extension pair is not split across the boundary",
  B.meter(straddle).segments, Math.ceil(B.meter(straddle).units / 153) + 1);

// An emoji is one code point but two UCS-2 units, and likewise never split.
check("an emoji counts as two UCS-2 units", B.meter("\u{1F44D}").units, 2);
check("35 emoji fill one UCS-2 segment", B.meter(rep("\u{1F44D}", 35)).segments, 1);
check("36 emoji need two", B.meter(rep("\u{1F44D}", 36)).segments, 2);

check("headroom says how much room is left before the next segment",
  B.meter(rep("a", 150)).headroom, 10);
check("headroom is measured against the multipart capacity once multipart",
  B.meter(rep("a", 200)).headroom, 306 - 200);

check("the character that forced UCS-2 is named",
  B.offendingCharacters("feedback — today"), [{ character: "—", code_point: "U+2014" }]);
check("a GSM-safe body names nothing", B.offendingCharacters("feedback today"), []);
check("each offender is reported once",
  B.offendingCharacters("—a—b’").map((o) => o.code_point), ["U+2014", "U+2019"]);

// ---------------------------------------------------------------- pricing ---

const CARD = { sms_rate_cents_per_segment: "0.79", sms_markup_pct: "0" };

check("an unconfigured rate is zero, not a guess", B.rateCard({}).rate_cents_per_segment, 0);
check("an unconfigured rate is flagged as such", B.rateCard({}).configured, false);
check("a configured rate is flagged", B.rateCard(CARD).configured, true);
check("nonsense in the setting does not become a price",
  B.rateCard({ sms_rate_cents_per_segment: "free please" }).rate_cents_per_segment, 0);
check("a negative rate is floored at zero",
  B.rateCard({ sms_rate_cents_per_segment: "-5" }).rate_cents_per_segment, 0);

check("markup is applied to the carrier rate",
  B.rateCard({ ...CARD, sms_markup_pct: "20" }).unit_price_cents, 0.948);
check("the carrier rate survives markup being applied",
  B.rateCard({ ...CARD, sms_markup_pct: "20" }).rate_cents_per_segment, 0.79);

// Sub-cent rates are the norm, and rounding each message to a whole cent would
// bill $0.01 for something that cost $0.0079 — a 27% overcharge, every message.
check("a three-segment message keeps sub-cent precision",
  B.priceMessage({ segments: 3 }, B.rateCard(CARD)).billable_cents, 2.37);
check("rounding happens once, at the total", B.toCents(2.37), 2.37);
check("half rounds away from zero", B.toCents(0.005), 0.01);

// --------------------------------------------------------------- statement --

const row = (over = {}) => ({
  channel: "sms", status: "sent", created_at: "2026-07-01T10:00:00Z",
  body: "Aronimink Golf Club: quick feedback please", segments: 1,
  unit_price_cents: 0.79, kind: "survey", encoding: "gsm7", ...over,
});

const s1 = B.statement([row(), row(), row({ segments: 3, encoding: "ucs2" })], CARD);
check("segments are summed, not messages", s1.totals.segments_sent, 5);
check("the total is the segments at the rate", s1.totals.amount_cents, 3.95);
check("the invoice total is formatted money", s1.totals.amount, "$0.04");

// The likeliest way a back-charge system overbills: failures sit in the same
// table and look identical to a COUNT(*).
const s2 = B.statement([row(), row({ status: "failed", segments: 3 })], CARD);
check("a failed send is not charged", s2.totals.amount_cents, 0.79);
check("a failed send is not counted as sent", s2.totals.segments_sent, 1);
check("but it is reported, so the club can see it was not billed", s2.totals.messages_failed, 1);

// Email shares message_log with SMS and must not appear on an SMS invoice.
const s3 = B.statement([row(), { channel: "email", status: "sent", body: "hi", created_at: "2026-07-01T10:00:00Z" }], CARD);
check("email is not an SMS charge", s3.totals.messages_sent, 1);
check("email is not counted as a failed SMS either", s3.totals.messages_failed, 0);

// The price on the row wins over today's price, or an invoice stops being
// reproducible the moment anyone edits the rate.
const s4 = B.statement([row({ unit_price_cents: 0.5 })], { sms_rate_cents_per_segment: "2.00" });
check("a sent message keeps the price it was sent at", s4.totals.amount_cents, 0.5);

// Allowance is consumed oldest-first, not discounted off the total, so it still
// behaves when the rate changed mid-period.
const s5 = B.statement(
  [
    row({ created_at: "2026-07-01T00:00:00Z", segments: 2, unit_price_cents: 1 }),
    row({ created_at: "2026-07-02T00:00:00Z", segments: 2, unit_price_cents: 10 }),
  ],
  { ...CARD, sms_included_segments_per_period: "3" }
);
check("the allowance is used up first", s5.totals.segments_included, 3);
check("only the excess is charged", s5.totals.segments_charged, 1);
check("and it is charged at the rate of the message that used it", s5.totals.amount_cents, 10);

// Rows arriving out of order must still consume the allowance chronologically.
const s6 = B.statement(
  [
    row({ created_at: "2026-07-09T00:00:00Z", segments: 1, unit_price_cents: 10 }),
    row({ created_at: "2026-07-01T00:00:00Z", segments: 1, unit_price_cents: 1 }),
  ],
  { ...CARD, sms_included_segments_per_period: "1" }
);
check("out-of-order rows are still consumed oldest-first", s6.totals.amount_cents, 10);

check("a breakdown by kind is produced",
  B.statement([row({ kind: "survey" }), row({ kind: "reminder", segments: 3 })], CARD)
    .by_kind.map((k) => [k.kind, k.segments]),
  [["reminder", 3], ["survey", 1]]);
check("a message sent before kinds existed is not silently dropped",
  B.statement([row({ kind: null })], CARD).by_kind[0].kind, "unattributed");

// A row written before metering shipped still has a body to count from.
const s7 = B.statement([row({ segments: null, unit_price_cents: null, body: rep("a", 200) })], CARD);
check("an unmetered row is metered from its body", s7.totals.segments_sent, 2);
check("and the statement says the price is not historical",
  s7.warnings.some((w) => w.includes("before per-segment metering")), true);

check("no configured rate is called out rather than billed as zero",
  B.statement([row({ unit_price_cents: 0 })], {}).warnings.some((w) => w.includes("No SMS rate is configured")), true);
check("segments that could not be priced are counted",
  B.statement([row({ unit_price_cents: 0, segments: 4 })], {}).unpriced_segments, 4);
check("UCS-2 spend is called out so it can be fixed",
  B.statement([row({ encoding: "ucs2", segments: 3 })], CARD)
    .warnings.some((w) => w.includes("UCS-2")), true);

check("an empty period is a zero invoice, not an error", B.statement([], CARD).totals.amount_cents, 0);

// ----------------------------------------------------------------- periods --

check("a month resolves to its UTC bounds", B.monthBounds("2026-07"),
  { period: "2026-07", from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" });
check("December rolls into the next year", B.monthBounds("2026-12").to, "2027-01-01T00:00:00.000Z");
check("a nonsense month is rejected", B.monthBounds("2026-13"), null);
check("a missing month is rejected", B.monthBounds(""), null);

// ------------------------------------------------- the club's real wording ---
// These assert what the club is actually billed for today. If someone rewords a
// template into UCS-2, this is the test that fails and says why.

const LINK = "https://vero.onrender.com/s/0f8c2a41-7b6e-4c19-9a3d-1e5b7c2d4f60";
for (const type of ["food_bev", "golf", "events"]) {
  const body = smsBody({ surveyType: type, link: LINK, clubName: "Aronimink Golf Club" });
  const m = B.meter(body);
  check(`the ${type} survey sends as GSM-7`, m.encoding, "gsm7");
  check(`the ${type} survey costs one segment`, m.segments, 1);
}
const staff = B.meter(staffSmsBody({ link: "https://vero.onrender.com/ss/0f8c2a41-7b6e-4c19-9a3d-1e5b7c2d4f60", firstName: "Jessica", clubName: "Aronimink Golf Club" }));
check("the staff survey sends as GSM-7", staff.encoding, "gsm7");
// Two segments, and deliberately recorded as two rather than quietly reworded:
// at 173 septets it is over the 160 limit by more than any phrasing tweak
// recovers, so shortening it is a wording decision for the club, not a billing
// one. What matters here is that the cost is known and cannot drift unnoticed.
check("the staff survey costs two segments — it is over the 160 limit", staff.segments, 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
