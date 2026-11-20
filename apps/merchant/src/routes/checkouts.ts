import {callCheckout} from '../lib/checkout-rpc';
import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import {SignJWT,jwtVerify} from 'jose';
import {authMiddleware,adminOnly} from '../middleware/auth';
import {ApiError,type Env,type HonoEnv} from '../types';
import {checkoutInput} from '../lib/checkout-core';
import {startStripeCheckout,reconcileStripeCheckout} from '../lib/ucp-payment-service';
import {storeApiBase} from '../lib/stores';
export const checkouts=new Hono<HonoEnv>();
export async function checkoutHandoff(env:Env,id:string,expires:string){
 if(!env.ORDER_TOKEN_SECRET||env.ORDER_TOKEN_SECRET.length<32||!env.STORE_URL)throw ApiError.serviceUnavailable('Checkout handoff is not configured');
 const url=new URL('/commerce-handoff',env.STORE_URL);if(url.protocol!=='https:')throw ApiError.serviceUnavailable('HTTPS storefront required');
 const exp=Math.floor(Date.parse(expires)/1000),iat=exp-3600;
 const token=await new SignJWT({purpose:'checkout-handoff',store_id:env.STORE_ID||'default',session_id:id}).setProtectedHeader({alg:'HS256'}).setIssuedAt(iat).setExpirationTime(exp).setJti(id).sign(new TextEncoder().encode(env.ORDER_TOKEN_SECRET));
 url.hash=new URLSearchParams({token}).toString();return url.href;
}
checkouts.get('/catalog',async c=>{
 if(c.env.CHECKOUT_ENABLED!=='true')throw ApiError.serviceUnavailable('Checkout is disabled');
 await c.var.db.podInit();
 const rows=await c.var.db.query(`SELECT v.sku,v.title,vp.price_cents unit_price,cur.code currency,MAX(0,COALESCE(i.on_hand-i.reserved,0)) available FROM variants v JOIN products p ON p.id=v.product_id JOIN variant_prices vp ON vp.variant_id=v.id JOIN currencies cur ON cur.id=vp.currency_id LEFT JOIN inventory i ON i.sku=v.sku WHERE v.status='active' AND p.status='active' AND cur.status='active' AND v.requires_shipping=1 AND v.weight_g>0 AND vp.price_cents>0 AND COALESCE(i.on_hand-i.reserved,0)>0 AND NOT EXISTS(SELECT 1 FROM pod_mappings pm WHERE pm.sku=v.sku AND json_extract(pm.config,'$.enabled')=1) ORDER BY v.sku,cur.code LIMIT 500`,[]);
 return c.json({items:rows});
});
checkouts.get('/status',c=>c.json({enabled:c.env.CHECKOUT_ENABLED==='true',stripe_configured:!!c.env.STRIPE_SECRET_KEY,storefront_configured:!!c.env.STORE_URL,artwork_upload_enabled:false}));
checkouts.use('*',bodyLimit({maxSize:32000}),async(c,next)=>{
 const token=c.env.CHECKOUT_BFF_TOKEN;
 if(token&&token.length>=32){const encoder=new TextEncoder(),key=await crypto.subtle.importKey('raw',encoder.encode(token),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);if(await crypto.subtle.verify('HMAC',key,await crypto.subtle.sign('HMAC',key,encoder.encode('Bearer '+token)),encoder.encode(c.req.header('Authorization')||''))){await next();return;}}
 await authMiddleware(c,async()=>{await adminOnly(c,next);});
});
checkouts.use('*',async(c,next)=>{c.header('Cache-Control','private, no-store');if(c.req.method!=='GET'&&c.env.CHECKOUT_ENABLED!=='true')throw ApiError.serviceUnavailable('Checkout is disabled');await next();});
checkouts.get('/readiness',async c=>c.json({...await c.var.db.checkoutReadiness(z.string().max(200).parse(c.req.query('cursor')||'')),integrations:{stripe_key_present:!!c.env.STRIPE_SECRET_KEY,stripe_webhook_present:!!c.env.STRIPE_WEBHOOK_SECRET,stripe_mode:c.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')?'test':c.env.STRIPE_SECRET_KEY?.startsWith('sk_live_')?'live':'unknown',feeds_enabled:c.env.FEEDS_ENABLED==='true',marketing_enabled:c.env.MARKETING_ENABLED==='true',marketing_send_enabled:c.env.MARKETING_SEND_ENABLED==='true',mailgun_key_present:!!c.env.MAILGUN_API_KEY,mailgun_signing_key_present:!!c.env.MAILGUN_WEBHOOK_SIGNING_KEY,marketing_policy_present:!!c.env.MARKETING_POLICY_VERSION,marketing_sender_present:!!c.env.MARKETING_FROM_EMAIL,marketing_contact_present:!!c.env.MARKETING_CONTACT_ADDRESS,mcp_deferred:true,pod_deferred:true}}));
checkouts.post('/',async c=>{const key=z.string().uuid().parse(c.req.header('Idempotency-Key'));return c.json(await callCheckout(c.var.db,{action:'create',input:checkoutInput.parse(await c.req.json()),source:'web',key}),201);});
checkouts.post('/handoff',async c=>{
 const {token}=z.object({token:z.string().min(20).max(3000)}).strict().parse(await c.req.json());if(!c.env.ORDER_TOKEN_SECRET||c.env.ORDER_TOKEN_SECRET.length<32)throw ApiError.serviceUnavailable('Handoff is not configured');
 let id:string;try{const {payload}=await jwtVerify(token,new TextEncoder().encode(c.env.ORDER_TOKEN_SECRET),{algorithms:['HS256'],requiredClaims:['exp','iat','jti']});if(payload.purpose!=='checkout-handoff'||payload.store_id!==(c.env.STORE_ID||'default')||payload.jti!==payload.session_id)throw Error();id=z.string().uuid().parse(payload.session_id);}catch{throw ApiError.invalidRequest('Invalid or expired handoff');}
 return c.json(await callCheckout(c.var.db,{action:'redeem',id}));
});
checkouts.get('/:id',async c=>c.json(await callCheckout(c.var.db,{action:'get',id:z.string().uuid().parse(c.req.param('id'))})));
checkouts.post('/:id/quote',async c=>{
 const id=z.string().uuid().parse(c.req.param('id')),key=z.string().uuid().parse(c.req.header('Idempotency-Key'));
 const {version,patch}=z.object({version:z.number().int().positive(),patch:checkoutInput.partial()}).strict().parse(await c.req.json());const current=await callCheckout(c.var.db,{action:'get',id});
 return c.json(await callCheckout(c.var.db,{action:'update',id,patch,source:current.source,key,version,browser:true}));
});
checkouts.post('/:id/reconcile',async c=>{const id=z.string().uuid().parse(c.req.param('id'));const state=await callCheckout(c.var.db,{action:'get',id});if(state.status==='complete_in_progress'&&await c.var.db.checkoutReconcileAllow(id))await reconcileStripeCheckout(c.var.db,c.env,id);return c.json(await callCheckout(c.var.db,{action:'get',id}));});
checkouts.post('/:id/pay',async c=>{
 const id=z.string().uuid().parse(c.req.param('id'));
 const input=z.object({version:z.number().int().positive(),expected_total:z.number().int().positive(),success_url:z.string().url(),cancel_url:z.string().url(),confirmed:z.literal(true)}).strict().parse(await c.req.json());
 const current=await callCheckout(c.var.db,{action:'get',id});if(current.source!=='web'&&!current.claimed)throw ApiError.forbidden('Accept the checkout handoff first');
 if(current.version!==input.version||current.total!==input.expected_total)throw ApiError.invalidRequest('Quote changed; review the current checkout');
 if(!['ready_for_complete','complete_in_progress'].includes(current.status))throw ApiError.invalidRequest('Checkout is not ready');
 return c.json({checkout_id:id,continue_url:(await startStripeCheckout(c.var.db,c.env,id,storeApiBase(c.req.url,c.env),input.success_url,input.cancel_url,{version:input.version,total:input.expected_total})).url});
});
