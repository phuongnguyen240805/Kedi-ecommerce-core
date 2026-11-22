import {z} from 'zod';
import type {ShippingSql} from './shipping-store';
import {ShippingError} from './smart-shipping';
export const FULFILLMENT_SCHEMA=`
CREATE TABLE IF NOT EXISTS checkout_carrier_execution(quote_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,details_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checkout_fulfillment_intents(session_id TEXT PRIMARY KEY,method TEXT NOT NULL,snapshot_json TEXT NOT NULL,activated INTEGER NOT NULL DEFAULT 0);
`;
const fail=(code:string,message:string):never=>{throw new ShippingError(code,409,message);};
export const executionSchema=z.object({provider:z.literal('ghn'),service_type_id:z.number().int(),account_id:z.string(),execution_owner:z.enum(['pancake','direct']),environment:z.enum(['production','staging']),shop_id:z.number().int().positive(),pos_partner_id:z.number().int().positive().optional(),pos_account_id:z.number().int().positive().optional(),payment_method:z.enum(['prepaid','cod']),cod_value_vnd:z.number().int().nonnegative(),carrier_fee_vnd:z.number().int().nonnegative(),subsidy_vnd:z.number().int().nonnegative(),customer_fee_vnd:z.number().int().nonnegative(),parcel:z.object({length_cm:z.number().positive(),width_cm:z.number().positive(),height_cm:z.number().positive(),packaging_weight_g:z.number().nonnegative().default(0),weight_g:z.number().positive(),goods_value_vnd:z.number().int().positive()})});
export type Execution=z.infer<typeof executionSchema>;
export type FulfillmentConfig={shop_id:string;warehouse_id:string;dispatch_enabled:boolean;test_payment:boolean;test_export_enabled:boolean};
export function saveCarrierExecution(sql:ShippingSql,id:string,quoteId:string,raw:unknown){
 const details=executionSchema.parse(raw),[quote]=sql.exec('SELECT session_id FROM checkout_carrier_quotes WHERE id=?',quoteId).toArray();
 if(quote?.session_id!==id)fail('carrier_quote_changed','Carrier quote ownership changed');
 const encoded=JSON.stringify(details),[prior]=sql.exec('SELECT details_json FROM checkout_carrier_execution WHERE quote_id=?',quoteId).toArray();
 if(prior&&prior.details_json!==encoded)fail('carrier_quote_conflict','Carrier execution changed');
 sql.exec('INSERT OR IGNORE INTO checkout_carrier_execution VALUES(?,?,?)',quoteId,id,encoded);
}
/** Freeze routing before payment I/O; never create an extra order or reserve stock here. */
export function prepareCheckoutFulfillment(sql:ShippingSql,id:string,method:'stripe'|'techcombank_qr'|'cod',config:FulfillmentConfig){
 const [old]=sql.exec('SELECT method,snapshot_json FROM checkout_fulfillment_intents WHERE session_id=?',id).toArray();
 if(old){if(old.method!==method)fail('payment_method_locked','Payment method is already locked');return;}
 const [draft]=sql.exec('SELECT snapshot_json,input_json FROM checkout_drafts WHERE id=?',id).toArray();if(!draft)fail('checkout_not_found','Checkout not found');
 const state=JSON.parse(String(draft.snapshot_json)),input=JSON.parse(String(draft.input_json));
 if(state.currency!=='VND'||state.address?.country!=='VN'||!state.physical)return;
 const a=state.address;if(!/^(0[35789]\d{8}|\+84[35789]\d{8})$/.test(a.phone||''))fail('recipient_phone_required','A valid Vietnamese delivery phone is required');
 const [quote]=sql.exec('SELECT q.*,e.details_json FROM checkout_carrier_quotes q JOIN checkout_carrier_execution e ON e.quote_id=q.id AND e.session_id=q.session_id WHERE q.id=? AND q.session_id=?',input.carrier_quote_id,id).toArray();
 if(!quote||Number(quote.expires_at)<=Date.now())fail('carrier_quote_expired','Request a current carrier quote before placing the order');
 const execution=executionSchema.parse(JSON.parse(String(quote.details_json)));
 if(execution.payment_method!==(method==='cod'?'cod':'prepaid'))fail('cod_quote_required','Recalculate delivery for the selected payment method');
 if(method==='cod'&&execution.cod_value_vnd!==state.total)fail('cod_quote_mismatch','COD amount differs from the confirmed total');
 const [warehouse]=sql.exec("SELECT target_id FROM pancake_links WHERE shop_id=? AND kind='warehouse' AND source_id=?",config.shop_id,config.warehouse_id).toArray();if(!warehouse)fail('pos_warehouse_missing','POS warehouse mapping is missing');
 const items=state.line_items.map((line:{sku:string;quantity:number;unit_price:number;title:string})=>{
  const [v]=sql.exec("SELECT v.id,v.weight_g,p.source_id pos_product_id,l.source_id pos_variant_id FROM variants v JOIN pancake_links p ON p.target_id=v.product_id AND p.shop_id=? AND p.kind='product' JOIN pancake_links l ON l.target_id=v.id AND l.shop_id=? AND l.kind='variation' WHERE v.sku=? AND v.variant_type='physical'",config.shop_id,config.shop_id,line.sku).toArray();
  if(!v)fail('sku_mapping_missing','A checkout SKU has no verified POS mapping');
  return {sku:line.sku,title:line.title,qty:line.quantity,unit_price_vnd:line.unit_price,pos_product_id:String(v.pos_product_id),pos_variant_id:String(v.pos_variant_id),local_variant_id:String(v.id),weight_g:Number(v.weight_g)};
 });
 const offer={...execution,id:state.selected_shipping_option_id,service_name:state.shipping_options.find((o:{id:string})=>o.id===state.selected_shipping_option_id)?.title||'GHN',currency:'VND',source:'carrier_api'};
 const snapshot={recipient:{name:a.name,phone:a.phone,address:[a.line_one,a.line_two].filter(Boolean).join(', '),city:a.state||a.city,district_id:a.district_id,ward_code:a.ward_code},customer_email:state.buyer.email,note:'KediMuse checkout '+id,shop_id:config.shop_id,warehouse_id:config.warehouse_id,fufuni_warehouse_id:String(warehouse.target_id),shipping:{offer,destination:{district_id:a.district_id,ward_code:a.ward_code},payment_method:execution.payment_method},parcel:execution.parcel,dispatch_enabled:config.dispatch_enabled,dispatch_account_id:String(execution.pos_account_id||execution.account_id),automation_version:2,checkout_session_id:id,test_payment:method==='stripe'&&config.test_payment,test_export_enabled:config.test_export_enabled,items,totals:{subtotal_vnd:state.subtotal,discount_vnd:0,shipping_vnd:state.shipping,tax_vnd:state.tax,total_vnd:state.total},tax_inclusive:false};
 sql.exec('INSERT INTO checkout_fulfillment_intents(session_id,method,snapshot_json) VALUES(?,?,?)',id,method,JSON.stringify(snapshot));
}
/** Called atomically after verified prepaid settlement or explicit COD order acceptance. */
export function activateCheckoutFulfillment(sql:ShippingSql,id:string){
 if(!sql.exec("SELECT name FROM sqlite_master WHERE name='checkout_fulfillment_intents'").toArray().length)return;
 const [intent]=sql.exec('SELECT * FROM checkout_fulfillment_intents WHERE session_id=?',id).toArray();if(!intent||Number(intent.activated))return;
 const [session]=sql.exec('SELECT order_id,status,order_number FROM ucp_checkout_sessions WHERE id=?',id).toArray(),[choice]=sql.exec('SELECT reference,bank_json FROM checkout_payment_choices WHERE session_id=?',id).toArray();
 if(!session?.order_id||session.status!=='completed')fail('order_not_ready','Order is not ready for fulfillment');
 const snapshot=JSON.parse(String(intent.snapshot_json)),cod=intent.method==='cod',orderId=String(session.order_id),[order]=sql.exec('SELECT status FROM orders WHERE id=?',orderId).toArray();
 if(!cod&&order.status!=='paid')fail('payment_pending','Prepaid order must be verified paid');
 const time=new Date().toISOString();
 sql.exec(`INSERT INTO commerce_orders(order_id,cart_id,idempotency_key,request_json,snapshot_json,method,payment_status,cod_status,reference,expires_at,bank_json,reservation_state,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,orderId,id,id,JSON.stringify({checkout_session_id:id}),JSON.stringify(snapshot),intent.method,cod?'unpaid':'paid',cod?'to_collect':'not_applicable',choice.reference,Date.now()+86400000,choice.bank_json,cod?'ucp_held':'consumed',time);
 sql.exec("INSERT INTO commerce_outbox(id,order_id,event,created_at) VALUES(?,?,'order.confirmed',?)",crypto.randomUUID(),orderId,time);
 sql.exec('INSERT INTO commerce_audit VALUES(?,?,?,?,?,?)',crypto.randomUUID(),orderId,'checkout.accepted','verified-checkout',JSON.stringify({session_id:id,method:intent.method,test_payment:snapshot.test_payment}),time);
 sql.exec('UPDATE checkout_fulfillment_intents SET activated=1 WHERE session_id=?',id);
}
export function checkoutFulfillmentStatus(sql:ShippingSql,orderId:unknown){
 if(!orderId||!sql.exec("SELECT name FROM sqlite_master WHERE name='commerce_orders'").toArray().length)return null;
 const [row]=sql.exec("SELECT c.pancake_order_id,c.payment_status,c.cod_status,b.state pos_state,s.tracking_number,s.state shipment_state,s.last_error FROM commerce_orders c LEFT JOIN commerce_outbox b ON b.order_id=c.order_id AND b.event='order.confirmed' LEFT JOIN commerce_shipments s ON s.order_id=c.order_id WHERE c.order_id=?",String(orderId)).toArray();
 return row?{pos_order_id:row.pancake_order_id?String(row.pancake_order_id):null,pos_status:row.pancake_order_id?'synced':String(row.pos_state||'pending'),payment_status:String(row.payment_status),cod_status:String(row.cod_status),tracking_number:row.tracking_number?String(row.tracking_number):null,shipment_status:String(row.shipment_state||'pending'),needs_attention:!!row.last_error||row.pos_state==='needs_attention'}:null;
}
