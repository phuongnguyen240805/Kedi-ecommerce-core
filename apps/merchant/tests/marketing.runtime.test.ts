import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {unstable_dev} from 'wrangler';
test('real Worker/DO deduplicates subscriptions, revokes a leased send and exports canonical feeds',{timeout:90000},async()=>{
 const root=fileURLToPath(new URL('../.wrangler/',import.meta.url));mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'marketing-runtime-'));
 const source=fileURLToPath(new URL('../src/index.ts',import.meta.url)).replaceAll('\\','/'),main=join(dir,'worker.ts'),config=join(dir,'wrangler.json');
 writeFileSync(main,`
 import original,{MerchantDO} from ${JSON.stringify(source)};export {MerchantDO};
 export default {async fetch(req,env,ctx){
 if(!new URL(req.url).pathname.startsWith('/__test/'))return original.fetch(req,env,ctx);
 const db=env.MERCHANT.getByName('default');await db.marketingInit();
 const input={email:'Buyer@Example.Test',consent:true,source:'newsletter',policy_version:'v1',rate_key:'a'.repeat(64)};
 await Promise.all(Array.from({length:8},()=>db.marketingSubscribe(input,'v1')));
 const [sub]=await db.query('SELECT * FROM marketing_subscribers');await db.marketingConfirm(sub.id,sub.nonce,'v1');
 const job=await db.marketingClaim('lease');await db.marketingUnsubscribe(sub.id);const eligible=await db.marketingEligible(job.id,'lease');
 await db.run("INSERT INTO currencies(id,code,display_name,decimal_places) VALUES('usd','USD','Dollar',2)");
 await db.run("INSERT INTO products(id,title,status) VALUES('p','Shirt','active')");await db.run("INSERT INTO variants(id,product_id,sku,title,price_cents,currency) VALUES('v','p','SHIRT','Shirt',2500,'USD')");
 await db.run("INSERT INTO inventory(id,sku,on_hand,reserved) VALUES('i','SHIRT',10,0)");
 await db.feedPut('SHIRT',{title:'Shirt',description:'Cotton shirt',brand:'Test Brand',seller_name:'Test Merchant',url:'https://shop.test/shirt',image_url:'https://cdn.shop.test/shirt.png',currency:'USD',store_country:'US',target_countries:['US'],mode:'stock',approved:true,availability_verified_until:Date.now()+86400000,identifier_exists:false},'https://shop.test');
 return Response.json({subscribers:await db.query('SELECT count(*) n FROM marketing_subscribers'),eligible,feed:await db.feedSnapshot()});
 }};`);
 writeFileSync(config,JSON.stringify({name:'marketing-runtime-test',main,compatibility_date:'2026-08-04',compatibility_flags:['nodejs_compat'],vars:{MARKETING_BFF_TOKEN:'m'.repeat(40),MARKETING_ENABLED:'true',MARKETING_POLICY_VERSION:'v1',FEEDS_ENABLED:'true',STORE_URL:'https://shop.test',STORE_NAME:'Test Merchant'},kv_namespaces:[{binding:'KV_CACHE',id:'0123456789abcdef0123456789abcdef'}],durable_objects:{bindings:[{name:'MERCHANT',class_name:'MerchantDO'}]},migrations:[{tag:'v1',new_sqlite_classes:['MerchantDO']}]}));
 let worker:Awaited<ReturnType<typeof unstable_dev>>|undefined;
 try{worker=await unstable_dev(main,{config,local:true,persist:false,port:0,inspectorPort:0,logLevel:'error',experimental:{disableExperimentalWarning:true}});
  const response=await worker.fetch('http://localhost/__test/run');assert.equal(response.status,200);
  const result=await response.json() as {subscribers:{n:number}[];eligible:null;feed:{offers:unknown[]}};assert.equal(result.subscribers[0].n,1);assert.equal(result.eligible,null);assert.equal(result.feed.offers.length,1);
  const subscription={email:'new@example.test',consent:true,source:'popup',policy_version:'v1',rate_key:'c'.repeat(64)};const register=await worker.fetch('http://localhost/v1/marketing/subscribe',{method:'POST',headers:{Authorization:'Bearer '+'m'.repeat(40),'Content-Type':'application/json'},body:JSON.stringify(subscription)});assert.equal(register.status,200);assert.equal((await worker.fetch('http://localhost/v1/marketing/admin/overview',{headers:{Authorization:'Bearer '+'m'.repeat(40)}})).status,401);
  const jsonl=await worker.fetch('http://localhost/v1/feeds/openai.jsonl');assert.equal(jsonl.status,200);assert.equal(JSON.parse(await jsonl.text()).price,'25.00 USD');
  const xml=await worker.fetch('http://localhost/v1/feeds/google.xml');assert.equal(xml.status,200);assert.match(await xml.text(),/<g:price>25.00 USD<\/g:price>/);
 }finally{await worker?.stop();rmSync(dir,{recursive:true,force:true});}
});
