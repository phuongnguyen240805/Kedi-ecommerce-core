import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {MARKETING_SCHEMA,subscribeMarketing,confirmMarketing,unsubscribeMarketing,claimMarketing,marketingEligible,finishMarketing,recordMarketingEvent,planMarketing} from '../src/lib/marketing-core';
import {POD_SCHEMA} from '../src/lib/pod-core';
import {marketingToken,verifyMarketingToken,verifyMailgunSignature} from '../src/lib/marketing-tokens';
import {deliverMarketing} from '../src/lib/marketing-runner';
import type {ShippingSql} from '../src/lib/shipping-store';
import type {DOStub,Env} from '../src/types';
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../src/do.ts',import.meta.url),'utf8').match(/const SCHEMA = `([\s\S]*?)`;/)![1]);db.exec(POD_SCHEMA);db.exec(MARKETING_SCHEMA);
 const sql:ShippingSql={exec:(q,...args)=>{const rows=db.prepare(q).all(...args) as Record<string,unknown>[];return {toArray:()=>rows};}};
 const tx=<T>(f:()=>T):T=>{db.exec('BEGIN');try{const r=f();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const input={email:'Buyer@Example.Test',consent:true as const,source:'newsletter' as const,policy_version:'v1',rate_key:'a'.repeat(64)};
 const subscribe=()=>tx(()=>subscribeMarketing(sql,input,'v1'));
 const sub=()=>db.prepare('SELECT * FROM marketing_subscribers').get()!;
 const confirm=()=>tx(()=>confirmMarketing(sql,String(sub().id),String(sub().nonce),'v2'));
 return {db,sql,tx,input,subscribe,sub,confirm};
}
test('normalized subscriber is unique, consent is versioned, and welcome requires mailbox confirmation',()=>{
 const f=fixture();f.subscribe();f.subscribe();assert.equal(f.db.prepare('SELECT count(*) n FROM marketing_subscribers').get()!.n,1);
 assert.equal(f.sub().email,'buyer@example.test');assert.equal(f.db.prepare('SELECT count(*) n FROM marketing_jobs').get()!.n,1);
 assert.equal(f.db.prepare('SELECT kind FROM marketing_jobs').get()!.kind,'confirmation');
 f.confirm();f.confirm();assert.equal(f.db.prepare("SELECT count(*) n FROM marketing_jobs WHERE kind='welcome'").get()!.n,1);
 assert.equal(f.db.prepare("SELECT policy_version FROM marketing_consent WHERE event='confirmed'").get()!.policy_version,'v1');
 assert.throws(()=>subscribeMarketing(f.sql,{...f.input,consent:false} as never,'v1'));
 assert.throws(()=>subscribeMarketing(f.sql,{...f.input,policy_version:'old'},'v1'),/policy/);
});
test('unsubscribe invalidates an already-claimed marketing job and does not reopen on send completion',()=>{
 const f=fixture();f.subscribe();f.confirm();const confirmation=f.tx(()=>claimMarketing(f.sql,'confirm'))!;
 // Pending confirmation is canceled after activation, so the first eligible job is welcome.
 assert.equal(confirmation.kind,'welcome');
 f.tx(()=>unsubscribeMarketing(f.sql,String(f.sub().id)));assert.equal(marketingEligible(f.sql,confirmation.id,'confirm'),null);
 f.tx(()=>finishMarketing(f.sql,confirmation.id,'confirm','accepted','message-id'));
 assert.equal(f.db.prepare('SELECT state FROM marketing_jobs WHERE id=?').get(confirmation.id)!.state,'canceled');
});
test('permanent bounce/complaint suppresses future sends and duplicate events are no-ops',()=>{
 const f=fixture();f.subscribe();f.confirm();const j=f.tx(()=>claimMarketing(f.sql,'lease'))!;
 const event={id:'event',token:'token',job_id:j.id,email:'BUYER@EXAMPLE.TEST',event:'failed',permanent:true};
 f.tx(()=>recordMarketingEvent(f.sql,event));assert.deepEqual(f.tx(()=>recordMarketingEvent(f.sql,event)),{duplicate:true});
 assert.equal(f.db.prepare('SELECT email FROM marketing_suppressions').get()!.email,'buyer@example.test');
 assert.equal(f.sub().status,'suppressed');f.subscribe();assert.equal(f.sub().status,'suppressed');assert.equal(f.tx(()=>claimMarketing(f.sql,'again')),null);
});
test('unknown delivery is never automatically resent; retryable rejection is scheduled with backoff',()=>{
 const f=fixture();f.subscribe();const j=f.tx(()=>claimMarketing(f.sql,'lease'))!;f.tx(()=>finishMarketing(f.sql,j.id,'lease','unknown'));
 assert.equal(f.tx(()=>claimMarketing(f.sql,'again',Date.now()+86400000)),null);
 const g=fixture();g.subscribe();const r=g.tx(()=>claimMarketing(g.sql,'retry'))!;g.tx(()=>finishMarketing(g.sql,r.id,'retry','retry'));
 assert.equal(g.tx(()=>claimMarketing(g.sql,'too-soon')),null);assert.ok(g.tx(()=>claimMarketing(g.sql,'later',Date.now()+3600000)));
});
test('abandoned cart cancels on authoritative paid order even before the next planner run',()=>{
 const f=fixture();f.subscribe();f.confirm();const now=Date.now(),cart=crypto.randomUUID();
 f.db.prepare("INSERT INTO carts(id,customer_email,currency,expires_at,created_at,updated_at,stripe_checkout_session_id) VALUES(?,'buyer@example.test','USD',?,?,?,'cs_cart')").run(cart,new Date(now+86400000).toISOString(),new Date(now-7200000).toISOString(),new Date(now-7200000).toISOString());
 f.db.prepare("INSERT INTO cart_items(id,cart_id,sku,title,qty,unit_price_cents,currency) VALUES('item',?,'SHIRT','Shirt',1,2500,'USD')").run(cart);
 f.tx(()=>planMarketing(f.sql,now));assert.equal(f.db.prepare("SELECT count(*) n FROM marketing_jobs WHERE kind='abandoned'").get()!.n,1);
 const welcome=f.tx(()=>claimMarketing(f.sql,'welcome'))!;f.tx(()=>finishMarketing(f.sql,welcome.id,'welcome','accepted','welcome-id'));
 const abandoned=f.tx(()=>claimMarketing(f.sql,'cart'))!;assert.equal(abandoned.kind,'abandoned');
 f.db.exec("INSERT INTO orders(id,number,status,customer_email,subtotal_cents,tax_cents,total_cents,currency,stripe_checkout_session_id) VALUES('order','ORDER','paid','buyer@example.test',2500,0,2500,'USD','cs_cart')");
 assert.equal(marketingEligible(f.sql,abandoned.id,'cart'),null);f.tx(()=>planMarketing(f.sql,now));assert.equal(f.db.prepare('SELECT state FROM marketing_jobs WHERE id=?').get(abandoned.id)!.state,'canceled');
});
test('Mailgun timeout is recorded unknown and another runner cannot send it again',async()=>{
 const f=fixture();f.subscribe();let sends=0;const transport=mock.method(globalThis,'fetch',async()=>{sends++;throw Error('Network timeout');});
 const stub={marketingClaim:async(t:string)=>f.tx(()=>claimMarketing(f.sql,t)),marketingEligible:async(id:string,t:string)=>marketingEligible(f.sql,id,t),marketingFinish:async(id:string,t:string,o:Parameters<typeof finishMarketing>[3],p?:string)=>{f.tx(()=>finishMarketing(f.sql,id,t,o,p));},query:async(q:string,p:unknown[])=>f.sql.exec(q,...p).toArray()} as unknown as DOStub;
 const env={MARKETING_ENABLED:'true',MARKETING_SEND_ENABLED:'true',MAILGUN_API_KEY:'fixture',MAILGUN_DOMAIN:'mg.shop.test',MARKETING_FROM_EMAIL:'hello@shop.test',MARKETING_CONTACT_ADDRESS:'Fixture merchant address',STORE_URL:'https://shop.test',STORE_PUBLIC_API_URL:'https://merchant.test',STORE_NAME:'Test Shop',ORDER_TOKEN_SECRET:'fixture-secret-at-least-thirty-two-characters'} as Env;
 try{await deliverMarketing(env,stub);await deliverMarketing(env,stub);assert.equal(sends,1);assert.equal(f.db.prepare('SELECT state FROM marketing_jobs').get()!.state,'unknown');}finally{transport.mock.restore();}
});
test('signed preference tokens bind purpose and store; Mailgun signature rejects forgery and stale time',async()=>{
 const env={STORE_ID:'store-a',ORDER_TOKEN_SECRET:'fixture-secret-at-least-thirty-two-characters'} as Env;
 const token=await marketingToken(env,'confirm','subscriber',{nonce:'nonce'});assert.equal((await verifyMarketingToken(env,token,'confirm')).subscriber_id,'subscriber');
 await assert.rejects(verifyMarketingToken({...env,STORE_ID:'store-b'},token,'confirm'));await assert.rejects(verifyMarketingToken(env,token,'unsubscribe'));
 const timestamp=String(Math.floor(Date.now()/1000)),nonce='test-nonce',key=await crypto.subtle.importKey('raw',new TextEncoder().encode('secret'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(timestamp+nonce))),b=>b.toString(16).padStart(2,'0')).join('');
 assert.equal(await verifyMailgunSignature('secret',{timestamp,token:nonce,signature}),true);assert.equal(await verifyMailgunSignature('wrong',{timestamp,token:nonce,signature}),false);assert.equal(await verifyMailgunSignature('secret',{timestamp,token:nonce,signature},Date.now()+2*86400000),false);
});

test('late delivered and accepted events never reopen a canceled subscriber job or erase delivery evidence',()=>{
 const f=fixture();f.subscribe();f.confirm();const job=f.tx(()=>claimMarketing(f.sql,'lease'))!;f.tx(()=>finishMarketing(f.sql,job.id,'lease','accepted','provider'));const event=(id:string,event:string)=>f.tx(()=>recordMarketingEvent(f.sql,{id,token:id,job_id:job.id,email:'buyer@example.test',event,permanent:false}));
 event('delivered','delivered');event('clicked','clicked');event('accepted-late','accepted');assert.equal(f.db.prepare('SELECT delivery_status FROM marketing_jobs WHERE id=?').get(job.id)!.delivery_status,'delivered');
 f.db.prepare("UPDATE marketing_jobs SET state='canceled' WHERE id=?").run(job.id);event('delivered-late','delivered');assert.equal(f.db.prepare('SELECT state FROM marketing_jobs WHERE id=?').get(job.id)!.state,'canceled');event('complained','complained');event('delivered-after-complaint','delivered');assert.equal(f.db.prepare('SELECT delivery_status FROM marketing_jobs WHERE id=?').get(job.id)!.delivery_status,'complained');assert.equal(f.sub().status,'suppressed');
});
test('frequency cap includes outstanding sends and unknown results so concurrent claims cannot exceed three per day',()=>{
 const f=fixture();f.subscribe();f.confirm();const now=Date.now();f.db.exec("UPDATE marketing_jobs SET state='canceled'");for(let i=0;i<4;i++)f.db.prepare("INSERT INTO marketing_jobs(id,email,kind,payload,dedupe_key,state,due_at,created_at,updated_at) VALUES(?,'buyer@example.test','win_back','{}',?,'pending',?,?,?)").run('cap-'+i,'cap-'+i,now,now,now);
 const first=f.tx(()=>claimMarketing(f.sql,'lease1',now))!;f.tx(()=>finishMarketing(f.sql,first.id,'lease1','unknown',undefined,now));assert.ok(f.tx(()=>claimMarketing(f.sql,'lease2',now)));assert.ok(f.tx(()=>claimMarketing(f.sql,'lease3',now)));assert.equal(f.tx(()=>claimMarketing(f.sql,'lease4',now)),null);assert.equal(f.db.prepare("SELECT count(*) n FROM marketing_jobs WHERE state='sending'").get()!.n,2);
});
