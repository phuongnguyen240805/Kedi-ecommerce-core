import {shippingQuoteSetup,shippingLocationConfiguration} from '../lib/shipping-registry';
import {OpenAPIHono,createRoute,z} from '@hono/zod-openapi';
import {authMiddleware,adminOnly} from '../middleware/auth';
import {ApiError,type HonoEnv} from '../types';
import {ShippingError,calculateShipping,quoteRequestSchema,hashShipping,policyIdentity} from '../lib/smart-shipping';
import {ghnRequest} from '../lib/ghn-shipping';
import {unwrapShipping} from '../lib/shipping-store';
const app=new OpenAPIHono<HonoEnv>();app.use('*',authMiddleware);
app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');try{await next();}catch(e){if(e instanceof ShippingError)throw new ApiError(e.code,e.status,e.message);throw e;}});
const generic={description:'Shipping response',content:{'application/json':{schema:z.record(z.string(),z.unknown())}}};
const responses={200:generic,400:{description:'Invalid input'},404:{description:'Cart/quote not found'},409:{description:'Expired or changed quote'},422:{description:'Parcel or destination unsupported'},429:{description:'Retry too soon'},502:{description:'Carrier unavailable'},503:{description:'Shipping not configured'}};
const cartParam=z.object({cartId:z.string().uuid()});
app.openapi(createRoute({method:'get',path:'/status',tags:['Smart Shipping'],responses:{200:generic}}),async c=>{
 try{const {config}=shippingQuoteSetup(c.env);return c.json({enabled:true,ready:true,providers:shippingQuoteSetup(c.env).providers.map(p=>p.code),environment:config.environment,quote_ttl_seconds:300,
  max_delivery_hours:config.policy.max_delivery_hours,delivery_deadline_mode:config.policy.delivery_deadline_mode,subsidy_vnd:config.policy.subsidy_vnd,free_shipping_from_vnd:config.policy.free_shipping_from_vnd||null},200);}
 catch(e){return c.json({enabled:c.env.SMART_SHIPPING_ENABLED==='true',ready:false,providers:[],reason:e instanceof ShippingError?e.message:'Smart Shipping chưa được cấu hình.'},200);}
});
app.openapi(createRoute({method:'post',path:'/quotes',tags:['Smart Shipping'],request:{body:{content:{'application/json':{schema:quoteRequestSchema}}}},responses}),async c=>{
 const {config,providers}=shippingQuoteSetup(c.env);const request=c.req.valid('json');
 const cart=unwrapShipping(await c.var.db.beginShippingQuote(request.cart_id));
 const circuits=await c.var.db.shippingCircuitStatus();
 const available=providers.filter(p=>!circuits.some(b=>b.account_id===p.code&&Number(b.open_until)>Date.now()));
 const result=await calculateShipping(cart,request,config,available);
 await c.var.db.shippingQuoteResults(available.flatMap(p=>{
   const warning=result.warnings.find(w=>w.provider===p.code&&w.code!=='account_ineligible');
   const quoted=[...(result.quote?.offers||[]),...result.excluded_offers].some(o=>(o.account_id||o.provider)===p.code);
   return warning||quoted?[{account_id:p.code,failed:!!warning&&!quoted}]:[];
 }));
 for(const p of providers)if(!available.includes(p))result.warnings.push({provider:p.code,code:'carrier_circuit_open'});
 if(result.quote)unwrapShipping(await c.var.db.storeShippingQuote(result.quote));
 return c.json({quote:result.quote?{id:result.quote.id,cart_id:result.quote.cart_id,fingerprint:result.quote.fingerprint,
  expires_at:result.quote.expires_at,offers:result.quote.offers,recommended_id:result.quote.recommended_id}:null,
  parcel:result.parcel,warnings:result.warnings,excluded_offers:result.excluded_offers,expires_at:result.expires_at},200);
});
app.openapi(createRoute({method:'put',path:'/carts/{cartId}/selection',tags:['Smart Shipping'],request:{params:cartParam,body:{content:{'application/json':{
 schema:z.object({quote_id:z.string().uuid(),option_id:z.string().min(1).max(100)}).strict()}}}},responses}),async c=>{
 const {config}=shippingQuoteSetup(c.env);const {cartId}=c.req.valid('param'),body=c.req.valid('json');
 const selection=unwrapShipping(await c.var.db.selectShippingQuote(cartId,body.quote_id,body.option_id,await hashShipping(policyIdentity(config))));
 return c.json({selection},200);
});
app.openapi(createRoute({method:'get',path:'/carts/{cartId}/selection',tags:['Smart Shipping'],request:{params:cartParam},responses}),async c=>{
 const {cartId}=c.req.valid('param');const {config}=shippingQuoteSetup(c.env);
 return c.json({selection:unwrapShipping(await c.var.db.shippingSelection(cartId,await hashShipping(policyIdentity(config))))},200);
});
app.openapi(createRoute({method:'delete',path:'/carts/{cartId}/selection',tags:['Smart Shipping'],request:{params:cartParam},responses}),async c=>{
 unwrapShipping(await c.var.db.clearShippingSelection(c.req.valid('param').cartId));return c.json({cleared:true},200);
});
// Provider address IDs are a distinct namespace from POS IDs. Read-only lookup,
// with small selected fields; no token or raw provider payload reaches the browser.
app.openapi(createRoute({method:'get',path:'/ghn/locations',tags:['Smart Shipping'],request:{query:z.object({
  level:z.enum(['province','district','ward']),parent_id:z.coerce.number().int().positive().optional()})},responses}),async c=>{
 const config=shippingLocationConfiguration(c.env),q=c.req.valid('query');
 if(q.level!=='province'&&!q.parent_id)throw new ShippingError('location_parent_missing',400,'Cần chọn khu vực cha.');
 const endpoint={province:'master-data/province',district:'master-data/district',ward:'master-data/ward'}[q.level];
 const payload=q.level==='district'?{province_id:q.parent_id}:q.level==='ward'?{district_id:q.parent_id}:{};
 const raw=await ghnRequest(config,endpoint,payload,undefined,'GET');
 const data=z.array(z.record(z.string(),z.unknown())).max(1000).safeParse(raw);
 if(!data.success)throw new ShippingError('ghn_schema',502,'Danh mục địa chỉ GHN không hợp lệ.');
 const keys={province:['ProvinceID','ProvinceName'],district:['DistrictID','DistrictName'],ward:['WardCode','WardName']}[q.level];
 const items=data.data.flatMap(row=>{
  const id=row[keys[0]],name=row[keys[1]];
  if((typeof id!=='number'&&typeof id!=='string')||typeof name!=='string')return [];
  if(q.level==='ward'&&row.SupportType!==2&&row.SupportType!==3)return [];
  return [{id:String(id),name}];
 });return c.json({items,address_model:'ghn_district_ward'},200);
});
app.openapi(createRoute({method:'get',path:'/carts/{cartId}/pos-handoff',tags:['Smart Shipping'],middleware:[adminOnly] as const,request:{params:cartParam},responses}),async c=>{
 const {config}=shippingQuoteSetup(c.env),cartId=c.req.valid('param').cartId;
 const selection=unwrapShipping(await c.var.db.shippingSelection(cartId,await hashShipping(policyIdentity(config))));
 if(!selection)throw new ShippingError('shipping_quote_required',409,'Cần báo giá còn hạn trước khi chuẩn bị giao hàng.');
 return c.json({dispatch_owner:selection.offer.execution_owner||'pancake',shipment_created:false,quote_id:selection.quote_id,expires_at:selection.expires_at,
  carrier:selection.offer.provider,account_id:selection.offer.account_id,service_type_id:selection.offer.service_type_id,carrier_fee_vnd:selection.offer.carrier_fee_vnd,
  customer_fee_vnd:selection.offer.customer_fee_vnd,subsidy_vnd:selection.offer.subsidy_vnd,cod_value_vnd:selection.offer.cod_value_vnd,
  destination:selection.destination,environment:selection.offer.environment},200);
});
export const smartShipping=app;
