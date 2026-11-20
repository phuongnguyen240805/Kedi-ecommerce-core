import {z} from 'zod';
import type {ShippingSql} from './shipping-store';
import {ShippingError} from './smart-shipping';
export const CHECKOUT_SCHEMA=`
CREATE TABLE IF NOT EXISTS checkout_drafts(id TEXT PRIMARY KEY,source TEXT NOT NULL,input_json TEXT NOT NULL,snapshot_json TEXT NOT NULL,version INTEGER NOT NULL,claimed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS checkout_idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,request_json TEXT NOT NULL,response_json TEXT NOT NULL,PRIMARY KEY(scope,key));
CREATE TABLE IF NOT EXISTS checkout_handoffs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,created_at INTEGER NOT NULL);
`;
const money=z.number().int().nonnegative().max(1_000_000_000);
export const checkoutAddress=z.object({name:z.string().trim().min(2).max(100),phone:z.string().max(30).default(''),line_one:z.string().trim().min(5).max(300),line_two:z.string().max(200).default(''),city:z.string().trim().min(1).max(100),state:z.string().max(100).default(''),country:z.string().regex(/^[A-Z]{2}$/),postal_code:z.string().trim().min(1).max(30)}).strict();
export const checkoutInput=z.object({currency:z.string().regex(/^[A-Za-z]{3}$/).transform(v=>v.toUpperCase()),line_items:z.array(z.object({id:z.string().min(1).max(200),quantity:z.number().int().min(1).max(99)}).strict()).min(1).max(50),buyer:z.object({email:z.string().trim().email().max(254)}).strict().optional(),address:checkoutAddress.optional(),shipping_option_id:z.string().max(100).optional()}).strict();
export type CheckoutInput=z.infer<typeof checkoutInput>;
export type CheckoutSnapshot=ReturnType<typeof quoteCheckout>;
const fail=(code:string,message:string,status=409):never=>{throw new ShippingError(code,status,message);};
function taxRate(sql:ShippingSql,country:string|undefined,code:string|null){
 const rates=sql.exec("SELECT * FROM tax_rates WHERE status='active' AND (country_code=? OR country_code IS NULL) AND (tax_code=? OR tax_code IS NULL)",country||'',code).toArray();
 const score=(r:Record<string,unknown>)=>(r.country_code===country?2:0)+(r.tax_code===code&&code!==null?1:0);
 rates.sort((a,b)=>score(b)-score(a));if(rates.length>1&&score(rates[0])===score(rates[1]))fail('tax_policy_ambiguous','More than one tax rule matches this item');
 const rate=Number(rates[0]?.rate_percentage||0);if(!Number.isFinite(rate)||rate<0||rate>100)fail('invalid_tax_policy','Invalid tax policy');return rate;
}
export function quoteCheckout(sql:ShippingSql,raw:CheckoutInput){
 const input=checkoutInput.parse(raw),[currency]=sql.exec("SELECT id FROM currencies WHERE code=? AND status='active'",input.currency).toArray();if(!currency)fail('currency_unavailable','Currency is not configured',400);
 const regions=input.address?sql.exec("SELECT DISTINCT r.id,r.tax_inclusive FROM regions r JOIN region_countries rc ON rc.region_id=r.id JOIN countries c ON c.id=rc.country_id WHERE r.status='active' AND c.status='active' AND c.code=? AND r.currency_id=? ORDER BY r.id",input.address.country,currency.id).toArray():[];
 if(new Set(regions.map(r=>r.tax_inclusive)).size>1)fail('tax_policy_ambiguous','Destination has conflicting tax policies');
 const inclusive=regions[0]?.tax_inclusive===1,seen=new Set<string>();let weight=0,physical=false,subtotal=0,tax=0;
 const messages:{code:string;content:string}[]=[];if(!input.buyer)messages.push({code:'buyer_required',content:'Enter your contact email'});
 const lines=input.line_items.map(line=>{
  const [v]=sql.exec("SELECT v.*,p.title product_title,p.image_url product_image,p.shipping_class_id product_shipping_class,COALESCE(vp.price_cents,CASE WHEN v.currency=? THEN v.price_cents END) resolved_price,COALESCE(i.on_hand-i.reserved,0) available FROM variants v JOIN products p ON p.id=v.product_id LEFT JOIN variant_prices vp ON vp.variant_id=v.id AND vp.currency_id=? LEFT JOIN inventory i ON i.sku=v.sku WHERE (v.id=? OR v.sku=?) AND v.status='active' AND p.status='active'",input.currency,currency.id,line.id,line.id).toArray();
  if(!v)fail('product_unavailable','A selected product is unavailable',400);
  if(v.requires_shipping===0||(v.variant_type&&v.variant_type!=='physical'))fail('unsupported_fulfillment','Use a dedicated checkout for digital products',400);
  if(seen.has(String(v.sku)))fail('duplicate_product','Combine quantities for the same product',400);seen.add(String(v.sku));
  if(sql.exec("SELECT sku FROM pod_mappings WHERE sku=? AND json_extract(config,'$.enabled')=1",v.sku).toArray().length)fail('pod_requires_artwork','Use the custom print checkout for this product',400);
  if(Number(v.available)<line.quantity)fail('insufficient_stock','Requested quantity is unavailable');
  const price=money.positive().parse(v.resolved_price),rate=input.address?taxRate(sql,input.address.country,v.tax_code as string|null):0;
  const unit=inclusive?Math.round(price/(1+rate/100)):price,net=money.parse(unit*line.quantity),lineTax=money.parse(inclusive?price*line.quantity-net:Math.round(net*rate/100));subtotal+=net;tax+=lineTax;
  if(v.requires_shipping!==0){physical=true;if(!Number.isFinite(v.weight_g)||Number(v.weight_g)<=0)messages.push({code:'weight_missing',content:'The merchant must configure product shipping weight'});weight+=Number(v.weight_g||0)*line.quantity;if(v.shipping_class_id||v.product_shipping_class)messages.push({code:'shipping_context_required',content:'This product needs a merchant shipping quote'});}
  return {id:String(v.id),sku:String(v.sku),title:String(v.title||v.product_title),quantity:line.quantity,unit_price:unit,display_unit_price:price,subtotal:net,tax:lineTax,total:net+lineTax,requires_shipping:v.requires_shipping!==0};
 });
 if(physical&&!input.address)messages.push({code:'address_required',content:'Enter your delivery address'});
 if(physical&&input.address&&!regions.length)messages.push({code:'destination_unavailable',content:'This destination is not configured for this currency'});
 const rates=physical&&input.address&&regions.length&&!messages.some(m=>['weight_missing','shipping_context_required'].includes(m.code))?sql.exec("SELECT DISTINCT sr.id,sr.display_name,sr.tax_code,sr.tax_inclusive,sp.amount_cents,sr.max_delivery_days FROM shipping_rates sr JOIN region_shipping_rates rs ON rs.shipping_rate_id=sr.id JOIN regions r ON r.id=rs.region_id JOIN region_countries rc ON rc.region_id=r.id JOIN countries c ON c.id=rc.country_id JOIN shipping_rate_prices sp ON sp.shipping_rate_id=sr.id AND sp.currency_id=r.currency_id WHERE sr.status='active' AND r.status='active' AND c.status='active' AND c.code=? AND r.currency_id=? AND sr.shipping_class_id IS NULL AND (sr.max_weight_g IS NULL OR sr.max_weight_g>=?) ORDER BY sr.id",input.address.country,currency.id,weight).toArray():[];
 const options=rates.map(r=>{const price=money.parse(r.amount_cents),rate=taxRate(sql,input.address?.country,r.tax_code as string|null),net=r.tax_inclusive===1?Math.round(price/(1+rate/100)):price,tax=r.tax_inclusive===1?price-net:Math.round(net*rate/100);return {id:String(r.id),title:String(r.display_name),amount:net+tax,shipping:net,tax,currency:input.currency,estimated_days:r.max_delivery_days as number|null};});
 const selected=options.find(o=>o.id===input.shipping_option_id);if(physical&&!selected)messages.push({code:'shipping_required',content:options.length?'Choose a delivery option':'No delivery option is currently available'});
 const shipping=physical&&selected?selected.shipping:0;tax+=physical&&selected?selected.tax:0;money.parse(subtotal);money.parse(tax);const total=money.parse(subtotal+tax+shipping);
 if(total<=0)fail('invalid_total','Checkout total must be positive',400);
 return {currency:input.currency,line_items:lines,subtotal,tax,shipping,total,shipping_options:options,selected_shipping_option_id:selected?.id||null,buyer:input.buyer||null,address:input.address||null,status:messages.length?'incomplete' as const:'ready_for_complete' as const,messages,physical};
}
export function checkoutRead(sql:ShippingSql,id:string){
 const [d]=sql.exec('SELECT d.*,s.status,s.expires_at,s.order_id,s.order_number FROM checkout_drafts d JOIN ucp_checkout_sessions s ON s.id=d.id WHERE d.id=?',id).toArray();if(!d)fail('checkout_not_found','Checkout not found',404);
 return {id,version:Number(d.version),...(JSON.parse(String(d.snapshot_json)) as CheckoutSnapshot),status:Date.parse(String(d.expires_at))<=Date.now()&&!['completed','complete_in_progress','canceled'].includes(String(d.status))?'expired':String(d.status),expires_at:String(d.expires_at),order_id:d.order_id?String(d.order_id):null,order_number:d.order_number?String(d.order_number):null,source:String(d.source),claimed:d.claimed===1};
}
export function checkoutSave(sql:ShippingSql,raw:CheckoutInput,source:string,id:string=crypto.randomUUID(),expectedVersion?:number){
 const [old]=sql.exec('SELECT d.*,s.status,s.expires_at FROM checkout_drafts d JOIN ucp_checkout_sessions s ON s.id=d.id WHERE d.id=?',id).toArray();
 if(old){if(old.source!==source)fail('checkout_not_found','Checkout not found',404);if(['complete_in_progress','completed','canceled'].includes(String(old.status))||Date.parse(String(old.expires_at))<=Date.now())fail('checkout_closed','Checkout is closed');if(expectedVersion!==undefined&&Number(old.version)!==expectedVersion)fail('checkout_changed','Checkout changed; reload before updating');}
 const input=checkoutInput.parse(raw),snapshot=quoteCheckout(sql,input),expires=old?String(old.expires_at):new Date(Date.now()+3600000).toISOString(),time=new Date().toISOString();
 const lines=snapshot.line_items.map(i=>({id:i.id,item:{id:i.sku,title:i.title},quantity:i.quantity,unit_price:{amount:i.unit_price,currency:input.currency},total_price:{amount:i.subtotal,currency:input.currency}}));
 const totals=[{type:'subtotal',amount:snapshot.subtotal,currency:input.currency},{type:'tax',amount:snapshot.tax,currency:input.currency},{type:'shipping',amount:snapshot.shipping,currency:input.currency},{type:'grand_total',amount:snapshot.total,currency:input.currency}];
 sql.exec("INSERT INTO ucp_checkout_sessions(id,status,currency,line_items,buyer,totals,messages,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,currency=excluded.currency,line_items=excluded.line_items,buyer=excluded.buyer,totals=excluded.totals,messages=excluded.messages,updated_at=excluded.updated_at",id,snapshot.status,input.currency,JSON.stringify(lines),JSON.stringify(input.buyer||null),JSON.stringify(totals),JSON.stringify(snapshot.messages),expires,time,time);
 sql.exec('INSERT INTO checkout_drafts(id,source,input_json,snapshot_json,version) VALUES(?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET input_json=excluded.input_json,snapshot_json=excluded.snapshot_json,version=version+1',id,source,JSON.stringify(input),JSON.stringify(snapshot));return checkoutRead(sql,id);
}
export function checkoutCommand<T>(sql:ShippingSql,scope:string,key:string,raw:unknown,work:()=>T):T{
 z.string().min(1).max(255).parse(key);const encoded=JSON.stringify(raw);const [previous]=sql.exec('SELECT * FROM checkout_idempotency WHERE scope=? AND key=?',scope,key).toArray();if(previous){if(previous.request_json!==encoded)fail('idempotency_conflict','Idempotency key was used with different input');return JSON.parse(String(previous.response_json));}
 const response=work();sql.exec('INSERT INTO checkout_idempotency VALUES(?,?,?,?)',scope,key,encoded,JSON.stringify(response));return response;
}
export function checkoutCancel(sql:ShippingSql,id:string,source:string){const current=checkoutRead(sql,id);if(current.source!==source)fail('checkout_not_found','Checkout not found',404);if(['complete_in_progress','completed'].includes(current.status))fail('checkout_locked','Payment must be reconciled before cancellation');sql.exec("UPDATE ucp_checkout_sessions SET status='canceled',updated_at=? WHERE id=?",new Date().toISOString(),id);return checkoutRead(sql,id);}

export type CheckoutRpcCommand={action:'get';id:string}|{action:'create';input:CheckoutInput;source:string;key:string}|{action:'update';id:string;patch:Partial<CheckoutInput>;source:string;key:string;version?:number;browser?:boolean}|{action:'cancel';id:string;source:string;key:string}|{action:'redeem';id:string};
export type CheckoutRpcResult={ok:true;value:ReturnType<typeof checkoutRead>}|{ok:false;error:{code:string;status:number;message:string}};
