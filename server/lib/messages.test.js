const { resolveSurveyForVisit, smsBody, emailSubject } = require("./messages.js");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const FNB    = { template_id: "t-fnb",    survey_type: "food_bev" };
const GOLF   = { template_id: "t-golf",   survey_type: "golf" };
const TENNIS = { template_id: "t-tennis", survey_type: "food_bev" };  // racquets questions
const byId   = { "t-fnb": FNB, "t-golf": GOLF, "t-tennis": TENNIS };
const byType = { food_bev: FNB, golf: GOLF };

const resolve = (visit) => resolveSurveyForVisit({ visit, templatesById: byId, templatesByType: byType });

// --- no override: the visit's type decides
eq("dining visit, no outlet override",
  resolve({ visitor_type: "member", outlets: { name: "Belmont Bar" } }),
  { template_id: "t-fnb", survey_type: "food_bev", source: "type-default" });

eq("golf visit, no outlet override",
  resolve({ visitor_type: "golf", outlets: { name: "Golf Patio" } }),
  { template_id: "t-golf", survey_type: "golf", source: "type-default" });

// --- the point of the feature: an outlet asks its own questions
eq("racquets centre nominates its own template",
  resolve({ visitor_type: "member", outlets: { name: "Racquets Center F&B", template_id: "t-tennis" } }),
  { template_id: "t-tennis", survey_type: "food_bev", source: "outlet" });

// --- an outlet override beats the visit type, and the wording follows it
eq("outlet override wins over the visit type",
  resolve({ visitor_type: "member", outlets: { name: "Pro Shop", template_id: "t-golf" } }),
  { template_id: "t-golf", survey_type: "golf", source: "outlet" });

eq("wording follows the resolved template, not the visit",
  smsBody({ surveyType: resolve({ visitor_type: "member", outlets: { template_id: "t-golf" } }).survey_type, link: "L" }),
  smsBody({ surveyType: "golf", link: "L" }));

// --- robustness: bad or missing data must not stop a send
eq("override points at a template that no longer exists",
  resolve({ visitor_type: "member", outlets: { template_id: "t-deleted" } }),
  { template_id: "t-fnb", survey_type: "food_bev", source: "type-default" });

eq("outlet missing entirely",
  resolve({ visitor_type: "member" }),
  { template_id: "t-fnb", survey_type: "food_bev", source: "type-default" });

eq("no templates configured at all",
  resolveSurveyForVisit({ visit: { visitor_type: "member" }, templatesById: {}, templatesByType: {} }),
  { template_id: null, survey_type: "food_bev", source: "none" });

eq("empty override is treated as no override",
  resolve({ visitor_type: "golf", outlets: { template_id: "" } }),
  { template_id: "t-golf", survey_type: "golf", source: "type-default" });

// --- wording per type, now personalised -----------------------------------
// A hyphen, not an em dash. An em dash is outside GSM-7, which re-encodes the
// whole message as UCS-2 and charges three segments where one would do.
eq("golf sms, greeted by name",
  smsBody({ surveyType: "golf", link: "L", clubName: "C", firstName: "Pat" }),
  "C: Pat, how was your round today? Quick feedback, under a minute: L");
eq("golf sms with no name falls back",
  smsBody({ surveyType: "golf", link: "L", clubName: "C" }),
  "C: How was your round today? Quick feedback, under a minute: L");
eq("dining sms names the member and the outlet",
  smsBody({ surveyType: "food_bev", link: "L", clubName: "C", firstName: "Pat", outlet: "Grill Room" }),
  "C: Pat, how was the Grill Room today? Quick feedback, under a minute: L");
eq("an outlet already starting with 'The' is not doubled",
  smsBody({ surveyType: "food_bev", link: "L", clubName: "C", firstName: "Pat", outlet: "The Grill" }),
  "C: Pat, how was The Grill today? Quick feedback, under a minute: L");
eq("event sms names the event",
  smsBody({ surveyType: "events", link: "L", clubName: "C", firstName: "Pat", eventName: "the Member-Guest" }),
  "C: Pat, how was the Member-Guest? Quick feedback, under a minute: L");

eq("golf email subject", emailSubject({ surveyType: "golf", firstName: "Pat" }), "Pat, how was your round?");
eq("dining email subject names the outlet",
  emailSubject({ surveyType: "food_bev", firstName: "Pat", outlet: "Grill Room" }),
  "Pat, how was the Grill Room?");
eq("email subject with nothing known", emailSubject({ surveyType: "food_bev" }), "How was your visit today?");

// --- a name we do not really have -----------------------------------------
// "Hi ," reads worse than no greeting, and a placeholder is not a name.
for (const notAName of ["", "   ", "Guest", "guest", "MEMBER", "n/a", "Unknown"]) {
  const body = smsBody({ surveyType: "food_bev", link: "L", clubName: "C", firstName: notAName, outlet: "Grill Room" });
  eq(`"${notAName}" is not treated as a name`, body,
     "C: How was the Grill Room today? Quick feedback, under a minute: L");
}
eq("an absurdly long 'first name' is ignored",
  smsBody({ surveyType: "food_bev", link: "L", clubName: "C", firstName: "Pat Doe, Member 40182, Belmont", outlet: "Grill Room" }),
  "C: How was the Grill Room today? Quick feedback, under a minute: L");

// --- personalisation must not quietly cost a segment -----------------------
// The rule: the name is always worth it, the outlet has to be free. An SMS is
// billed per 160-character segment, so an outlet name long enough to spill
// into a second one is dropped rather than charged for on every send.
{
  const { meter } = require("./sms-billing");
  const CLUB = "Aronimink Golf Club";
  const LINK = "https://clubvero.io/s/0f8c2a41-7b6e-4c19-9a3d-1e5b7c2d4f60";
  const seg = (args) => meter(smsBody({ surveyType: "food_bev", link: LINK, clubName: CLUB, ...args })).segments;
  const plain = seg({});

  eq("a normal name and outlet cost no more than no personalisation at all",
     seg({ firstName: "Pat", outlet: "Belmont Dining Room" }) <= plain, true);
  eq("a long name and a long outlet still cost no more",
     seg({ firstName: "Alexandra", outlet: "The Belmont Poolside Terrace" }) <= plain, true);
  eq("...and the one that got dropped was the outlet, not the name",
     smsBody({ surveyType: "food_bev", link: LINK, clubName: CLUB, firstName: "Alexandra", outlet: "The Belmont Poolside Terrace" }).includes("Alexandra,"),
     true);

  // A name outside GSM-7 re-encodes the message as UCS-2 — 70 characters a
  // segment — and there is no wording that avoids it. The name is kept: the
  // segments are spent either way, and dropping it would save nothing while
  // making these members the only ones getting an impersonal message.
  const accented = smsBody({ surveyType: "food_bev", link: LINK, clubName: CLUB, firstName: "María", outlet: "Belmont Dining Room" });
  eq("an accented name is still greeted", accented.includes("María,"), true);
  eq("and the outlet rides along, since the segments are already spent",
     accented.includes("Belmont Dining Room"), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
