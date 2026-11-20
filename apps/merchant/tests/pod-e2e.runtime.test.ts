import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,resolve,sep} from 'node:path';
import {PNG} from 'pngjs';
import {unstable_dev} from 'wrangler';

test('POD HTTP flow uses local R2, review, frozen quote, verified payment and one mock fulfillment',{timeout:120000},async()=>{
 const root=fileURLToPath(new URL('../.wrangler/',import.meta.url));mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'pod-e2e-'));
 const source=(p:string)=>JSON.stringify(fileURLToPath(new URL('../src/'+p,import.meta.url)).replaceAll('\\','/'));
 const main=join(dir,'worker.ts'),config=join(dir,'wrangler.json');
 writeFileSync(main,`
 import {Hono} from 'hono';import {MerchantDO} from ${source('do.ts')};export {MerchantDO};
 import {createPodRouter} from ${source('routes/pod.ts')};import {PrintifyClient} from ${source('lib/pod-printify.ts')};
 import {applyStripeCheckout} from ${source('lib/ucp-payment-service.ts')};import {processPodFulfillment} from ${source('lib/pod-runner.ts')};
 import {hashKey} from ${source('middleware/auth.ts')};
 export default {async fetch(req,env){
 const db=env.MERCHANT.getByName('default');await db.podInit();const url=new URL(req.url);
 if(url.pathname==='/__test/seed'){
 await db.run("INSERT INTO api_keys(id,key_hash,key_prefix,role,created_at) VALUES('admin',?,'sk_fixture','admin','now')",[await hashKey('sk_fixture')]);
 await db.run("INSERT INTO currencies(id,code,display_name,decimal_places) VALUES('usd','USD','Dollar',2)");
 await db.run("INSERT INTO products(id,title,status) VALUES('p','POD shirt','active')");
 await db.run("INSERT INTO variants(id,product_id,sku,title,price_cents,currency,status) VALUES('v','p','POD','Shirt',2500,'USD','active')");
 await db.run("INSERT INTO variant_prices(id,variant_id,currency_id,price_cents) VALUES('price','v','usd',2500)");
 const mapping={product_id:'shirt',variant_id:1,blueprint_id:2,print_provider_id:3,placement:'front',min_width:100,min_height:100,countries:['US'],production_cost_minor:1000,cost_verified_until:Date.now()+86400000,minimum_margin_minor:500,tax_bps:0,tax_policy_ref:'reviewed-local-policy',currency:'USD',enabled:true};
 await db.run('INSERT INTO pod_mappings VALUES(?,?,?)',['POD','version',JSON.stringify(mapping)]);
 await db.run('CREATE TABLE test_provider_calls(kind TEXT,body TEXT)');return Response.json({ok:true});}
 const [f]=await db.query('SELECT reference FROM pod_fulfillments LIMIT 1');
 const provider=new PrintifyClient('fixture','123',async(url,init)=>{
  const path=String(url);if(init?.method==='POST')await db.run('INSERT INTO test_provider_calls VALUES(?,?)',[path.endsWith('orders.json')?'submit':'quote',String(init.body)]);
  if(path.includes('/products/'))return Response.json({blueprint_id:2,print_provider_id:3,variants:[{id:1,cost:1000,is_enabled:true}]});
  if(path.endsWith('/shipping.json'))return Response.json({standard:500});
  const status=new URL(req.url).searchParams.get('status')||'pending';
  return Response.json({id:'provider-order',status,metadata:{shop_order_id:f?.reference||'unused'},...(status==='fulfilled'?{shipments:[{carrier:'FixtureCarrier',number:'TRACK123',url:'https://tracking.example.test/123',delivered_at:new Date().toISOString()}]}:{})});
 });
 if(url.pathname==='/__test/settle'){
  const input=await req.json();const session={id:'cs_local_'+input.id,metadata:{ucp_checkout_session_id:input.id},status:'complete',payment_status:input.paid?'paid':'unpaid',amount_total:input.amount,currency:'usd',payment_intent:'pi_local'};
  try{await applyStripeCheckout(db,input.id,session);return Response.json({ok:true});}catch{return Response.json({error:'rejected'},{status:409});}
 }
 if(url.pathname==='/__test/process'){
  const [job]=await db.query('SELECT id FROM pod_fulfillments LIMIT 1');if(!job)return Response.json({error:'no job'},{status:409});
  return Response.json(await processPodFulfillment({...env,POD_SUBMIT_ENABLED:url.searchParams.get('submit')==='true'?'true':'false',POD_ACCOUNT_AUTOMATION_VERIFIED:'true'},db,job.id,'https://local.test',provider));
 }
 if(url.pathname==='/__test/result')return Response.json({orders:await db.query('SELECT id,status FROM orders'),jobs:await db.query('SELECT state,external_id FROM pod_fulfillments'),posts:await db.query("SELECT body FROM test_provider_calls WHERE kind='submit'"),inventory:await db.query('SELECT * FROM inventory'),audits:await db.query('SELECT event FROM pod_audit')});
 const app=new Hono();app.use('*',async(c,next)=>{c.set('db',db);await next();});app.onError((e,c)=>c.json({error:e.code||e.message},e.status||e.statusCode||400));
 app.route('/v1/pod',createPodRouter({provider,stripe:async(db,env,id)=>{await db.ucpPaymentBegin(id,'https://shop.test/ok','https://shop.test/cancel');await db.ucpPaymentAttach(id,'cs_local_'+id,'https://checkout.stripe.com/c/pay/fixture');return {id:'cs_local_'+id,url:'https://checkout.stripe.com/c/pay/fixture'};}}));
 return app.fetch(req,env);
 }};`);
 writeFileSync(config,JSON.stringify({name:'pod-e2e-local',main,compatibility_date:'2025-12-01',compatibility_flags:['nodejs_compat'],vars:{POD_ENABLED:'true',ORDER_TOKEN_SECRET:'local-only-signing-key-at-least-32-characters',STORE_ID:'local'},r2_buckets:[{binding:'IMAGES',bucket_name:'pod-test-local-only'}],durable_objects:{bindings:[{name:'MERCHANT',class_name:'MerchantDO'}]},migrations:[{tag:'v1',new_sqlite_classes:['MerchantDO']}]}));
 let worker:Awaited<ReturnType<typeof unstable_dev>>|undefined;
 try{
  worker=await unstable_dev(main,{config,local:true,persist:false,port:0,inspectorPort:0,logLevel:'error',experimental:{disableExperimentalWarning:true}});
  const call=async(path:string,body?:unknown)=>worker!.fetch('http://localhost'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer sk_fixture',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await call('/__test/seed')).status,200);
  const cart=await (await call('/v1/pod/carts',{email:'buyer@example.test'})).json() as {id:string};
  const png=PNG.sync.write(new PNG({width:100,height:100}));
  const upload=await worker.fetch('http://localhost/v1/pod/artworks',{method:'POST',headers:{Authorization:'Bearer sk_fixture','Content-Type':'image/png','X-Cart-Id':cart.id},body:png});
  assert.equal(upload.status,201,await upload.clone().text());const art=await upload.json() as {id:string};
  const recipient={first_name:'Test',last_name:'Buyer',email:'buyer@example.test',phone:'',country:'US',region:'CA',address1:'123 Test Street',address2:'',city:'Test City',zip:'90001'};
  const quoteInput={cart_id:cart.id,recipient,lines:[{sku:'POD',qty:2,artwork_id:art.id}]};
  const unapproved=await call('/v1/pod/quotes',quoteInput);assert.equal(unapproved.status,400,await unapproved.text());
  const preview=await call('/v1/pod/admin/artworks/'+art.id+'/preview');assert.equal(preview.status,200);assert.deepEqual(Buffer.from(await preview.arrayBuffer()),png);
  assert.equal((await worker.fetch('http://localhost/v1/pod/admin/artworks/'+art.id+'/preview')).status,401);
  assert.equal((await call('/v1/pod/artworks/'+art.id+'/approve',{evidence:'Verified actual PNG, print dimensions and usage rights.'})).status,200);
  assert.equal((await call('/v1/pod/artworks/'+art.id+'/reject',{evidence:'Rejected file for local review cycle.'})).status,200);
  assert.equal((await call('/v1/pod/quotes',quoteInput)).status,400);
  await call('/v1/pod/artworks/'+art.id+'/approve',{evidence:'Re-reviewed actual PNG, print dimensions and rights.'});
  const quoted=await call('/v1/pod/quotes',quoteInput);assert.equal(quoted.status,200,await quoted.clone().text());const quote=await quoted.json() as {id:string;total:number};assert.equal(quote.total,5500);
  assert.equal((await call('/v1/pod/checkout',{cart_id:cart.id,quote_id:quote.id,expected_total:1,success_url:'https://shop.test/ok',cancel_url:'https://shop.test/cancel'})).status,400);
  const checkout=await (await call('/v1/pod/checkout',{cart_id:cart.id,quote_id:quote.id,expected_total:quote.total,success_url:'https://shop.test/ok',cancel_url:'https://shop.test/cancel'})).json() as {checkout_id:string};assert.ok(checkout.checkout_id);
  assert.equal((await call('/v1/pod/artworks/'+art.id+'/reject',{evidence:'Cannot change file after payment was prepared.'})).status,400);
  await call('/__test/settle',{id:checkout.checkout_id,paid:false,amount:quote.total});assert.equal((await call('/__test/process?submit=true')).status,409);
  assert.equal((await call('/__test/settle',{id:checkout.checkout_id,paid:true,amount:quote.total+1})).status,409);
  for(let i=0;i<3;i++)assert.equal((await call('/__test/settle',{id:checkout.checkout_id,paid:true,amount:quote.total})).status,200);
  assert.deepEqual(await (await call('/__test/process')).json(),{enabled:false});
  assert.equal((await (await call('/__test/process?submit=true')).json() as {state:string}).state,'accepted');
  assert.equal((await (await call('/__test/process?status=in-production')).json() as {state:string}).state,'in_production');
  assert.equal((await (await call('/__test/process?status=fulfilled')).json() as {state:string}).state,'delivered');
  const result=await (await call('/__test/result')).json() as {orders:unknown[];jobs:{state:string}[];posts:{body:string}[];inventory:unknown[]};
  assert.equal(result.orders.length,1);assert.equal(result.jobs.length,1);assert.equal(result.jobs[0].state,'delivered');assert.equal(result.posts.length,1);assert.equal(result.inventory.length,0);
  const payload=JSON.parse(result.posts[0].body);const signedUrl=new URL(payload.line_items[0].print_areas.front);
  const asset=await worker.fetch('http://localhost'+signedUrl.pathname+signedUrl.search);assert.equal(asset.status,200);assert.deepEqual(Buffer.from(await asset.arrayBuffer()),png);
  assert.equal((await worker.fetch('http://localhost'+signedUrl.pathname+'?token=invalid')).status,404);
  const order=await call('/v1/pod/orders/'+checkout.checkout_id+'?cart_id='+cart.id);assert.equal(order.status,200);assert.match(await order.text(),/TRACK123/);
  assert.equal((await call('/v1/pod/orders/'+checkout.checkout_id+'?cart_id='+crypto.randomUUID())).status,404);
 }finally{await worker?.stop();if(!resolve(dir).startsWith(resolve(root)+sep))throw Error('Unexpected fixture path');rmSync(dir,{recursive:true,force:true});}
});
