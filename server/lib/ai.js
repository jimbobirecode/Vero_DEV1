const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

async function callClaude(prompt, maxTokens = 300) {
  if (!ANTHROPIC_API_KEY) return null;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    console.error("[ai] API error:", res.status, await res.text().catch(() => ""));
    return null;
  }

  const data = await res.json();
  return data.content?.[0]?.text ?? null;
}

async function tagComment(comment, scores) {
  if (!comment || comment.trim().length < 5) return null;

  const prompt = `Analyze this private club guest survey comment. Return ONLY valid JSON, no markdown.

Comment: "${comment}"
Scores: NPS ${scores.nps}/10, Overall ${scores.overall}/5, Food ${scores.food}/5, Service ${scores.service}/5

Return:
{
  "tags": ["tag1", "tag2"],
  "sentiment": "positive" | "negative" | "mixed" | "neutral",
  "safety_concern": true | false
}

Tags should be 1-3 short labels from: food quality, food temperature, service speed, staff praise, staff complaint, ambiance, cleanliness, hygiene concern, menu/drinks, value, wait time, noise, facilities, kitchen issue, management, reservation, parking, event, other.
Only include tags that are clearly present in the comment.`;

  const text = await callClaude(prompt, 200);
  if (!text) return null;
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return null;
  }
}

async function generateAlertSummary(comment, scores, outletName, memberName) {
  const prompt = `Write a single concise sentence summarizing this guest complaint for a club manager's alert notification. Be specific about the issue. No quotes, no filler.

Guest: ${memberName || "Guest"}
Outlet: ${outletName || "Unknown"}
NPS: ${scores.nps}/10, Overall: ${scores.overall}/5, Food: ${scores.food}/5, Service: ${scores.service}/5
Comment: "${comment || "No comment provided"}"`;

  return await callClaude(prompt, 100);
}

async function generateFollowUp(alert) {
  const resp = alert.survey_responses;
  const member = resp?.visits?.members;
  const memberName = member ? `${member.first_name} ${member.last_name}` : "the guest";
  const outlet = alert.outlets?.name || "the outlet";

  const prompt = `You are advising a private club General Manager on how to follow up on a negative guest experience. Be specific, professional, and actionable.

Guest: ${memberName}
Outlet: ${outlet}
Severity: ${alert.severity}
NPS: ${resp?.q1_nps}/10, Overall: ${resp?.q2_overall_stars}/5, Food: ${resp?.q3_food_stars}/5, Service: ${resp?.q4_service_stars}/5
Comment: "${resp?.q5_comment || "No comment"}"

Provide ONLY valid JSON:
{
  "suggested_action": "2-3 sentence action plan for the manager",
  "member_message": "A short, warm message the manager could send or say to the guest to recover the relationship (2-3 sentences max)"
}`;

  const text = await callClaude(prompt, 400);
  if (!text) return null;
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return null;
  }
}

module.exports = { tagComment, generateAlertSummary, generateFollowUp };
