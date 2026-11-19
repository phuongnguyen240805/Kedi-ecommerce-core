import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { unstable_dev } from 'wrangler';

test('real Worker/DO atomically settles concurrent paid callbacks and preserves another store', {timeout:90000}, async()=>{
 const root=fileURLToPath(new URL('../.wrangler/',import.meta.url));mkdirSync(root,{recursive:true});
 const dir=mkdtempSync(join(root,'ucp-payment-'));
 const source=fileURLToPath(new URL('../src/index.ts',import.meta.url)).replaceAll('\\','/');
 const main=join(dir,'worker.ts'),config=join(dir,'wrangler.json');
 writeFileSync(main,`
 import original,{MerchantDO} from ${JSON.stringify(source)};
 export {MerchantDO};
 export default {async fetch(req,env,ctx){
 const url=new URL(req.url);if(!url.pathname.startsWith('/__test/'))return original.fetch(req,env,ctx);
 const db=env.MERCHANT.getByName(url.searchParams.get('store')||'test-a');
 const input=await req.json();
 if(url.pathname==='/__test/seed'){
 await db.run("INSERT INTO inventory(sku,on_hand,reserved) VALUES('shirt',10,2)");
 await db.run("INSERT INTO ucp_checkout_sessions(id,status,currency,line_items,buyer,totals,expires_at,created_at,updated_at) VALUES(?,'ready_for_complete','USD',?,?,?,?,?,?)",[
 'checkout',JSON.stringify([{item:{id:'shirt',title:'Shirt'},quantity:2,unit_price:{amount:1500,currency:'USD'}}]),
 JSON.stringify({email:'buyer@example.test'}),JSON.stringify([{type:'subtotal',amount:3000,currency:'USD'},{type:'tax',amount:300,currency:'USD'},{type:'grand_total',amount:3300,currency:'USD'}]),
 new Date(Date.now()+3600000).toISOString(),new Date().toISOString(),new Date().toISOString()]);
 return Response.json({ok:true});}
 if(url.pathname==='/__test/begin')return Response.json(await db.ucpPaymentBegin('checkout','https://shop.test/ok','https://shop.test/cancel'));
 if(url.pathname==='/__test/paid'){try{return Response.json(await db.ucpPaymentSettle(input));}catch{return Response.json({rejected:true},{status:409});}}
 return Response.json({orders:await db.query('SELECT * FROM orders'),items:await db.query('SELECT * FROM order_items'),inventory:await db.query('SELECT * FROM inventory'),outbox:await db.query('SELECT * FROM payment_outbox')});
 }};`);
 writeFileSync(config,JSON.stringify({name:'ucp-payment-test',main,compatibility_date:'2026-08-04',compatibility_flags:['nodejs_compat'],
 durable_objects:{bindings:[{name:'MERCHANT',class_name:'MerchantDO'}]},migrations:[{tag:'v1',new_sqlite_classes:['MerchantDO']}] }));
 let worker:Awaited<ReturnType<typeof unstable_dev>>|undefined;
 try{
  worker=await unstable_dev(main,{config,local:true,persist:false,inspectorPort:0,experimental:{disableExperimentalWarning:true},ip:'127.0.0.1',port:0,logLevel:'error'});
  const call=async(path:string,body:unknown={},store='test-a')=>worker!.fetch('http://localhost/__test/'+path+'?store='+store,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await call('seed')).status,200);assert.equal((await call('seed',{},'test-b')).status,200);
  await call('begin');
  const payment={sessionId:'checkout',stripeId:'cs_runtime',paymentStatus:'paid',amount:3300,currency:'USD',paymentIntent:'pi_runtime'};
  assert.equal((await call('paid',payment,'test-b')).status,409);
  assert.equal((await call('paid',{...payment,amount:3301})).status,409);
  const replies=await Promise.all(Array.from({length:8},()=>call('paid',payment).then(r=>r.json()) as Promise<{orderId:string}>));
  assert.equal(new Set(replies.map(r=>r.orderId)).size,1);
  const state=await (await call('state')).json() as {orders:unknown[];items:unknown[];inventory:{on_hand:number;reserved:number}[];outbox:unknown[]};
  assert.equal(state.orders.length,1);assert.equal(state.items.length,1);assert.equal(state.outbox.length,1);
  assert.equal(state.inventory[0].on_hand,8);assert.equal(state.inventory[0].reserved,2);
 }finally{await worker?.stop();rmSync(dir,{recursive:true,force:true});}
});
