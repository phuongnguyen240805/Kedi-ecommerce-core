import {z} from 'zod';
import type {ShippingSql} from './shipping-store';
import {ShippingError} from './smart-shipping';
import type {CheckoutInput} from './checkout-core';
export const carrierOptionSchema=z.object({id:z.string().min(1).max(100),title:z.string().min(1).max(200),amount:z.number().int().nonnegative().max(1_000_000_000),currency:z.literal('VND')}).strict();
export type CarrierOption=z.infer<typeof carrierOptionSchema>;
export function carrierBinding(input:CheckoutInput,lines:{sku:string;quantity:number;unit_price:number;total:number}[]){return JSON.stringify({currency:input.currency,address:input.address,line_items:lines.map(({sku,quantity,unit_price,total})=>({sku,quantity,unit_price,total})).sort((a,b)=>a.sku.localeCompare(b.sku))});}
export function saveCheckoutCarrier(sql:ShippingSql,id:string,quoteId:string,version:number,raw:CarrierOption[],context:string,time=Date.now()){
 const options=z.array(carrierOptionSchema).min(1).max(10).parse(raw);
 const [draft]=sql.exec('SELECT d.*,s.status,s.expires_at FROM checkout_drafts d JOIN ucp_checkout_sessions s ON s.id=d.id WHERE d.id=?',id).toArray();
 if(!draft||Number(draft.version)!==version||!['incomplete','ready_for_complete'].includes(String(draft.status))||Date.parse(String(draft.expires_at))<=time)throw new ShippingError('checkout_changed',409,'Reload the current checkout before requesting delivery');
 const input=JSON.parse(String(draft.input_json)) as CheckoutInput,snapshot=JSON.parse(String(draft.snapshot_json));
 if(input.currency!=='VND'||input.address?.country!=='VN'||!input.address.district_id||!input.address.ward_code)throw new ShippingError('carrier_destination_required',400,'Select a Vietnamese delivery district and ward');
 if(options.some(o=>!o.id.startsWith('carrier:'+quoteId+':'))||new Set(options.map(o=>o.id)).size!==options.length)throw new ShippingError('invalid_carrier_quote',400,'Invalid carrier quote');
 const binding=carrierBinding(input,snapshot.line_items),[old]=sql.exec('SELECT * FROM checkout_carrier_quotes WHERE id=?',quoteId).toArray();
 if(old){if(old.session_id!==id||old.binding_json!==binding||old.context!==context)throw new ShippingError('carrier_quote_conflict',409,'Delivery quote belongs to another checkout');return;}
 sql.exec('INSERT INTO checkout_carrier_quotes(id,session_id,binding_json,options_json,context,expires_at) VALUES(?,?,?,?,?,?)',quoteId,id,binding,JSON.stringify(options),context,time+300000);
}
export function readCheckoutCarrier(sql:ShippingSql,input:CheckoutInput,lines:Parameters<typeof carrierBinding>[1],id?:string,time=Date.now()){
 if(!input.carrier_quote_id)return [];
 const [row]=sql.exec('SELECT * FROM checkout_carrier_quotes WHERE id=? AND session_id=?',input.carrier_quote_id,id||'').toArray();
 if(!row||row.binding_json!==carrierBinding(input,lines))throw new ShippingError('carrier_quote_changed',409,'Delivery address, products or prices changed. Request a new delivery quote.');
 if(Number(row.expires_at)<=time)throw new ShippingError('carrier_quote_expired',409,'Delivery quote expired. Request a new delivery quote.');
 return z.array(carrierOptionSchema).parse(JSON.parse(String(row.options_json))).map(o=>({...o,shipping:o.amount,tax:0,estimated_days:null}));
}
