process.env.SUPABASE_URL="https://p";process.env.SUPABASE_SERVICE_ROLE_KEY="s";
const Module=require("module");
const rr=Module._resolveFilename;
Module._resolveFilename=function(r,...x){if(r.endsWith("lib/supabase")||r==="./supabase")return "SB";return rr.call(this,r,...x);};
require.cache["SB"]={id:"SB",filename:"SB",loaded:true,exports:{supabase:{from:()=>({select:()=>({then:r=>r({data:[],error:null})}),upsert:async()=>({})})}}};
const {shouldSend}=require("./scheduler.js");

let pass=0,fail=0;
const t=(label,args,wantSend)=>{
  const r=shouldSend(args);
  const ok=r.send===wantSend;
  console.log(`${ok?"PASS":"FAIL"}  ${label.padEnd(52)} -> ${r.send?"SEND":"hold"}  (${r.reason})`);
  ok?pass++:fail++;
};
const D="2026-07-31";
const at=(h,m)=>({date:D,hour:h,minute:m});

console.log("--- configured 09:30, nothing sent today ---");
t("08:00 — before the time",            {now:at(8,0),  sendTime:"09:30", lastSentDate:null}, false);
t("09:29 — one minute before",          {now:at(9,29), sendTime:"09:30", lastSentDate:null}, false);
t("09:30 — exactly the time",           {now:at(9,30), sendTime:"09:30", lastSentDate:null}, true);
t("09:31 — just after",                 {now:at(9,31), sendTime:"09:30", lastSentDate:null}, true);
t("14:00 — hours late (missed tick)",   {now:at(14,0), sendTime:"09:30", lastSentDate:null}, true);

console.log("\n--- once-per-day guard ---");
t("09:30 but already sent today",       {now:at(9,30), sendTime:"09:30", lastSentDate:D},    false);
t("15:00 already sent today",           {now:at(15,0), sendTime:"09:30", lastSentDate:D},    false);
t("09:30 next day (stamp is stale)",    {now:at(9,30), sendTime:"09:30", lastSentDate:"2026-07-30"}, true);

console.log("\n--- blackout is absolute ---");
t("07:59 — before 8am",                 {now:at(7,59), sendTime:"07:00", lastSentDate:null}, false);
t("20:00 — 8pm",                        {now:at(20,0), sendTime:"19:30", lastSentDate:null}, false);
t("23:30 — late night",                 {now:at(23,30),sendTime:"09:30", lastSentDate:null}, false);
t("02:00 — overnight",                  {now:at(2,0),  sendTime:"09:30", lastSentDate:null}, false);

console.log("\n--- the customer changes the time in the UI ---");
t("11:00, time changed to 14:00 -> hold",{now:at(11,0),sendTime:"14:00", lastSentDate:null}, false);
t("14:00, time changed to 14:00 -> send",{now:at(14,0),sendTime:"14:00", lastSentDate:null}, true);
t("11:00, time changed to 08:00 -> send",{now:at(11,0),sendTime:"08:00", lastSentDate:null}, true);

console.log("\n--- bad data ---");
t("no send time set (defaults 09:30)",  {now:at(10,0), sendTime:undefined, lastSentDate:null}, true);
t("garbage send time",                  {now:at(10,0), sendTime:"not-a-time", lastSentDate:null}, false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
