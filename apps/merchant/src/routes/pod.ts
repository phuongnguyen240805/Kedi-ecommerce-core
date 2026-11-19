import {Hono} from 'hono';
import {z} from 'zod';
import {jwtVerify} from 'jose';
import {authMiddleware,adminOnly} from '../middleware/auth';
import {ApiError,type HonoEnv} from '../types';
import {storeApiBase} from '../lib/stores';
import {podMapping,podQuoteInput} from '../lib/pod-core';
import {PrintifyClient} from '../lib/pod-printify';
import {startStripeCheckout} from '../lib/ucp-payment-service';
import {processPodFulfillment} from '../lib/pod-runner';
import {inspectPodPng} from '../lib/pod-artwork';

export const pod=new Hono<HonoEnv>();
pod.get('/status',c=>c.json({enabled:c.env.POD_ENABLED==='true',provider:'printify',production_enabled:c.env.POD_SUBMIT_ENABLED==='true'&&c.env.POD_ACCOUNT_AUTOMATION_VERIFIED==='true'}));
pod.get('/assets/:id',async c=>{
 try{
  if(!c.env.ORDER_TOKEN_SECRET||c.env.ORDER_TOKEN_SECRET.length<32||!c.env.IMAGES)throw Error();
  const {payload}=await jwtVerify(c.req.query('token')||'',new TextEncoder().encode(c.env.ORDER_TOKEN_SECRET),{algorithms:['HS256']});
  if(payload.purpose!=='pod-artwork'||payload.artwork_id!==c.req.param('id')||payload.store_id!==(c.env.STORE_ID||'default'))throw Error();
  await c.var.db.podInit();
  const [art]=await c.var.db.query<{object_key:string;sha256:string;approved_at:number}>('SELECT * FROM pod_artworks WHERE id=?',[c.req.param('id')]);
  if(!art?.approved_at||art.sha256!==payload.sha256)throw Error();
  const object=await c.env.IMAGES.get(art.object_key);if(!object)throw Error();
  return new Response(object.body,{headers:{'Content-Type':'image/png','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
 }catch{return c.json({error:'Artwork unavailable'},404);}
});
pod.use('*',authMiddleware,adminOnly);
pod.use('*',async(c,next)=>{
 if(c.env.POD_ENABLED!=='true')return c.json({error:'POD is disabled for this store'},503);
 await c.var.db.podInit();c.header('Cache-Control','private, no-store');await next();
});
async function json(c:{req:{raw:Request}}){
 const reader=c.req.raw.body?.getReader();if(!reader)throw ApiError.invalidRequest('JSON required');
 const chunks:Uint8Array[]=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>64000){await reader.cancel();throw ApiError.invalidRequest('Request too large');}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder().decode(bytes));
}
pod.post('/carts',async c=>{
 const {email}=z.object({email:z.string().email().max(254)}).strict().parse(await json(c));
 const [currency]=await c.var.db.query("SELECT id FROM currencies WHERE code='USD' AND status='active'",[]);if(!currency)throw ApiError.serviceUnavailable('USD is not configured');
 const id=crypto.randomUUID(),expires_at=new Date(Date.now()+86400000).toISOString();
 await c.var.db.run("INSERT INTO carts(id,customer_email,currency,expires_at) VALUES(?,?,'USD',?)",[id,email,expires_at]);return c.json({id,currency:'USD',expires_at},201);
});
pod.get('/catalog',async c=>c.json({items:await c.var.db.query(`SELECT v.sku,v.title,p.image_url,vp.price_cents AS price_minor,'USD' AS currency FROM pod_mappings m JOIN variants v ON v.sku=m.sku JOIN products p ON p.id=v.product_id JOIN variant_prices vp ON vp.variant_id=v.id JOIN currencies cur ON cur.id=vp.currency_id AND cur.code='USD' WHERE v.status='active' AND p.status='active' AND json_extract(m.config,'$.enabled')=1 ORDER BY v.sku LIMIT 500`,[])}));
pod.put('/mappings/:sku',async c=>{
 const config=podMapping.parse(await json(c)),version=crypto.randomUUID();
 await c.var.db.run('INSERT INTO pod_mappings VALUES(?,?,?) ON CONFLICT(sku) DO UPDATE SET version=excluded.version,config=excluded.config',[c.req.param('sku'),version,JSON.stringify(config)]);
 return c.json({version});
});
pod.post('/artworks',async c=>{
 if(!c.env.IMAGES)throw ApiError.serviceUnavailable('Artwork storage is not configured');
 const cartId=z.string().uuid().parse(c.req.header('X-Cart-Id'));
 const [cart]=await c.var.db.query<{status:string}>('SELECT status FROM carts WHERE id=?',[cartId]);
 if(cart?.status!=='open')throw ApiError.invalidRequest('Open cart required');
 if(c.req.header('Content-Type')!=='image/png')throw ApiError.invalidRequest('Upload a PNG print file');
 const reader=c.req.raw.body?.getReader();if(!reader)throw ApiError.invalidRequest('PNG required');
 const chunks:Uint8Array[]=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>20_000_000){await reader.cancel();throw ApiError.invalidRequest('Artwork exceeds 20 MB');}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 let dimensions:{width:number;height:number};try{dimensions=inspectPodPng(bytes);}catch{throw ApiError.invalidRequest('Invalid PNG print file');}
 const {width,height}=dimensions;
 const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
 const id=crypto.randomUUID(),key=`pod-artworks/${id}.png`;
 await c.env.IMAGES.put(key,bytes,{httpMetadata:{contentType:'image/png'}});
 await c.var.db.run('INSERT INTO pod_artworks(id,cart_id,object_key,sha256,width,height) VALUES(?,?,?,?,?,?)',[id,cartId,key,sha256,width,height]);
 return c.json({id,width,height,sha256,status:'awaiting_review'},201);
});
pod.post('/artworks/:id/approve',async c=>{
 const {evidence}=z.object({evidence:z.string().min(10).max(1000)}).strict().parse(await json(c));
 return c.json(await c.var.db.podApprove(c.req.param('id'),JSON.stringify({evidence,actor:c.var.auth.sub||c.var.auth.email||'admin-api-key'})));
});
pod.get('/artworks/:id',async c=>{
 const [row]=await c.var.db.query('SELECT id,width,height,sha256,approved_at FROM pod_artworks WHERE id=? AND cart_id=?',[c.req.param('id'),c.req.query('cart_id')||'']);
 if(!row)throw ApiError.notFound('Artwork not found');return c.json(row);
});
pod.post('/quotes',async c=>{
 const plan=await c.var.db.podPlan(podQuoteInput.parse(await json(c)));
 const shipping=await new PrintifyClient(c.env.PRINTIFY_API_TOKEN||'',c.env.PRINTIFY_SHOP_ID||'').shipping(plan);
 return c.json(await c.var.db.podStoreQuote(plan,shipping));
});
pod.post('/checkout',async c=>{
 const input=z.object({cart_id:z.string().uuid(),quote_id:z.string().uuid(),expected_total:z.number().int().positive(),success_url:z.string().url(),cancel_url:z.string().url()}).strict().parse(await json(c));
 const checkout=await c.var.db.podCheckout(input.cart_id,input.quote_id,input.expected_total);
 const stripe=await startStripeCheckout(c.var.db,c.env,checkout.id,storeApiBase(c.req.url,c.env),input.success_url,input.cancel_url);
 return c.json({checkout_id:checkout.id,continue_url:stripe.url});
});
pod.post('/checkout/resume',async c=>{
 const input=z.object({cart_id:z.string().uuid(),checkout_id:z.string().uuid(),success_url:z.string().url(),cancel_url:z.string().url()}).strict().parse(await json(c));
 const [link]=await c.var.db.query('SELECT checkout_id FROM pod_checkouts WHERE cart_id=? AND checkout_id=?',[input.cart_id,input.checkout_id]);
 if(!link)throw ApiError.notFound('Checkout not found');
 const stripe=await startStripeCheckout(c.var.db,c.env,input.checkout_id,storeApiBase(c.req.url,c.env),input.success_url,input.cancel_url);
 return c.json({checkout_id:input.checkout_id,continue_url:stripe.url});
});
pod.get('/orders/:checkoutId',async c=>{
 const [row]=await c.var.db.query(`SELECT s.id,s.status,s.order_id,o.number,o.total_cents,o.currency,f.state AS fulfillment_status,f.status_json FROM pod_checkouts p JOIN ucp_checkout_sessions s ON s.id=p.checkout_id LEFT JOIN orders o ON o.id=s.order_id LEFT JOIN pod_fulfillments f ON f.order_id=o.id WHERE p.checkout_id=? AND p.cart_id=?`,[c.req.param('checkoutId'),c.req.query('cart_id')||'']);
 if(!row)throw ApiError.notFound('Checkout not found');return c.json(row);
});
pod.get('/admin/fulfillments',async c=>c.json({items:await c.var.db.query('SELECT id,order_id,reference,state,external_id,updated_at FROM pod_fulfillments ORDER BY updated_at DESC LIMIT 100',[])}));
pod.post('/admin/fulfillments/:id/reconcile',async c=>c.json(await processPodFulfillment(c.env,c.var.db,c.req.param('id'),storeApiBase(c.req.url,c.env))));
