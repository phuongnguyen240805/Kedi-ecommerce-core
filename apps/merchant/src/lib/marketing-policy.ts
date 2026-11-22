import {z} from 'zod';
import type {ShippingSql} from './shipping-store';
import {ShippingError} from './smart-shipping';

export const MARKETING_POLICY_SCHEMA=`
CREATE TABLE IF NOT EXISTS marketing_settings(id TEXT PRIMARY KEY,config TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS marketing_delivery_observations(order_id TEXT PRIMARY KEY,first_seen_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS marketing_checkout_links(cart_id TEXT PRIMARY KEY,checkout_id TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS marketing_audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,evidence TEXT NOT NULL,created_at INTEGER NOT NULL);
`;
export const marketingPolicyInput=z.object({
 welcome:z.boolean().default(true),abandoned:z.boolean().default(true),post_purchase:z.boolean().default(true),win_back:z.boolean().default(true),
 abandoned_after_hours:z.number().int().min(1).max(168).default(1),post_purchase_after_days:z.number().int().min(0).max(30).default(3),
 win_back_after_days:z.number().int().min(30).max(365).default(90),daily_cap:z.number().int().min(1).max(3).default(3),
 cooldown_hours:z.number().int().min(0).max(168).default(0),batch_size:z.number().int().min(1).max(50).default(10)
}).strict();
export function marketingPolicy(sql:ShippingSql){
 const [row]=sql.exec("SELECT config FROM marketing_settings WHERE id='automation'").toArray();
 return marketingPolicyInput.parse(row?JSON.parse(String(row.config)):{});
}
export function saveMarketingPolicy(sql:ShippingSql,raw:unknown,actor:string,now=Date.now()){
 const policy=marketingPolicyInput.parse(raw);
 sql.exec("INSERT INTO marketing_settings VALUES('automation',?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,updated_at=excluded.updated_at",JSON.stringify(policy),now);
 sql.exec('INSERT INTO marketing_audit VALUES(?,?,?,?,?,?)',crypto.randomUUID(),actor,'policy','automation',JSON.stringify(policy),now);
 return policy;
}
export const marketingJobDecision=z.object({action:z.enum(['cancel','retry_rejected']),evidence:z.string().trim().min(10).max(1000)}).strict();
export function decideMarketingJob(sql:ShippingSql,id:string,raw:unknown,actor:string,now=Date.now()){
 const input=marketingJobDecision.parse(raw),[row]=sql.exec('SELECT state FROM marketing_jobs WHERE id=?',id).toArray();
 // Unknown means the provider may already have sent the email. Only a webhook may resolve it.
 if(!row||(input.action==='retry_rejected'?row.state!=='dead':!['pending','unknown','dead'].includes(String(row.state))))throw new ShippingError('marketing_job_conflict',409,'This job cannot be changed. Unknown deliveries cannot be retried.');
 sql.exec('UPDATE marketing_jobs SET state=?,attempts=0,due_at=?,lease_token=NULL,lease_until=0,updated_at=? WHERE id=?',input.action==='cancel'?'canceled':'pending',now,now,id);
 sql.exec('INSERT INTO marketing_audit VALUES(?,?,?,?,?,?)',crypto.randomUUID(),actor,input.action,id,input.evidence,now);
 return {saved:true};
}
