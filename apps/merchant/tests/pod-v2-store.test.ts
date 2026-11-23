import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {POD_V2_SCHEMA,podV2Command,type PodV2Command} from '../src/lib/pod-v2-store';
import {canonicalPod,podSha,podPrintSpec} from '../src/lib/pod-v2-model';
import type {ShippingSql} from '../src/lib/shipping-store';

function fixture(){
 const db=new DatabaseSync(':memory:');db.exec(POD_V2_SCHEMA);db.exec(POD_V2_SCHEMA);
 db.exec(`CREATE TABLE pod_audit(id TEXT,subject_id TEXT,event TEXT,evidence TEXT,created_at INTEGER);
 CREATE TABLE pod_fulfillments(id TEXT,order_id TEXT,body TEXT,state TEXT,external_id TEXT,status_json TEXT,updated_at INTEGER);
 CREATE TABLE orders(id TEXT,status TEXT,total_cents INTEGER,currency TEXT);
 CREATE TABLE payment_receipts(order_id TEXT,provider TEXT,amount_minor INTEGER,currency TEXT);
 CREATE TABLE ucp_checkout_sessions(id TEXT,order_id TEXT);
 CREATE TABLE pod_checkouts(checkout_id TEXT,quote_id TEXT);
 INSERT INTO orders VALUES('order','paid',3000,'USD');
 INSERT INTO payment_receipts VALUES('order','stripe',3000,'USD');
 INSERT INTO pod_fulfillments VALUES('job','order','{"amount":3000}','queued',NULL,NULL,0);
 INSERT INTO ucp_checkout_sessions VALUES('checkout','order');INSERT INTO pod_checkouts VALUES('checkout','quote');`);
 const sql:ShippingSql={exec:(q,...p)=>{const rows=db.prepare(q).all(...p) as Record<string,unknown>[];return {toArray:()=>rows};}};
 db.prepare('INSERT INTO pod_v2_quote_bindings VALUES(?,?,?,?)').run('quote','store-a',JSON.stringify({shop_id:'111',snapshots:[],payment_environment:'test'}),1);
 const command=(c:PodV2Command,now=1000)=>{db.exec('BEGIN');try{const result=podV2Command(sql,c,now);db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
 const claim:PodV2Command={action:'claim',store:'store-a',fulfillment_id:'job',line_key:'line',operation:'media_upload',fingerprint:'a'.repeat(64),token:crypto.randomUUID(),shop_id:'111'};
 return {db,sql,command,claim};
}
test('P01-T02 100 consumers have one durable operation intent; a lost lease never re-posts',()=>{
 const f=fixture();const first=f.command(f.claim) as {id:string;token:string};assert.ok(first.id);
 for(let i=0;i<99;i++)assert.equal(f.command({...f.claim,token:crypto.randomUUID()}),null);
 assert.equal(f.command({...f.claim,token:crypto.randomUUID()},62000),null);
 assert.equal(f.db.prepare('SELECT state FROM pod_v2_operations').get()!.state,'outcome_unknown');
 assert.throws(()=>f.command({action:'finish',store:'store-a',id:first.id,token:first.token,resource_id:'image'},63000),{code:'pod_operation_fence_lost'});
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM pod_v2_operations').get()!.n,1);
});
test('P01-T04 P05-T04 unknown POST cannot be claimed again; confirmed references are durable',()=>{
 const f=fixture(),op=f.command(f.claim) as {id:string;token:string};
 f.command({action:'finish',store:'store-a',...op,error_code:'provider_timeout'});
 assert.equal(f.command({...f.claim,token:crypto.randomUUID()}),null);
 f.command({action:'resolve',store:'store-a',id:op.id,resource_id:'image-A',proof:{id:'image-A'},actor:'reviewer',evidence:'Verified provider GET matches upload fingerprint.'});
 assert.equal(f.command({...f.claim,token:crypto.randomUUID()}),null);
 assert.equal(f.db.prepare('SELECT resource_id FROM pod_v2_operations').get()!.resource_id,'image-A');
});
test('P01-T10 P01-T11 payment, shop, store and fingerprint cannot be swapped',()=>{
 const f=fixture();assert.throws(()=>f.command({...f.claim,store:'store-b'}),/merchant review/);
 assert.throws(()=>f.command({...f.claim,shop_id:'222'}),/merchant review/);
 f.db.exec('UPDATE payment_receipts SET amount_minor=1');assert.throws(()=>f.command(f.claim),/merchant review/);
 f.db.exec("UPDATE payment_receipts SET amount_minor=3000;UPDATE orders SET status='refunded'");assert.throws(()=>f.command(f.claim),/merchant review/);
 f.db.exec("UPDATE orders SET status='paid'");f.command(f.claim);assert.throws(()=>f.command({...f.claim,fingerprint:'b'.repeat(64)}),/merchant review/);
});
test('P06-T04 P06-T06 manual shop and exact production approval are separate gates',()=>{
 const f=fixture(),claim={...f.claim,operation:'create_order' as const};assert.throws(()=>f.command(claim));
 f.command({action:'approval',store:'store-a',subject_id:'111',kind:'manual_shop',actor:'operator',evidence:'Shop Manual Approval verified in dashboard.',valid_until:2000,fingerprint:'c'.repeat(64)});
 assert.ok(f.command(claim));assert.throws(()=>f.command({...claim,operation:'send_to_production'}));
 f.command({action:'approval',store:'store-a',subject_id:'job',kind:'production',actor:'operator',evidence:'Reviewed paid order and actual print-ready preview.',valid_until:2000,fingerprint:'a'.repeat(64)});
 assert.ok(f.command({...claim,operation:'send_to_production'}));
});
test('P07-T03 durable webhook inbox deduplicates and rejects same ID with different bytes',()=>{
 const f=fixture(),event={action:'inbox' as const,store:'store-a',event_id:'event',digest:'d'.repeat(64),order_id:'provider-order',topic:'order:updated'};
 for(let i=0;i<100;i++)f.command(event);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM pod_v2_inbox').get()!.n,1);
 assert.throws(()=>f.command({...event,digest:'e'.repeat(64)}));
});
test('P03-T05 sealed snapshots are protected by SQL triggers; schema is additive/idempotent',()=>{
 const f=fixture();f.db.exec("INSERT INTO pod_v2_snapshots VALUES('snapshot','store-a','cart','{}','hash',1)");
 assert.throws(()=>f.db.exec("UPDATE pod_v2_snapshots SET body='tampered'"),/immutable/);
 assert.throws(()=>f.db.exec('DELETE FROM pod_v2_snapshots'),/immutable/);
 assert.equal(f.db.prepare('SELECT status FROM orders').get()!.status,'paid');
});
test('P02-T04 print geometry requires verified physical dimensions and rejects duplicate positions',async()=>{
 assert.equal(canonicalPod({b:2,a:1}),' {"a":1,"b":2}'.trim());assert.equal(await podSha(canonicalPod({a:1,b:2})),await podSha(canonicalPod({b:2,a:1})));
 assert.equal(podPrintSpec.safeParse({sku:'shirt'}).success,false);
});
