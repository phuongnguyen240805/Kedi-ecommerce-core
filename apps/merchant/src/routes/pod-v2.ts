import {Hono} from 'hono';
import {z} from 'zod';
import type {HonoEnv,Env} from '../types';
import {podAddress,podMapping} from '../lib/pod-core';
import {canonicalPod,podEvidence,podFail,podHash,podPrintSpec,podReadBytes,podSha} from '../lib/pod-v2-model';
import {loadPodDesign,readPodSnapshotAsset,sealPodDesign} from '../lib/pod-v2-assets';
import {StagedPrintifyClient} from '../lib/pod-v2-printify';
import {podPaymentKey,podProductionFingerprint,processStagedPod,reconcileStagedResource} from '../lib/pod-v2-runner';
import {startStripeCheckout} from '../lib/ucp-payment-service';
import {storeApiBase} from '../lib/stores';

const json=async(req:Request)=>JSON.parse(new TextDecoder().decode(await podReadBytes(req.body,64000)));
export function podV2Readiness(env:Env){return {enabled:env.POD_NEW_PIPELINE_ENABLED==='true',storage_ready:!!env.IMAGES,provider_configured:!!env.PRINTIFY_API_TOKEN&&!!env.PRINTIFY_SHOP_ID,asset_signing_ready:!!env.ORDER_TOKEN_SECRET&&env.ORDER_TOKEN_SECRET.length>=32,production_enabled:env.POD_PRODUCTION_RELEASE_ENABLED==='true',bank_ready:false};}
const topics=z.enum(['order:updated','order:sent-to-production','order:shipment:created','order:shipment:delivered','order:line-item:canceled']);
export async function verifyPrintifyWebhook(bytes:Uint8Array,signature:string,secrets:string[]){
 if(!/^sha256=[a-f0-9]{64}$/.test(signature))return false;
 const received=Uint8Array.from(signature.slice(7).match(/../g)!,x=>parseInt(x,16));let valid=false;
 for(const secret of secrets){if(secret.length<32)continue;const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);valid=(await crypto.subtle.verify('HMAC',key,received,new Uint8Array(bytes)))||valid;}
 return valid;
}
export function podV2PublicRouter(){
 const router=new Hono<HonoEnv>();
 router.get('/status',c=>c.json(podV2Readiness(c.env)));
 router.get('/assets/:id/:position',async c=>{
  try{await c.var.db.podV2Init();const bytes=await readPodSnapshotAsset(c.var.db,c.env,c.req.param('id'),c.req.param('position'),c.req.query('token')||'');return new Response(bytes,{headers:{'Content-Type':'image/png','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});}
  catch{return c.json({error:'Artwork unavailable'},404);}
 });
 router.post('/webhooks/printify',async c=>{
  if(c.env.POD_WEBHOOK_ENABLED!=='true')return c.json({error:'Webhook disabled'},503);
  const bytes=await podReadBytes(c.req.raw.body,64000);
  if(!await verifyPrintifyWebhook(bytes,c.req.header('X-Pfy-Signature')||'',[c.env.PRINTIFY_WEBHOOK_SECRET||'',c.env.PRINTIFY_WEBHOOK_PREVIOUS_SECRET||'']))return c.json({error:'Invalid webhook'},401);
  const event=z.object({id:z.string().min(1).max(150),type:topics,resource:z.object({id:z.string().min(1).max(150),type:z.literal('order'),data:z.object({shop_id:z.union([z.string(),z.number()])}).passthrough()}).passthrough()}).passthrough().parse(JSON.parse(new TextDecoder().decode(bytes)));
  if(String(event.resource.data.shop_id)!==c.env.PRINTIFY_SHOP_ID)return c.json({error:'Invalid shop'},403);
  await c.var.db.podV2({action:'inbox',store:c.env.STORE_ID||'default',event_id:event.id,digest:await podSha(bytes),order_id:event.resource.id,topic:event.type});
  return c.json({received:true}); // Cron performs provider GET; no side-effect during webhook acknowledgement.
 });
 return router;
}
export function podV2AdminRouter(deps:{provider?:StagedPrintifyClient;stripe?:typeof startStripeCheckout}={}){
 const router=new Hono<HonoEnv>();
 router.use('*',async(c,next)=>{await c.var.db.podV2Init();c.header('Cache-Control','private, no-store');await next();});
 const provider=(env:Env)=>deps.provider||new StagedPrintifyClient(env.PRINTIFY_API_TOKEN||'',env.PRINTIFY_SHOP_ID||'');
 router.post('/admin/specs',async c=>{
  const input=z.object({spec:podPrintSpec,evidence:podEvidence}).strict().parse(await json(c.req.raw));
  const hash=await provider(c.env).verifyCatalog(input.spec);if(hash!==input.spec.catalog_hash)podFail('pod_catalog_hash_mismatch');
  return c.json(await c.var.db.podV2({action:'spec',store:c.env.STORE_ID||'default',id:crypto.randomUUID(),body:input.spec,actor:c.var.auth.sub||c.var.auth.email||'admin-api-key',evidence:input.evidence}),201);
 });
 router.post('/admin/specs/check',async c=>{const spec=podPrintSpec.parse(await json(c.req.raw));return c.json({catalog_hash:await provider(c.env).verifyCatalog(spec)});});
 router.get('/admin/specs',async c=>c.json({items:await c.var.db.query('SELECT id,sku,body,actor,evidence,created_at FROM pod_v2_specs WHERE store_id=? ORDER BY created_at DESC LIMIT 100',[c.env.STORE_ID||'default'])}));
 router.post('/admin/mappings/activate',async c=>{
  const input=z.object({spec_id:z.string().uuid(),mapping:podMapping,evidence:podEvidence}).strict().parse(await json(c.req.raw));
  const [row]=await c.var.db.query<{body:string}>('SELECT body FROM pod_v2_specs WHERE id=? AND store_id=?',[input.spec_id,c.env.STORE_ID||'default']);if(!row)podFail('pod_spec_missing');
  const spec=podPrintSpec.parse(JSON.parse(row.body));if(await provider(c.env).verifyCatalog(spec)!==spec.catalog_hash)podFail('pod_catalog_drift');
  return c.json(await c.var.db.podV2({action:'activate',store:c.env.STORE_ID||'default',...input,actor:c.var.auth.sub||c.var.auth.email||'admin-api-key'}));
 });
 router.get('/print-specs/:sku',async c=>{
  const [row]=await c.var.db.query<{id:string;body:string}>('SELECT id,body FROM pod_v2_specs WHERE store_id=? AND sku=? ORDER BY created_at DESC LIMIT 1',[c.env.STORE_ID||'default',c.req.param('sku')]);if(!row)podFail('pod_spec_missing');
  const spec=podPrintSpec.parse(JSON.parse(row.body));if(spec.valid_until<=Date.now())podFail('pod_spec_expired');
  return c.json({id:row.id,sku:spec.sku,valid_until:spec.valid_until,placements:spec.placements.map(({position,decoration_method,width_px,height_px,width_in,height_in,min_dpi,safe_inset_px})=>({position,decoration_method,width_px,height_px,width_in,height_in,min_dpi,safe_inset_px}))});
 });
 router.post('/design-snapshots',async c=>{if(c.env.POD_NEW_PIPELINE_ENABLED!=='true')podFail('pod_v2_disabled');return c.json(await sealPodDesign(c.var.db,c.env,await json(c.req.raw)),201);});
 router.post('/quotes',async c=>{
  if(c.env.POD_NEW_PIPELINE_ENABLED!=='true')podFail('pod_v2_disabled');if(!c.env.IMAGES)podFail('pod_r2_missing');
  const input=z.object({cart_id:z.string().uuid(),recipient:podAddress,snapshot_ids:z.array(z.string().uuid()).min(1).max(20),quantities:z.array(z.number().int().min(1).max(99)).min(1).max(20)}).strict().parse(await json(c.req.raw));
  if(input.snapshot_ids.length!==input.quantities.length||new Set(input.snapshot_ids).size!==input.snapshot_ids.length)podFail('pod_snapshot_lines_mismatch');
  const store=c.env.STORE_ID||'default',snapshots=await Promise.all(input.snapshot_ids.map(id=>loadPodDesign(c.var.db,store,id,input.cart_id)));
  const plan=await c.var.db.podPlan({cart_id:input.cart_id,recipient:input.recipient,lines:snapshots.map((s,i)=>({sku:s.sku,qty:input.quantities[i],artwork_id:s.assets[0].artwork_id}))});
  for(const s of snapshots)if(s.spec.valid_until<=Date.now()||await provider(c.env).verifyCatalog(s.spec)!==s.spec.catalog_hash)podFail('pod_catalog_drift');
  const quote=await c.var.db.podStoreQuote(plan,await provider(c.env).shipping(plan));
  const [stored]=await c.var.db.query<{snapshot:string}>('SELECT snapshot FROM pod_quotes WHERE id=?',[quote.id]);
  const key=await podPaymentKey(c.var.db,c.env);
  await c.var.db.podV2({action:'bind',store,quote_id:quote.id,binding:{shop_id:c.env.PRINTIFY_SHOP_ID||'',snapshots,payment_environment:key?.startsWith('sk_live_')?'live':'test',quote_hash:await podSha(canonicalPod(JSON.parse(stored.snapshot)))}});
  return c.json(quote);
 });
 router.post('/checkout',async c=>{
  if(c.env.POD_NEW_PIPELINE_ENABLED!=='true'||!c.env.IMAGES)podFail('pod_v2_not_ready');
  const input=z.object({cart_id:z.string().uuid(),quote_id:z.string().uuid(),expected_total:z.number().int().positive(),success_url:z.string().url(),cancel_url:z.string().url()}).strict().parse(await json(c.req.raw));
  const store=c.env.STORE_ID||'default';
  const [binding]=await c.var.db.query<{body:string}>('SELECT body FROM pod_v2_quote_bindings WHERE quote_id=? AND store_id=?',[input.quote_id,store]);if(!binding)podFail('pod_snapshot_quote_required');
  const pinned=JSON.parse(binding.body) as import('../lib/pod-v2-store').PodQuoteBinding;
  for(const reference of pinned.snapshots){const sealed=await loadPodDesign(c.var.db,store,reference.id,input.cart_id);if(sealed.hash!==reference.hash||sealed.spec.valid_until<=Date.now())podFail('pod_snapshot_stale');for(const asset of sealed.assets){const [art]=await c.var.db.query<{approved_at:number|null;sha256:string}>('SELECT approved_at,sha256 FROM pod_artworks WHERE id=? AND cart_id=?',[asset.artwork_id,input.cart_id]);if(!art?.approved_at||art.sha256!==asset.sha256)podFail('pod_artwork_unapproved');}}
  const checkout=await c.var.db.podCheckout(input.cart_id,input.quote_id,input.expected_total);
  const stripe=await (deps.stripe||startStripeCheckout)(c.var.db,c.env,checkout.id,storeApiBase(c.req.url,c.env),input.success_url,input.cancel_url);
  return c.json({checkout_id:checkout.id,continue_url:stripe.url});
 });
 router.post('/admin/shop/manual-approval',async c=>{
  const input=z.object({evidence:podEvidence,valid_until:z.number().int().positive()}).strict().parse(await json(c.req.raw));
  return c.json(await c.var.db.podV2({action:'approval',store:c.env.STORE_ID||'default',subject_id:c.env.PRINTIFY_SHOP_ID||'',kind:'manual_shop',...input,actor:c.var.auth.sub||c.var.auth.email||'admin-api-key',fingerprint:await podSha('manual-shop:'+c.env.PRINTIFY_SHOP_ID)}));
 });
 router.post('/admin/fulfillments/:id/approve-production',async c=>{
  const input=z.object({evidence:podEvidence,valid_until:z.number().int().positive()}).strict().parse(await json(c.req.raw)),store=c.env.STORE_ID||'default',id=c.req.param('id');
  return c.json(await c.var.db.podV2({action:'approval',store,subject_id:id,kind:'production',...input,actor:c.var.auth.sub||c.var.auth.email||'admin-api-key',fingerprint:await podProductionFingerprint(c.var.db,store,id)}));
 });
 router.get('/admin/operations',async c=>c.json({items:await c.var.db.query('SELECT id,fulfillment_id,line_key,operation,state,resource_id,error_code,attempts,updated_at FROM pod_v2_operations WHERE store_id=? ORDER BY updated_at DESC LIMIT 100',[c.env.STORE_ID||'default'])}));
 router.post('/admin/operations/:id/reconcile',async c=>{const input=z.object({resource_id:z.string().regex(/^[a-zA-Z0-9_-]{1,150}$/),evidence:podEvidence}).strict().parse(await json(c.req.raw));return c.json(await reconcileStagedResource(c.env,c.var.db,c.req.param('id'),input.resource_id,c.var.auth.sub||c.var.auth.email||'admin-api-key',input.evidence,deps.provider));});
 router.get('/admin/health',async c=>c.json({readiness:podV2Readiness(c.env),operations:await c.var.db.query('SELECT state,COUNT(*) count,MIN(updated_at) oldest_at FROM pod_v2_operations WHERE store_id=? GROUP BY state',[c.env.STORE_ID||'default']),inbox:await c.var.db.query('SELECT state,COUNT(*) count,MIN(received_at) oldest_at FROM pod_v2_inbox WHERE store_id=? GROUP BY state',[c.env.STORE_ID||'default'])}));
 router.post('/admin/fulfillments/:id/reconcile',async c=>c.json(await processStagedPod(c.env,c.var.db,c.req.param('id'),storeApiBase(c.req.url,c.env),{client:deps.provider})));
 return router;
}
