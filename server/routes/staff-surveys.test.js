// Covers who a shift survey actually reaches. The failure this guards against
// is silent: a POS export spelling a name differently from the servers row
// means that person is credited for their sales and never surveyed, with
// nothing anywhere saying so.
process.env.SUPABASE_URL="https://p";process.env.SUPABASE_SERVICE_ROLE_KEY="s";

let VISITS = [], SERVERS = [];
const Module=require("module");
const rr=Module._resolveFilename;
Module._resolveFilename=function(r,...x){if(r.endsWith("lib/supabase")||r==="../lib/supabase")return "SB";return rr.call(this,r,...x);};
function from(table){
  const api={
    select:()=>api, eq:()=>api, gte:()=>api, not:()=>api, in:()=>api, order:()=>api, limit:()=>api,
    then:(resolve)=>resolve({data: table==="visits"?VISITS:SERVERS, error:null}),
  };
  return api;
}
require.cache["SB"]={id:"SB",filename:"SB",loaded:true,exports:{supabase:{from}}};

const { serversWhoWorked } = require("./staff-surveys.js");

let pass=0,fail=0;
const check=(label,got,want)=>{
  const ok=JSON.stringify(got)===JSON.stringify(want);
  console.log(`${ok?"PASS":"FAIL"}  ${label.padEnd(56)} -> ${JSON.stringify(got)}`);
  if(!ok) console.log(`      wanted ${JSON.stringify(want)}`);
  ok?pass++:fail++;
};
const names = (list) => list.map(s=>s.name).sort();

const JESS={server_id:"s1",name:"Jessica",phone:"+1610",email:null};
const MARCUS={server_id:"s2",name:"Marcus Reed",phone:null,email:"m@club.com"};

(async () => {
  console.log("--- matching by server_id ---");
  SERVERS=[JESS,MARCUS];
  VISITS=[{server_id:"s1",server_name:null}];
  check("direct server_id link", names(await serversWhoWorked("2026-08-01")), ["Jessica"]);

  console.log("\n--- matching by name when server_id is absent ---");
  VISITS=[{server_id:null,server_name:"Jessica"}];
  check("exact name", names(await serversWhoWorked("2026-08-01")), ["Jessica"]);

  VISITS=[{server_id:null,server_name:"jessica"}];
  check("POS lowercased the name", names(await serversWhoWorked("2026-08-01")), ["Jessica"]);

  VISITS=[{server_id:null,server_name:"  JESSICA  "}];
  check("padded and uppercased", names(await serversWhoWorked("2026-08-01")), ["Jessica"]);

  VISITS=[{server_id:null,server_name:"Marcus   Reed"}];
  check("collapsed inner whitespace", names(await serversWhoWorked("2026-08-01")), ["Marcus Reed"]);

  console.log("\n--- people who must NOT be surveyed ---");
  VISITS=[{server_id:null,server_name:"Nobody Here"}];
  check("name with no server record", names(await serversWhoWorked("2026-08-01")), []);

  VISITS=[{server_id:null,server_name:null}];
  check("visit with no server at all", names(await serversWhoWorked("2026-08-01")), []);

  VISITS=[{server_id:"gone",server_name:null}];
  check("server_id of an inactive server", names(await serversWhoWorked("2026-08-01")), []);

  console.log("\n--- one survey per person ---");
  VISITS=[
    {server_id:"s1",server_name:null},
    {server_id:null,server_name:"jessica"},
    {server_id:"s1",server_name:"Jessica"},
  ];
  check("several visits, asked once", names(await serversWhoWorked("2026-08-01")), ["Jessica"]);

  VISITS=[{server_id:"s1",server_name:null},{server_id:null,server_name:"Marcus Reed"}];
  check("two people both found", names(await serversWhoWorked("2026-08-01")), ["Jessica","Marcus Reed"]);

  console.log("\n--- no visits ---");
  VISITS=[];
  check("nobody worked", names(await serversWhoWorked("2026-08-01")), []);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
