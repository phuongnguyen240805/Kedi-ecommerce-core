import {z} from 'zod';
import type {ShippingSql} from './shipping-store';
import {podMapping,savePodMappingDraft} from './pod-core';
import {podActor,podEvidence,podFail,podHash,podOperation,podPrintSpec,podSnapshotInput,podStoreId,type PodDesignSnapshot,type PodOperation} from './pod-v2-model';

// Additive DO schema, initialized through ensureSchemaObjects. No D1 migration or namespace change.
export const POD_V2_SCHEMA=`
CREATE TABLE IF NOT EXISTS pod_v2_specs(id TEXT PRIMARY KEY,store_id TEXT NOT NULL,sku TEXT NOT NULL,body TEXT NOT NULL,actor TEXT NOT NULL,evidence TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pod_v2_snapshots(id TEXT PRIMARY KEY,store_id TEXT NOT NULL,cart_id TEXT NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pod_v2_quote_bindings(quote_id TEXT PRIMARY KEY,store_id TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pod_v2_operations(id TEXT PRIMARY KEY,store_id TEXT NOT NULL,fulfillment_id TEXT NOT NULL,line_key TEXT NOT NULL,operation TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,resource_id TEXT,proof_json TEXT,error_code TEXT,updated_at INTEGER NOT NULL,UNIQUE(store_id,fulfillment_id,line_key,operation));
CREATE INDEX IF NOT EXISTS pod_v2_operation_review ON pod_v2_operations(store_id,state,updated_at);
CREATE TABLE IF NOT EXISTS pod_v2_approvals(store_id TEXT NOT NULL,subject_id TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,valid_until INTEGER NOT NULL,PRIMARY KEY(store_id,subject_id,kind));
CREATE TABLE IF NOT EXISTS pod_v2_inbox(store_id TEXT NOT NULL,event_id TEXT NOT NULL,digest TEXT NOT NULL,order_id TEXT NOT NULL,topic TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',received_at INTEGER NOT NULL,PRIMARY KEY(store_id,event_id));
CREATE TABLE IF NOT EXISTS pod_v2_retries(store_id TEXT NOT NULL,fulfillment_id TEXT NOT NULL,attempts INTEGER NOT NULL,next_at INTEGER NOT NULL,error_code TEXT NOT NULL,PRIMARY KEY(store_id,fulfillment_id));
CREATE TRIGGER IF NOT EXISTS pod_v2_snapshot_no_update BEFORE UPDATE ON pod_v2_snapshots BEGIN SELECT RAISE(ABORT,'sealed_snapshot_immutable'); END;
CREATE TRIGGER IF NOT EXISTS pod_v2_snapshot_no_delete BEFORE DELETE ON pod_v2_snapshots BEGIN SELECT RAISE(ABORT,'sealed_snapshot_immutable'); END;
CREATE TRIGGER IF NOT EXISTS pod_v2_spec_no_update BEFORE UPDATE ON pod_v2_specs BEGIN SELECT RAISE(ABORT,'print_spec_version_immutable'); END;
CREATE TRIGGER IF NOT EXISTS pod_v2_quote_no_update BEFORE UPDATE ON pod_v2_quote_bindings BEGIN SELECT RAISE(ABORT,'pod_quote_binding_immutable'); END;
`;

export type PodQuoteBinding={shop_id:string;snapshots:PodDesignSnapshot[];payment_environment:'test'|'live';quote_hash:string};
export type PodOperationRow={id:string;store_id:string;fulfillment_id:string;line_key:string;operation:PodOperation;fingerprint:string;
 state:'in_flight'|'outcome_unknown'|'confirmed';token:string|null;lease_until:number;attempts:number;resource_id:string|null;proof_json:string|null;error_code:string|null;updated_at:number};
export type PodV2Command=
 |{action:'spec';store:string;id:string;body:unknown;actor:string;evidence:string}
 |{action:'activate';store:string;spec_id:string;mapping:unknown;actor:string;evidence:string}
 |{action:'seal';store:string;snapshot:PodDesignSnapshot}
 |{action:'bind';store:string;quote_id:string;binding:PodQuoteBinding}
 |{action:'claim';store:string;fulfillment_id:string;line_key:string;operation:PodOperation;fingerprint:string;token:string;shop_id:string}
 |{action:'finish';store:string;id:string;token:string;resource_id?:string;proof?:unknown;error_code?:string}
 |{action:'approval';store:string;subject_id:string;kind:'manual_shop'|'production';actor:string;evidence:string;valid_until:number;fingerprint:string}
 |{action:'inbox';store:string;event_id:string;digest:string;order_id:string;topic:string}
 |{action:'project';store:string;fulfillment_id:string;provider_id:string;state:string;status:unknown}
 |{action:'resolve';store:string;id:string;resource_id:string;proof:unknown;actor:string;evidence:string};

function audit(sql:ShippingSql,subject:string,event:string,body:unknown,now:number){sql.exec('INSERT INTO pod_audit VALUES(?,?,?,?,?)',crypto.randomUUID(),subject,event,JSON.stringify(body),now);}
export function readPodV2Binding(sql:ShippingSql,store:string,fulfillment:string):PodQuoteBinding|null{
 const [row]=sql.exec(`SELECT b.body FROM pod_fulfillments f JOIN ucp_checkout_sessions s ON s.order_id=f.order_id JOIN pod_checkouts p ON p.checkout_id=s.id JOIN pod_v2_quote_bindings b ON b.quote_id=p.quote_id WHERE f.id=? AND b.store_id=?`,fulfillment,store).toArray();
 return row?JSON.parse(String(row.body)) as PodQuoteBinding:null;
}
export function assertPodV2Paid(sql:ShippingSql,store:string,id:string,shop:string){
 const binding=readPodV2Binding(sql,store,id);if(!binding||binding.shop_id!==shop)podFail('pod_store_account_mismatch');
 const [row]=sql.exec(`SELECT f.body,f.state,o.status,o.total_cents,o.currency FROM pod_fulfillments f JOIN orders o ON o.id=f.order_id WHERE f.id=? AND EXISTS(SELECT 1 FROM payment_receipts r WHERE r.order_id=o.id AND r.amount_minor=o.total_cents AND r.currency=o.currency AND r.provider='stripe')`,id).toArray();
 if(!row||row.status!=='paid'||row.currency!=='USD'||['canceled','delivered'].includes(String(row.state)))podFail('pod_verified_payment_required');
 const snapshot=JSON.parse(String(row.body));if(snapshot.amount!==row.total_cents)podFail('pod_receipt_quote_mismatch');
 return binding;
}

/** Called only in the owning MerchantDO transactionSync, never around provider IO. */
export function podV2Command(sql:ShippingSql,command:PodV2Command,now=Date.now()):unknown{
 const store=podStoreId.parse(command.store);
 switch(command.action){
 case 'spec':{
  z.string().uuid().parse(command.id);const spec=podPrintSpec.parse(command.body);podActor.parse(command.actor);podEvidence.parse(command.evidence);
  if(spec.valid_until<=now||spec.valid_until>now+30*86400000)podFail('pod_spec_expiry');
  sql.exec('INSERT INTO pod_v2_specs VALUES(?,?,?,?,?,?,?)',command.id,store,spec.sku,JSON.stringify(spec),command.actor,command.evidence,now);
  audit(sql,command.id,'pod.v2.spec_approved',{actor:command.actor},now);return {id:command.id};
 }
 case 'activate':{
  const [row]=sql.exec('SELECT body FROM pod_v2_specs WHERE id=? AND store_id=?',command.spec_id,store).toArray();if(!row)podFail('pod_spec_missing');
  const spec=podPrintSpec.parse(JSON.parse(String(row.body))),mapping=podMapping.parse(command.mapping);podEvidence.parse(command.evidence);podActor.parse(command.actor);
  if(!mapping.enabled||spec.valid_until<=now||mapping.blueprint_id!==spec.blueprint_id||mapping.print_provider_id!==spec.print_provider_id||mapping.variant_id!==spec.variant_id||mapping.min_width!==spec.placements[0].width_px||mapping.min_height!==spec.placements[0].height_px||mapping.placement!==spec.placements[0].position||mapping.cost_verified_until<=now)podFail('pod_mapping_spec_mismatch');
  const version=crypto.randomUUID();
  const [existing]=sql.exec('SELECT config FROM pod_mappings WHERE sku=?',spec.sku).toArray();
  if(!existing)savePodMappingDraft(sql,spec.sku,{...mapping,enabled:false},command.actor);
  sql.exec('UPDATE pod_mappings SET version=?,config=? WHERE sku=?',version,JSON.stringify(mapping),spec.sku);
  audit(sql,spec.sku,'pod.v2.mapping_activated',{version,spec_id:command.spec_id,actor:command.actor,evidence:command.evidence},now);return {version};
 }
 case 'seal':{
  const s=command.snapshot;podSnapshotInput.parse({cart_id:s.cart_id,sku:s.sku,spec_id:s.spec_id,design_id:s.design_id,design_version:s.design_version,renderer_version:s.renderer_version,assets:s.assets.map(a=>({position:a.position,artwork_id:a.artwork_id})),rights_accepted:true});
  if(s.store_id!==store||s.sealed_at>now||s.spec.valid_until<=now)podFail('pod_snapshot_scope');podHash.parse(s.hash);
  const [cart]=sql.exec("SELECT id FROM carts WHERE id=? AND status='open' AND expires_at>?",s.cart_id,new Date(now).toISOString()).toArray();
  const [mapping]=sql.exec('SELECT version FROM pod_mappings WHERE sku=?',s.sku).toArray();if(!cart||mapping?.version!==s.mapping_version)podFail('pod_snapshot_stale');
  for(const a of s.assets){const [art]=sql.exec('SELECT sha256,approved_at FROM pod_artworks WHERE id=? AND cart_id=?',a.artwork_id,s.cart_id).toArray();if(!art?.approved_at||art.sha256!==a.sha256)podFail('pod_artwork_unapproved');}
  sql.exec('INSERT INTO pod_v2_snapshots VALUES(?,?,?,?,?,?)',s.id,store,s.cart_id,JSON.stringify(s),s.hash,now);
  audit(sql,s.id,'pod.v2.snapshot_sealed',{sha256:s.hash},now);return {id:s.id,hash:s.hash,status:'sealed'};
 }
 case 'bind':{
  const [quote]=sql.exec('SELECT snapshot FROM pod_quotes WHERE id=?',command.quote_id).toArray();if(!quote)podFail('pod_quote_missing');
  const q=JSON.parse(String(quote.snapshot));if(command.binding.snapshots.length!==q.lines.length)podFail('pod_snapshot_lines_mismatch');
  for(let i=0;i<q.lines.length;i++){
   const s=command.binding.snapshots[i],line=q.lines[i];
   const [stored]=sql.exec('SELECT hash FROM pod_v2_snapshots WHERE id=? AND store_id=? AND cart_id=?',s.id,store,q.cart_id).toArray();
   if(!stored||stored.hash!==s.hash||s.sku!==line.sku||s.mapping_version!==line.mapping_version||s.assets[0]?.artwork_id!==line.artwork_id||s.spec.shop_id!==command.binding.shop_id)podFail('pod_snapshot_lines_mismatch');
  }
  sql.exec('INSERT INTO pod_v2_quote_bindings VALUES(?,?,?,?)',command.quote_id,store,JSON.stringify(command.binding),now);return {bound:true};
 }
 case 'claim':{
  podOperation.parse(command.operation);podHash.parse(command.fingerprint);z.string().uuid().parse(command.token);
  const binding=assertPodV2Paid(sql,store,command.fulfillment_id,command.shop_id);
  if(command.operation==='create_order'||command.operation==='send_to_production'){
   const [manual]=sql.exec("SELECT body,valid_until FROM pod_v2_approvals WHERE store_id=? AND subject_id=? AND kind='manual_shop'",store,command.shop_id).toArray();
   if(!manual||Number(manual.valid_until)<=now)podFail('pod_manual_shop_required');
  }
  if(command.operation==='send_to_production'){
   const [approval]=sql.exec("SELECT body,valid_until FROM pod_v2_approvals WHERE store_id=? AND subject_id=? AND kind='production'",store,command.fulfillment_id).toArray();
   if(!approval||Number(approval.valid_until)<=now||JSON.parse(String(approval.body)).fingerprint!==command.fingerprint)podFail('pod_production_approval_required');
  }
  if(binding.snapshots.some(s=>s.spec.valid_until<=now))podFail('pod_spec_expired');
  const [previous]=sql.exec('SELECT * FROM pod_v2_operations WHERE store_id=? AND fulfillment_id=? AND line_key=? AND operation=?',store,command.fulfillment_id,command.line_key,command.operation).toArray();
  if(previous){
   if(previous.fingerprint!==command.fingerprint)podFail('pod_operation_fingerprint_changed');
   if(previous.state==='in_flight'&&Number(previous.lease_until)<=now){sql.exec("UPDATE pod_v2_operations SET state='outcome_unknown',token=NULL,error_code='lease_expired',updated_at=? WHERE id=?",now,previous.id);}
   return null; // Neither expired lease nor unknown outcome authorizes a second POST.
  }
  const id=crypto.randomUUID();sql.exec("INSERT INTO pod_v2_operations(id,store_id,fulfillment_id,line_key,operation,fingerprint,state,token,lease_until,attempts,updated_at) VALUES(?,?,?,?,?,?,'in_flight',?,?,1,?)",id,store,command.fulfillment_id,command.line_key,command.operation,command.fingerprint,command.token,now+60000,now);
  return {id,token:command.token};
 }
 case 'finish':{
  const [op]=sql.exec("SELECT * FROM pod_v2_operations WHERE id=? AND store_id=? AND token=? AND state='in_flight' AND lease_until>?",command.id,store,command.token,now).toArray();if(!op)podFail('pod_operation_fence_lost');
  if(command.error_code){z.string().regex(/^[a-z0-9_]{1,80}$/).parse(command.error_code);sql.exec("UPDATE pod_v2_operations SET state='outcome_unknown',token=NULL,resource_id=COALESCE(resource_id,?),error_code=?,updated_at=? WHERE id=?",command.resource_id||null,command.error_code,now,command.id);return {unknown:true};}
  if(!command.resource_id)podFail('pod_resource_missing');
  sql.exec("UPDATE pod_v2_operations SET state='confirmed',resource_id=?,proof_json=?,token=NULL,updated_at=? WHERE id=?",command.resource_id,JSON.stringify(command.proof??null),now,command.id);return {confirmed:true};
 }
 case 'approval':{
  podActor.parse(command.actor);podEvidence.parse(command.evidence);podHash.parse(command.fingerprint);
  if(command.valid_until<=now||command.valid_until>now+86400000)podFail('pod_approval_expiry');
  sql.exec('INSERT INTO pod_v2_approvals VALUES(?,?,?,?,?) ON CONFLICT(store_id,subject_id,kind) DO UPDATE SET body=excluded.body,valid_until=excluded.valid_until',store,command.subject_id,command.kind,JSON.stringify({actor:command.actor,evidence:command.evidence,fingerprint:command.fingerprint}),command.valid_until);
  audit(sql,command.subject_id,'pod.v2.'+command.kind+'_approved',{actor:command.actor,evidence:command.evidence},now);return {approved:true};
 }
 case 'inbox':{
  podHash.parse(command.digest);z.string().min(1).max(150).parse(command.event_id);
  const [old]=sql.exec('SELECT digest FROM pod_v2_inbox WHERE store_id=? AND event_id=?',store,command.event_id).toArray();if(old&&old.digest!==command.digest)podFail('pod_event_digest_conflict');
  sql.exec('INSERT OR IGNORE INTO pod_v2_inbox(store_id,event_id,digest,order_id,topic,received_at) VALUES(?,?,?,?,?,?)',store,command.event_id,command.digest,command.order_id,command.topic,now);return {received:true};
 }
 case 'project':{
  if(!readPodV2Binding(sql,store,command.fulfillment_id))podFail('pod_store_account_mismatch');
  const [previous]=sql.exec('SELECT state,external_id FROM pod_fulfillments WHERE id=?',command.fulfillment_id).toArray();
  if(previous?.external_id&&previous.external_id!==command.provider_id)podFail('pod_external_conflict');
  const rank:Record<string,number>={accepted:1,in_production:2,partially_shipped:3,shipped:4,delivered:5};
  const state=['canceled','delivered'].includes(String(previous?.state))?String(previous!.state):command.state==='needs_review'?'needs_review':(rank[String(previous?.state)]||0)>(rank[command.state]||0)?String(previous?.state):command.state;
  sql.exec('UPDATE pod_fulfillments SET state=?,external_id=?,status_json=?,updated_at=? WHERE id=?',state,command.provider_id,JSON.stringify(command.status),now,command.fulfillment_id);
  sql.exec("UPDATE pod_v2_inbox SET state='processed' WHERE store_id=? AND order_id=?",store,command.provider_id);return {state};
 }
 case 'resolve':{
  podActor.parse(command.actor);podEvidence.parse(command.evidence);
  const [op]=sql.exec("SELECT id FROM pod_v2_operations WHERE id=? AND store_id=? AND (state='outcome_unknown' OR (state='in_flight' AND lease_until<=?))",command.id,store,now).toArray();if(!op)podFail('pod_resolution_not_allowed');
  sql.exec("UPDATE pod_v2_operations SET state='confirmed',resource_id=?,proof_json=?,token=NULL,updated_at=? WHERE id=?",command.resource_id,JSON.stringify(command.proof),now,command.id);
  audit(sql,command.id,'pod.v2.operation_reconciled',{actor:command.actor,evidence:command.evidence},now);return {confirmed:true};
 }
 }
}
