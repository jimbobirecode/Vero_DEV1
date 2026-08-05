process.env.SUPABASE_URL="https://p";process.env.SUPABASE_SERVICE_ROLE_KEY="s";
const Module=require("module");
const rr=Module._resolveFilename;
Module._resolveFilename=function(r,...x){if(r.endsWith("lib/supabase")||r==="./supabase")return "SB";return rr.call(this,r,...x);};
require.cache["SB"]={id:"SB",filename:"SB",loaded:true,exports:{supabase:{from:()=>({select:()=>({then:r=>r({data:[],error:null})}),upsert:async()=>({})})}}};
const {shouldSendStaffSurvey}=require("./scheduler.js");

let pass=0,fail=0;
const t=(label,args,wantSend)=>{
  const r=shouldSendStaffSurvey(args);
  const ok=r.send===wantSend;
  console.log(`${ok?"PASS":"FAIL"}  ${label.padEnd(54)} -> ${r.send?"SEND":"hold"}  (${r.reason})`);
  ok?pass++:fail++;
};
const D="2026-07-31";
const at=(h,m)=>({date:D,hour:h,minute:m});
const on={enabled:"true",sendTime:"20:30",lastSentDate:null};

console.log("--- opt-in gate ---");
t("enabled unset — never sends",         {now:at(20,30),...on,enabled:undefined},  false);
t("enabled 'false'",                     {now:at(20,30),...on,enabled:"false"},    false);
t("enabled true (boolean, not string)",  {now:at(20,30),...on,enabled:true},       true);
t("enabled 'true'",                      {now:at(20,30),...on},                    true);

console.log("\n--- configured 20:30, nothing sent today ---");
t("19:00 — before the time",             {now:at(19,0), ...on},  false);
t("20:29 — one minute before",           {now:at(20,29),...on},  false);
t("20:30 — exactly the time",            {now:at(20,30),...on},  true);
t("22:59 — late but still allowed",      {now:at(22,59),...on},  true);

console.log("\n--- staff quiet window 11pm-11am is absolute ---");
t("23:00 — quiet window starts",         {now:at(23,0), ...on},                    false);
t("02:00 — middle of the night",         {now:at(2,0),  ...on,sendTime:"01:00"},   false);
t("10:59 — still too early",             {now:at(10,59),...on,sendTime:"09:00"},   false);
t("11:00 — window ends, time passed",    {now:at(11,0), ...on,sendTime:"09:00"},   true);

console.log("\n--- once-per-day guard ---");
t("20:30 but already sent today",        {now:at(20,30),...on,lastSentDate:D},           false);
t("20:30 next day (stamp is stale)",     {now:at(20,30),...on,lastSentDate:"2026-07-30"},true);

console.log("\n--- malformed send time never sends ---");
t("garbage send time",                   {now:at(20,30),...on,sendTime:"half eight"},    false);
t("empty string falls back to 20:30",    {now:at(20,30),...on,sendTime:""},              true);
t("empty string, before fallback time",  {now:at(19,0), ...on,sendTime:""},              false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
