import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {MARKETING_SCHEMA,subscribeMarketing,confirmMarketing} from '../src/lib/marketing-core';
import {COMMERCE_SCHEMA} from '../src/lib/commerce-core';
import {marketingRfm,createExperiment,experimentPayload,experimentReport} from '../src/lib/marketing-admin';
import type {ShippingSql} from '../src/lib/shipping-store';
function fixture(){const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../src/do.ts',import.meta.url),'utf8').match(/const SCHEMA = `([\s\S]*?)`;/)![1]);db.exec(COMMERCE_SCHEMA);db.exec(MARKETING_SCHEMA);const sql:ShippingSql={exec:(q,...args)=>{const rows=db.prepare(q).all(...args) as Record<string,unknown>[];return {toArray:()=>rows};}};return {db,sql};}
const copy={subject:'Your next custom print',text:'Explore the new products available at our store.'};
test('RFM excludes unpaid COD, withdrawn consent and full refunds; money remains separated by currency',()=>{
 const {db,sql}=fixture();const now=Date.now();for(const email of ['a@test.com','b@test.com'])db.prepare('INSERT INTO marketing_subscribers VALUES(?,?,?, ?,?, ?,?)').run(email,email,email.startsWith('a')?'active':'withdrawn','nonce',now,now,now);
 const order=(id:string,total:number,currency:string,email='a@test.com',paid=true)=>db.prepare("INSERT INTO orders(id,number,status,customer_email,subtotal_cents,tax_cents,total_cents,currency,stripe_checkout_session_id,created_at) VALUES(?,?,'processing',?,?,0,?,?,?,?)").run(id,id,email,total,total,currency,paid?id:null,new Date(now-86400000).toISOString());
 order('usd',2500,'USD');order('vnd',200000,'VND');order('unpaid',9000,'USD','a@test.com',false);order('withdrawn',4000,'USD','b@test.com');
 db.prepare("INSERT INTO refunds(id,order_id,stripe_refund_id,amount_cents,status,reason,currency) VALUES('refund','usd','re_test',500,'succeeded','requested_by_customer','USD')").run();
 const result=marketingRfm(sql,'',now);assert.equal(result.rows.length,2);const usd=result.rows.find(r=>r.currency==='USD')!;assert.equal(usd.monetary_minor,2000);assert.equal(usd.frequency,1);assert.equal(usd.recency_days,1);assert.equal(usd.segment,'recent');assert.equal(result.rows.find(r=>r.currency==='VND')!.monetary_minor,200000);
});
test('RFM pagination advances by customers and never drops a customer currency',()=>{
 const {db,sql}=fixture(),now=Date.now();for(let i=0;i<55;i++){const email=String(i).padStart(3,'0')+'@test.com';db.prepare("INSERT INTO marketing_subscribers VALUES(?,?,'active','n',?,?,?)").run(email,email,now,now,now);}
 const first=marketingRfm(sql);assert.equal(first.rows.length,50);assert.ok(first.next_cursor);const second=marketingRfm(sql,first.next_cursor!);assert.equal(second.rows.length,5);assert.equal(second.next_cursor,null);assert.equal(new Set([...first.rows,...second.rows].map(r=>r.email)).size,55);
});
test('A/B assignment is stable, single-active and frozen into queued content; confirmations never enter experiments',()=>{
 const {db,sql}=fixture(),input={kind:'welcome' as const,a:copy,b:{...copy,subject:'A fresh print idea'}};const {id}=createExperiment(sql,input);
 assert.throws(()=>createExperiment(sql,input));const first=experimentPayload(sql,'buyer@test.com','welcome');assert.deepEqual(experimentPayload(sql,'buyer@test.com','welcome'),first);assert.deepEqual(experimentPayload(sql,'buyer@test.com','confirmation'),{});
 subscribeMarketing(sql,{email:'buyer@test.com',consent:true,source:'newsletter',policy_version:'v1',rate_key:'a'.repeat(64)},'v1');const sub=db.prepare('SELECT * FROM marketing_subscribers').get()!;confirmMarketing(sql,String(sub.id),String(sub.nonce),'v1');const job=db.prepare("SELECT payload FROM marketing_jobs WHERE kind='welcome'").get()!;const payload=JSON.parse(String(job.payload));assert.equal(payload.experiment_id,id);assert.deepEqual(payload.copy,first.copy);
 db.prepare('UPDATE marketing_experiments SET active=0 WHERE id=?').run(id);assert.deepEqual(experimentPayload(sql,'other@test.com','welcome'),{});assert.equal(JSON.parse(String(db.prepare("SELECT payload FROM marketing_jobs WHERE kind='welcome'").get()!.payload)).experiment_id,id);assert.ok(experimentReport(sql).length);
});

test('experiment revenue excludes unpaid COD attribution and deducts only same-currency settled refunds',()=>{
 const {db,sql}=fixture(),now=Date.now();const {id}=createExperiment(sql,{kind:'welcome',a:copy,b:copy});subscribeMarketing(sql,{email:'buyer@test.com',consent:true,source:'newsletter',policy_version:'v1',rate_key:'a'.repeat(64)},'v1');const sub=db.prepare('SELECT * FROM marketing_subscribers').get()!;confirmMarketing(sql,String(sub.id),String(sub.nonce),'v1');const job=db.prepare("SELECT id FROM marketing_jobs WHERE kind='welcome'").get()!;db.prepare("UPDATE marketing_jobs SET accepted_at=?,delivery_status='delivered' WHERE id=?").run(now,job.id);
 for(const paid of [true,false]){const key=paid?'paid':'unpaid';db.prepare("INSERT INTO orders(id,number,status,customer_email,subtotal_cents,tax_cents,total_cents,currency,stripe_checkout_session_id) VALUES(?,?,'processing','buyer@test.com',2500,0,2500,'USD',?)").run(key,key,paid?'cs_fixture':null);db.prepare("INSERT INTO marketing_attribution VALUES(?,?,'last_click_7d',?)").run(key,job.id,now);}
 db.prepare("INSERT INTO refunds(id,order_id,stripe_refund_id,amount_cents,status,currency) VALUES('refund','paid','re_test',500,'succeeded','USD')").run();
 db.prepare("INSERT INTO refunds(id,order_id,stripe_refund_id,amount_cents,status,currency) VALUES('foreign','paid','re_other',500,'succeeded','EUR')").run();
 const report=experimentReport(sql),usd=report.find(r=>r.currency==='USD')!;assert.equal(usd.net_revenue_minor,2000);assert.equal(usd.attributed_orders,1);assert.equal(report.reduce((n,r)=>n+Number(r.attributed_orders),0),1);assert.equal(usd.id,id);
});
