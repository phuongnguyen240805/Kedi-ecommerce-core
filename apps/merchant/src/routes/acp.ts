import {callCheckout} from '../lib/checkout-rpc';
import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import {ApiError,type HonoEnv} from '../types';
import {ShippingError} from '../lib/smart-shipping';
import {checkoutAddress,type CheckoutInput} from '../lib/checkout-core';
import {checkoutHandoff} from './checkouts';
export const ACP_VERSION='2026-04-17';
export const acp=new Hono<HonoEnv>();
const item=z.object({id:z.string().min(1).max(200),name:z.string().max(500).optional(),unit_amount:z.number().int().optional()}).strict();
const buyer=z.object({email:z.string().email().max(254),first_name:z.string().max(100).optional(),last_name:z.string().max(100).optional(),full_name:z.string().max(200).optional(),phone_number:z.string().max(30).optional()}).strict();
const fulfillment=z.object({name:z.string().max(100).optional(),phone_number:z.string().max(30).optional(),email:z.string().email().max(254).optional(),address:z.object({name:z.string().max(100),line_one:z.string().max(300),line_two:z.string().max(200).optional(),city:z.string().max(100),state:z.string().max(100).optional(),country:z.string().regex(/^[A-Za-z]{2}$/),postal_code:z.string().max(30)}).strict()}).strict();
export const acpCreate=z.object({currency:z.string().regex(/^[A-Za-z]{3}$/),line_items:z.array(item).min(1).max(50),capabilities:z.object({payment:z.object({handlers:z.array(z.unknown()).max(10)}).strict().optional(),extensions:z.array(z.string()).max(20).optional(),interventions:z.record(z.string(),z.unknown()).optional()}).strict(),buyer:buyer.optional(),fulfillment_details:fulfillment.optional(),locale:z.string().max(30).optional(),timezone:z.string().max(100).optional()}).strict();
export const acpUpdate=z.object({line_items:z.array(item).min(1).max(50).optional(),buyer:buyer.optional(),fulfillment_details:fulfillment.optional()}).strict();
function selection(items:z.infer<typeof item>[]){const counts=new Map<string,number>();for(const i of items)counts.set(i.id,(counts.get(i.id)||0)+1);return [...counts].map(([id,quantity])=>({id,quantity}));}
function address(raw:z.infer<typeof fulfillment>|undefined){if(!raw?.address)return undefined;const a=raw.address;return checkoutAddress.parse({name:raw.name||a.name,phone:raw.phone_number||'',line_one:a.line_one,line_two:a.line_two||'',city:a.city,state:a.state||'',country:a.country.toUpperCase(),postal_code:a.postal_code});}
export async function acpResponse(state:Awaited<ReturnType<import('../types').DOStub['checkoutGet']>>,env:import('../types').Env){
 const closed=['canceled','expired','completed'].includes(state.status),status=closed?state.status:state.status==='complete_in_progress'?'complete_in_progress':'requires_escalation';
 const totals=(type:string,amount:number,display_text:string)=>({type,amount,display_text});
 const response={id:state.id,status,currency:state.currency.toLowerCase(),line_items:state.line_items.map(i=>({id:i.id,item:{id:i.sku},quantity:i.quantity,name:i.title,unit_amount:i.unit_price,totals:[totals('subtotal',i.subtotal,'Products'),totals('tax',i.tax,'Tax'),totals('total',i.total,'Total')]})),totals:[totals('subtotal',state.subtotal,'Products'),totals('tax',state.tax,'Tax'),totals('fulfillment',state.shipping,'Shipping'),totals('total',state.total,'Total')],fulfillment_options:[],messages:closed?[]:[{type:'error',code:'intervention_required',content_type:'plain',content:'Continue on the merchant website to review delivery and authorize payment.',resolution:'requires_buyer_review'}],links:[],capabilities:{},expires_at:state.expires_at,...(!closed&&!state.claimed?{continue_url:await checkoutHandoff(env,state.id,state.expires_at)}:{}),...(state.order_id?{order:{id:state.order_id,checkout_session_id:state.id,permalink_url:new URL('/commerce-checkout?session='+encodeURIComponent(state.id),env.STORE_URL).href}}:{})};return response;
}
acp.onError((error,c)=>{const status=error instanceof z.ZodError?400:error instanceof ShippingError?(error.code==='idempotency_conflict'?422:error.status):error instanceof ApiError?error.statusCode:500;return c.json({type:status>=500?'service_unavailable':'invalid_request',code:error instanceof ShippingError?error.code:error instanceof z.ZodError?'invalid_input':'request_unavailable',message:status===500?'Checkout is unavailable':error instanceof z.ZodError?'Unsupported or invalid checkout fields':error.message},status as 400);});
acp.use('*',bodyLimit({maxSize:32000}),async(c,next)=>{
 c.header('Cache-Control','private, no-store');c.header('API-Version',ACP_VERSION);
 if(c.env.ACP_ENABLED!=='true'||c.env.ACP_ACCESS_VERIFIED!=='true'||c.env.CHECKOUT_ENABLED!=='true')throw ApiError.notFound('ACP is not enabled');
 const token=c.env.ACP_API_TOKEN;if(!token||token.length<32)throw ApiError.serviceUnavailable('ACP authentication is not configured');
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(token),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);const encoder=new TextEncoder();if(!await crypto.subtle.verify('HMAC',key,await crypto.subtle.sign('HMAC',key,encoder.encode('Bearer '+token)),encoder.encode(c.req.header('Authorization')||'')))throw ApiError.unauthorized('Invalid ACP authentication');
 if(c.req.header('API-Version')!==ACP_VERSION)throw ApiError.invalidRequest('Unsupported API-Version; expected '+ACP_VERSION);
 if(c.req.method==='POST'){const value=c.req.header('Idempotency-Key');if(!value||value.length>255)throw new ShippingError('idempotency_key_required',400,'Idempotency-Key is required');c.header('Idempotency-Key',value);}
 await next();
});
acp.post('/checkout_sessions',async c=>{const input=acpCreate.parse(await c.req.json());if(input.capabilities.extensions?.length)throw ApiError.invalidRequest('Extensions are not supported by this handoff adapter');const raw:CheckoutInput={currency:input.currency.toUpperCase(),line_items:selection(input.line_items),buyer:input.buyer?{email:input.buyer.email}:undefined,address:address(input.fulfillment_details)};const state=await callCheckout(c.var.db,{action:'create',input:raw,source:'acp',key:c.req.header('Idempotency-Key')!});return c.json(await acpResponse(state,c.env),201);});
async function owned(db:import('../types').DOStub,id:string){const state=await callCheckout(db,{action:'get',id:z.string().uuid().parse(id)});if(state.source!=='acp')throw ApiError.notFound('Checkout not found');return state;}
acp.get('/checkout_sessions/:id',async c=>c.json(await acpResponse(await owned(c.var.db,c.req.param('id')),c.env)));
acp.post('/checkout_sessions/:id',async c=>{const state=await owned(c.var.db,c.req.param('id')),input=acpUpdate.parse(await c.req.json());const patch:Partial<CheckoutInput>={...(input.line_items?{line_items:selection(input.line_items)}:{}),...(input.buyer?{buyer:{email:input.buyer.email}}:{}),...(input.fulfillment_details?{address:address(input.fulfillment_details),shipping_option_id:undefined}:{})};return c.json(await acpResponse(await callCheckout(c.var.db,{action:'update',id:state.id,patch,source:'acp',key:c.req.header('Idempotency-Key')!}),c.env));});
acp.post('/checkout_sessions/:id/cancel',async c=>{const state=await owned(c.var.db,c.req.param('id'));if(state.claimed)throw ApiError.invalidRequest('Continue this checkout on the merchant website');return c.json(await acpResponse(await callCheckout(c.var.db,{action:'cancel',id:state.id,source:'acp',key:c.req.header('Idempotency-Key')!}),c.env));});
// This adapter never accepts delegated payment credentials or claims a completed order.
acp.post('/checkout_sessions/:id/complete',async c=>{await owned(c.var.db,c.req.param('id'));throw new ShippingError('browser_confirmation_required',409,'Use the continue_url from the checkout state; payment is authorized on the merchant website');});
