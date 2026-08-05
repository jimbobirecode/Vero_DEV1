// AI analysis of one event.
//
// Deliberately not the weekly outlet prompt. That one reads seven days of a
// continuing operation and asks what is trending; an event happened once, on a
// date, and the useful question is "how did that evening go and what would we
// change next time". Trend language has nothing to attach to, so the prompt
// forbids it.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You analyse guest feedback from a single private club event.
Always respond in valid JSON only — no preamble, no markdown.`;

function userPrompt({ event, scores, responses }) {
  const kind = event.category === "golf" ? "golf event" : "event";
  return `A ${kind} at a private members' club: "${event.name}", held on ${event.event_date}.

Scores across ${scores.responses} response${scores.responses === 1 ? "" : "s"}:
- NPS ${scores.nps ?? "n/a"} (${scores.promoters} promoters, ${scores.passives} passives, ${scores.detractors} detractors)
- CSAT ${scores.csat ?? "n/a"} out of 5

Each response below has the ratings given and any comment written:

${JSON.stringify(responses, null, 2)}

Return a JSON object with exactly this shape:
{
  "urgency": "critical" | "watch" | "maintain",
  "headline": "one sentence on how this event actually went, specific to what attendees said",
  "themes": [
    { "keyword": string, "sentiment": "positive" | "negative" | "neutral",
      "count": number, "example_quote": string }
  ],
  "what_worked": [string]
}

Rules:
- This was a one-off occasion, not an ongoing operation. Never describe anything as rising, falling, improving or declining — you have a single event to go on and no trend to read.
- Every theme and every entry in what_worked must trace to something an attendee actually wrote or rated. Never offer generic hospitality advice.
- count is how many responses raised that theme.
- example_quote must be verbatim from a comment, or an empty string if the theme comes from ratings alone.
- "critical" only where a comment describes something that must not happen again — a safety, hygiene or serious service failure. A merely disappointing score is "watch".
- With fewer than 3 comments, set urgency to "maintain", say plainly in the headline that the sample is too small for a reliable read, and return empty arrays.`;
}

// rows: submitted survey_responses for the event.
function toPayload(rows = []) {
  return rows
    .filter((r) => r && r.submitted_at)
    .map((r) => ({
      nps: r.q1_nps ?? null,
      overall: r.q2_overall_stars ?? null,
      rating_3: r.q3_food_stars ?? null,
      rating_4: r.q4_service_stars ?? null,
      comment: r.q5_comment ?? null,
    }));
}

function emptyResult(reason) {
  return { urgency: "maintain", headline: reason, themes: [], what_worked: [] };
}

async function generate({ event, scores, rows, fetchImpl = fetch }) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured on the server");
  }

  const responses = toPayload(rows);
  if (!responses.length) {
    return emptyResult("Nobody has answered this event's survey yet, so there is nothing to analyse.");
  }

  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt({ event, scores, responses }) }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Anthropic API returned ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text ?? "";
  return parseResult(text);
}

// The model is told to return bare JSON, but a fenced block is the usual way
// that instruction gets bent. Failing to parse must not lose the run.
function parseResult(text) {
  const cleaned = String(text).replace(/```json|```/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return emptyResult("The analysis could not be read back. Try generating it again.");
  }

  const urgency = ["critical", "watch", "maintain"].includes(parsed.urgency) ? parsed.urgency : "maintain";
  return {
    urgency,
    headline: typeof parsed.headline === "string" ? parsed.headline : "",
    themes: Array.isArray(parsed.themes) ? parsed.themes.slice(0, 8) : [],
    what_worked: Array.isArray(parsed.what_worked)
      ? parsed.what_worked.filter((s) => typeof s === "string").slice(0, 6)
      : [],
  };
}

module.exports = { generate, parseResult, toPayload, userPrompt };
