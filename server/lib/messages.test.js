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

// --- wording per type
eq("golf sms wording",  smsBody({ surveyType: "golf",   link: "L", clubName: "C" }), "C: How was your round? We'd love your quick feedback — takes under a minute: L");
eq("golf email subject", emailSubject({ surveyType: "golf" }), "How was your round?");
eq("dining email subject", emailSubject({ surveyType: "food_bev" }), "How was your visit today?");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
