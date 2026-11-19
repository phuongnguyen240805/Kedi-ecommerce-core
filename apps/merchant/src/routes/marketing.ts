import {Hono} from 'hono';
import {z} from 'zod';
import {authMiddleware,adminOnly} from '../middleware/auth';
import {ApiError,type HonoEnv} from '../types';
import {subscriptionInput} from '../lib/marketing-core';
import {verifyMarketingToken,verifyMailgunSignature} from '../lib/marketing-tokens';
export const marketing=new Hono<HonoEnv>();
async function json(request:Request){const reader=request.body?.getReader();if(!reader)throw ApiError.invalidRequest('JSON required');const chunks:Uint8Array[]=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>64000){await reader.cancel();throw ApiError.invalidRequest('Request too large');}chunks.push(value);}const bytes=new Uint8Array(size);let off=0;for(const chunk of chunks){bytes.set(chunk,off);off+=chunk.length;}return JSON.parse(new TextDecoder().decode(bytes));}
marketing.get('/status',c=>c.json({enabled:c.env.MARKETING_ENABLED==='true',policy_version:c.env.MARKETING_POLICY_VERSION||null}));
marketing.post('/confirm',async c=>{
 const {token}=z.object({token:z.string().max(4000)}).strict().parse(await json(c.req.raw));
 let claims;try{claims=await verifyMarketingToken(c.env,token,'confirm');}catch{throw ApiError.invalidRequest('Invalid or expired confirmation');}
 if(typeof claims.nonce!=='string')throw ApiError.invalidRequest('Invalid confirmation');
 await c.var.db.marketingConfirm(claims.subscriber_id,claims.nonce,c.env.MARKETING_POLICY_VERSION||'');
 let coupon:string|null=null;
 if(c.env.MARKETING_WELCOME_DISCOUNT_CODE){const [offer]=await c.var.db.query<{code:string}>("SELECT code FROM discounts WHERE code=? AND status='active' AND (expires_at IS NULL OR julianday(expires_at)>julianday('now')) AND (starts_at IS NULL OR julianday(starts_at)<=julianday('now'))",[c.env.MARKETING_WELCOME_DISCOUNT_CODE]);coupon=offer?.code||null;}
 return c.json({confirmed:true,coupon});
});
marketing.post('/unsubscribe',async c=>{
 let token=c.req.query('token');if(!token)token=z.object({token:z.string().max(4000)}).parse(await json(c.req.raw)).token;
 let claims;try{claims=await verifyMarketingToken(c.env,token,'unsubscribe');}catch{throw ApiError.invalidRequest('Invalid unsubscribe link');}
 return c.json(await c.var.db.marketingUnsubscribe(claims.subscriber_id));
});
marketing.post('/mailgun',async c=>{
 const input=z.object({signature:z.object({timestamp:z.string(),token:z.string().min(1).max(200),signature:z.string()}),'event-data':z.object({id:z.string(),event:z.string(),recipient:z.string(),severity:z.string().optional(),'user-variables':z.object({marketing_job_id:z.string(),store_id:z.string()})}).passthrough()}).parse(await json(c.req.raw));
 if(!await verifyMailgunSignature(c.env.MAILGUN_WEBHOOK_SIGNING_KEY||'',input.signature))throw ApiError.unauthorized('Invalid webhook signature');
 const event=input['event-data'];if(event['user-variables'].store_id!==(c.env.STORE_ID||'default'))throw ApiError.forbidden('Wrong event store');
 return c.json(await c.var.db.marketingEvent({id:event.id,token:input.signature.token,job_id:event['user-variables'].marketing_job_id,email:event.recipient,event:event.event,permanent:event.severity==='permanent'}));
});
marketing.post('/recovery',async c=>{
 const {token}=z.object({token:z.string().max(4000)}).parse(await json(c.req.raw));
 let claims;try{claims=await verifyMarketingToken(c.env,token,'recovery');}catch{throw ApiError.invalidRequest('Invalid recovery link');}
 await c.var.db.marketingInit();
 const [cart]=await c.var.db.query<{id:string;expires_at:string}>(`SELECT c.id,c.expires_at FROM carts c JOIN marketing_subscribers s ON lower(c.customer_email)=s.email WHERE c.id=? AND s.id=?`,[claims.cart_id,claims.subscriber_id]);
 if(!cart||Date.parse(cart.expires_at)<=Date.now())throw ApiError.invalidRequest('This cart has expired');
 const [checkout]=await c.var.db.query<{checkout_id:string}>('SELECT checkout_id FROM pod_checkouts WHERE cart_id=?',[cart.id]);
 const [quote]=await c.var.db.query<{snapshot:string}>('SELECT snapshot FROM pod_quotes WHERE cart_id=? ORDER BY expires_at DESC LIMIT 1',[cart.id]);
 let draft:unknown=null;
 if(quote){const data=JSON.parse(quote.snapshot),line=data.lines?.[0];if(line){const [art]=await c.var.db.query('SELECT id,width,height,sha256,approved_at FROM pod_artworks WHERE id=? AND cart_id=?',[line.artwork_id,cart.id]);draft={sku:line.sku,qty:line.qty,art,recipient:data.recipient};}}
 return c.json({scope:quote||checkout?'pod':'commerce',cart_id:cart.id,checkout_id:checkout?.checkout_id||null,draft});
});
marketing.use('*',authMiddleware,adminOnly);
marketing.post('/subscribe',async c=>{
 if(c.env.MARKETING_ENABLED!=='true'||!c.env.MARKETING_POLICY_VERSION)throw ApiError.serviceUnavailable('Email registration is not available');
 return c.json(await c.var.db.marketingSubscribe(subscriptionInput.parse(await json(c.req.raw)),c.env.MARKETING_POLICY_VERSION));
});
marketing.get('/admin/overview',async c=>{
 await c.var.db.marketingInit();
 return c.json({subscribers:await c.var.db.query('SELECT status,count(*) count FROM marketing_subscribers GROUP BY status',[]),jobs:await c.var.db.query('SELECT kind,state,count(*) count FROM marketing_jobs GROUP BY kind,state',[]),
  attributed_revenue:await c.var.db.query("SELECT o.currency,SUM(o.total_cents-COALESCE((SELECT SUM(r.amount_cents) FROM refunds r WHERE r.order_id=o.id AND r.status='succeeded'),0)) net_revenue_minor,COUNT(*) orders FROM marketing_attribution a JOIN orders o ON o.id=a.order_id WHERE o.status NOT IN ('pending','canceled','refunded') GROUP BY o.currency",[]),model:'last_click_7d_not_incremental_lift'});
});
