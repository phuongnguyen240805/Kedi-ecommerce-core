import {test,afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {shippingConfiguration,applySubsidy,calculateShipping,selectCheapest,quoteRequestSchema,ShippingError,type ShippingCart,type ShippingOffer} from '../src/lib/smart-shipping';
import {ghnProvider,ghnRequest} from '../src/lib/ghn-shipping';
import {SHIPPING_SCHEMA,loadShippingCart,storeShippingQuote,selectShippingQuote,readShippingSelection,beginShippingQuote,type ShippingSql} from '../src/lib/shipping-store';
import {PANCAKE_SCHEMA} from '../src/lib/pancake-store';
import {ensureSchemaObjects} from '../src/lib/sql-schema';
const time=Date.parse('2026-10-13T00:00:00Z');
const policy={version:'test',max_delivery_hours:24,subsidy_vnd:10000,parcel:{length_cm:25,width_cm:20,height_cm:15,max_weight_g:19999,packaging_weight_g:100}};
const config=shippingConfiguration({SMART_SHIPPING_ENABLED:'true',SMART_SHIPPING_POLICY:JSON.stringify(policy),GHN_TOKEN:'fake-token-for-test',GHN_SHOP_ID:'1',GHN_FROM_DISTRICT_ID:'2',GHN_FROM_WARD_CODE:'0003'});
const cart:ShippingCart={id:'00000000-0000-4000-8000-000000000001',status:'open',currency:'VND',region_id:null,expires_at:'2026-10-14T00:00:00Z',discount_code:null,discount_amount_cents:0,address:[null,null,null,null,null,null,null],items:[{sku:'APPLE',qty:2,unit_price_cents:100000,currency:'VND',weight_g:500,requires_shipping:1,variant_status:'active',product_status:'active',current_price:100000,available:10}]};
const request=quoteRequestSchema.parse({cart_id:cart.id,destination:{district_id:3,ward_code:'0004'}});
const offer=(id:string,fee:number,hours=12):ShippingOffer=>({id,provider:id,service_type_id:2,service_name:id,currency:'VND',...applySubsidy(fee,200000,config.policy),cod_value_vnd:0,estimated_delivery_at:new Date(time+hours*3600000).toISOString(),fee_breakdown:{total:fee},source:'carrier_api',environment:'production'});
afterEach(()=>mock.restoreAll());
test('existing schema can initialize without issuing DDL when writes are unavailable',()=>{
 const db=new DatabaseSync(':memory:');db.exec(SHIPPING_SCHEMA);
 const sql={exec:(query:string)=>{assert.match(query,/^SELECT /);return {toArray:()=>db.prepare(query).all() as Record<string,unknown>[]};}};
 ensureSchemaObjects(sql,SHIPPING_SCHEMA);db.close();
});
test('cheapest eligible service wins; too-slow cheap service is excluded, fee/subsidy are distinct',async()=>{
 const result=await calculateShipping(cart,request,config,[{code:'test',quote:async()=>({offers:[offer('slow',10000,48),offer('fast',30000),offer('cheap',20000)],warnings:[]})}],time);
 assert.equal(result.quote?.recommended_id,'cheap');assert.equal(result.quote?.offers[0].customer_fee_vnd,10000);assert.equal(result.parcel.weight_g,1100);
 assert.equal(result.quote?.expires_at,time+300000);
 assert.equal(result.excluded_offers[0].id,'slow');
});
test('free shipping threshold and oversized subsidy never produce negative customer fees',()=>{
 assert.equal(applySubsidy(5000,200000,config.policy).customer_fee_vnd,0);
 assert.equal(applySubsidy(30000,200000,{...config.policy,free_shipping_from_vnd:200000}).subsidy_vnd,30000);
 assert.throws(()=>applySubsidy(-1,200000,config.policy),ShippingError);
});
test('client cannot submit trusted fees, parcel weights, or relax merchant SLA',async()=>{
 assert.equal(quoteRequestSchema.safeParse({...request,shipping_cents:0}).success,false);
 const result=await calculateShipping(cart,{...request,deliver_by:'2026-10-15T00:00:00Z'},config,[{code:'slow',quote:async()=>({offers:[offer('slow',1000,30)],warnings:[]})}],time);
 assert.equal(result.quote,null);
 assert.equal(result.excluded_offers[0].carrier_fee_vnd,1000);
});
test('unknown weight, stale prices, insufficient inventory and disallowed districts are rejected',async()=>{
 for(const patch of [{weight_g:0},{current_price:90000},{available:1}])await assert.rejects(()=>calculateShipping({...cart,items:[{...cart.items[0],...patch}]},request,config,[],time),ShippingError);
 await assert.rejects(()=>calculateShipping(cart,request,{...config,policy:{...config.policy,allowed_district_ids:[999]}},[],time),/khu vực/);
});
test('one provider outage does not erase other valid quotes and exposes no provider error body',async()=>{
 const result=await calculateShipping(cart,request,config,[{code:'broken',quote:async()=>{throw Error('secret-token');}},{code:'ok',quote:async()=>({offers:[offer('ok',20000)],warnings:[]})}],time);
 assert.equal(result.quote?.offers.length,1);assert.equal(JSON.stringify(result).includes('secret-token'),false);
});
test('preferred delivery time keeps a slower real quote available with an explicit late flag',async()=>{
 const preferred={...config,policy:{...config.policy,max_delivery_hours:48,delivery_deadline_mode:'preferred' as const}};
 const result=await calculateShipping(cart,request,preferred,[{code:'test',quote:async()=>({offers:[offer('slow-cheap',20000,58),offer('fast',30000,12)],warnings:[]})}],time);
 assert.equal(result.quote?.recommended_id,'slow-cheap');
 assert.equal(result.quote?.offers[0].meets_delivery_deadline,false);
 assert.equal(result.quote?.offers[1].meets_delivery_deadline,true);
 assert.equal(result.excluded_offers.length,0);
 const customerDeadline=await calculateShipping(cart,{...request,deliver_by:new Date(time+2*3600000).toISOString()},preferred,[{code:'test',quote:async()=>({offers:[offer('fast',30000,12)],warnings:[]})}],time);
 assert.equal(customerDeadline.quote?.offers[0].meets_delivery_deadline,false);
 const laterDeadline=await calculateShipping(cart,{...request,deliver_by:new Date(time+72*3600000).toISOString()},preferred,[{code:'test',quote:async()=>({offers:[offer('slow-cheap',20000,58)],warnings:[]})}],time);
 assert.equal(laterDeadline.quote?.offers[0].meets_delivery_deadline,true);
});
test('GHN uses service_type_id and true VND units; COD includes customer shipping in fee requote',async()=>{
 const calls:{path:string;body:Record<string,unknown>}[]=[];
 mock.method(globalThis,'fetch',async(input:URL|RequestInfo,init?:RequestInit)=>{
  const path=new URL(String(input)).pathname,body=JSON.parse(String(init?.body));calls.push({path,body});
  let data:unknown=path.endsWith('available-services')?[{service_id:999,short_name:'Hàng nhẹ',service_type_id:2}]:path.endsWith('leadtime')?{leadtime:(time+12*3600000)/1000}:{total:30000,service_fee:30000,cod_fee:0};
  return Response.json({code:200,data});
 });
 const result=await calculateShipping(cart,{...request,payment_method:'cod'},config,[ghnProvider],time);
 assert.equal(result.quote?.offers[0].carrier_fee_vnd,30000);assert.equal(result.quote?.offers[0].cod_value_vnd,220000);
 const feeCalls=calls.filter(c=>c.path.endsWith('/fee'));assert.equal(feeCalls.length,2);assert.equal(feeCalls[1].body.cod_value,220000);
 assert.equal(feeCalls[0].body.weight,1100);assert.equal(feeCalls[0].body.to_ward_code,'0004');assert.equal(feeCalls[0].body.service_type_id,2);assert.equal('service_id' in feeCalls[0].body,false);
});
test('GHN heavy service receives one measured parcel and excludes light-only service',async()=>{
 const calls:Record<string,unknown>[]=[];
 mock.method(globalThis,'fetch',async(input:URL|RequestInfo,init?:RequestInit)=>{
  const path=new URL(String(input)).pathname,body=JSON.parse(String(init?.body));calls.push(body);
  return Response.json({code:200,data:path.endsWith('available-services')?[{service_id:1,short_name:'Light',service_type_id:2},{service_id:2,short_name:'Heavy',service_type_id:5}]:path.endsWith('leadtime')?{leadtime:(time+12*3600000)/1000}:{total:30000}});
 });
 const heavyConfig={...config,policy:{...config.policy,parcel:{...config.policy.parcel,max_weight_g:30000}}};
 const result=await calculateShipping({...cart,items:[{...cart.items[0],weight_g:10000}]},request,heavyConfig,[ghnProvider],time);
 assert.equal(result.quote?.offers[0].service_type_id,5);
 assert.deepEqual(calls.at(-1)?.items,[{name:'Kiện hàng',quantity:1,weight:20100,length:25,width:20,height:15}]);
});
test('GHN failures/redirection/oversize response never leak token or upstream message',async()=>{
 for(const response of [new Response('secret-token',{status:403}),new Response(null,{status:302,headers:{Location:'https://evil.example'}}),Response.json({code:400,message:'secret-token',data:null}),new Response('x'.repeat(1000001))]){
  mock.method(globalThis,'fetch',async()=>response);
  await assert.rejects(()=>ghnRequest(config,'v2/shipping-order/fee',{}),e=>e instanceof ShippingError&&!e.message.includes('secret-token'));
  mock.restoreAll();
 }
});
function database(){
 const db=new DatabaseSync(':memory:');const source=readFileSync(new URL('../src/do.ts',import.meta.url),'utf8');db.exec(source.match(/const SCHEMA = `([\s\S]*?)`;/)![1]);db.exec(PANCAKE_SCHEMA);db.exec(SHIPPING_SCHEMA);
 db.exec(`INSERT INTO currencies(id,code,display_name,decimal_places) VALUES('vnd','VND','VND',0);
 INSERT INTO products(id,title,status) VALUES('p','Apple','active');
 INSERT INTO variants(id,product_id,sku,title,price_cents,currency,weight_g,status) VALUES('v','p','APPLE','Apple',100000,'VND',500,'active');
 INSERT INTO variant_prices(id,variant_id,currency_id,price_cents) VALUES('vp','v','vnd',100000);
 INSERT INTO pancake_sync_state(shop_id,warehouse_id) VALUES('shop','w');
 INSERT INTO pancake_links(shop_id,kind,source_id,target_id,seen_token) VALUES('shop','warehouse','w','local-w','1');
 INSERT INTO warehouses(id,display_name,address_line1,city,postal_code,country_code) VALUES('local-w','Test warehouse','Address','City','','VN');
 INSERT INTO inventory(id,sku,on_hand,reserved) VALUES('i','APPLE',10,0);
 INSERT INTO warehouse_inventory(id,sku,warehouse_id,on_hand,reserved) VALUES('wi','APPLE','local-w',10,0);`);
 db.prepare('INSERT INTO carts(id,customer_email,currency,expires_at) VALUES(?,?,?,?)').run(cart.id,'qa@example.test','VND',cart.expires_at);
 db.prepare('INSERT INTO cart_items(id,cart_id,sku,title,qty,unit_price_cents,currency) VALUES(?,?,?,?,?,?,?)').run('ci',cart.id,'APPLE','Apple',2,100000,'VND');
 const sql:ShippingSql={exec:(q,...args)=>{const values=db.prepare(q).all(...args);return {toArray:()=>values as Record<string,unknown>[]};}};
 const transaction=<T>(f:()=>T)=>{db.exec('BEGIN');try{const value=f();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}};
 return {db,sql,transaction};
}
test('quote storage survives serialization; selection is bound to cart/policy and stale fees clear atomically',async()=>{
 const {db,sql,transaction}=database();const snapshot=loadShippingCart(sql,cart.id);
 const result=await calculateShipping(snapshot,request,config,[{code:'ok',quote:async()=>({offers:[offer('ok',30000)],warnings:[]})}],time);const q=result.quote!;
 transaction(()=>storeShippingQuote(sql,q,time));
 assert.throws(()=>transaction(()=>selectShippingQuote(sql,cart.id,q.id,'evil',q.policy_key,time)),/Dịch vụ/);
 assert.throws(()=>transaction(()=>selectShippingQuote(sql,cart.id,q.id,'ok','wrong-policy',time)),/Quy tắc/);
 assert.throws(()=>transaction(()=>selectShippingQuote(sql,cart.id,q.id,'ok',q.policy_key,time+300001)),/hết hạn/);
 transaction(()=>selectShippingQuote(sql,cart.id,q.id,'ok',q.policy_key,time));assert.equal(db.prepare('SELECT shipping_cents FROM carts').get()?.shipping_cents,20000);
 assert.equal(readShippingSelection(sql,cart.id,q.policy_key,time)?.offer.id,'ok');
 db.exec('UPDATE cart_items SET qty=3');assert.equal(transaction(()=>readShippingSelection(sql,cart.id,q.policy_key,time)),null);
 assert.equal(db.prepare('SELECT shipping_cents FROM carts').get()?.shipping_cents,0);
 db.exec('UPDATE cart_items SET qty=2');transaction(()=>selectShippingQuote(sql,cart.id,q.id,'ok',q.policy_key,time));
 db.exec("INSERT INTO pancake_sync_state(shop_id,warehouse_id) VALUES('other-shop','other-warehouse')");
 assert.equal(transaction(()=>readShippingSelection(sql,cart.id,q.policy_key,time)),null);
 assert.equal(db.prepare('SELECT shipping_cents FROM carts').get()?.shipping_cents,0);db.close();
});
test('external quote race and rapid repeat requests are rejected before storing stale charges',async()=>{
 const {db,sql,transaction}=database();const snapshot=transaction(()=>beginShippingQuote(sql,cart.id,time));
 assert.throws(()=>transaction(()=>beginShippingQuote(sql,cart.id,time+5000)),/10 giây/);
 const result=await calculateShipping(snapshot,request,config,[{code:'ok',quote:async()=>({offers:[offer('ok',30000)],warnings:[]})}],time);
 db.exec('UPDATE variants SET weight_g=800');assert.throws(()=>transaction(()=>storeShippingQuote(sql,result.quote!,time)),/thay đổi/);
 assert.equal(db.prepare('SELECT COUNT(*) as n FROM shipping_quotes').get()?.n,0);db.close();
});
