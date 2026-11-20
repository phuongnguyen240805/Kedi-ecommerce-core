import {z} from 'zod';
import type {ShippingSql} from './shipping-store';
export const EXPERIMENT_SCHEMA=`
CREATE TABLE IF NOT EXISTS marketing_experiments(id TEXT PRIMARY KEY,kind TEXT NOT NULL,config TEXT NOT NULL,active INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS marketing_one_active_experiment ON marketing_experiments(kind) WHERE active=1;
CREATE TABLE IF NOT EXISTS marketing_assignments(experiment_id TEXT NOT NULL,email TEXT NOT NULL,variant TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(experiment_id,email));`;
export const marketingCopy=z.object({subject:z.string().trim().min(1).max(150).refine(v=>!/[\r\n]/.test(v)),text:z.string().trim().min(10).max(3000)}).strict();
export const experimentInput=z.object({kind:z.enum(['welcome','abandoned','post_purchase','win_back']),a:marketingCopy,b:marketingCopy}).strict();
export function createExperiment(sql:ShippingSql,raw:z.infer<typeof experimentInput>,now=Date.now()){
 const config=experimentInput.parse(raw),id=crypto.randomUUID();
 if(sql.exec('SELECT id FROM marketing_experiments WHERE kind=? AND active=1',config.kind).toArray().length)throw Error('Pause the current experiment before creating another');
 sql.exec('INSERT INTO marketing_experiments VALUES(?,?,?,1,?)',id,config.kind,JSON.stringify(config),now);return {id};
}
export function experimentPayload(sql:ShippingSql,email:string,kind:string,now=Date.now()){
 const [experiment]=sql.exec('SELECT * FROM marketing_experiments WHERE active=1 AND kind=?',kind).toArray();if(!experiment)return {};
 let [assigned]=sql.exec('SELECT variant FROM marketing_assignments WHERE experiment_id=? AND email=?',experiment.id,email).toArray();
 if(!assigned){const variant=crypto.getRandomValues(new Uint8Array(1))[0]<128?'a':'b';sql.exec('INSERT INTO marketing_assignments VALUES(?,?,?,?)',experiment.id,email,variant,now);assigned={variant};}
 const config=experimentInput.parse(JSON.parse(String(experiment.config))),variant=assigned.variant==='a'?'a':'b';
 return {experiment_id:String(experiment.id),experiment_variant:variant,copy:config[variant]};
}
// One aggregate query, filtered before pagination. Never convert/sum unlike currencies.
export function marketingRfm(sql:ShippingSql,cursor='',now=Date.now()){
 const subscribers=sql.exec("SELECT email FROM marketing_subscribers s WHERE status='active' AND email>? AND NOT EXISTS(SELECT 1 FROM marketing_suppressions x WHERE x.email=s.email) ORDER BY email LIMIT 51",cursor).toArray();
 const emails=subscribers.slice(0,50).map(r=>String(r.email));if(!emails.length)return {window_days:365,rows:[],next_cursor:null};
 const rows=sql.exec(`WITH paid AS (
 SELECT o.id,lower(o.customer_email) email,o.currency,o.created_at,
 MAX(0,o.total_cents-COALESCE((SELECT SUM(r.amount_cents) FROM refunds r WHERE r.order_id=o.id AND r.currency=o.currency AND r.status='succeeded'),0)) net
 FROM orders o WHERE o.status IN ('paid','processing','shipped','delivered') AND unixepoch(o.created_at)*1000>=?
 AND (EXISTS(SELECT 1 FROM payment_receipts pr WHERE pr.order_id=o.id AND pr.amount_minor=o.total_cents AND pr.currency=o.currency) OR o.stripe_checkout_session_id IS NOT NULL OR EXISTS(SELECT 1 FROM commerce_orders c WHERE c.order_id=o.id AND c.payment_status='paid'))
 ) SELECT s.id,s.email,p.currency,MAX(unixepoch(p.created_at)*1000) last_paid_at,COUNT(p.id) frequency,COALESCE(SUM(p.net),0) monetary_minor
 FROM marketing_subscribers s LEFT JOIN paid p ON p.email=s.email AND p.net>0
 WHERE s.email IN (${emails.map(()=>'?').join(',')})
 GROUP BY s.email,p.currency ORDER BY s.email,p.currency LIMIT 1001`,now-365*86400000,...emails).toArray();
 if(rows.length>1000)throw Error('Too many currencies for this customer page');
 return {window_days:365,rows:rows.map(r=>{const recency=r.last_paid_at==null?null:Math.max(0,Math.floor((now-Number(r.last_paid_at))/86400000)),frequency=Number(r.frequency);return {...r,recency_days:recency,segment:frequency===0?'prospect':recency!<=30&&frequency>=3?'loyal':recency!<=30?'recent':recency!>=90?'at_risk':'active'};}),next_cursor:subscribers.length>50?emails.at(-1)!:null};
}
export function experimentReport(sql:ShippingSql){
 return sql.exec(`SELECT e.id,e.kind,e.active,json_extract(j.payload,'$.experiment_variant') variant,o.currency,
 COUNT(DISTINCT j.id) queued,COUNT(DISTINCT CASE WHEN j.accepted_at IS NOT NULL THEN j.id END) accepted,
 COUNT(DISTINCT CASE WHEN j.delivery_status='delivered' THEN j.id END) delivered,COUNT(DISTINCT o.id) attributed_orders,
 COALESCE(SUM(CASE WHEN o.id IS NOT NULL THEN MAX(0,o.total_cents-COALESCE((SELECT SUM(r.amount_cents) FROM refunds r WHERE r.order_id=o.id AND r.currency=o.currency AND r.status='succeeded'),0)) ELSE 0 END),0) net_revenue_minor
 FROM marketing_experiments e LEFT JOIN marketing_jobs j ON json_extract(j.payload,'$.experiment_id')=e.id
 LEFT JOIN marketing_attribution a ON a.job_id=j.id LEFT JOIN orders o ON o.id=a.order_id AND o.status IN ('paid','processing','shipped','delivered')
 AND (EXISTS(SELECT 1 FROM payment_receipts pr WHERE pr.order_id=o.id AND pr.amount_minor=o.total_cents AND pr.currency=o.currency) OR o.stripe_checkout_session_id IS NOT NULL OR EXISTS(SELECT 1 FROM commerce_orders c WHERE c.order_id=o.id AND c.payment_status='paid'))
 GROUP BY e.id,variant,o.currency ORDER BY e.created_at DESC LIMIT 200`).toArray();
}
