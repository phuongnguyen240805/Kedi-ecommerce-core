import Stripe from 'stripe';
import type {DOStub,Env} from '../types';
import type {PodSnapshot} from './pod-core';
import {loadPodDesign,podSnapshotAssetUrl} from './pod-v2-assets';
import {canonicalPod,podFail,podReadBytes,podSha,type PodDesignSnapshot,type PodOperation} from './pod-v2-model';
import {PodProviderError,StagedPrintifyClient,stagedPublicState,type StagedLine,type StagedOrder} from './pod-v2-printify';
import type {PodOperationRow,PodQuoteBinding} from './pod-v2-store';

export async function podV2Binding(db:DOStub,store:string,id:string){
 const [row]=await db.query<{body:string}>(`SELECT b.body FROM pod_fulfillments f JOIN ucp_checkout_sessions s ON s.order_id=f.order_id JOIN pod_checkouts p ON p.checkout_id=s.id JOIN pod_v2_quote_bindings b ON b.quote_id=p.quote_id WHERE f.id=? AND b.store_id=?`,[id,store]);
 return row?JSON.parse(row.body) as PodQuoteBinding:null;
}
export async function podPaymentKey(db:DOStub,env:Env){
 let key=env.STRIPE_SECRET_KEY;if(!key){const [row]=await db.query<{value:string}>("SELECT value FROM config WHERE key='stripe'");try{key=JSON.parse(row?.value||'{}').secret_key;}catch{}}
 return key;
}
async function verifiedLivePayment(db:DOStub,env:Env,id:string){
 const key=await podPaymentKey(db,env);if(!key?.startsWith('sk_live_'))return false;
 const [row]=await db.query<{external_id:string;amount_minor:number;currency:string;checkout_id:string}>(`SELECT r.external_id,r.amount_minor,r.currency,s.id AS checkout_id FROM payment_receipts r JOIN ucp_checkout_sessions s ON s.order_id=r.order_id JOIN pod_fulfillments f ON f.order_id=r.order_id WHERE f.id=? AND r.provider='stripe'`,[id]);
 if(!row)return false;const receipt=await new Stripe(key).checkout.sessions.retrieve(row.external_id,{expand:['payment_intent.latest_charge']});
 const intent=receipt.payment_intent,charge=typeof intent==='object'&&intent?intent.latest_charge:null;
 if(!intent||typeof intent!=='object'||intent.status!=='succeeded'||!charge||typeof charge!=='object'||charge.refunded||charge.amount_refunded>0||charge.disputed)return false;
 return receipt.livemode===true&&receipt.payment_status==='paid'&&receipt.status==='complete'&&receipt.amount_total===row.amount_minor&&receipt.currency?.toUpperCase()===row.currency&&receipt.metadata?.ucp_checkout_session_id===row.checkout_id;
}
export async function podProductionFingerprint(db:DOStub,store:string,id:string){
 const binding=await podV2Binding(db,store,id);if(!binding)podFail('pod_binding_missing');
 const [job]=await db.query<{external_id:string|null;body:string}>('SELECT external_id,body FROM pod_fulfillments WHERE id=?',[id]);if(!job?.external_id)podFail('pod_order_not_created');
 return podSha(canonicalPod({store,id,provider_id:job.external_id,quote_hash:binding.quote_hash,snapshots:binding.snapshots.map(s=>({id:s.id,hash:s.hash})),body:JSON.parse(job.body)}));
}

type StagedDependencies={client?:StagedPrintifyClient;verifyPayment?:()=>Promise<boolean>};
export async function processStagedPod(env:Env,db:DOStub,id:string,base:string,deps:StagedDependencies={}){
 await db.podV2Init();const store=env.STORE_ID||'default';
 if(!await podV2Binding(db,store,id))return {staged:false};
 // Rotate checked jobs behind older work, including held or retry-scheduled jobs, so a batch of ten cannot starve tracking.
 await db.run('UPDATE pod_fulfillments SET updated_at=? WHERE id=?',[Date.now(),id]);
 const [retry]=await db.query<{next_at:number;attempts:number}>('SELECT next_at,attempts FROM pod_v2_retries WHERE store_id=? AND fulfillment_id=?',[store,id]);
 if(retry&&retry.next_at>Date.now())return {state:'retry_scheduled'};
 try{const result=await runStagedPod(env,db,id,base,deps);await db.run('DELETE FROM pod_v2_retries WHERE store_id=? AND fulfillment_id=?',[store,id]);return result;}
 catch(error){
  const code=error instanceof PodProviderError?error.code:typeof error==='object'&&error&&'code' in error&&typeof error.code==='string'&&/^[a-z0-9_]{1,80}$/.test(error.code)?error.code:'pod_review_required';
  const attempt=(retry?.attempts||0)+1,delay=error instanceof PodProviderError&&error.status===429?error.retryAfter*1000:Math.min(1800000,60000*2**Math.min(attempt-1,5));
  await db.run('INSERT INTO pod_v2_retries VALUES(?,?,?,?,?) ON CONFLICT(store_id,fulfillment_id) DO UPDATE SET attempts=excluded.attempts,next_at=excluded.next_at,error_code=excluded.error_code',[store,id,attempt,Date.now()+delay+crypto.getRandomValues(new Uint16Array(1))[0]%5000,code]);
  console.warn(JSON.stringify({event:'pod.v2.needs_attention',store_id:store,fulfillment_id:id,code}));return {state:'needs_review',reason:code};
 }
}
async function runStagedPod(env:Env,db:DOStub,id:string,base:string,deps:StagedDependencies={}){
 await db.podV2Init();const store=env.STORE_ID||'default',binding=await podV2Binding(db,store,id);if(!binding)return {staged:false};
 const [job]=await db.query<{reference:string;body:string;external_id:string|null;state:string}>('SELECT reference,body,external_id,state FROM pod_fulfillments WHERE id=?',[id]);if(!job)podFail('pod_fulfillment_missing');
 const snapshot=JSON.parse(job.body) as PodSnapshot;
 if(binding.shop_id!==env.PRINTIFY_SHOP_ID)podFail('pod_store_account_mismatch');
 const client=deps.client||new StagedPrintifyClient(env.PRINTIFY_API_TOKEN||'',binding.shop_id);
 const operations=()=>db.query<PodOperationRow>('SELECT * FROM pod_v2_operations WHERE store_id=? AND fulfillment_id=?',[store,id]);
 const rows=await operations(),resources=new Map(rows.filter(o=>o.state==='confirmed').map(o=>[o.line_key+':'+o.operation,o.resource_id!]));
 const lines:StagedLine[]=[];
 for(let i=0;i<snapshot.lines.length;i++){
  const s=binding.snapshots[i];if(!s)podFail('pod_snapshot_lines_mismatch');
  const productId=resources.get(s.id+':create_product');if(productId)lines.push({product_id:productId,variant_id:s.spec.variant_id,quantity:snapshot.lines[i].qty,external_id:s.id});
 }
 const reconcile=async(order:StagedOrder)=>{
  if(lines.length!==snapshot.lines.length)podFail('pod_provider_resources_missing');client.verifyOrder(order,job.reference,lines,snapshot.recipient);
  const state=stagedPublicState(order);await db.podV2({action:'project',store,fulfillment_id:id,provider_id:order.id,state,status:{provider_status:order.status,shipments:(order.shipments||[]).map(s=>({...s,url:s.url&&/^https:\/\//.test(s.url)?s.url:undefined}))}});return state;
 };
 // Reconcile confirmed/unknown existing orders even while write gates are OFF or payment is now refunded.
 if(job.external_id){const order=await client.order(job.external_id);await reconcile(order);if(!['pending'].includes(order.status))return {state:stagedPublicState(order)};}
 const unknownOrder=rows.find(o=>o.operation==='create_order'&&o.state!=='confirmed');
 if(unknownOrder){
  const found=await client.findOrder(job.reference);if(!found)return {state:'submission_unknown'};
  client.verifyOrder(found,job.reference,lines,snapshot.recipient);
  // A still-active call may complete itself. Only reconcile expired/unknown intents.
  if(unknownOrder.state==='in_flight'&&unknownOrder.lease_until>Date.now())return {state:'in_flight'};
  await db.podV2({action:'resolve',store,id:unknownOrder.id,resource_id:found.id,proof:{provider_id:found.id},actor:'provider-reconciler',evidence:'Authoritative shop GET matches external reference and every product line.'});
  await reconcile(found);return {state:'accepted'};
 }
 if(env.POD_NEW_PIPELINE_ENABLED!=='true'||env.POD_ENABLED!=='true'||env.POD_SUBMIT_ENABLED!=='true'||env.POD_ACCOUNT_AUTOMATION_VERIFIED!=='true')return {state:'writes_disabled'};
 if(!env.IMAGES)return {state:'storage_unconfigured'};
 if(!deps.verifyPayment&&binding.payment_environment!=='live')return {state:'live_payment_required'};
 if(!await (deps.verifyPayment?deps.verifyPayment():verifiedLivePayment(db,env,id)))return {state:'live_payment_required'};
 if(await podSha(canonicalPod(snapshot))!==binding.quote_hash)podFail('pod_quote_hash_mismatch');
 const execute=async(line:string,operation:PodOperation,fingerprint:string,enabled:boolean,work:(capture:(id:string)=>void)=>Promise<{id:string;proof?:unknown}>)=>{
  const cached=resources.get(line+':'+operation);if(cached)return cached;if(!enabled)return null;
  const token=crypto.randomUUID(),claim=await db.podV2({action:'claim',store,fulfillment_id:id,line_key:line,operation,fingerprint,token,shop_id:binding.shop_id}) as {id:string}|null;
  if(!claim)return null;let candidate:string|undefined;
  try{const result=await work(resource=>{candidate=resource;});await db.podV2({action:'finish',store,id:claim.id,token,resource_id:result.id,proof:result.proof});resources.set(line+':'+operation,result.id);return result.id;}
  catch(error){await db.podV2({action:'finish',store,id:claim.id,token,resource_id:candidate,error_code:error instanceof PodProviderError?error.code:'provider_verification_unknown'}).catch(()=>{});return null;}
 };
 // All validation and GETs occur BEFORE recording a new side-effect intent.
 const designs:PodDesignSnapshot[]=[];
 for(let i=0;i<binding.snapshots.length;i++){
  const expected=binding.snapshots[i],s=await loadPodDesign(db,store,expected.id);if(s.hash!==expected.hash||s.spec.valid_until<=Date.now())podFail('pod_snapshot_stale');
  const line=snapshot.lines[i];if(line.mapping.cost_verified_until<=Date.now()||line.unit_minor-line.mapping.production_cost_minor<line.mapping.minimum_margin_minor)podFail('pod_cost_expired');
  if(await client.verifyCatalog(s.spec)!==s.spec.catalog_hash)podFail('pod_catalog_drift');
  for(const asset of s.assets){const [art]=await db.query<{approved_at:number|null;sha256:string}>('SELECT approved_at,sha256 FROM pod_artworks WHERE id=? AND cart_id=?',[asset.artwork_id,s.cart_id]);if(!art?.approved_at||art.sha256!==asset.sha256)podFail('pod_artwork_unapproved');const object=await env.IMAGES.get(asset.object_key);if(!object)podFail('pod_artwork_missing');const bytes=await podReadBytes(object.body,20_000_000);if(await podSha(bytes)!==asset.sha256)podFail('pod_artwork_checksum_changed');}
  designs.push(s);
 }
 for(let i=0;i<designs.length;i++){
  const s=designs[i],line=snapshot.lines[i],images:Record<string,string>={};
  for(const asset of s.assets){
   const filename=`kedi_${store}_${s.id}_${asset.position}_${asset.sha256.slice(0,16)}.png`;
   const fingerprint=await podSha(canonicalPod({shop:binding.shop_id,snapshot:s.hash,asset:asset.sha256,filename}));
   const uploadUrl=!resources.has(s.id+'_'+asset.position+':media_upload')&&env.POD_PRINTIFY_MEDIA_WRITE_ENABLED==='true'?await podSnapshotAssetUrl(env,base,s,asset.position):'';
   const imageId=await execute(s.id+'_'+asset.position,'media_upload',fingerprint,env.POD_PRINTIFY_MEDIA_WRITE_ENABLED==='true',async capture=>{
    const uploaded=await client.upload(filename,uploadUrl);capture(uploaded.id);const verified=await client.image(uploaded.id);
    if(verified.width!==asset.width||verified.height!==asset.height||verified.file_name!==filename||verified.mime_type!=='image/png'||verified.size!==asset.size)podFail('pod_uploaded_image_mismatch');
    return {id:verified.id,proof:{sha256:asset.sha256,width:verified.width,height:verified.height}};
   });
   if(!imageId)return {state:'media_pending_or_unknown'};images[asset.position]=imageId;
  }
  const productFingerprint=await podSha(canonicalPod({snapshot:s.hash,images,price:line.unit_minor}));
  const productId=await execute(s.id,'create_product',productFingerprint,env.POD_PRINTIFY_PRODUCT_WRITE_ENABLED==='true',async capture=>{
   const created=await client.createProduct(s,images,line.unit_minor,'Kedi '+s.id+' '+s.hash.slice(0,12));capture(created.id);
   const verified=client.verifyProduct(await client.product(created.id),s,images,line.mapping.production_cost_minor);return {id:verified.id,proof:{snapshot_hash:s.hash}};
  });
  if(!productId)return {state:'product_pending_or_unknown'};
  client.verifyProduct(await client.product(productId),s,images,line.mapping.production_cost_minor);
  const entry={product_id:productId,variant_id:s.spec.variant_id,quantity:line.qty,external_id:s.id};if(!lines.some(l=>l.external_id===s.id))lines.push(entry);
 }
 if(await client.shipping(snapshot,lines)!==snapshot.shipping)podFail('pod_shipping_changed');
 const orderFingerprint=await podSha(canonicalPod({shop:binding.shop_id,reference:job.reference,lines,recipient:snapshot.recipient}));
 const providerId=await execute('order','create_order',orderFingerprint,env.POD_ORDER_CREATE_ENABLED==='true',async capture=>{
  const created=await client.createOrder(job.reference,lines,snapshot.recipient);capture(created.id);const verified=client.verifyOrder(await client.order(created.id),job.reference,lines,snapshot.recipient);return {id:verified.id};
 });
 if(!providerId)return {state:'order_pending_or_unknown'};
 const order=await client.order(providerId);await reconcile(order);
 if(env.POD_PRODUCTION_RELEASE_ENABLED!=='true'||order.status!=='pending')return {state:'production_held'};
 if(!await (deps.verifyPayment?deps.verifyPayment():verifiedLivePayment(db,env,id)))return {state:'payment_review_required'};
 const productionFingerprint=await podProductionFingerprint(db,store,id);
 const production=await execute('order','send_to_production',productionFingerprint,true,async capture=>{await client.send(providerId);capture(providerId);return {id:providerId};});
 if(!production)return {state:'production_pending_or_unknown'};
 return {state:await reconcile(await client.order(providerId))};
}

/** Recover an uncertain side effect using authoritative GET evidence; never permits another POST. */
export async function reconcileStagedResource(env:Env,db:DOStub,operationId:string,resourceId:string,actor:string,evidence:string,provider?:StagedPrintifyClient){
 await db.podV2Init();const store=env.STORE_ID||'default';
 const [op]=await db.query<PodOperationRow>('SELECT * FROM pod_v2_operations WHERE id=? AND store_id=?',[operationId,store]);
 if(!op||op.state==='confirmed'||op.state==='in_flight'&&op.lease_until>Date.now())podFail('pod_resolution_not_allowed');
 const binding=await podV2Binding(db,store,op.fulfillment_id);if(!binding||binding.shop_id!==env.PRINTIFY_SHOP_ID)podFail('pod_store_account_mismatch');
 const client=provider||new StagedPrintifyClient(env.PRINTIFY_API_TOKEN||'',binding.shop_id);
 const [job]=await db.query<{body:string;reference:string}>('SELECT body,reference FROM pod_fulfillments WHERE id=?',[op.fulfillment_id]);const snapshot=JSON.parse(job.body) as PodSnapshot;
 const confirmed=await db.query<PodOperationRow>("SELECT * FROM pod_v2_operations WHERE store_id=? AND fulfillment_id=? AND state='confirmed'",[store,op.fulfillment_id]);
 if(op.operation==='media_upload'){
  const s=binding.snapshots.find(s=>op.line_key.startsWith(s.id+'_')),asset=s?.assets.find(a=>op.line_key===s.id+'_'+a.position);if(!s||!asset)podFail('pod_resource_scope');
  const image=await client.image(resourceId),filename=`kedi_${store}_${s.id}_${asset.position}_${asset.sha256.slice(0,16)}.png`;
  if(image.file_name!==filename||image.width!==asset.width||image.height!==asset.height||image.size!==asset.size||image.mime_type!=='image/png')podFail('pod_uploaded_image_mismatch');
 }else if(op.operation==='create_product'){
  const index=binding.snapshots.findIndex(s=>s.id===op.line_key),s=binding.snapshots[index];if(!s)podFail('pod_resource_scope');const images:Record<string,string>={};
  for(const asset of s.assets){const resource=confirmed.find(o=>o.line_key===s.id+'_'+asset.position&&o.operation==='media_upload');if(!resource?.resource_id)podFail('pod_provider_resources_missing');images[asset.position]=resource.resource_id;}
  const product=client.verifyProduct(await client.product(resourceId),s,images,snapshot.lines[index].mapping.production_cost_minor);if(product.title!=='Kedi '+s.id+' '+s.hash.slice(0,12))podFail('pod_product_reference_mismatch');
 }else{
  const lines=binding.snapshots.map((s,i)=>{const resource=confirmed.find(o=>o.line_key===s.id&&o.operation==='create_product');if(!resource?.resource_id)podFail('pod_provider_resources_missing');return {product_id:resource.resource_id,variant_id:s.spec.variant_id,quantity:snapshot.lines[i].qty,external_id:s.id};});
  const order=client.verifyOrder(await client.order(resourceId),job.reference,lines,snapshot.recipient);
  if(op.operation==='send_to_production'&&!['in-production','sending-to-production','fulfilled'].includes(order.status))podFail('pod_production_not_confirmed');
 }
 await db.podV2({action:'resolve',store,id:op.id,resource_id:resourceId,proof:{provider_id:resourceId,verified_by:'scoped_provider_get'},actor,evidence});
 await db.run('DELETE FROM pod_v2_retries WHERE store_id=? AND fulfillment_id=?',[store,op.fulfillment_id]);return {confirmed:true};
}
