import {ShippingError,type ShippingCart,type ShippingItem,type StoredShippingQuote,type ShippingOffer} from './smart-shipping';
import {cartTaxSummary} from './commerce-money';
export type ShippingSql={exec:(query:string,...params:unknown[])=>{toArray:()=>Record<string,unknown>[]}};
export type ShippingResult<T>={ok:true;value:T}|{ok:false;error:{code:string;status:number;message:string}};
export function shippingResult<T>(fn:()=>T):ShippingResult<T>{try{return {ok:true,value:fn()};}catch(e){if(e instanceof ShippingError)return {ok:false,error:{code:e.code,status:e.status,message:e.message}};throw e;}}
export function unwrapShipping<T>(result:ShippingResult<T>):T{if(!result.ok)throw new ShippingError(result.error.code,result.error.status,result.error.message);return result.value;}
export const SHIPPING_SCHEMA=`
CREATE TABLE IF NOT EXISTS shipping_quotes(id TEXT PRIMARY KEY,cart_id TEXT NOT NULL,cart_snapshot TEXT NOT NULL,
 policy_key TEXT NOT NULL,quote_json TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS shipping_quotes_expiry ON shipping_quotes(expires_at);
CREATE TABLE IF NOT EXISTS cart_shipping_quotes(cart_id TEXT PRIMARY KEY,quote_id TEXT NOT NULL,option_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shipping_quote_attempts(cart_id TEXT PRIMARY KEY,requested_at INTEGER NOT NULL);
`;
export function loadShippingCart(sql:ShippingSql,id:string):ShippingCart{
 const row=sql.exec('SELECT * FROM carts WHERE id=?',id).toArray()[0];
 if(!row)throw new ShippingError('cart_not_found',404,'Không tìm thấy giỏ hàng.');
 const warehouses=sql.exec('SELECT DISTINCT warehouse_id FROM pancake_sync_state WHERE warehouse_id IS NOT NULL').toArray();
 if(warehouses.length!==1)throw new ShippingError('warehouse_ambiguous',503,'Cần xác định một kho xuất hàng POS cho Smart Shipping.');
 const items=sql.exec(`SELECT ci.sku,ci.qty,ci.unit_price_cents,ci.currency,v.weight_g,v.requires_shipping,
  v.status AS variant_status,p.status AS product_status,COALESCE(vp.price_cents,v.price_cents) AS current_price,
  COALESCE(wi.on_hand-wi.reserved,0) AS available
  FROM cart_items ci LEFT JOIN variants v ON v.sku=ci.sku LEFT JOIN products p ON p.id=v.product_id
  LEFT JOIN variant_prices vp ON vp.variant_id=v.id AND vp.currency_id=(SELECT id FROM currencies WHERE code='VND')
  LEFT JOIN warehouse_inventory wi ON wi.sku=ci.sku AND wi.warehouse_id=(SELECT target_id FROM pancake_links
    WHERE kind='warehouse' AND source_id=(SELECT warehouse_id FROM pancake_sync_state ORDER BY last_completed_at DESC LIMIT 1) LIMIT 1)
  WHERE ci.cart_id=? ORDER BY ci.sku`,id).toArray() as unknown as ShippingItem[];
 return {id,status:String(row.status),currency:String(row.currency),region_id:row.region_id?String(row.region_id):null,expires_at:String(row.expires_at),
  discount_code:row.discount_code?String(row.discount_code):null,discount_amount_cents:Number(row.discount_amount_cents||0),
  address:[row.shipping_name,row.shipping_line1,row.shipping_line2,row.shipping_city,row.shipping_state,row.shipping_postal_code,row.shipping_country],items,
  tax_extra_vnd:row.currency==='VND'?cartTaxSummary(sql,id).extra_vnd:0};
}
export function beginShippingQuote(sql:ShippingSql,id:string,now=Date.now()){
 const cart=loadShippingCart(sql,id);
 const last=sql.exec('SELECT requested_at FROM shipping_quote_attempts WHERE cart_id=?',id).toArray()[0];
 if(last&&Number(last.requested_at)>now-10_000)throw new ShippingError('quote_rate_limited',429,'Vui lòng đợi 10 giây trước khi tính phí lại.');
 sql.exec('INSERT INTO shipping_quote_attempts(cart_id,requested_at) VALUES(?,?) ON CONFLICT(cart_id) DO UPDATE SET requested_at=excluded.requested_at',id,now);
 sql.exec('DELETE FROM shipping_quotes WHERE expires_at<?',now-3_600_000);
 sql.exec('DELETE FROM shipping_quote_attempts WHERE requested_at<?',now-86_400_000);
 return cart;
}
export function storeShippingQuote(sql:ShippingSql,quote:StoredShippingQuote,now=Date.now()){
 if(JSON.stringify(loadShippingCart(sql,quote.cart_id))!==quote.cart_snapshot)throw new ShippingError('quote_cart_changed',409,'Giỏ thay đổi trong lúc tính phí. Vui lòng tính lại.');
 if(quote.expires_at<=now)throw new ShippingError('quote_expired',409,'Báo giá đã hết hạn.');
 sql.exec('INSERT INTO shipping_quotes(id,cart_id,cart_snapshot,policy_key,quote_json,expires_at) VALUES(?,?,?,?,?,?)',
  quote.id,quote.cart_id,quote.cart_snapshot,quote.policy_key,JSON.stringify(quote),quote.expires_at);
}
export function selectShippingQuote(sql:ShippingSql,cartId:string,quoteId:string,optionId:string,policyKey:string,now=Date.now()){
 const row=sql.exec('SELECT * FROM shipping_quotes WHERE id=? AND cart_id=?',quoteId,cartId).toArray()[0];
 if(!row)throw new ShippingError('quote_not_found',404,'Không tìm thấy báo giá của giỏ này.');
 if(Number(row.expires_at)<=now)throw new ShippingError('quote_expired',409,'Báo giá hết hạn. Vui lòng tính phí lại.');
 if(row.policy_key!==policyKey)throw new ShippingError('quote_policy_changed',409,'Quy tắc vận chuyển đã đổi. Vui lòng tính phí lại.');
 const cart=loadShippingCart(sql,cartId);
 if(cart.status!=='open'||!Number.isFinite(Date.parse(cart.expires_at))||Date.parse(cart.expires_at)<=now||JSON.stringify(cart)!==row.cart_snapshot)
  throw new ShippingError('quote_cart_changed',409,'Giỏ thay đổi. Vui lòng tính phí lại.');
 const quote=JSON.parse(String(row.quote_json)) as StoredShippingQuote;
 const offer=quote.offers.find(o=>o.id===optionId);if(!offer)throw new ShippingError('quote_option_invalid',400,'Dịch vụ không thuộc báo giá.');
 sql.exec('INSERT INTO cart_shipping_quotes(cart_id,quote_id,option_id) VALUES(?,?,?) ON CONFLICT(cart_id) DO UPDATE SET quote_id=excluded.quote_id,option_id=excluded.option_id',cartId,quoteId,optionId);
 sql.exec('UPDATE carts SET shipping_rate_id=NULL,shipping_cents=?,updated_at=? WHERE id=?',offer.customer_fee_vnd,new Date(now).toISOString(),cartId);
 return {quote_id:quote.id,expires_at:quote.expires_at,destination:quote.request.destination,payment_method:quote.request.payment_method,offer};
}
export function clearShippingSelection(sql:ShippingSql,cartId:string){
 const existing=sql.exec('SELECT cart_id FROM cart_shipping_quotes WHERE cart_id=?',cartId).toArray()[0];
 if(existing){sql.exec('DELETE FROM cart_shipping_quotes WHERE cart_id=?',cartId);sql.exec('UPDATE carts SET shipping_cents=0,shipping_rate_id=NULL WHERE id=?',cartId);}
}
export function readShippingSelection(sql:ShippingSql,cartId:string,policyKey?:string,now=Date.now()){
 const selected=sql.exec(`SELECT s.quote_id,s.option_id,q.quote_json,q.expires_at,q.cart_snapshot,q.policy_key FROM cart_shipping_quotes s
  LEFT JOIN shipping_quotes q ON q.id=s.quote_id WHERE s.cart_id=?`,cartId).toArray()[0];
 if(!selected)return null;
 let cart:ShippingCart;
 try {cart=loadShippingCart(sql,cartId);} catch(error) {
  if(!(error instanceof ShippingError))throw error;
  clearShippingSelection(sql,cartId);return null;
 }
 if(!selected.quote_json||Number(selected.expires_at)<=now||JSON.stringify(cart)!==selected.cart_snapshot||(policyKey!==undefined&&selected.policy_key!==policyKey)){
  clearShippingSelection(sql,cartId);return null;
 }
 const quote=JSON.parse(String(selected.quote_json)) as StoredShippingQuote;
 const offer=quote.offers.find(o=>o.id===selected.option_id);if(!offer){clearShippingSelection(sql,cartId);return null;}
 return {quote_id:String(selected.quote_id),expires_at:quote.expires_at,destination:quote.request.destination,payment_method:quote.request.payment_method,offer};
}
export type ShippingSelection=ReturnType<typeof readShippingSelection>;
