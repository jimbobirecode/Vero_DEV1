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

function smsBody({ surveyType, link, clubName = CLUB_NAME }) {
  if (surveyType === "golf") {
    return `${clubName}: How was your round? We'd love your quick feedback — takes under a minute: ${link}`;
  }
  if (surveyType === "events") {
    return `${clubName}: Thanks for joining us. How was the event? Takes under a minute: ${link}`;
  }
  return `${clubName}: We'd love your quick feedback on today's visit. Takes under a minute: ${link}`;
}

function emailSubject({ surveyType }) {
  if (surveyType === "golf") return "How was your round?";
  if (surveyType === "events") return "How was the event?";
  return "How was your visit today?";
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
  smsBody, emailSubject, surveyTypeForVisit, resolveSurveyForVisit, sampleLink, CLUB_NAME,
  staffSmsBody, staffEmailSubject, staffSampleLink,
};
