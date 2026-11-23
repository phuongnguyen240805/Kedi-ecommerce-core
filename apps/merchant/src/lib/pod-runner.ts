import {SignJWT} from 'jose';
import type {DOStub,Env} from '../types';
import {PrintifyClient,printifyFulfillmentState} from './pod-printify';
import type {PodLine} from './pod-core';
import {podV2Binding,processStagedPod} from './pod-v2-runner';

export async function podArtworkUrl(env:Env,base:string,line:PodLine){
 if(!env.ORDER_TOKEN_SECRET||env.ORDER_TOKEN_SECRET.length<32)throw Error('POD artwork signing is not configured');
 const token=await new SignJWT({artwork_id:line.artwork_id,sha256:line.sha256,store_id:env.STORE_ID||'default',purpose:'pod-artwork'})
  .setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('7d').sign(new TextEncoder().encode(env.ORDER_TOKEN_SECRET));
 return `${base}/v1/pod/assets/${line.artwork_id}?token=${encodeURIComponent(token)}`;
}
export async function processPodFulfillment(env:Env,db:DOStub,id:string,base:string,client?:PrintifyClient){
 if(db.podV2Init){
  await db.podV2Init();
  if(await podV2Binding(db,env.STORE_ID||'default',id))return processStagedPod(env,db,id,base);
  if(env.POD_NEW_PIPELINE_ENABLED==='true'){
   const [legacy]=await db.query<{attempted_at:number|null}>('SELECT attempted_at FROM pod_fulfillments WHERE id=?',[id]);
   if(!legacy?.attempted_at)return {enabled:false,reason:'legacy_creation_disabled'};
  }
 }
 if(env.POD_ENABLED!=='true')return {enabled:false};
 if(env.POD_SUBMIT_ENABLED!=='true'||env.POD_ACCOUNT_AUTOMATION_VERIFIED!=='true'){
  const [existing]=await db.query<{attempted_at:number|null}>('SELECT attempted_at FROM pod_fulfillments WHERE id=?',[id]);
  if(!existing?.attempted_at)return {enabled:false};
 }
 const provider=client||new PrintifyClient(env.PRINTIFY_API_TOKEN||'',env.PRINTIFY_SHOP_ID||'');
 const token=crypto.randomUUID(),job=await db.podClaim(id,token);if(!job)return {claimed:false};
 try{
  let external=job.externalId?await provider.get(job.externalId,job.reference):job.reconcileOnly?await provider.find(job.reference):null;
  if(!external&&!job.reconcileOnly){
   if(job.snapshot.lines.some(l=>l.mapping.cost_verified_until<=Date.now())){
    await db.podFinish(id,token,{state:'needs_review'});return {review:true};
   }
   for(const line of job.snapshot.lines){
    const [art]=await db.query<{sha256:string;approved_at:number}>('SELECT sha256,approved_at FROM pod_artworks WHERE id=? AND cart_id=?',[line.artwork_id,job.snapshot.cart_id]);
    if(!art?.approved_at||art.sha256!==line.sha256)throw Error('Artwork approval changed');
   }
   if(await provider.shipping(job.snapshot)!==job.snapshot.shipping){await db.podFinish(id,token,{state:'needs_review'});return {review:true};}
   external=await provider.submit(job.snapshot,job.reference,line=>podArtworkUrl(env,base,line));
  }
  if(!external){await db.podFinish(id,token,{state:'submission_unknown'});return {unknown:true};}
  const state=printifyFulfillmentState(external);
  await db.podFinish(id,token,{state,externalId:external.id,status:{provider_status:external.status,shipments:external.shipments||[]}});
  return {state};
 }catch{
  await db.podFinish(id,token,{state:'submission_unknown'});return {unknown:true};
 }
}
