import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {unstable_dev} from 'wrangler';
test('real MCP transport validates origins/auth, exposes bounded tools, and atomically consumes handoffs once',{timeout:90000},async()=>{
 const root=fileURLToPath(new URL('../.wrangler/',import.meta.url));mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'shopping-runtime-'));
 const source=fileURLToPath(new URL('../src/index.ts',import.meta.url)).replaceAll('\\','/'),tokens=fileURLToPath(new URL('../src/lib/shopping.ts',import.meta.url)).replaceAll('\\','/'),main=join(dir,'worker.ts'),config=join(dir,'wrangler.json');
 writeFileSync(main,`
 import original,{MerchantDO} from ${JSON.stringify(source)};import {verifyShopping} from ${JSON.stringify(tokens)};export {MerchantDO};
 export default {async fetch(req,env,ctx){
 const path=new URL(req.url).pathname;if(!path.startsWith('/__test/'))return original.fetch(req,env,ctx);
 const db=env.MERCHANT.getByName('default');await db.podInit();
 if(path==='/__test/budget'){return Response.json(await Promise.allSettled(Array.from({length:15},()=>db.shoppingAiAllow('a'.repeat(64)))));}
 if(path==='/__test/consume'){const token=await req.text();const {selection,id,expires_at}=await verifyShopping(env.ORDER_TOKEN_SECRET,'halifruit','shopping-handoff',token);const results=await Promise.allSettled([db.shoppingConsume(id,selection,expires_at),db.shoppingConsume(id,selection,expires_at)]);return Response.json(results);}
 await db.run("INSERT INTO currencies(id,code,display_name,decimal_places) VALUES('usd','USD','Dollar',2)");
 await db.run("INSERT INTO products(id,title,status) VALUES('p','Shirt','active')");await db.run("INSERT INTO variants(id,product_id,sku,title,price_cents,currency) VALUES('v','p','SHIRT','Shirt',2500,'USD')");
 await db.run('INSERT INTO pod_mappings VALUES(?,?,?)',['SHIRT','1',JSON.stringify({enabled:true,cost_verified_until:Date.now()+86400000})]);
 await db.feedPut('SHIRT',{title:'Cat Shirt',description:'Cotton',brand:'Test',seller_name:'Test',url:'https://shop.test/shirt',image_url:'https://shop.test/shirt.png',currency:'USD',store_country:'US',target_countries:['US'],mode:'pod',approved:true,availability_verified_until:Date.now()+86400000,identifier_exists:false},'https://shop.test');return Response.json({ok:true});
 }};`);
 writeFileSync(config,JSON.stringify({name:'shopping-runtime-test',main,compatibility_date:'2026-08-04',compatibility_flags:['nodejs_compat'],vars:{SHOPPING_ENABLED:'true',SHOPPING_MCP_TOKEN:'t'.repeat(40),ORDER_TOKEN_SECRET:'s'.repeat(40),STORE_URL:'https://shop.test'},kv_namespaces:[{binding:'KV_CACHE',id:'0123456789abcdef0123456789abcdef'}],durable_objects:{bindings:[{name:'MERCHANT',class_name:'MerchantDO'}]},migrations:[{tag:'v1',new_sqlite_classes:['MerchantDO']}]}));
 let worker:Awaited<ReturnType<typeof unstable_dev>>|undefined;
 try{worker=await unstable_dev(main,{config,local:true,persist:false,port:0,inspectorPort:0,logLevel:'error',experimental:{disableExperimentalWarning:true}});
  assert.equal((await worker.fetch('http://localhost/__test/seed')).status,200);
  const request={jsonrpc:'2.0',id:1,method:'tools/list',params:{}};
  const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+'t'.repeat(40)};
  const send=(body:unknown,extra={})=>worker!.fetch('http://localhost/v1/shopping/mcp',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
  assert.equal((await send(request,{Origin:'https://evil.test'})).status,403);assert.equal((await send(request,{Authorization:'Bearer wrong'})).status,401);
  const response=await send(request);assert.equal(response.status,200);const listed=await response.json() as {result:{tools:{name:string}[]}};
  assert.deepEqual(listed.result.tools.map(t=>t.name).sort(),['create_cart','get_cart','get_product','prepare_checkout','search_products','update_cart'].sort());
  const call=async(name:string,args:unknown)=>{const r=await send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}});assert.equal(r.status,200);return await r.json() as {result:{isError?:boolean;content:{text:string}[]}};};
  const cart=await call('create_cart',{item_id:'v',qty:2,country:'US'});assert.ok(!cart.result.isError);const {cart_token}=JSON.parse(cart.result.content[0].text);
  const handoff=await call('prepare_checkout',{cart_token});assert.ok(!handoff.result.isError);const {continue_url}=JSON.parse(handoff.result.content[0].text);assert.equal(new URL(continue_url).origin,'https://shop.test');
  const token=new URLSearchParams(new URL(continue_url).hash.slice(1)).get('token')!;
  const consumed=await worker.fetch('http://localhost/__test/consume',{method:'POST',body:token});const results=await consumed.json() as {status:string;value?:{sku:string}}[];
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='fulfilled')?.value?.sku,'SHIRT');
  assert.equal((await call('create_cart',{item_id:'v',qty:2,country:'VN'})).result.isError,true);
  assert.equal((await call('mark_paid',{})).result.isError,true);
  const budgets=await (await worker.fetch('http://localhost/__test/budget')).json() as {status:string}[];assert.equal(budgets.filter(r=>r.status==='fulfilled').length,10);
 }finally{await worker?.stop();rmSync(dir,{recursive:true,force:true});}
});
