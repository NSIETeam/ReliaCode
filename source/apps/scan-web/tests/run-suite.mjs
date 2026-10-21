import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";

const root=new URL("..",import.meta.url);

function run(args,env=process.env){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{cwd:root,env,stdio:"inherit"});
    child.once("error",reject);
    child.once("exit",(code,signal)=>code===0?resolve():reject(new Error(`${args.join(" ")} failed with ${signal||code}`)));
  });
}

async function freePort(){
  const probe=createServer();
  probe.listen(0,"127.0.0.1");
  await once(probe,"listening");
  const port=probe.address().port;
  await new Promise((resolve,reject)=>probe.close(error=>error?reject(error):resolve()));
  return port;
}

await run(["--test","tests/persistence.test.mjs"]);
await run(["--test","tests/proxy-security.test.mjs"]);
await run(["--test","tests/monochrome-contract.test.mjs"]);

const port=await freePort(),baseUrl=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,["server.mjs"],{cwd:root,env:{...process.env,HOST:"127.0.0.1",PORT:String(port)},stdio:["ignore","inherit","inherit"]});
let stopped=false;
const stop=()=>{if(!stopped){stopped=true;server.kill("SIGTERM");}};
process.once("SIGINT",()=>{stop();process.exitCode=130;});
process.once("SIGTERM",()=>{stop();process.exitCode=143;});
try{
  for(let attempt=0;attempt<50;attempt+=1){
    if(server.exitCode!==null)throw new Error(`Web test server exited with ${server.exitCode}`);
    try{const response=await fetch(`${baseUrl}/health/live`);if(response.ok)break;}catch{}
    if(attempt===49)throw new Error("Web test server did not become healthy");
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  const env={...process.env,RELIACODE_TEST_BASE_URL:baseUrl};
  for(const script of ["e2e.mjs","mobile-and-edge.mjs","monochrome.e2e.mjs","server-auth-monochrome.e2e.mjs","agent.mjs","domain-api.e2e.mjs","document-console.e2e.mjs","governance-console.e2e.mjs","reward-console.e2e.mjs"])await run([`tests/${script}`],env);
}finally{
  stop();
  if(server.exitCode===null)await once(server,"exit");
}
