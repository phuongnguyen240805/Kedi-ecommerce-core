import {z} from '@hono/zod-openapi';

export class ShippingError extends Error {
  constructor(public code:string,public status:number,message:string){super(message);}
}
const positive=z.number().int().positive().max(2_000_000_000);
const amount=z.number().int().nonnegative().max(2_000_000_000);
export const destinationSchema=z.object({district_id:positive,ward_code:z.string().regex(/^[A-Za-z0-9]{1,12}$/)}).strict();
export const quoteRequestSchema=z.object({cart_id:z.string().uuid(),destination:destinationSchema,
  payment_method:z.enum(['prepaid','cod']).default('prepaid'),deliver_by:z.string().datetime({offset:true}).optional()}).strict();
export type QuoteRequest=z.infer<typeof quoteRequestSchema>;
export const policySchema=z.object({version:z.string().min(1).max(50),max_delivery_hours:positive.max(168),
  delivery_deadline_mode:z.enum(['strict','preferred']).default('strict'),
  subsidy_vnd:amount.default(0),free_shipping_from_vnd:positive.optional(),
  allowed_district_ids:z.array(positive).max(1000).optional(),
  parcel:z.object({length_cm:positive.max(200),width_cm:positive.max(200),height_cm:positive.max(200),
    max_weight_g:positive.max(50_000),packaging_weight_g:amount.max(5000).default(0)}).strict(),
}).strict();
export type ShippingPolicy=z.infer<typeof policySchema>;
export type ShippingEnv={SMART_SHIPPING_ENABLED?:string;SMART_SHIPPING_POLICY?:string;GHN_TOKEN?:string;GHN_SHOP_ID?:string;
  GHN_FROM_DISTRICT_ID?:string;GHN_FROM_WARD_CODE?:string;GHN_ENVIRONMENT?:string};
export function shippingConfiguration(env:ShippingEnv){
  if(env.SMART_SHIPPING_ENABLED!=='true')throw new ShippingError('shipping_disabled',503,'Smart Shipping chưa được bật.');
  let policy:ShippingPolicy;
  try{policy=policySchema.parse(JSON.parse(env.SMART_SHIPPING_POLICY||''));}
  catch{throw new ShippingError('shipping_policy_missing',503,'Chưa cấu hình quy cách kiện hàng và thời hạn giao.');}
  const config=z.object({token:z.string().min(8),shop_id:positive,from_district_id:positive,from_ward_code:z.string().regex(/^[A-Za-z0-9]{1,12}$/),
    environment:z.enum(['production','staging'])}).safeParse({token:env.GHN_TOKEN,shop_id:Number(env.GHN_SHOP_ID),from_district_id:Number(env.GHN_FROM_DISTRICT_ID),
      from_ward_code:env.GHN_FROM_WARD_CODE,environment:env.GHN_ENVIRONMENT||'production'});
  if(!config.success)throw new ShippingError('ghn_configuration_missing',503,'Chưa cấu hình API GHN và địa chỉ kho lấy hàng.');
  return {...config.data,policy};
}
export type ShippingConfig=ReturnType<typeof shippingConfiguration>;
export type ShippingItem={sku:string;qty:number;unit_price_cents:number;currency:string;weight_g:number;requires_shipping:number;
  variant_status:string;product_status:string;current_price:number;available:number};
export type ShippingCart={tax_extra_vnd?:number;id:string;status:string;currency:string;region_id:string|null;expires_at:string;
  discount_code:string|null;discount_amount_cents:number;address:unknown[];items:ShippingItem[]};
export function validateShippingCart(cart:ShippingCart,policy:ShippingPolicy,now=Date.now()){
  if(cart.status!=='open'||!Number.isFinite(Date.parse(cart.expires_at))||Date.parse(cart.expires_at)<=now)throw new ShippingError('cart_expired',409,'Giỏ hàng đã đóng hoặc hết hạn.');
  if(cart.currency!=='VND'||!cart.items.length)throw new ShippingError('cart_invalid',400,'Cần giỏ hàng VND có sản phẩm.');
  let grams=policy.parcel.packaging_weight_g,subtotal=0,physical=0;
  for(const item of cart.items){
    if(!Number.isSafeInteger(item.qty)||item.qty<=0||item.qty>1000||item.currency!=='VND'||!Number.isSafeInteger(item.unit_price_cents)||item.unit_price_cents<=0)
      throw new ShippingError('cart_invalid',409,'Số lượng hoặc giá giỏ hàng không hợp lệ.');
    if(item.current_price!==item.unit_price_cents||item.variant_status!=='active'||item.product_status!=='active')
      throw new ShippingError('cart_changed',409,'Giá hoặc trạng thái sản phẩm đã đổi. Cập nhật giỏ trước khi tính phí.');
    if(item.requires_shipping){
      physical++;if(item.available<item.qty)throw new ShippingError('insufficient_stock',409,'Sản phẩm không đủ tồn khả dụng.');
      if(!Number.isSafeInteger(item.weight_g)||item.weight_g<=0)throw new ShippingError('weight_missing',422,'Sản phẩm chưa có trọng lượng giao hàng.');
      grams+=item.weight_g*item.qty;
    }
    subtotal+=item.unit_price_cents*item.qty;
  }
  if(!physical)throw new ShippingError('shipping_not_required',400,'Giỏ hàng không cần vận chuyển.');
  if(!Number.isSafeInteger(grams)||grams>policy.parcel.max_weight_g)throw new ShippingError('parcel_too_heavy',422,'Giỏ vượt quy cách kiện hàng đã cấu hình.');
  const discount=cart.discount_amount_cents||0;
  if(!Number.isSafeInteger(subtotal)||subtotal>2_000_000_000||!Number.isSafeInteger(discount)||discount<0||discount>subtotal)
    throw new ShippingError('cart_invalid',409,'Giá trị giỏ hàng không hợp lệ.');
  return {weight_g:grams,goods_value_vnd:subtotal-discount+(cart.tax_extra_vnd||0),...policy.parcel};
}
export type Parcel=ReturnType<typeof validateShippingCart>;
export type ShippingOffer={id:string;provider:string;service_type_id:number;service_name:string;currency:'VND';
  meets_delivery_deadline?:boolean;
  carrier_fee_vnd:number;subsidy_vnd:number;customer_fee_vnd:number;cod_value_vnd:number;estimated_delivery_at:string;
  fee_breakdown:Record<string,number>;source:'carrier_api';environment:'production'|'staging'};
export type ProviderContext={config:ShippingConfig;request:QuoteRequest;parcel:Parcel;now:number;signal:AbortSignal};
export type ProviderResult={offers:ShippingOffer[];warnings:{provider:string;code:string}[]};
export type ShippingProvider={code:string;quote:(context:ProviderContext)=>Promise<ProviderResult>};
export function applySubsidy(fee:number,goods:number,policy:ShippingPolicy){
  if(!Number.isSafeInteger(fee)||fee<0||fee>2_000_000_000)throw new ShippingError('carrier_schema',502,'Phí hãng trả về không hợp lệ.');
  const subsidy=policy.free_shipping_from_vnd!==undefined&&goods>=policy.free_shipping_from_vnd?fee:Math.min(fee,policy.subsidy_vnd);
  return {carrier_fee_vnd:fee,subsidy_vnd:subsidy,customer_fee_vnd:fee-subsidy};
}
export function selectCheapest(offers:ShippingOffer[],deadline:number){
  return offers.filter(o=>Number.isFinite(Date.parse(o.estimated_delivery_at))&&Date.parse(o.estimated_delivery_at)<=deadline)
    .sort((a,b)=>a.carrier_fee_vnd-b.carrier_fee_vnd||Date.parse(a.estimated_delivery_at)-Date.parse(b.estimated_delivery_at)||a.id.localeCompare(b.id));
}
export async function hashShipping(value:unknown){
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
export function policyIdentity(config:ShippingConfig){const {token,...publicConfig}=config;return publicConfig;}
export type StoredShippingQuote={id:string;cart_id:string;cart_snapshot:string;policy_key:string;fingerprint:string;
  request:QuoteRequest;offers:ShippingOffer[];recommended_id:string;created_at:number;expires_at:number};
export async function calculateShipping(cart:ShippingCart,request:QuoteRequest,config:ShippingConfig,providers:ShippingProvider[],now=Date.now()){
  const parcel=validateShippingCart(cart,config.policy,now);
  if(config.policy.allowed_district_ids&&!config.policy.allowed_district_ids.includes(request.destination.district_id))
    throw new ShippingError('destination_unavailable',422,'Địa chỉ ngoài khu vực phục vụ đã cấu hình.');
  const policyDeadline=now+config.policy.max_delivery_hours*3_600_000;
  const requestedDeadline=request.deliver_by?Date.parse(request.deliver_by):policyDeadline;
  const deadline=config.policy.delivery_deadline_mode==='preferred'?requestedDeadline:Math.min(policyDeadline,requestedDeadline);
  if(!Number.isFinite(deadline)||deadline<=now)throw new ShippingError('deadline_invalid',400,'Thời hạn giao phải nằm trong tương lai.');
  const signal=AbortSignal.timeout(12_000);
  const results=await Promise.allSettled(providers.map(p=>p.quote({config,request,parcel,now,signal})));
  const offers:ShippingOffer[]=[];const warnings:ProviderResult['warnings']=[];
  results.forEach((r,i)=>{if(r.status==='fulfilled'){offers.push(...r.value.offers);warnings.push(...r.value.warnings);}else warnings.push({provider:providers[i].code,code:r.reason instanceof ShippingError?r.reason.code:'carrier_unavailable'});});
  const annotated=offers.map(o=>({...o,meets_delivery_deadline:Date.parse(o.estimated_delivery_at)<=deadline}));
  const eligible=selectCheapest(annotated,config.policy.delivery_deadline_mode==='preferred'?Infinity:deadline).filter(o=>Date.parse(o.estimated_delivery_at)>=now);
  const excluded_offers=config.policy.delivery_deadline_mode==='preferred'?[]:annotated.filter(o=>Number.isFinite(Date.parse(o.estimated_delivery_at))&&Date.parse(o.estimated_delivery_at)>deadline);
  const expires_at=now+300_000;
  if(!eligible.length)return {quote:null,parcel,excluded_offers,expires_at,warnings:[...warnings,{provider:'engine',code:offers.length?'delivery_deadline_unavailable':'no_carrier_quote'}]};
  const policy_key=await hashShipping(policyIdentity(config));
  const quote:StoredShippingQuote={id:crypto.randomUUID(),cart_id:cart.id,cart_snapshot:JSON.stringify(cart),policy_key,
    fingerprint:await hashShipping({cart,request,parcel,policy_key}),request,offers:eligible,recommended_id:eligible[0].id,created_at:now,expires_at:now+300_000};
  return {quote,parcel,excluded_offers,expires_at,warnings};
}
