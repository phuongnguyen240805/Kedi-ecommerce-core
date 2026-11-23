import type {Context} from 'hono';
import type {Env,HonoEnv} from '../types';
import {callCheckout} from './checkout-rpc';
import {shippingQuoteSetup,shippingLocationConfiguration,carrierAccounts,carrierConfiguration} from './shipping-registry';
import {ghnRequest} from './ghn-shipping';
import {ShippingError,applySubsidy,type Parcel} from './smart-shipping';
import type {CheckoutInput} from './checkout-core';
import {z} from 'zod';
function checkoutCarrierConfig(env:Env){const setup=shippingQuoteSetup(env);const account=carrierAccounts(env).find(a=>a.id===setup.providers[0]?.code);return {setup,account,config:account?carrierConfiguration(env,account):shippingLocationConfiguration(env)};}
export function carrierDeliveryReady(env:Env){if(env.CHECKOUT_CARRIER_ENABLED!=='true')return false;try{checkoutCarrierConfig(env);return true;}catch{return false;}}
export function carrierContext(env:Env){const {setup,config}=checkoutCarrierConfig(env);return JSON.stringify({shop_id:config.shop_id,warehouse:env.PANCAKE_WAREHOUSE_ID,from_district_id:config.from_district_id,from_ward_code:config.from_ward_code,policy:setup.config.policy});}
export async function assertCarrierContext(c:Context<HonoEnv>,id:string,option:string|null){if(!option?.startsWith('carrier:'))return;if(!carrierDeliveryReady(c.env))throw new ShippingError('carrier_unavailable',503,'Carrier payments are unavailable');const quote=option.split(':')[1];const [row]=await c.var.db.query<{context:string;expires_at:number}>('SELECT context,expires_at FROM checkout_carrier_quotes WHERE id=? AND session_id=?',[quote,id]);if(row&&Number(row.expires_at)<=Date.now())throw new ShippingError('carrier_quote_expired',409,'Delivery quote expired. Request a new delivery quote.');if(!row||row.context!==carrierContext(c.env))throw new ShippingError('carrier_quote_changed',409,'The pickup location or delivery policy changed. Request a new quote.');}
export async function checkoutLocations(c:Context<HonoEnv>){
 const level=z.enum(['province','district','ward']).safeParse(c.req.query('level'));if(!level.success)throw new ShippingError('invalid_location',400,'Choose a location level');
 const parent=Number(c.req.query('parent_id'));if(level.data!=='province'&&(!Number.isSafeInteger(parent)||parent<1))throw new ShippingError('invalid_location',400,'Choose the parent location');
 const endpoint={province:'master-data/province',district:'master-data/district',ward:'master-data/ward'}[level.data];
 const data=await ghnRequest(checkoutCarrierConfig(c.env).config,endpoint,level.data==='province'?{}:level.data==='district'?{province_id:parent}:{district_id:parent},undefined,'GET');
 const rows=z.array(z.record(z.string(),z.unknown())).max(1000).parse(data),keys={province:['ProvinceID','ProvinceName'],district:['DistrictID','DistrictName'],ward:['WardCode','WardName']}[level.data];
 return c.json({items:rows.filter(row=>level.data!=='ward'||row.SupportType===2||row.SupportType===3).map(row=>({id:String(row[keys[0]]),name:String(row[keys[1]])}))});
}
export async function updateWithCarrier(c:Context<HonoEnv>,id:string,key:string,version:number,patch:Partial<CheckoutInput>,source:string){
 const chosen=patch.shipping_option_id?.match(/^carrier:([0-9a-f-]{36}):\d+$/)?.[1];
 if(chosen){try{return await callCheckout(c.var.db,{action:'update',id,source,key,version,patch:{...patch,carrier_quote_id:chosen},browser:true});}catch(e){if(!(e instanceof ShippingError)||!['carrier_quote_changed','carrier_quote_expired'].includes(e.code))throw e;}}
 const base=await callCheckout(c.var.db,{action:'update',id,source,key:key+':base',version,patch:{...patch,carrier_quote_id:null,shipping_option_id:''},browser:true});
 const [saved]=await c.var.db.query<{id:string}>('SELECT id FROM checkout_carrier_quotes WHERE id=? AND session_id=?',[key,id]);if(saved)return callCheckout(c.var.db,{action:'get',id});
 if(base.currency!=='VND'||base.address?.country!=='VN'||!base.address.district_id||!base.address.ward_code)return base;
 const {setup,config,account}=checkoutCarrierConfig(c.env);
 const [draftInput]=await c.var.db.query<{input_json:string}>('SELECT input_json FROM checkout_drafts WHERE id=?',[id]);const cod=JSON.parse(draftInput.input_json).payment_method==='cod';if(cod&&(c.env.CHECKOUT_COD_ENABLED!=='true'||account&&!account.cod))throw new ShippingError('cod_unavailable',503,'COD is not available for this carrier account');
 const wards=z.array(z.object({WardCode:z.string(),SupportType:z.number()})).parse(await ghnRequest(config,'master-data/ward',{district_id:base.address.district_id},undefined,'GET'));
 if(!wards.some(w=>w.WardCode===base.address!.ward_code&&(w.SupportType===2||w.SupportType===3)))throw new ShippingError('invalid_location',400,'Ward does not belong to the chosen delivery district');
 const weights=await c.var.db.query<{sku:string;weight_g:number}>('SELECT sku,weight_g FROM variants WHERE sku IN ('+base.line_items.map(()=>'?').join(',')+')',base.line_items.map(i=>i.sku));
 const weight=base.line_items.reduce((sum,item)=>sum+(weights.find(w=>w.sku===item.sku)?.weight_g||0)*item.quantity,setup.config.policy.parcel.packaging_weight_g);
 if(!Number.isSafeInteger(weight)||weight<=0||weight>setup.config.policy.parcel.max_weight_g)throw new ShippingError('parcel_too_heavy',422,'The parcel needs a merchant delivery quote');
 const parcel={...setup.config.policy.parcel,weight_g:weight,goods_value_vnd:base.subtotal+base.tax} as Parcel;
 if(parcel.goods_value_vnd>5000000||account&&(weight>account.max_weight_g||account.allowed_district_ids&&!account.allowed_district_ids.includes(base.address.district_id)))throw new ShippingError('carrier_unavailable',422,'The carrier cannot quote this parcel or destination');
 const services=z.array(z.object({service_type_id:z.number().int(),short_name:z.string().max(100)})).max(20).parse(await ghnRequest(config,'v2/shipping-order/available-services',{shop_id:config.shop_id,from_district:config.from_district_id,to_district:base.address.district_id}));
 const type=weight<20000?2:5,service=services.find(s=>s.service_type_id===type);if(!service)throw new ShippingError('carrier_unavailable',503,'No GHN service is available for this destination');
 const feeBody={from_district_id:config.from_district_id,from_ward_code:config.from_ward_code,to_district_id:base.address.district_id,to_ward_code:base.address.ward_code,service_type_id:type,weight,length:parcel.length_cm,width:parcel.width_cm,height:parcel.height_cm,insurance_value:parcel.goods_value_vnd,cod_value:0,...(type===5?{items:[{name:'Parcel',quantity:1,weight,length:parcel.length_cm,width:parcel.width_cm,height:parcel.height_cm}]}:{})};
 if(setup.config.policy.delivery_deadline_mode==='strict'){const lead=z.object({leadtime:z.number().int().positive()}).safeParse(await ghnRequest(config,'v2/shipping-order/leadtime',feeBody));if(!lead.success||lead.data.leadtime*1000>Date.now()+setup.config.policy.max_delivery_hours*3600000)throw new ShippingError('delivery_deadline_unavailable',503,'The carrier has not confirmed the required delivery deadline');}
 let codValue=cod?parcel.goods_value_vnd:0,fee:{total:number}|undefined,charged:ReturnType<typeof applySubsidy>|undefined,stable=false;
 for(let attempt=0;attempt<4;attempt++){fee=z.object({total:z.number().int().nonnegative().max(1000000000)}).parse(await ghnRequest(config,'v2/shipping-order/fee',{...feeBody,cod_value:codValue}));charged=applySubsidy(fee.total,parcel.goods_value_vnd,setup.config.policy);const next=cod?parcel.goods_value_vnd+charged.customer_fee_vnd:0;if(next===codValue){stable=true;break;}codValue=next;}
 if(!stable||!fee||!charged)throw new ShippingError('cod_fee_unstable',502,'COD fee did not stabilize; request a new quote');
 const offers=[{service_name:service.short_name,customer_fee_vnd:charged.customer_fee_vnd}];
 await c.var.db.checkoutCarrierSave(id,key,base.version,offers.map((offer,index)=>({id:'carrier:'+key+':'+index,title:offer.service_name+' (GHN)',amount:offer.customer_fee_vnd,currency:'VND' as const})),carrierContext(c.env),{provider:'ghn',service_type_id:type,account_id:account?.id||'legacy-ghn',execution_owner:account?.execution_owner||'pancake',environment:config.environment,shop_id:config.shop_id,pos_partner_id:account?.pancake_partner_id,pos_account_id:account?.pancake_account_id||Number(c.env.PANCAKE_GHN_ACCOUNT_ID)||undefined,payment_method:cod?'cod':'prepaid',cod_value_vnd:codValue,carrier_fee_vnd:fee.total,subsidy_vnd:charged.subsidy_vnd,customer_fee_vnd:charged.customer_fee_vnd,parcel});
 return callCheckout(c.var.db,{action:'update',id,source,key:key+':carrier',version:base.version,patch:{carrier_quote_id:key},browser:true});
}
