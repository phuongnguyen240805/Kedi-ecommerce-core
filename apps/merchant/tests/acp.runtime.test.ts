import {marketingToken} from '../src/lib/marketing-tokens';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {unstable_dev} from 'wrangler';
test('ACP handoff uses schema-pinned requests, dedicated auth and one-use browser claim',{timeout:90000},async()=>{
 const root=fileURLToPath(new URL('../.wrangler/',import.meta.url));mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'ucp-http-'));
 const source=fileURLToPath(new URL('../src/index.ts',import.meta.url)).replaceAll('\\','/'),main=join(dir,'worker.ts'),config=join(dir,'wrangler.json');
 writeFileSync(main,`
 import original,{MerchantDO} from ${JSON.stringify(source)};export {MerchantDO};
 export default {async fetch(req,env,ctx){const path=new URL(req.url).pathname;if(!path.startsWith('/__test/'))return original.fetch(req,env,ctx);const db=env.MERCHANT.getByName('default');
 if(path==='/__test/sql'){await db.marketingInit();const {query,params}=await req.json();return Response.json(await db.run(query,params));}
 await db.run("INSERT INTO currencies(id,code,display_name,decimal_places) VALUES('usd','USD','Dollar',2)");
 await db.run("INSERT INTO products(id,title,status) VALUES('product','Shirt','active'),('draft','Hidden','draft')");
 await db.run("INSERT INTO variants(id,product_id,sku,title,price_cents,currency) VALUES('variant','product','SHIRT','Shirt',2500,'USD'),('hidden','draft','HIDDEN','Hidden',100,'USD')");
 await db.run("INSERT INTO variant_prices(id,variant_id,currency_id,price_cents) VALUES('price','variant','usd',2500),('hidden-price','hidden','usd',100)");
 await db.run("INSERT INTO inventory(id,sku,on_hand,reserved) VALUES('inventory','SHIRT',10,2),('hidden-i','HIDDEN',100,0)");
 await db.run("INSERT INTO tax_rates(id,display_name,rate_percentage) VALUES('tax','Test tax',10)");await db.run("UPDATE variants SET weight_g=500 WHERE sku='SHIRT'");return Response.json({seeded:true});
 }};`);
 writeFileSync(config,JSON.stringify({name:'ucp-http-test',main,compatibility_date:'2025-12-01',vars:{CHECKOUT_ENABLED:'true',CHECKOUT_BFF_TOKEN:'b'.repeat(40),ACP_ENABLED:'true',ACP_ACCESS_VERIFIED:'true',ACP_API_TOKEN:'a'.repeat(40),ORDER_TOKEN_SECRET:'s'.repeat(40),STORE_URL:'https://printerval.gofiber-phuongnguyen.workers.dev'},compatibility_flags:['nodejs_compat'],kv_namespaces:[{binding:'KV_CACHE',id:'0'.repeat(32)}],durable_objects:{bindings:[{name:'MERCHANT',class_name:'MerchantDO'}]},migrations:[{tag:'v1',new_sqlite_classes:['MerchantDO']}]}));
 let worker:Awaited<ReturnType<typeof unstable_dev>>|undefined;
 try{worker=await unstable_dev(main,{config,local:true,persist:false,port:0,inspectorPort:0,logLevel:'error',experimental:{disableExperimentalWarning:true}});
 const request=(path:string,body?:unknown,method='POST')=>worker!.fetch('http://localhost'+path,{method,redirect:'manual',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 assert.equal((await request('/__test/seed')).status,200);
 const sql=async(query:string,params:unknown[]=[])=>{assert.equal((await request('/__test/sql',{query,params})).status,200);};

 const acp=(path:string,body?:unknown,key='key-1',token='a'.repeat(40),version='2026-04-17')=>worker!.fetch('http://localhost/acp'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,'API-Version':version,'Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)})});
 assert.equal((await worker.fetch('http://localhost/v1/checkouts/readiness')).status,401);const ready=await worker.fetch('http://localhost/v1/checkouts/readiness',{headers:{Authorization:'Bearer '+'b'.repeat(40)}});assert.equal(ready.status,200);const diagnostics=await ready.json() as any;assert.equal(diagnostics.scope,'catalog_configuration_only');assert.equal(diagnostics.integrations.stripe_mode,'unknown');assert.ok(!JSON.stringify(diagnostics).includes('b'.repeat(40)));
 const catalog=async()=>await (await worker.fetch('http://localhost/v1/checkouts/catalog')).json() as any;assert.equal((await catalog()).items.length,1);await sql("INSERT INTO pod_mappings(sku,version,config) VALUES('SHIRT','fixture','{\"enabled\":true}')");assert.equal((await catalog()).items.length,0);await sql("DELETE FROM pod_mappings WHERE sku='SHIRT'");await sql("UPDATE inventory SET reserved=on_hand WHERE sku='SHIRT'");assert.equal((await catalog()).items.length,0);await sql("UPDATE inventory SET reserved=2 WHERE sku='SHIRT'");
 const search=async(body:unknown)=>worker!.fetch('http://localhost/v1/checkouts/search',{method:'POST',headers:{Authorization:'Bearer '+'b'.repeat(40),'Content-Type':'application/json'},body:JSON.stringify(body)});const found=await search({query:'Shirt',interpret:false,rate_key:'e'.repeat(64)});assert.equal(found.status,200);assert.equal(((await found.json()) as any).items[0].unit_price,2500);assert.equal((await search({query:'Shirt',interpret:true,rate_key:'e'.repeat(64)})).status,503);assert.equal((await worker.fetch('http://localhost/v1/shopping/mcp')).status,404);
 const input={currency:'usd',line_items:[{id:'SHIRT'},{id:'SHIRT'}],capabilities:{},buyer:{email:'buyer@example.test'}};
 assert.equal((await acp('/checkout_sessions',input,'key-1','wrong')).status,401);assert.equal((await acp('/checkout_sessions',input,'key-1','a'.repeat(40),'wrong')).status,400);assert.equal((await acp('/checkout_sessions',input,'')).status,400);
 const create=await acp('/checkout_sessions',input);assert.equal(create.status,201);const state=await create.json() as any;
 assert.equal(state.status,'requires_escalation');assert.equal(state.line_items[0].quantity,2);assert.equal(state.line_items[0].unit_amount,2500);assert.ok(state.continue_url.startsWith('https://printerval.gofiber-phuongnguyen.workers.dev/commerce-handoff#token='));
 const repeated=await acp('/checkout_sessions',input);assert.deepEqual(await repeated.json(),state);
 assert.equal((await acp('/checkout_sessions',{...input,line_items:[{id:'SHIRT'}]})).status,422);
 assert.equal((await acp('/checkout_sessions',{...input,line_items:[{id:'SHIRT',quantity:2}]},'bad-item')).status,400);
 const updated=await acp('/checkout_sessions/'+state.id,{buyer:{email:'other@example.test'}},'update-1');assert.equal(updated.status,200);const after=await updated.json() as any;
 assert.equal((await request('/ucp/v1/checkout-sessions/'+state.id,{buyer:{email:'forged@test.com'}},'PATCH')).status,403);
 assert.equal((await request('/ucp/v1/checkout-sessions/'+state.id,undefined,'DELETE')).status,403);
 assert.equal((await acp('/checkout_sessions/'+state.id+'/complete',{payment_data:{token:'must-not-charge'}},'complete-1')).status,409);
 const handoff=new URLSearchParams(new URL(after.continue_url).hash.slice(1)).get('token');
 const claim=()=>worker!.fetch('http://localhost/v1/checkouts/handoff',{method:'POST',headers:{Authorization:'Bearer '+'b'.repeat(40),'Content-Type':'application/json'},body:JSON.stringify({token:handoff})});
 const claims=await Promise.all([claim(),claim()]);assert.deepEqual(claims.map(r=>r.status).sort(),[200,409]);
 assert.equal((await acp('/checkout_sessions/'+state.id,{buyer:{email:'forged@test.com'}},'update-after-claim')).status,409);
 const stateResponse=await acp('/checkout_sessions/'+state.id);assert.equal(stateResponse.status,200);const claimed=await stateResponse.json() as any;assert.equal(claimed.continue_url,undefined);
 assert.equal((await worker.fetch('http://localhost/v1/marketing/admin/overview',{headers:{Authorization:'Bearer '+'b'.repeat(40)}})).status,401);
 const web=await worker.fetch('http://localhost/v1/checkouts',{method:'POST',headers:{Authorization:'Bearer '+'b'.repeat(40),'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({currency:'USD',line_items:[{id:'SHIRT',quantity:1}],buyer:{email:'recover@example.test'}})});assert.equal(web.status,201);const original=await web.json() as any;
 const subscriber=crypto.randomUUID();await sql("INSERT INTO marketing_subscribers VALUES(?,?,'active','nonce',?,?,?)",[subscriber,'recover@example.test',Date.now(),Date.now(),Date.now()]);
 const recoveryToken=await marketingToken({ORDER_TOKEN_SECRET:'s'.repeat(40),STORE_ID:'halifruit'},'recovery',subscriber,{scope:'checkout',checkout_id:original.id});
 const recover=()=>request('/v1/marketing/recovery',{token:recoveryToken});const recovered=await recover();assert.equal(recovered.status,200);const recoveredData=await recovered.json() as any;assert.equal(recoveredData.scope,'checkout');assert.notEqual(recoveredData.checkout_id,original.id);assert.deepEqual(await (await recover()).json(),recoveredData);assert.ok(!JSON.stringify(recoveredData).includes('recover@example.test'));
 const out=process.env.ACP_CONTRACT_OUTPUT;if(out)writeFileSync(out,JSON.stringify({request:input,created:state,updated:after,claimed}));

 }finally{await worker?.stop();rmSync(dir,{recursive:true,force:true});}
});
