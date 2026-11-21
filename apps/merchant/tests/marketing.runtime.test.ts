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
 const path=new URL(req.url).pathname;if(path.startsWith('/__disabled/')){const url=new URL(req.url);url.pathname=path.replace('/__disabled','');return original.fetch(new Request(url,req),{...env,FEEDS_ENABLED:'false'},ctx);}if(!path.startsWith('/__test/'))return original.fetch(req,env,ctx);
 const db=env.MERCHANT.getByName('default');await db.marketingInit();
 for(const [key,role]of [['sk_feed_test','admin'],['pk_feed_test','public']]){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));const hash=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');await db.run('INSERT INTO api_keys(id,key_hash,key_prefix,role) VALUES(?,?,?,?)',[key,hash,key,role]);}
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
  const admin={Authorization:'Bearer sk_feed_test'};
 assert.equal((await worker.fetch('http://localhost/v1/feeds/admin/offers')).status,401);
 assert.equal((await worker.fetch('http://localhost/v1/feeds/admin/offers',{headers:{Authorization:'Bearer pk_feed_test'}})).status,403);
 const listing=await worker.fetch('http://localhost/v1/feeds/admin/offers',{headers:admin});assert.equal(listing.status,200);assert.equal((await listing.json() as any).items[0].sku,'SHIRT');
 const samples=await worker.fetch('http://localhost/v1/feeds/admin/preview-records',{headers:admin});assert.equal(samples.status,200);const sampled=await samples.json() as any;assert.equal(sampled.openai[0].item_id,'v');assert.equal(sampled.sampled,1);
 const preview=await worker.fetch('http://localhost/__disabled/v1/feeds/admin/preview/openai.jsonl',{headers:admin});assert.equal(preview.status,200);assert.match(preview.headers.get('cache-control')||'',/no-store/);assert.equal(JSON.parse(await preview.text()).price,'25.00 USD');
 assert.equal((await worker.fetch('http://localhost/__disabled/v1/feeds/openai.jsonl')).status,404);
 const product=await worker.fetch('http://localhost/v1/checkouts/products/v');assert.equal(product.status,200);const offer=await product.json() as any;assert.equal(offer.product.unit_price,2500);assert.equal(offer.product.item_id,'v');assert.equal(offer.checkout_enabled,false);
 assert.equal((await worker.fetch('http://localhost/v1/checkouts/products/not-approved')).status,404);
 const diagnostics=await worker.fetch('http://localhost/v1/feeds/admin/diagnostics',{headers:admin});assert.equal(diagnostics.status,200);assert.equal((await diagnostics.json() as any).publication_status,'ready_for_submission');
 const migrate=(body:unknown,token='sk_feed_test')=>worker!.fetch('http://localhost/v1/storefront-migrations/catalog',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const imported={source:'printerval',validate_only:false,products:[{id:'00000000-0000-4000-8000-000000000021',title:'Migrated runtime sample',status:'draft',created_at:new Date().toISOString(),variants:[{id:'00000000-0000-4000-8000-000000000022',sku:'MIGRATED-RUNTIME',title:'Sample',price_cents:2500,currency:'USD',variant_type:'physical',requires_shipping:true,weight_g:210,dims_cm:null}]}]};
 assert.equal((await migrate(imported,'pk_feed_test')).status,403);assert.equal((await migrate({...imported,validate_only:true})).status,200);const migrated=await migrate(imported);assert.equal(migrated.status,200);assert.equal((await migrate(imported)).status,200);
 const publicKey='pk_'+crypto.randomUUID().replaceAll('-',''),bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(publicKey)),hash=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
 const access=await worker.fetch('http://localhost/v1/storefront-migrations/public-access',{method:'POST',headers:{...admin,'Content-Type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),key_hash:hash,key_prefix:publicKey.slice(0,15)})});assert.equal(access.status,200);
 assert.equal((await worker.fetch('http://localhost/v1/products',{headers:{Authorization:'Bearer '+publicKey}})).status,200);assert.equal((await worker.fetch('http://localhost/v1/feeds/admin/offers',{headers:{Authorization:'Bearer '+publicKey}})).status,403);
 const availabilityUrl='http://localhost/v1/checkouts/availability?sku=SHIRT';assert.equal((await worker.fetch(availabilityUrl)).status,401);assert.equal((await worker.fetch(availabilityUrl,{headers:{Authorization:'Bearer pk_feed_test'}})).status,403);const availability=await worker.fetch(availabilityUrl,{headers:admin});assert.equal(availability.status,200);assert.match(availability.headers.get('cache-control')||'',/no-store/);const availableRows=await availability.json() as any;assert.equal(availableRows.items.length,1);assert.equal(availableRows.items[0].sku,'SHIRT');assert.equal(availableRows.items[0].available,10);assert.equal(availableRows.integrations,undefined);assert.equal((await worker.fetch('http://localhost/v1/checkouts/availability',{headers:admin})).status,400);assert.equal((await worker.fetch('http://localhost/v1/checkouts/availability?'+Array.from({length:25},()=> 'sku=SHIRT').join('&'),{headers:admin})).status,400);
 const createCurrencyCart=(currency:string)=>worker!.fetch('http://localhost/v1/carts',{method:'POST',headers:{Authorization:'Bearer pk_feed_test','Content-Type':'application/json'},body:JSON.stringify({customer_email:'cart@example.test',currency})});const currencyCart=await createCurrencyCart('USD');assert.equal(currencyCart.status,200);assert.equal((await currencyCart.json() as any).currency,'USD');assert.equal((await createCurrencyCart('ZZZ')).status,400);
 const xml=await worker.fetch('http://localhost/v1/feeds/google.xml');assert.equal(xml.status,200);assert.match(await xml.text(),/<g:price>25.00 USD<\/g:price>/);
 }finally{await worker?.stop();rmSync(dir,{recursive:true,force:true});}
});
