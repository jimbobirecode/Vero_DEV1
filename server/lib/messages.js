// The exact wording members receive.
//
// Kept here so the sender and the Survey Builder preview cannot drift apart —
// a preview that quotes different text from the one that actually goes out is
// worse than no preview at all.

const { CLUB_NAME } = require("./club-config");

// Default survey type for a visit. Events have their own send path; anything
// that is not golf falls back to food & beverage.
function surveyTypeForVisit(visit) {
  if (visit?.visitor_type === "golf") return "golf";
  return "food_bev";
}

// Which template a visit actually gets, and therefore which wording.
//
// An outlet may nominate its own template — a racquets centre or a lesson
// should not be asked about food quality. Where it does not, the visit falls
// back to the default template for its type.
//
// The survey type comes from the resolved template rather than the visit, so
// the message a member receives always matches the questions they are about
// to be asked.
function resolveSurveyForVisit({ visit, templatesById = {}, templatesByType = {} }) {
  const outletTemplateId = visit?.outlets?.template_id || null;
  const chosen = (outletTemplateId && templatesById[outletTemplateId]) || null;

  if (chosen) {
    return {
      template_id: chosen.template_id,
      survey_type: chosen.survey_type || surveyTypeForVisit(visit),
      source: "outlet",
    };
  }

  const fallbackType = surveyTypeForVisit(visit);
  const byType = templatesByType[fallbackType] || null;
  return {
    template_id: byType ? byType.template_id : null,
    survey_type: fallbackType,
    source: byType ? "type-default" : "none",
  };
}

// A member's own name, trimmed to the part we would actually greet them by.
// A blank, a placeholder, or something that is plainly not a name is treated
// as not knowing it — "Hi ," reads worse than no greeting at all.
function greetingName(firstName) {
  const name = String(firstName || "").trim();
  if (!name) return "";
  if (name.length > 20) return "";                       // a pasted full record, not a first name
  if (/^(guest|member|unknown|n\/?a|test)$/i.test(name)) return "";
  return name;
}

// The outlet as it should read mid-sentence. Clubs name outlets inconsistently
// — "The Grill", "Grill Room", "BELMONT DINING ROOM" — and "how was the The
// Grill today?" is the kind of small wrongness that makes a message feel
// automated.
function outletPhrase(outlet) {
  const name = String(outlet || "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 40) return "";
  // Already starts with an article: use it as written.
  if (/^the\s/i.test(name)) return name;
  return `the ${name}`;
}

// ---------------------------------------------------------------------------
// The SMS
// ---------------------------------------------------------------------------
// Personalising a text costs money, which is not obvious until the bill.
// An SMS is billed per 160-character segment, and a single character outside
// the GSM-7 alphabet re-encodes the whole message as UCS-2 — 70 characters a
// segment. So a member called María or Zoë would take a one-segment survey to
// three, purely for being greeted by name.
//
// The rule here: the name is always worth it, the outlet has to be free.
//
// The name is what the member actually notices, it is short, and the members
// whose names carry an accent are exactly the ones who would notice being the
// only people getting an impersonal message. The outlet is a nicety, so it is
// included only when it costs nothing — with a long name or a long outlet it
// is dropped rather than buying a second segment for every send.
//
// The wording was tightened at the same time ("Quick feedback, under a
// minute" rather than "We'd love your quick feedback... Takes under a
// minute"), which buys back more characters than the greeting spends. On a
// short link domain the personalised message is shorter than the impersonal
// one it replaces.
function smsBody({ surveyType, link, clubName = CLUB_NAME, firstName = "", outlet = "", eventName = "" }) {
  const name = greetingName(firstName);
  const where = outletPhrase(outlet);
  const event = String(eventName || "").trim();
  const tail = `Quick feedback, under a minute: ${link}`;

  // Richest first. `named` marks the ones that greet the member, so the budget
  // below can be worked out from the actual name-only wording rather than by
  // matching on the text — the richest message contains the name too, so a
  // text match picks it and the budget silently becomes "whatever the richest
  // costs", which is no budget at all.
  let candidates;
  if (surveyType === "golf") {
    candidates = [
      { named: true,  text: name && `${clubName}: ${name}, how was your round today? ${tail}` },
      { named: false, text: `${clubName}: How was your round today? ${tail}` },
    ];
  } else if (surveyType === "events") {
    candidates = [
      { named: true,  text: name && event && `${clubName}: ${name}, how was ${event}? ${tail}` },
      { named: true,  text: name && `${clubName}: ${name}, how was the event? ${tail}` },
      { named: false, text: event && `${clubName}: How was ${event}? ${tail}` },
      { named: false, text: `${clubName}: How was the event? ${tail}` },
    ];
  } else {
    candidates = [
      { named: true,  text: name && where && `${clubName}: ${name}, how was ${where} today? ${tail}` },
      { named: true,  text: name && `${clubName}: ${name}, how was your visit today? ${tail}` },
      { named: false, text: where && `${clubName}: How was ${where} today? ${tail}` },
      { named: false, text: `${clubName}: How was your visit today? ${tail}` },
    ];
  }
  candidates = candidates.filter((c) => c.text);

  // Required lazily: lib/sms-billing pulls in the rate card, and the wording
  // must stay usable — by the Builder preview and by the tests — on a machine
  // with no database configured.
  let meter;
  try { ({ meter } = require("./sms-billing")); } catch { return candidates[0].text; }

  const cost = (c) => meter(c.text).segments;

  // The budget: whatever the plainest message costs, and never less than the
  // cheapest message that still greets them by name. That second clause is
  // what keeps the name when an accent has already forced UCS-2 — by then the
  // segments are spent and dropping the name would save nothing.
  const plainest = candidates[candidates.length - 1];
  const named = candidates.filter((c) => c.named);
  const cheapestNamed = named.length
    ? named.reduce((a, b) => (cost(b) < cost(a) ? b : a))
    : plainest;
  const budget = Math.max(cost(plainest), cost(cheapestNamed));

  return (candidates.find((c) => cost(c) <= budget) || candidates[0]).text;
}

// ---------------------------------------------------------------------------
// The email
// ---------------------------------------------------------------------------
// No segments, so nothing is dropped for cost — the email says everything the
// SMS wishes it had room for.
function emailSubject({ surveyType, firstName = "", outlet = "", eventName = "" }) {
  const name = greetingName(firstName);
  const where = outletPhrase(outlet);
  const event = String(eventName || "").trim();

  if (surveyType === "golf") {
    return name ? `${name}, how was your round?` : "How was your round?";
  }
  if (surveyType === "events") {
    const what = event || "the event";
    return name ? `${name}, how was ${what}?` : `How was ${what}?`;
  }
  if (where) return name ? `${name}, how was ${where}?` : `How was ${where}?`;
  return name ? `${name}, how was your visit?` : "How was your visit today?";
}

// The plain-text email, used when no SendGrid dynamic template is configured.
//
// This used to be the SMS text verbatim, which read like a text message that
// had wandered into an inbox — no greeting, no sign-off, and the club's name
// jammed on the front with a colon because that is how an SMS has to identify
// itself. An email has room to be a short note from the club instead.
function emailBody({ surveyType, link, clubName = CLUB_NAME, firstName = "", outlet = "", eventName = "", visitDate = "" }) {
  const name = greetingName(firstName);
  const where = outletPhrase(outlet);
  const event = String(eventName || "").trim();

  const when = (() => {
    if (!visitDate) return "";
    const d = new Date(visitDate);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  })();

  let opening;
  if (surveyType === "golf") {
    opening = when ? `Thank you for playing with us on ${when}.` : "Thank you for playing with us.";
  } else if (surveyType === "events") {
    opening = event ? `Thank you for joining us at ${event}.` : "Thank you for joining us.";
  } else if (where) {
    opening = when ? `Thank you for visiting ${where} on ${when}.` : `Thank you for visiting ${where}.`;
  } else {
    opening = when ? `Thank you for visiting us on ${when}.` : "Thank you for visiting us.";
  }

  const ask = surveyType === "golf"
    ? "How was your round? It takes under a minute to tell us, and it goes straight to the team."
    : "How was it? It takes under a minute to tell us, and it goes straight to the team.";

  return [
    name ? `Hello ${name},` : "Hello,",
    "",
    opening,
    "",
    ask,
    "",
    link,
    "",
    `Thank you,`,
    clubName,
  ].join("\n");
}

// A stand-in link for previews, so the sample reads at a realistic length —
// SMS length matters and the token is a material part of it.
function sampleLink(baseUrl) {
  const base = (baseUrl || "https://your-club.vero.app").replace(/\/+$/, "");
  return `${base}/s/0f8c2a41-7b6e-4c19-9a3d-1e5b7c2d4f60`;
}

// --- Staff workday survey -------------------------------------------------
// Deliberately plainer than the member wording: this goes to a colleague at
// the end of a shift, not to a guest. It names the day so someone finishing a
// late service is in no doubt which shift they are being asked about.
function staffSmsBody({ link, firstName = "", clubName = CLUB_NAME }) {
  const greeting = firstName ? `${firstName}, h` : "H";
  return `${clubName}: ${greeting}ow did your shift go today? Two minutes, and it goes to the management team: ${link}`;
}

function staffEmailSubject() {
  return "How did your shift go today?";
}

function staffSampleLink(baseUrl) {
  const base = (baseUrl || "https://your-club.vero.app").replace(/\/+$/, "");
  return `${base}/ss/0f8c2a41-7b6e-4c19-9a3d-1e5b7c2d4f60`;
}

module.exports = {
  smsBody, emailSubject, emailBody, surveyTypeForVisit, resolveSurveyForVisit, sampleLink, CLUB_NAME,
  staffSmsBody, staffEmailSubject, staffSampleLink,
  greetingName, outletPhrase,
};
