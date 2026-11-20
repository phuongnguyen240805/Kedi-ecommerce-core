import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {POD_SCHEMA,podQuotePlan,storePodQuote,checkoutPodQuote,claimPodFulfillment,finishPodFulfillment,approvePodArtwork,reviewPodArtwork,savePodMappingDraft} from '../src/lib/pod-core';
import {UCP_PAYMENT_SCHEMA,beginUcpPayment,settleUcpPayment} from '../src/lib/ucp-payment';
import {PrintifyClient,printifyFulfillmentState} from '../src/lib/pod-printify';
import {processPodFulfillment} from '../src/lib/pod-runner';
import type {ShippingSql} from '../src/lib/shipping-store';
import type {DOStub,Env} from '../src/types';
import {inspectPodPng} from '../src/lib/pod-artwork';
import {PNG} from 'pngjs';

function fixture(){
 const db=new DatabaseSync(':memory:');const source=readFileSync(new URL('../src/do.ts',import.meta.url),'utf8');db.exec(source.match(/const SCHEMA = `([\s\S]*?)`;/)![1]);db.exec(POD_SCHEMA);db.exec(UCP_PAYMENT_SCHEMA);
 const now=Date.now(),cart=crypto.randomUUID(),art=crypto.randomUUID();
 db.exec("INSERT INTO currencies(id,code,display_name,decimal_places) VALUES('usd','USD','Dollar',2);INSERT INTO products(id,title,status) VALUES('product','POD Shirt','active');INSERT INTO variants(id,product_id,sku,title,price_cents,currency,status) VALUES('variant','product','POD-S','Shirt / S',2500,'USD','active');INSERT INTO variant_prices(id,variant_id,currency_id,price_cents) VALUES('price','variant','usd',2500);");
 db.prepare("INSERT INTO carts(id,customer_email,currency,expires_at) VALUES(?,'buyer@example.test','USD',?)").run(cart,new Date(now+86400000).toISOString());
 const mapping={product_id:'printify-product',variant_id:101,blueprint_id:12,print_provider_id:2,placement:'front',min_width:1000,min_height:1000,countries:['US'],production_cost_minor:1000,cost_verified_until:now+86400000,minimum_margin_minor:500,tax_bps:500,tax_policy_ref:'reviewed-us-policy',currency:'USD',enabled:true};
 db.prepare('INSERT INTO pod_mappings VALUES(?,?,?)').run('POD-S','v1',JSON.stringify(mapping));
 db.prepare('INSERT INTO pod_artworks VALUES(?,?,?,?,?,?,?)').run(art,cart,'art.png','checksum',2000,2000,now);
 const sql:ShippingSql={exec:(q,...args)=>{const rows=db.prepare(q).all(...args) as Record<string,unknown>[];return {toArray:()=>rows};}};
 const tx=<T>(f:()=>T):T=>{db.exec('BEGIN');try{const r=f();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const input={cart_id:cart,recipient:{first_name:'Test',last_name:'Buyer',email:'buyer@example.test',phone:'',country:'US',region:'CA',address1:'123 Test Street',address2:'',city:'Test City',zip:'90001'},lines:[{sku:'POD-S',qty:2,artwork_id:art}]};
 const plan=()=>podQuotePlan(sql,input);const quote=()=>tx(()=>storePodQuote(sql,plan(),500));
 const pay=()=>{const q=quote(),c=tx(()=>checkoutPodQuote(sql,cart,q.id,q.total));tx(()=>beginUcpPayment(sql,c.id,'https://shop.test/ok','https://shop.test/cancel'));
  const payment={sessionId:c.id,stripeId:'cs_pod',paymentStatus:'paid',amount:q.total,currency:'USD',paymentIntent:'pi_pod'};
  return {q,c,payment,result:tx(()=>settleUcpPayment(sql,payment))};};
 return {db,sql,cart,art,mapping,input,tx,plan,quote,pay};
}
test('POD quote uses server USD price, tax, shipping and approved artwork without stock',()=>{
 const f=fixture();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM inventory').get()!.n,0);
 const q=f.quote();assert.equal(q.total,5750);assert.equal(q.tax,250);
 assert.throws(()=>podQuotePlan(f.sql,{...f.input,recipient:{...f.input.recipient,country:'VN'}}),/destination/);
 f.db.exec('UPDATE pod_artworks SET approved_at=NULL');assert.throws(f.plan,/approved/);
 approvePodArtwork(f.sql,f.art,'Manually reviewed print area, rights and quality.');assert.equal(f.plan().lines.length,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM pod_audit').get()!.n,1);
});
test('quote checkout rejects wrong totals and catalog drift; same quote is idempotent',()=>{
 const f=fixture(),q=f.quote();assert.throws(()=>f.tx(()=>checkoutPodQuote(f.sql,f.cart,q.id,q.total-1)),/total/);
 const a=f.tx(()=>checkoutPodQuote(f.sql,f.cart,q.id,q.total)),b=f.tx(()=>checkoutPodQuote(f.sql,f.cart,q.id,q.total));assert.deepEqual(a,b);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ucp_checkout_sessions').get()!.n,1);
 const g=fixture(),stale=g.quote();g.db.exec("UPDATE pod_mappings SET version='v2'");assert.throws(()=>g.tx(()=>checkoutPodQuote(g.sql,g.cart,stale.id,stale.total)),/changed/);
});
test('verified paid creates exactly one POD fulfillment and no Pancake order or stock deduction',()=>{
 const f=fixture(),paid=f.pay();f.tx(()=>settleUcpPayment(f.sql,paid.payment));
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM pod_fulfillments').get()!.n,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM inventory').get()!.n,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='commerce_orders'").get()!.n,0);
});
test('paid gate and lease prevent unpaid or concurrent manufacturing; timeout only reconciles',async()=>{
 const f=fixture();f.pay();const id=String(f.db.prepare('SELECT id FROM pod_fulfillments').get()!.id);
 const first=f.tx(()=>claimPodFulfillment(f.sql,id,'one'))!;assert.equal(first.reconcileOnly,false);
 assert.equal(f.tx(()=>claimPodFulfillment(f.sql,id,'two')),null);
 f.tx(()=>finishPodFulfillment(f.sql,id,'one',{state:'submission_unknown'}));
 const next=f.tx(()=>claimPodFulfillment(f.sql,id,'two'))!;assert.equal(next.reconcileOnly,true);
 f.tx(()=>finishPodFulfillment(f.sql,id,'two',{state:'submission_unknown'}));
 let posts=0;const client=new PrintifyClient('fixture-token','1',async(_url,init)=>{if(init?.method==='POST')posts++;return Response.json({data:[]});});
 const stub={podClaim:async(id:string,t:string)=>f.tx(()=>claimPodFulfillment(f.sql,id,t)),podFinish:async(id:string,t:string,r:Parameters<typeof finishPodFulfillment>[3])=>{f.tx(()=>finishPodFulfillment(f.sql,id,t,r));}} as unknown as DOStub;
 await processPodFulfillment({POD_ENABLED:'true',POD_SUBMIT_ENABLED:'true',POD_ACCOUNT_AUTOMATION_VERIFIED:'true'} as Env,stub,id,'https://merchant.test',client);
 assert.equal(posts,0);assert.equal(f.db.prepare('SELECT state FROM pod_fulfillments').get()!.state,'submission_unknown');
 f.db.exec("UPDATE orders SET status='refunded'");assert.equal(claimPodFulfillment(f.sql,id,'after-refund')?.reconcileOnly,true);
});
test('stale costs, insufficient margin, foreign artwork and expired quote fail closed',()=>{
 const f=fixture();const q=f.quote();assert.throws(()=>checkoutPodQuote(f.sql,f.cart,q.id,q.total,Date.now()+700000),/fresh quote/);
 assert.throws(()=>podQuotePlan(f.sql,{...f.input,lines:[{...f.input.lines[0],artwork_id:crypto.randomUUID()}]}),/approved/);
 f.db.prepare('UPDATE pod_mappings SET config=?').run(JSON.stringify({...f.mapping,production_cost_minor:2400}));assert.throws(f.plan,/margin/);
 f.db.prepare('UPDATE pod_mappings SET config=?').run(JSON.stringify({...f.mapping,cost_verified_until:1}));assert.throws(f.plan,/cost/);
});
test('Printify boundary preserves reference and artwork mapping; redirect never forwards token',async()=>{
 const f=fixture(),snapshot={...f.plan(),shipping:500,amount:5750,expires_at:Date.now()+600000};let body:Record<string,unknown>|undefined;
 const client=new PrintifyClient('secret','123',async(url,init)=>{
  assert.match(String(url),/^https:\/\/api\.printify\.com\/v1\/shops\/123\//);assert.equal(init?.redirect,'manual');
  body=JSON.parse(String(init?.body));return Response.json({id:'external',status:'pending',metadata:{shop_order_id:'reference'}});
 });
 assert.equal((await client.submit(snapshot,'reference',async()=> 'https://merchant.test/art.png')).id,'external');
 assert.equal(body!.external_id,'reference');assert.deepEqual((body!.line_items as {print_areas:unknown}[])[0].print_areas,{front:'https://merchant.test/art.png'});
 const redirect=new PrintifyClient('secret','123',async()=>new Response(null,{status:302,headers:{Location:'https://evil.test'}}));
 await assert.rejects(redirect.shipping(snapshot),/redirect/);
});
test('a timeout after the first manufacturing POST never produces a second manufacturing POST',async()=>{
 const f=fixture();f.pay();const id=String(f.db.prepare('SELECT id FROM pod_fulfillments').get()!.id);let manufacturingPosts=0;
 const client=new PrintifyClient('fixture-token','1',async(url)=>{
  const path=String(url);
  if(path.includes('products/'))return Response.json({blueprint_id:12,print_provider_id:2,variants:[{id:101,cost:1000,is_enabled:true}]});
  if(path.endsWith('orders/shipping.json'))return Response.json({standard:500});
  if(path.endsWith('orders.json')){manufacturingPosts++;throw Error('Connection lost after provider accepted');}
  return Response.json({data:[]});
 });
 const stub={podClaim:async(id:string,t:string)=>f.tx(()=>claimPodFulfillment(f.sql,id,t)),
  podFinish:async(id:string,t:string,r:Parameters<typeof finishPodFulfillment>[3])=>{f.tx(()=>finishPodFulfillment(f.sql,id,t,r));},
  query:async(q:string,p:unknown[])=>f.sql.exec(q,...p).toArray()} as unknown as DOStub;
 const env={POD_ENABLED:'true',POD_SUBMIT_ENABLED:'true',POD_ACCOUNT_AUTOMATION_VERIFIED:'true',ORDER_TOKEN_SECRET:'fixture-signing-secret-at-least-32-characters'} as Env;
 await processPodFulfillment(env,stub,id,'https://merchant.test',client);
 await processPodFulfillment(env,stub,id,'https://merchant.test',client);
 assert.equal(manufacturingPosts,1);assert.equal(f.db.prepare('SELECT state FROM pod_fulfillments').get()!.state,'submission_unknown');
});
test('print file inspection validates signature, dimensions, chunks and CRC',()=>{
 const png=new PNG({width:100,height:100});const bytes=PNG.sync.write(png);
 assert.deepEqual(inspectPodPng(bytes),{width:100,height:100});
 assert.throws(()=>inspectPodPng(bytes.subarray(0,bytes.length-5)));
 const corrupt=Buffer.from(bytes);corrupt[40]^=1;assert.throws(()=>inspectPodPng(corrupt));
});
test('submit kill switch leaves fresh jobs untouched and still reconciles attempted jobs',async()=>{
 const f=fixture();f.pay();const id=String(f.db.prepare('SELECT id FROM pod_fulfillments').get()!.id);let calls=0;
 const client=new PrintifyClient('fixture','1',async()=>{calls++;return Response.json({data:[]});});
 const db={query:async(q:string,p:unknown[])=>f.sql.exec(q,...p).toArray(),podClaim:async(i:string,t:string)=>f.tx(()=>claimPodFulfillment(f.sql,i,t)),podFinish:async(i:string,t:string,r:Parameters<typeof finishPodFulfillment>[3])=>{f.tx(()=>finishPodFulfillment(f.sql,i,t,r));}} as unknown as DOStub;
 const env={POD_ENABLED:'true',POD_SUBMIT_ENABLED:'false'} as Env;
 await processPodFulfillment(env,db,id,'https://merchant.test',client);assert.equal(calls,0);assert.equal(f.db.prepare('SELECT attempted_at FROM pod_fulfillments').get()!.attempted_at,null);
 f.tx(()=>claimPodFulfillment(f.sql,id,'first'));f.tx(()=>finishPodFulfillment(f.sql,id,'first',{state:'submission_unknown'}));
 await processPodFulfillment(env,db,id,'https://merchant.test',client);assert.equal(calls,1);
});
test('provider statuses distinguish production, issues, cancellation and incomplete shipment sets',()=>{
 const order={id:'ext',status:'pending',metadata:{shop_order_id:'ref'}};
 assert.equal(printifyFulfillmentState(order),'accepted');
 for(const status of ['in-production','sending-to-production'])assert.equal(printifyFulfillmentState({...order,status}),'in_production');
 for(const status of ['on-hold','payment-not-received','source-check-failed','has-issues','new-unknown-status'])assert.equal(printifyFulfillmentState({...order,status}),'needs_review');
 assert.equal(printifyFulfillmentState({...order,status:'canceled',shipments:[{carrier:'C',number:'N'}]}),'canceled');
 assert.equal(printifyFulfillmentState({...order,status:'fulfilled',line_items:[{status:'canceled'}]}),'needs_review');
 assert.equal(printifyFulfillmentState({...order,status:'in-production',shipments:[{carrier:'C',number:'N',delivered_at:'now'}]}),'shipped');
 assert.equal(printifyFulfillmentState({...order,status:'fulfilled',shipments:[{carrier:'C',number:'N',delivered_at:'now'}]}),'delivered');
});
test('disabled mapping draft requires active USD SKU, preserves active mapping and audits changes',()=>{
 const f=fixture();assert.throws(()=>savePodMappingDraft(f.sql,'POD-S',f.mapping,'admin'),/disabled/);
 assert.throws(()=>savePodMappingDraft(f.sql,'MISSING',{...f.mapping,enabled:false},'admin'),/USD/);
 assert.throws(()=>f.tx(()=>savePodMappingDraft(f.sql,'POD-S',{...f.mapping,enabled:false},'admin')),/active mapping/);
 f.db.exec('DELETE FROM pod_mappings');
 const saved=f.tx(()=>savePodMappingDraft(f.sql,'POD-S',{...f.mapping,enabled:false},'admin'));assert.equal(saved.enabled,false);
 assert.equal(JSON.parse(String(f.db.prepare('SELECT config FROM pod_mappings').get()!.config)).enabled,false);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM pod_audit WHERE event='mapping.draft_saved'").get()!.n,1);
});
test('artwork rejection revokes approval and review locks at checkout',()=>{
 const f=fixture();reviewPodArtwork(f.sql,f.art,'Rejected after actual preview review.',false);assert.throws(f.plan,/approved/);
 reviewPodArtwork(f.sql,f.art,'Approved following correction and review.',true);assert.equal(f.plan().lines.length,1);
 const q=f.quote();f.tx(()=>checkoutPodQuote(f.sql,f.cart,q.id,q.total));assert.throws(()=>reviewPodArtwork(f.sql,f.art,'Cannot change payment-bound artwork.',false),/open cart/);
});
test('provider review jobs with an external ID reconcile only and canceled jobs are terminal',()=>{
 const f=fixture();f.pay();const id=String(f.db.prepare('SELECT id FROM pod_fulfillments').get()!.id);
 f.tx(()=>claimPodFulfillment(f.sql,id,'first'));f.tx(()=>finishPodFulfillment(f.sql,id,'first',{state:'needs_review',externalId:'external'}));
 const next=f.tx(()=>claimPodFulfillment(f.sql,id,'review'));assert.equal(next?.reconcileOnly,true);
 f.tx(()=>finishPodFulfillment(f.sql,id,'review',{state:'canceled',externalId:'external'}));assert.equal(claimPodFulfillment(f.sql,id,'again'),null);
});
