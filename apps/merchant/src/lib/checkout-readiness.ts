import {taxRate} from './checkout-core';
import type {ShippingSql} from './shipping-store';
export function checkoutReadiness(sql:ShippingSql,cursor='',skus?:string[],carrierCountry?:string){
 const rows=sql.exec(`SELECT v.id,v.sku,v.status,v.requires_shipping,v.weight_g,v.shipping_class_id,v.tax_code,p.shipping_class_id product_shipping_class,p.status product_status,COALESCE(i.on_hand-i.reserved,0) available FROM variants v JOIN products p ON p.id=v.product_id LEFT JOIN inventory i ON i.sku=v.sku WHERE ${skus?'v.sku IN ('+skus.map(()=>'?').join(',')+')':'v.id>?'} ORDER BY v.id LIMIT 101`,...(skus||[cursor])).toArray();
 const items=rows.slice(0,100).map(v=>{
  const reasons:string[]=[];
  if(v.status!=='active'||v.product_status!=='active')reasons.push('product_not_active');
  if(v.requires_shipping!==1)reasons.push('dedicated_checkout_required');
  if(Number(v.weight_g)<=0||!Number.isFinite(v.weight_g))reasons.push('shipping_weight_missing');
  if(v.shipping_class_id||v.product_shipping_class)reasons.push('special_shipping_quote_required');
  if(Number(v.available)<=0)reasons.push('stock_unavailable');
  if(sql.exec("SELECT sku FROM pod_mappings WHERE sku=? AND json_extract(config,'$.enabled')=1",v.sku).toArray().length)reasons.push('pod_deferred');
  const prices=sql.exec(`SELECT cur.code,cur.decimal_places,vp.price_cents FROM variant_prices vp JOIN currencies cur ON cur.id=vp.currency_id WHERE vp.variant_id=? AND cur.status='active' AND vp.price_cents>0`,v.id).toArray();
  if(!prices.length)reasons.push('explicit_currency_price_missing');
  const currencies=prices.map(price=>{
   const destinations=sql.exec(`SELECT DISTINCT c.code,sr.tax_code shipping_tax_code FROM regions r JOIN currencies cur ON cur.id=r.currency_id JOIN region_countries rc ON rc.region_id=r.id JOIN countries c ON c.id=rc.country_id JOIN region_shipping_rates rs ON rs.region_id=r.id JOIN shipping_rates sr ON sr.id=rs.shipping_rate_id JOIN shipping_rate_prices sp ON sp.shipping_rate_id=sr.id AND sp.currency_id=cur.id WHERE cur.code=? AND r.status='active' AND c.status='active' AND sr.status='active' AND sr.shipping_class_id IS NULL AND (sr.max_weight_g IS NULL OR sr.max_weight_g>=?)`,price.code,Number(v.weight_g)||0).toArray();
   if(carrierCountry&&price.code==='VND'&&sql.exec("SELECT r.id FROM regions r JOIN currencies cur ON cur.id=r.currency_id JOIN region_countries rc ON rc.region_id=r.id JOIN countries c ON c.id=rc.country_id WHERE cur.code='VND' AND r.status='active' AND c.status='active' AND c.code=?",carrierCountry).toArray().length)destinations.push({code:carrierCountry,shipping_tax_code:null});
   const blocked_destinations:{country:string;reason:string}[]=[];const eligible=destinations.filter(c=>{try{taxRate(sql,String(c.code),v.tax_code as string|null);taxRate(sql,String(c.code),c.shipping_tax_code as string|null);return true;}catch(e){blocked_destinations.push({country:String(c.code),reason:e instanceof Error?e.message:'Tax configuration unavailable'});return false;}});
   return {blocked_destinations,currency:String(price.code),unit_price:Number(price.price_cents),destinations:[...new Set(eligible.map(c=>String(c.code)))]};
  });
  if(prices.length&&!currencies.some(p=>p.destinations.length)){reasons.push('delivery_configuration_missing');if(currencies.some(p=>p.blocked_destinations.length))reasons.push('tax_policy_missing_or_ambiguous');}
  return {id:String(v.id),sku:String(v.sku),available:Number(v.available),ready:reasons.length===0,reasons,currencies};
 });
 return {items,next_cursor:rows.length>100?String(rows[99].id):null,scope:'catalog_configuration_only',tax_policy_requires_merchant_review:true};
}
