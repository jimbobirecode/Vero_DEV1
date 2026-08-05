process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key";
const { parseResult, toPayload, userPrompt, generate } = require("./event-insight");

let pass = 0, fail = 0;
function check(label, cond, detail = "") {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? "\n      " + detail : ""}`); }
}

const GOOD = JSON.stringify({
  urgency: "watch",
  headline: "Warm reception for the format, let down by a slow turn at the halfway house.",
  themes: [{ keyword: "halfway house", sentiment: "negative", count: 3, example_quote: "Waited 20 minutes at the turn." }],
  what_worked: ["Shotgun start ran to time"],
});

console.log("\n--- reading the model back ---");
check("plain JSON", parseResult(GOOD).urgency === "watch");
check("fenced JSON, which is how the instruction usually gets bent",
  parseResult("```json\n" + GOOD + "\n```").themes.length === 1);
check("themes survive intact", parseResult(GOOD).themes[0].keyword === "halfway house");
check("what_worked survives", parseResult(GOOD).what_worked[0] === "Shotgun start ran to time");

console.log("\n--- a broken reply never loses the run ---");
let r = parseResult("I'm afraid I can't do that.");
check("unparseable falls back to maintain", r.urgency === "maintain");
check("and says so in the headline", /generating it again/.test(r.headline), r.headline);
check("with empty arrays, not undefined", Array.isArray(r.themes) && Array.isArray(r.what_worked));

console.log("\n--- malformed fields are not trusted ---");
r = parseResult(JSON.stringify({ urgency: "APOCALYPTIC", headline: 42, themes: "none", what_worked: [1, "ok"] }));
check("an unknown urgency becomes maintain", r.urgency === "maintain");
check("a non-string headline becomes empty", r.headline === "");
check("non-array themes become an array", Array.isArray(r.themes) && r.themes.length === 0);
check("non-string entries are dropped from what_worked",
  r.what_worked.length === 1 && r.what_worked[0] === "ok", JSON.stringify(r.what_worked));

console.log("\n--- the payload sent to the model ---");
const rows = [
  { q1_nps: 9, q2_overall_stars: 5, q3_food_stars: 4, q4_service_stars: 5, q5_comment: "Great day.", submitted_at: "x" },
  { q1_nps: 3, q2_overall_stars: 2, q3_food_stars: null, q4_service_stars: null, q5_comment: null, submitted_at: "x" },
  { q1_nps: 10, q2_overall_stars: 5, submitted_at: null },
];
const payload = toPayload(rows);
check("unsubmitted responses are excluded", payload.length === 2);
check("comments are carried", payload[0].comment === "Great day.");
check("missing ratings become null, not absent", payload[1].rating_3 === null);

console.log("\n--- the prompt is written for one occasion, not a trend ---");
const prompt = userPrompt({
  event: { name: "Club Championship", event_date: "2026-08-08", category: "golf" },
  scores: { responses: 2, nps: 0, promoters: 1, passives: 0, detractors: 1, csat: 3.5 },
  responses: payload,
});
check("names the event and date", /Club Championship/.test(prompt) && /2026-08-08/.test(prompt));
check("says golf event for a golf event", /golf event/.test(prompt));
check("forbids trend language", /Never describe anything as rising, falling/.test(prompt));
check("carries the scores", /NPS 0/.test(prompt) && /CSAT 3\.5/.test(prompt));

const general = userPrompt({
  event: { name: "Wine Dinner", event_date: "2026-08-01", category: "general" },
  scores: { responses: 1, nps: null, promoters: 0, passives: 0, detractors: 0, csat: null },
  responses: payload,
});
check("a general event is not called a golf event", !/golf event/.test(general));
check("absent scores read as n/a, not null", /NPS n\/a/.test(general), general.match(/NPS.*/)?.[0]);

console.log("\n--- generate() ---");
(async () => {
  let sent = null;
  const fakeFetch = async (url, opts) => {
    sent = { url, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ content: [{ text: GOOD }] }) };
  };
  const out = await generate({
    event: { name: "Club Championship", event_date: "2026-08-08", category: "golf" },
    scores: { responses: 2, nps: 0, promoters: 1, passives: 0, detractors: 1, csat: 3.5 },
    rows, fetchImpl: fakeFetch,
  });
  check("returns the parsed analysis", out.urgency === "watch");
  check("calls the messages endpoint", /api\.anthropic\.com\/v1\/messages/.test(sent.url));
  check("only submitted responses are sent", JSON.stringify(sent.body).includes("Great day"));

  const noRows = await generate({ event: { name: "x", event_date: "y" }, scores: { responses: 0 }, rows: [], fetchImpl: fakeFetch });
  check("no responses means no model call and a plain explanation",
    noRows.urgency === "maintain" && /Nobody has answered/.test(noRows.headline), noRows.headline);

  const failing = async () => ({ ok: false, status: 429, text: async () => "rate limited" });
  let threw = null;
  try {
    await generate({ event: { name: "x", event_date: "y" }, scores: { responses: 1 }, rows, fetchImpl: failing });
  } catch (e) { threw = e; }
  check("an API failure throws with the status", threw && /429/.test(threw.message), threw?.message);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
