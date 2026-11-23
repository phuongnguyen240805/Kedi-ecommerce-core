import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {PNG} from 'pngjs';
import {unstable_dev} from 'wrangler';

for(const faults of [false,true])test((faults?'E2E fault recovery at media/product/order/production: ':'E2E-001 ' )+'staged POD uses sealed R2 bytes, receipt, four independent intents, approval and signed tracking',{timeout:120000},async()=>{
 const root=fileURLToPath(new URL('../.wrangler/',import.meta.url));mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'pod-v2-'));
 const source=(p:string)=>JSON.stringify(fileURLToPath(new URL('../src/'+p,import.meta.url)).replaceAll('\\','/'));
 const main=join(dir,'worker.ts'),config=join(dir,'wrangler.json');
 writeFileSync(main,`
 import {Hono} from 'hono';import {MerchantDO} from ${source('do.ts')};export {MerchantDO};
 import {createPodRouter} from ${source('routes/pod.ts')};import {podV2AdminRouter,podV2PublicRouter} from ${source('routes/pod-v2.ts')};
 import {StagedPrintifyClient} from ${source('lib/pod-v2-printify.ts')};import {processStagedPod} from ${source('lib/pod-v2-runner.ts')};
 import {hashKey} from ${source('middleware/auth.ts')};import {readPodSnapshotAsset} from ${source('lib/pod-v2-assets.ts')};
 import {podSha,canonicalPod} from ${source('lib/pod-v2-model.ts')};
 export default {async fetch(req,env){const db=env.MERCHANT.getByName('default');await db.checkoutInit();await db.podV2Init();const u=new URL(req.url);
 if(u.pathname==='/test/seed'){
  await db.run("INSERT INTO api_keys(id,key_hash,key_prefix,role,created_at) VALUES('admin',?,'sk_fixture','admin','now')",[await hashKey('sk_fixture')]);
  await db.run("INSERT INTO currencies(id,code,display_name,decimal_places) VALUES('usd','USD','Dollar',2)");await db.run("INSERT INTO products(id,title,status) VALUES('p','Custom shirt','active')");
  await db.run("INSERT INTO variants(id,product_id,sku,title,price_cents,currency,status) VALUES('v','p','SHIRT','Custom shirt',3000,'USD','active')");await db.run("INSERT INTO variant_prices(id,variant_id,currency_id,price_cents) VALUES('price','v','usd',3000)");
  await db.run('CREATE TABLE provider_calls(kind TEXT,body TEXT)');await db.run('CREATE TABLE provider_state(kind TEXT PRIMARY KEY,body TEXT)');return Response.json({ok:true});
 }
 const client=new StagedPrintifyClient('fixture','111',async(url,init)=>{
  const path=new URL(String(url)).pathname;const body=init?.body?JSON.parse(String(init.body)):null;
  if(init?.method==='POST')await db.run('INSERT INTO provider_calls VALUES(?,?)',[path,JSON.stringify(body)]);
  if(path.includes('/catalog/'))return Response.json({id:3,variants:[{id:1,placeholders:[{position:'front',width:100,height:100,decoration_method:'dtg'}]}]});
  if(path.endsWith('/shipping.json'))return Response.json({standard:500});
  if(path==='/v1/uploads/images.json'){
   const a=new URL(body.url),parts=a.pathname.split('/');const bytes=await readPodSnapshotAsset(db,env,parts.at(-2),parts.at(-1),a.searchParams.get('token'));
   const image={id:'image-A',file_name:body.file_name,width:100,height:100,size:bytes.length,mime_type:'image/png'};
   await db.run('INSERT OR REPLACE INTO provider_state VALUES(?,?)',['image',JSON.stringify({...image,sha256:await podSha(bytes)})]);if(u.searchParams.get('fault')==='media')throw Error('Lost upload response');return Response.json(image);
  }
  if(path==='/v1/uploads/image-A.json'){const [r]=await db.query("SELECT body FROM provider_state WHERE kind='image'");return Response.json(JSON.parse(r.body));}
  if(path.endsWith('/products.json')){const result={...body,id:'product-A',variants:[{id:1,cost:1000,is_enabled:true}]};await db.run('INSERT OR REPLACE INTO provider_state VALUES(?,?)',['product',JSON.stringify(result)]);if(u.searchParams.get('fault')==='product')throw Error('Lost product response');return Response.json(result);}
  if(path.endsWith('/products/product-A.json')){const [r]=await db.query("SELECT body FROM provider_state WHERE kind='product'");return Response.json(JSON.parse(r.body));}
  if(path.endsWith('/orders.json')&&!body){const [r]=await db.query("SELECT body FROM provider_state WHERE kind='order'");return Response.json({current_page:1,last_page:1,data:r?[JSON.parse(r.body)]:[]});}
  if(path.endsWith('/orders.json')){const result={id:'order-A',status:'pending',address_to:body.address_to,metadata:{shop_order_id:body.external_id},line_items:body.line_items.map(l=>({...l,metadata:{external_id:l.external_id}}))};await db.run('INSERT OR REPLACE INTO provider_state VALUES(?,?)',['order',JSON.stringify(result)]);if(u.searchParams.get('fault')==='order')throw Error('Lost order response');return Response.json(result);}
  if(path.endsWith('/send_to_production.json')){const [r]=await db.query("SELECT body FROM provider_state WHERE kind='order'");const o=JSON.parse(r.body);o.status='in-production';await db.run("UPDATE provider_state SET body=? WHERE kind='order'",[JSON.stringify(o)]);if(u.searchParams.get('fault')==='production')throw Error('Lost production response');return new Response(null,{status:202});}
  if(path.endsWith('/orders/order-A.json')){const [r]=await db.query("SELECT body FROM provider_state WHERE kind='order'");return Response.json(JSON.parse(r.body));}
  throw Error('Unexpected provider request '+path);
 });
 if(u.pathname==='/test/settle'){const b=await req.json();await db.ucpPaymentBegin(b.id,'https://shop.test/ok','https://shop.test/cancel');await db.ucpPaymentAttach(b.id,'cs_fixture','https://checkout.stripe.com/c/pay/fixture');return Response.json(await db.ucpPaymentSettle({sessionId:b.id,stripeId:'cs_fixture',paymentStatus:'paid',amount:b.amount,currency:'USD',paymentIntent:'pi_fixture'}));}
 if(u.pathname==='/test/process'){const [job]=await db.query('SELECT id FROM pod_fulfillments');return Response.json(await processStagedPod({...env,...(u.searchParams.has('noR2')?{IMAGES:undefined}:{}),POD_PRODUCTION_RELEASE_ENABLED:u.searchParams.get('release')==='true'?'true':'false'},db,job.id,'https://merchant.test',{client,verifyPayment:async()=>true}));}
 if(u.pathname==='/test/state'){return Response.json({jobs:await db.query('SELECT * FROM pod_fulfillments'),ops:await db.query('SELECT * FROM pod_v2_operations'),calls:await db.query('SELECT * FROM provider_calls'),snapshots:await db.query('SELECT body FROM pod_v2_snapshots'),images:await db.query("SELECT body FROM provider_state WHERE kind='image'"),inbox:await db.query('SELECT * FROM pod_v2_inbox')});}
 if(u.pathname==='/test/race'){
  const [job]=await db.query('SELECT id FROM pod_fulfillments'),[stored]=await db.query('SELECT body FROM pod_v2_snapshots');const s=JSON.parse(stored.body),asset=s.assets[0],filename='kedi_store-a_'+s.id+'_'+asset.position+'_'+asset.sha256.slice(0,16)+'.png';
  const fingerprint=await podSha(canonicalPod({shop:'111',snapshot:s.hash,asset:asset.sha256,filename}));
  const results=await Promise.all(Array.from({length:100},()=>db.podV2({action:'claim',store:'store-a',fulfillment_id:job.id,line_key:s.id+'_'+asset.position,operation:'media_upload',fingerprint,token:crypto.randomUUID(),shop_id:'111'})));
  const owned=results.filter(Boolean);const upload=await client.upload(filename,'https://merchant.test/v1/pod/v2/assets/'+s.id+'/front?token='+await (async()=>{const {podSnapshotAssetUrl}=await import(${source('lib/pod-v2-assets.ts')});return new URL(await podSnapshotAssetUrl(env,'https://merchant.test',s,'front')).searchParams.get('token');})());
  await db.podV2({action:'finish',store:'store-a',id:owned[0].id,token:owned[0].token,resource_id:upload.id,proof:{sha256:asset.sha256}});return Response.json({owners:owned.length});
 }
 if(u.pathname==='/test/deliver'){const [r]=await db.query("SELECT body FROM provider_state WHERE kind='order'");const o=JSON.parse(r.body);o.status='fulfilled';o.shipments=[{carrier:'Mock',number:'TRACK',url:'https://tracking.example.test/TRACK',delivered_at:'2026-11-23'}];await db.run("UPDATE provider_state SET body=? WHERE kind='order'",[JSON.stringify(o)]);return Response.json({ok:true});}
 const app=new Hono();app.use('*',async(c,next)=>{c.set('db',db);await next();});app.onError((e,c)=>c.json({error:e.code||e.message},e.status||e.statusCode||400));
 app.route('/v1/pod',createPodRouter({stagedProvider:client,stripe:async(db,env,id)=>({id:'cs_fixture',url:'https://checkout.stripe.com/c/pay/fixture'})}));return app.fetch(req,env);
 }};`);
 writeFileSync(config,JSON.stringify({name:'pod-v2-local',main,compatibility_date:'2026-08-04',compatibility_flags:['nodejs_compat'],vars:{POD_ENABLED:'true',POD_SUBMIT_ENABLED:'true',POD_ACCOUNT_AUTOMATION_VERIFIED:'true',POD_NEW_PIPELINE_ENABLED:'true',POD_PRINTIFY_MEDIA_WRITE_ENABLED:'true',POD_PRINTIFY_PRODUCT_WRITE_ENABLED:'true',POD_ORDER_CREATE_ENABLED:'true',POD_WEBHOOK_ENABLED:'true',PRINTIFY_SHOP_ID:'111',STORE_ID:'store-a',ORDER_TOKEN_SECRET:'local-only-art-signing-key-at-least-32-characters',PRINTIFY_WEBHOOK_SECRET:'local-only-webhook-key-at-least-32-characters'},r2_buckets:[{binding:'IMAGES',bucket_name:'pod-v2-local-only'}],durable_objects:{bindings:[{name:'MERCHANT',class_name:'MerchantDO'}]},migrations:[{tag:'v1',new_sqlite_classes:['MerchantDO']}]}));
 let worker:Awaited<ReturnType<typeof unstable_dev>>|undefined;
 try{
  worker=await unstable_dev(main,{config,local:true,persist:false,port:0,inspectorPort:0,logLevel:'error',experimental:{disableExperimentalWarning:true}});
  const call=async(path:string,body?:unknown)=>{const r=await worker!.fetch('http://localhost'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer sk_fixture',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,await r.clone().text());return r.json() as Promise<any>;};
  await call('/test/seed');const cart=await call('/v1/pod/carts',{email:'buyer@example.test'});
  const png=new PNG({width:100,height:100});png.data[(50*100+50)*4+3]=255;const bytes=PNG.sync.write(png);
  const upload=await worker.fetch('http://localhost/v1/pod/artworks',{method:'POST',headers:{Authorization:'Bearer sk_fixture','Content-Type':'image/png','X-Cart-Id':cart.id},body:bytes});assert.equal(upload.status,201);const artwork=await upload.json() as {id:string;sha256:string};
  await call('/v1/pod/artworks/'+artwork.id+'/approve',{evidence:'Reviewed actual file, print placement and rights.'});
  const spec={sku:'SHIRT',shop_id:'111',blueprint_id:2,print_provider_id:3,variant_id:1,placements:[{position:'front',decoration_method:'dtg',width_px:100,height_px:100,width_in:1,height_in:1,min_dpi:72,safe_inset_px:5,bleed_policy:'Reviewed safe inset for this fixture.',physical_evidence:'Manufacturer dimension reviewed for fixture.'}],valid_until:Date.now()+86400000,catalog_hash:'0'.repeat(64)};
  const checked=await call('/v1/pod/v2/admin/specs/check',spec);spec.catalog_hash=checked.catalog_hash;
  const approved=await call('/v1/pod/v2/admin/specs',{spec,evidence:'Reviewed manufacturer print spec and physical dimensions.'});
  await call('/v1/pod/v2/admin/mappings/activate',{spec_id:approved.id,mapping:{product_id:'template',variant_id:1,blueprint_id:2,print_provider_id:3,placement:'front',min_width:100,min_height:100,countries:['US'],production_cost_minor:1000,cost_verified_until:Date.now()+86400000,minimum_margin_minor:500,tax_bps:0,tax_policy_ref:'Reviewed fixture tax policy',currency:'USD',enabled:true},evidence:'Approved mapping after provider catalog verification.'});
  const sealed=await call('/v1/pod/v2/design-snapshots',{cart_id:cart.id,sku:'SHIRT',spec_id:approved.id,design_id:'design-A',design_version:1,renderer_version:'flattened-canvas-v1',assets:[{position:'front',artwork_id:artwork.id}],rights_accepted:true});
  const recipient={first_name:'Test',last_name:'Buyer',email:'buyer@example.test',phone:'',country:'US',region:'CA',address1:'123 Test Street',address2:'',city:'Test City',zip:'90001'};
  const quote=await call('/v1/pod/v2/quotes',{cart_id:cart.id,recipient,snapshot_ids:[sealed.id],quantities:[1]});assert.equal(quote.total,3500);
  const checkout=await call('/v1/pod/v2/checkout',{cart_id:cart.id,quote_id:quote.id,expected_total:quote.total,success_url:'https://shop.test/ok',cancel_url:'https://shop.test/cancel'});
  await call('/test/settle',{id:checkout.checkout_id,amount:quote.total});await call('/v1/pod/v2/admin/shop/manual-approval',{evidence:'Verified Printify Manual Approval on the actual shop.',valid_until:Date.now()+3600000});
  assert.equal((await call('/test/process?noR2=true')).state,'storage_unconfigured');const beforeStorage=await call('/test/state');assert.equal(beforeStorage.ops.length,0);
  assert.equal((await worker.fetch('http://localhost/v1/pod/v2/admin/operations')).status,401);
  assert.equal((await worker.fetch('http://localhost/v1/pod/v2/webhooks/printify',{method:'POST',headers:{'X-Pfy-Signature':'sha256='+'0'.repeat(64)},body:'{}'})).status,401);
  if(!faults)assert.equal((await call('/test/race')).owners,1);
  if(faults){
   for(const [fault,operation,resource] of [['media','media_upload','image-A'],['product','create_product','product-A'],['order','create_order','order-A']]){
    await call('/test/process?fault='+fault);const failed=await call('/test/state'),op=failed.ops.find((o:any)=>o.operation===operation);assert.equal(op.state,'outcome_unknown');
    await call('/test/process?fault='+fault);const again=await call('/test/state');assert.equal(again.calls.filter((c:any)=>c.kind===failed.calls.at(-1).kind).length,failed.calls.filter((c:any)=>c.kind===failed.calls.at(-1).kind).length);
    if(operation!=='create_order')await call('/v1/pod/v2/admin/operations/'+op.id+'/reconcile',{resource_id:resource,evidence:'Verified provider resource after simulated lost response.'});
   }
  }
  assert.equal((await call('/test/process')).state,'production_held');let state=await call('/test/state');assert.equal(state.ops.length,3);assert.equal(state.calls.filter((x:any)=>x.kind.endsWith('/send_to_production.json')).length,0);
  assert.equal(JSON.parse(state.images[0].body).sha256,artwork.sha256);const original=state.snapshots[0].body;
  await call('/v1/pod/v2/admin/fulfillments/'+state.jobs[0].id+'/approve-production',{evidence:'Approved exact paid snapshot and provider product for print.',valid_until:Date.now()+3600000});
  if(faults){assert.equal((await call('/test/process?release=true&fault=production')).state,'production_pending_or_unknown');state=await call('/test/state');const op=state.ops.find((o:any)=>o.operation==='send_to_production');assert.equal(op.state,'outcome_unknown');await call('/v1/pod/v2/admin/operations/'+op.id+'/reconcile',{resource_id:'order-A',evidence:'Provider GET confirms production after response loss.'});}
  assert.equal((await call('/test/process?release=true')).state,'in_production');await call('/test/process?release=true');
  await call('/test/deliver');const raw=JSON.stringify({id:'event-A',type:'order:shipment:delivered',resource:{id:'order-A',type:'order',data:{shop_id:111}}});const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('local-only-webhook-key-at-least-32-characters'),{name:'HMAC',hash:'SHA-256'},false,['sign']);const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(raw))),b=>b.toString(16).padStart(2,'0')).join('');
  for(let i=0;i<2;i++)assert.equal((await worker.fetch('http://localhost/v1/pod/v2/webhooks/printify',{method:'POST',headers:{'X-Pfy-Signature':'sha256='+signature},body:raw})).status,200);
  assert.equal((await call('/test/process')).state,'delivered');state=await call('/test/state');assert.equal(state.ops.length,4);assert.equal(state.snapshots[0].body,original);assert.equal(state.inbox.length,1);assert.equal(state.inbox[0].state,'processed');
  for(const suffix of ['/uploads/images.json','/products.json','/orders.json','/send_to_production.json'])assert.equal(state.calls.filter((x:any)=>x.kind.endsWith(suffix)).length,1,suffix);
 }finally{await worker?.stop();rmSync(dir,{recursive:true,force:true});}
});
