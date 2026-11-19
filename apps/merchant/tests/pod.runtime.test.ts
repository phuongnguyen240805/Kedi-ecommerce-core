import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {unstable_dev} from 'wrangler';
test('real POD checkout persists a verified-paid fulfillment without stock or POS side effects',{timeout:90000},async()=>{
 const root=fileURLToPath(new URL('../.wrangler/',import.meta.url));mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'pod-runtime-'));
 const source=fileURLToPath(new URL('../src/index.ts',import.meta.url)).replaceAll('\\','/'),main=join(dir,'worker.ts'),config=join(dir,'wrangler.json');
 writeFileSync(main,`
 import original,{MerchantDO} from ${JSON.stringify(source)}; export {MerchantDO};
 export default {async fetch(req,env,ctx){
 if(!new URL(req.url).pathname.startsWith('/__test/'))return original.fetch(req,env,ctx);
 const db=env.MERCHANT.getByName('pod-test');await db.podInit();
 const cart=crypto.randomUUID(),art=crypto.randomUUID(),now=Date.now();
 await db.run("INSERT INTO currencies(id,code,display_name,decimal_places) VALUES('usd','USD','Dollar',2)");
 await db.run("INSERT INTO products(id,title,status) VALUES('p','POD shirt','active')");
 await db.run("INSERT INTO variants(id,product_id,sku,title,price_cents,currency,status) VALUES('v','p','POD','Shirt',2500,'USD','active')");
 await db.run("INSERT INTO carts(id,customer_email,currency,expires_at) VALUES(?,'buyer@example.test','USD',?)",[cart,new Date(now+86400000).toISOString()]);
 await db.run('INSERT INTO pod_artworks VALUES(?,?,?,?,?,?,?)',[art,cart,'print.png','checksum',2000,2000,now]);
 await db.run('INSERT INTO pod_mappings VALUES(?,?,?)',['POD','version',JSON.stringify({product_id:'provider-product',variant_id:1,blueprint_id:2,print_provider_id:3,placement:'front',min_width:1000,min_height:1000,countries:['US'],production_cost_minor:1000,cost_verified_until:now+86400000,minimum_margin_minor:500,tax_bps:0,tax_policy_ref:'reviewed-test-policy',currency:'USD',enabled:true})]);
 const plan=await db.podPlan({cart_id:cart,recipient:{first_name:'Test',last_name:'Buyer',email:'buyer@example.test',phone:'',country:'US',region:'CA',address1:'123 Test Street',address2:'',city:'Test City',zip:'90001'},lines:[{sku:'POD',qty:2,artwork_id:art}]});
 const quote=await db.podStoreQuote(plan,500),checkout=await db.podCheckout(cart,quote.id,quote.total);
 await db.ucpPaymentBegin(checkout.id,'https://shop.test/success','https://shop.test/cancel');
 const unpaid=await db.ucpPaymentSettle({sessionId:checkout.id,stripeId:'cs_pod',paymentStatus:'unpaid',amount:quote.total,currency:'USD',paymentIntent:'pi_pod'});
 const before=await db.query('SELECT * FROM pod_fulfillments');
 const input={sessionId:checkout.id,stripeId:'cs_pod',paymentStatus:'paid',amount:quote.total,currency:'USD',paymentIntent:'pi_pod'};
 const paid=await Promise.all(Array.from({length:4},()=>db.ucpPaymentSettle(input)));
 const fulfillments=await db.query('SELECT * FROM pod_fulfillments');const first=await db.podClaim(fulfillments[0].id,'one'),second=await db.podClaim(fulfillments[0].id,'two');
 return Response.json({unpaid,before,paid,fulfillments,first:!!first,second,inventory:await db.query('SELECT * FROM inventory'),pos:await db.query("SELECT name FROM sqlite_master WHERE name='commerce_orders'")});
 }};`);
 writeFileSync(config,JSON.stringify({name:'pod-runtime-test',main,compatibility_date:'2026-08-04',compatibility_flags:['nodejs_compat'],durable_objects:{bindings:[{name:'MERCHANT',class_name:'MerchantDO'}]},migrations:[{tag:'v1',new_sqlite_classes:['MerchantDO']}]}));
 let worker:Awaited<ReturnType<typeof unstable_dev>>|undefined;
 try{worker=await unstable_dev(main,{config,local:true,persist:false,port:0,inspectorPort:0,logLevel:'error',experimental:{disableExperimentalWarning:true}});
  const response=await worker.fetch('http://localhost/__test/run');assert.equal(response.status,200);
  const result=await response.json() as {unpaid:{paid:boolean};before:unknown[];paid:{orderId:string}[];fulfillments:unknown[];inventory:unknown[];pos:unknown[];first:boolean;second:null};
  assert.equal(result.unpaid.paid,false);assert.equal(result.before.length,0);assert.equal(new Set(result.paid.map(p=>p.orderId)).size,1);assert.equal(result.fulfillments.length,1);assert.equal(result.inventory.length,0);assert.equal(result.pos.length,0);assert.equal(result.first,true);assert.equal(result.second,null);
 }finally{await worker?.stop();rmSync(dir,{recursive:true,force:true});}
});
