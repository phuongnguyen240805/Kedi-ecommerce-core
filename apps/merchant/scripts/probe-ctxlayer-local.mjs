import { unstable_dev } from 'wrangler';
import { mkdtempSync,mkdirSync,writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const target=new URL(process.argv[2]||'https://localhost:8787');
if(!['localhost','127.0.0.1','[::1]'].includes(target.hostname)||target.username||target.password)
  throw Error('This probe accepts loopback URLs only');
target.pathname='/.well-known/oauth-protected-resource';target.search='';target.hash='';
const root=fileURLToPath(new URL('../.wrangler/',import.meta.url));mkdirSync(root,{recursive:true});
const folder=mkdtempSync(join(root,'ctxlayer-probe-')),entry=join(folder,'probe.mjs'),config=join(folder,'wrangler.json');
writeFileSync(entry,`export default {async fetch(_request,env){try{const response=await fetch(env.TARGET,{redirect:'manual',signal:AbortSignal.timeout(10000)});await response.body?.cancel();return Response.json({reachable:response.status===200,status:response.status});}catch{return Response.json({reachable:false,code:'local_gateway_network_or_tls'});}}}`);
writeFileSync(config,JSON.stringify({name:'ctxlayer-network-probe',main:entry,compatibility_date:'2025-12-01',vars:{TARGET:target.href}}));
let worker;
try{
 worker=await unstable_dev(entry,{config,local:true,persist:false,port:0,inspectorPort:0,logLevel:'error',experimental:{testMode:true,disableDevRegistry:true,watch:false,showInteractiveDevSession:false}});
 const result=await(await worker.fetch('/probe')).json();console.log(JSON.stringify(result));if(!result.reachable)process.exitCode=1;
}finally{await worker?.stop();}
