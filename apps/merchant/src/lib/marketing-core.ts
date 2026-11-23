import {sharedCheckoutRecoverable} from './checkout-marketing';
import {EXPERIMENT_SCHEMA,experimentPayload} from './marketing-admin';
import {z} from 'zod';
import {MARKETING_POLICY_SCHEMA,marketingPolicy} from './marketing-policy';
import type {ShippingSql} from './shipping-store';
import {ShippingError} from './smart-shipping';
export const MARKETING_SCHEMA=EXPERIMENT_SCHEMA+MARKETING_POLICY_SCHEMA+`
CREATE TABLE IF NOT EXISTS marketing_subscribers(id TEXT NOT NULL UNIQUE,email TEXT PRIMARY KEY,status TEXT NOT NULL,
 nonce TEXT NOT NULL,created_at INTEGER NOT NULL,confirmed_at INTEGER,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS marketing_consent(id TEXT PRIMARY KEY,email TEXT NOT NULL,event TEXT NOT NULL,purpose TEXT NOT NULL,source TEXT NOT NULL,policy_version TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS marketing_suppressions(email TEXT PRIMARY KEY,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS marketing_rates(rate_key TEXT NOT NULL,window INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(rate_key,window));
CREATE TABLE IF NOT EXISTS marketing_jobs(id TEXT PRIMARY KEY,email TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,
 dedupe_key TEXT NOT NULL UNIQUE,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
 due_at INTEGER NOT NULL,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,provider_id TEXT UNIQUE,
 delivery_status TEXT,accepted_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS marketing_due ON marketing_jobs(state,due_at);
CREATE TABLE IF NOT EXISTS marketing_events(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,event TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS marketing_webhook_tokens(token TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS marketing_attribution(order_id TEXT PRIMARY KEY,job_id TEXT NOT NULL,model TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS marketing_cursors(name TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS marketing_order_lookup ON orders(lower(customer_email),created_at);
CREATE INDEX IF NOT EXISTS marketing_cart_lookup ON carts(lower(customer_email),updated_at);
CREATE INDEX IF NOT EXISTS marketing_recipient_jobs ON marketing_jobs(email,state,updated_at);
`;
export const emailAddress=z.string().trim().toLowerCase().email().max(254);
export const subscriptionInput=z.object({email:emailAddress,consent:z.literal(true),source:z.enum(['newsletter','popup','checkout']),policy_version:z.string().min(1).max(100),rate_key:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type SubscriptionInput=z.infer<typeof subscriptionInput>;
export type MarketingKind='confirmation'|'welcome'|'abandoned'|'post_purchase'|'win_back';
function job(sql:ShippingSql,email:string,kind:MarketingKind,key:string,payload:Record<string,unknown>,due:number,now:number){
 sql.exec('INSERT OR IGNORE INTO marketing_jobs(id,email,kind,payload,dedupe_key,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',crypto.randomUUID(),email,kind,JSON.stringify({...payload,...experimentPayload(sql,email,kind,now),template_version:'v1'}),key,due,now,now);
}
export function subscribeMarketing(sql:ShippingSql,raw:SubscriptionInput,policy:string,now=Date.now()){
 const input=subscriptionInput.parse(raw);z.string().min(1).max(100).parse(policy);
 if(input.policy_version!==policy)throw new ShippingError('consent_policy_changed',409,'Review the current email policy before subscribing.');
 const window=Math.floor(now/3600_000),rate=sql.exec('SELECT count FROM marketing_rates WHERE rate_key=? AND window=?',input.rate_key,window).toArray()[0];
 if(Number(rate?.count||0)>=10)throw new ShippingError('subscription_rate_limited',429,'Please try again later.');
 sql.exec('INSERT INTO marketing_rates VALUES(?,?,1) ON CONFLICT(rate_key,window) DO UPDATE SET count=count+1',input.rate_key,window);
 sql.exec('DELETE FROM marketing_rates WHERE window<?',window-48);
 const existing=sql.exec('SELECT * FROM marketing_subscribers WHERE email=?',input.email).toArray()[0];
 if(sql.exec('SELECT email FROM marketing_suppressions WHERE email=?',input.email).toArray().length||existing?.status==='active')return {accepted:true};
 // Repeated submissions do not rotate a still-valid confirmation or send duplicates.
 if(existing?.status==='pending'&&Number(existing.updated_at)>now-86400000)return {accepted:true};
 const id=existing?String(existing.id):crypto.randomUUID(),nonce=crypto.randomUUID();
 sql.exec("UPDATE marketing_jobs SET state='canceled',updated_at=? WHERE email=? AND kind='confirmation' AND state IN ('pending','sending')",now,input.email);
 sql.exec("INSERT INTO marketing_subscribers(id,email,status,nonce,created_at,updated_at) VALUES(?,?,'pending',?,?,?) ON CONFLICT(email) DO UPDATE SET status='pending',nonce=excluded.nonce,updated_at=excluded.updated_at",id,input.email,nonce,now,now);
 sql.exec('INSERT INTO marketing_consent VALUES(?,?,?,?,?,?,?)',crypto.randomUUID(),input.email,'requested','news_and_offers',input.source,policy,now);
 job(sql,input.email,'confirmation',`confirmation:${id}:${nonce}`,{subscriber_id:id,nonce},now,now);
 return {accepted:true};
}
export function confirmMarketing(sql:ShippingSql,id:string,nonce:string,policy:string,now=Date.now()){
 const subscriber=sql.exec('SELECT * FROM marketing_subscribers WHERE id=? AND nonce=?',id,nonce).toArray()[0];
 if(!subscriber||sql.exec('SELECT email FROM marketing_suppressions WHERE email=?',subscriber.email).toArray().length)throw new ShippingError('confirmation_invalid',400,'Confirmation is invalid.');
 if(subscriber.status==='active')return {confirmed:true};
 if(subscriber.status!=='pending')throw new ShippingError('confirmation_invalid',400,'Confirmation is invalid.');
 sql.exec("UPDATE marketing_subscribers SET status='active',confirmed_at=?,updated_at=? WHERE id=?",now,now,id);
 const requested=sql.exec("SELECT policy_version FROM marketing_consent WHERE email=? AND event='requested' ORDER BY created_at DESC LIMIT 1",subscriber.email).toArray()[0];
 sql.exec('INSERT INTO marketing_consent VALUES(?,?,?,?,?,?,?)',crypto.randomUUID(),subscriber.email,'confirmed','news_and_offers','email_confirmation',String(requested?.policy_version||policy),now);
 job(sql,String(subscriber.email),'welcome',`welcome:${id}:${nonce}`,{subscriber_id:id},now,now);return {confirmed:true};
}
export function unsubscribeMarketing(sql:ShippingSql,id:string,now=Date.now()){
 const subscriber=sql.exec('SELECT * FROM marketing_subscribers WHERE id=?',id).toArray()[0];if(!subscriber)return {unsubscribed:true};
 if(subscriber.status==='unsubscribed')return {unsubscribed:true};
 sql.exec("UPDATE marketing_subscribers SET status='unsubscribed',updated_at=? WHERE id=?",now,id);
 sql.exec('INSERT INTO marketing_consent VALUES(?,?,?,?,?,?,?)',crypto.randomUUID(),subscriber.email,'withdrawn','news_and_offers','unsubscribe','',now);
 sql.exec("UPDATE marketing_jobs SET state='canceled',updated_at=? WHERE email=? AND state IN ('pending','sending')",now,subscriber.email);
 return {unsubscribed:true};
}
function paidCart(sql:ShippingSql,cartId:string){
 const linked=sql.exec('SELECT checkout_id FROM marketing_checkout_links WHERE cart_id=?',cartId).toArray()[0];
 if(linked)return true; // The linked checkout owns all reminders for this journey.
 const pod=sql.exec("SELECT s.order_id FROM pod_checkouts p JOIN ucp_checkout_sessions s ON s.id=p.checkout_id WHERE p.cart_id=? AND s.status='completed'",cartId).toArray().length;
 const [cart]=sql.exec('SELECT stripe_checkout_session_id FROM carts WHERE id=?',cartId).toArray();
 if(pod||cart?.stripe_checkout_session_id&&sql.exec("SELECT id FROM orders WHERE stripe_checkout_session_id=? AND status<>'pending' AND status<>'canceled'",cart.stripe_checkout_session_id).toArray().length)return true;
 if(sql.exec("SELECT name FROM sqlite_master WHERE name='commerce_orders'").toArray().length)
  return sql.exec("SELECT c.order_id FROM commerce_orders c JOIN orders o ON o.id=c.order_id WHERE c.cart_id=? AND (c.payment_status='paid' OR (c.method='cod' AND o.status NOT IN ('canceled','refunded')))",cartId).toArray().length>0;
 return false;
}
export function legacyMarketingRecoverable(sql:ShippingSql,cartId:string,subscriberId:string,now=Date.now()){
 const [row]=sql.exec("SELECT c.expires_at FROM carts c JOIN marketing_subscribers s ON lower(c.customer_email)=s.email WHERE c.id=? AND s.id=? AND s.status='active' AND NOT EXISTS(SELECT 1 FROM marketing_suppressions x WHERE x.email=s.email)",cartId,subscriberId).toArray();
 return !!row&&Date.parse(String(row.expires_at))>now&&!paidCart(sql,cartId);
}
function paidOrders(sql:ShippingSql,email:string){
 const has=(table:string)=>sql.exec('SELECT name FROM sqlite_master WHERE name=?',table).toArray().length>0;
 const receipt=has('payment_receipts')?"EXISTS(SELECT 1 FROM payment_receipts p WHERE p.order_id=o.id AND p.amount_minor=o.total_cents AND p.currency=o.currency)":"0";
 const commerce=has('commerce_orders')?"EXISTS(SELECT 1 FROM commerce_orders c WHERE c.order_id=o.id AND c.payment_status='paid')":"0";
 return sql.exec(`SELECT o.* FROM orders o WHERE lower(customer_email)=? AND status IN ('paid','processing','shipped','delivered') AND (o.status='paid' OR o.stripe_checkout_session_id IS NOT NULL OR ${receipt} OR ${commerce}) AND NOT EXISTS(SELECT 1 FROM refunds r WHERE r.order_id=o.id AND r.status='succeeded') ORDER BY created_at DESC,id DESC LIMIT 100`,email).toArray();
}
function deliveredOrder(sql:ShippingSql,order:Record<string,unknown>){return order.status==='delivered'||sql.exec("SELECT id FROM pod_fulfillments WHERE order_id=? AND state='delivered'",order.id).toArray().length>0;}
function campaignEligible(sql:ShippingSql,row:Record<string,unknown>,now:number,checkTime=true){
 const policy=marketingPolicy(sql),payload=JSON.parse(String(row.payload)),kind=String(row.kind);
 if(kind==='confirmation')return row.nonce===payload.nonce&&now-Number(row.created_at)<86400000;
 if(!['welcome','abandoned','post_purchase','win_back'].includes(kind)||!policy[kind as 'welcome'|'abandoned'|'post_purchase'|'win_back'])return false;
 if(kind==='abandoned'){
  if(payload.scope==='checkout'){
   if(!sharedCheckoutRecoverable(sql,String(payload.checkout_id),String(row.email),now))return false;
   const [session]=sql.exec('SELECT updated_at FROM ucp_checkout_sessions WHERE id=?',payload.checkout_id).toArray();
   return !checkTime||Date.parse(String(session.updated_at))<=now-policy.abandoned_after_hours*3600000;
  }
  const [cart]=sql.exec('SELECT customer_email,expires_at,updated_at FROM carts WHERE id=?',payload.cart_id).toArray();
  return !!cart&&String(cart.customer_email).toLowerCase()===row.email&&Date.parse(String(cart.expires_at))>now&&(!checkTime||Date.parse(String(cart.updated_at))<=now-policy.abandoned_after_hours*3600000)&&!paidCart(sql,String(payload.cart_id));
 }
 if(kind==='post_purchase'||kind==='win_back'){
  const orders=paidOrders(sql,String(row.email)),order=orders.find(o=>o.id===payload.order_id);if(!order)return false;
  if(kind==='win_back')return orders[0].id===order.id&&(!checkTime||Date.parse(String(order.created_at))<=now-policy.win_back_after_days*86400000);
  const [seen]=sql.exec('SELECT first_seen_at FROM marketing_delivery_observations WHERE order_id=?',order.id).toArray();
  return deliveredOrder(sql,order)&&!!seen&&(!checkTime||Number(seen.first_seen_at)<=now-policy.post_purchase_after_days*86400000);
 }
 return true;
}
export function planMarketing(sql:ShippingSql,now=Date.now()){
 const policy=marketingPolicy(sql);
 const cursor=sql.exec("SELECT value FROM marketing_cursors WHERE name='automation'").toArray()[0];
 const subscribers=sql.exec("SELECT * FROM marketing_subscribers WHERE status='active' AND id>? ORDER BY id LIMIT 200",cursor?.value||'').toArray();
 sql.exec("INSERT INTO marketing_cursors VALUES('automation',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",subscribers.at(-1)?.id||'');
 for(const sub of subscribers){
  const email=String(sub.email),sid=String(sub.id);
  const carts=policy.abandoned?sql.exec("SELECT * FROM carts WHERE lower(customer_email)=? AND unixepoch(updated_at)*1000<=? AND unixepoch(updated_at)*1000>? ORDER BY created_at DESC LIMIT 10",email,now-policy.abandoned_after_hours*3600000,now-7*86400000).toArray():[];
  for(const cart of carts){
   const cartId=String(cart.id);if(paidCart(sql,cartId))continue;
   const pod=sql.exec('SELECT checkout_id FROM pod_checkouts WHERE cart_id=?',cartId).toArray()[0];
   if(!pod&&!sql.exec('SELECT id FROM cart_items WHERE cart_id=? LIMIT 1',cartId).toArray().length&&!sql.exec('SELECT id FROM pod_quotes WHERE cart_id=? LIMIT 1',cartId).toArray().length)continue;
   if(Date.parse(String(cart.expires_at))<=now)continue;
   // Catalog-only guest aliases cannot become recipients; only confirmed subscribers reach this loop.
   job(sql,email,'abandoned',`abandoned:${cartId}`,{subscriber_id:sid,cart_id:cartId,checkout_id:pod?.checkout_id||null},now,now);
  }
  if(policy.abandoned&&sql.exec("SELECT name FROM sqlite_master WHERE name='checkout_drafts'").toArray().length){
   const shared=sql.exec(`SELECT d.id FROM checkout_drafts d JOIN ucp_checkout_sessions s ON s.id=d.id WHERE lower(json_extract(d.input_json,'$.buyer.email'))=? AND unixepoch(s.updated_at)*1000<=? AND unixepoch(s.created_at)*1000>? AND NOT EXISTS(SELECT 1 FROM checkout_recoveries r WHERE r.checkout_id=d.id) ORDER BY s.created_at DESC LIMIT 10`,email,now-policy.abandoned_after_hours*3600000,now-7*86400000).toArray();
   for(const checkout of shared)if(sharedCheckoutRecoverable(sql,String(checkout.id),email,now))job(sql,email,'abandoned',`abandoned:checkout:${checkout.id}`,{subscriber_id:sid,scope:'checkout',checkout_id:checkout.id},now,now);
  }
  const orders=paidOrders(sql,email);
  for(const order of orders){
   if(policy.post_purchase&&deliveredOrder(sql,order)){
    sql.exec('INSERT OR IGNORE INTO marketing_delivery_observations VALUES(?,?)',order.id,now);
    const [seen]=sql.exec('SELECT first_seen_at FROM marketing_delivery_observations WHERE order_id=?',order.id).toArray();
    job(sql,email,'post_purchase',`post_purchase:${order.id}`,{subscriber_id:sid,order_id:order.id},Number(seen.first_seen_at)+policy.post_purchase_after_days*86400000,now);
   }
   // Last-click attribution is reported as attributed revenue, never causal lift.
   const click=sql.exec("SELECT j.id FROM marketing_events e JOIN marketing_jobs j ON j.id=e.job_id WHERE j.email=? AND e.event='clicked' AND e.created_at<=? AND e.created_at>=? ORDER BY e.created_at DESC LIMIT 1",email,Date.parse(String(order.created_at)),Date.parse(String(order.created_at))-7*86400000).toArray()[0];
   if(click)sql.exec("INSERT OR IGNORE INTO marketing_attribution VALUES(?,?,'last_click_7d',?)",order.id,click.id,now);
  }
  const last=orders[0];if(policy.win_back&&last&&Date.parse(String(last.created_at))<=now-policy.win_back_after_days*86400000)
   job(sql,email,'win_back',`win_back:${sid}:${last.id}`,{subscriber_id:sid,order_id:last.id},now,now);
 }
 // Recheck queued lifecycle jobs after purchases, refunds and consent changes.
 for(const pending of sql.exec("SELECT j.*,s.status subscriber_status,s.nonce FROM marketing_jobs j JOIN marketing_subscribers s ON s.email=j.email WHERE j.kind<>'confirmation' AND j.state IN ('pending','sending') ORDER BY j.updated_at LIMIT 1000").toArray()){
  const enabled=policy[String(pending.kind) as 'welcome'|'abandoned'|'post_purchase'|'win_back'];
  if(!enabled)continue; // Pausing preserves pending jobs so the campaign can resume.
  if(pending.subscriber_status!=='active'||!campaignEligible(sql,pending,now,false))sql.exec("UPDATE marketing_jobs SET state='canceled',updated_at=? WHERE id=?",now,pending.id);
 }
}
export function marketingEligible(sql:ShippingSql,id:string,token:string,now=Date.now()){
 const row=sql.exec("SELECT j.*,s.id AS subscriber_id,s.status AS subscriber_status,s.nonce FROM marketing_jobs j JOIN marketing_subscribers s ON s.email=j.email WHERE j.id=? AND j.lease_token=? AND j.state='sending'",id,token).toArray()[0];
 if(!row||sql.exec('SELECT email FROM marketing_suppressions WHERE email=?',row.email).toArray().length)return null;
 if(row.kind==='confirmation'?row.subscriber_status!=='pending':row.subscriber_status!=='active')return null;
 if(Number(row.lease_until)<=now||!campaignEligible(sql,row,now))return null;
 return {...row,id:String(row.id),email:String(row.email),kind:String(row.kind) as MarketingKind,payload:JSON.parse(String(row.payload)),subscriber_id:String(row.subscriber_id),nonce:String(row.nonce)};
}
export function claimMarketing(sql:ShippingSql,token:string,now=Date.now()){
 const policy=marketingPolicy(sql);
 sql.exec("UPDATE marketing_jobs SET state='unknown',lease_token=NULL,lease_until=0,updated_at=? WHERE state='sending' AND lease_until<?",now,now);
 const rows=sql.exec("SELECT * FROM marketing_jobs WHERE state='pending' AND due_at<=? AND attempts<5 ORDER BY CASE kind WHEN 'confirmation' THEN 0 WHEN 'welcome' THEN 1 WHEN 'abandoned' THEN 2 WHEN 'post_purchase' THEN 3 ELSE 4 END,due_at,id LIMIT 100",now).toArray();
 for(const row of rows){
  if(row.kind!=='confirmation'&&!policy[String(row.kind) as 'welcome'|'abandoned'|'post_purchase'|'win_back']){sql.exec('UPDATE marketing_jobs SET due_at=? WHERE id=?',now+3600000,row.id);continue;}
  // A changed delay or renewed cart activity postpones a valid job instead of losing its dedupe key forever.
  if(row.kind!=='confirmation'&&campaignEligible(sql,row,now,false)&&!campaignEligible(sql,row,now)){sql.exec('UPDATE marketing_jobs SET due_at=? WHERE id=?',now+3600000,row.id);continue;}
  const recent=sql.exec("SELECT count(*) n FROM marketing_jobs WHERE email=? AND kind<>'confirmation' AND ((state IN ('accepted','delivered') AND accepted_at>?) OR (state IN ('sending','unknown') AND updated_at>?))",row.email,now-86400000,now-86400000).toArray()[0];
  const [cooldown]=sql.exec("SELECT id FROM marketing_jobs WHERE email=? AND kind<>'confirmation' AND (accepted_at>? OR (state IN ('sending','unknown') AND updated_at>?)) LIMIT 1",row.email,now-policy.cooldown_hours*3600000,now-policy.cooldown_hours*3600000).toArray();
  if(row.kind!=='confirmation'&&(Number(recent.n)>=policy.daily_cap||policy.cooldown_hours>0&&cooldown)){sql.exec('UPDATE marketing_jobs SET due_at=? WHERE id=?',now+3600_000,row.id);continue;}
  sql.exec("UPDATE marketing_jobs SET state='sending',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE id=?",token,now+60000,now,row.id);
  const eligible=marketingEligible(sql,String(row.id),token,now);if(eligible)return eligible;
  sql.exec("UPDATE marketing_jobs SET state='canceled',updated_at=? WHERE id=?",now,row.id);
 }
 return null;
}
export function finishMarketing(sql:ShippingSql,id:string,token:string,outcome:'accepted'|'retry'|'dead'|'unknown',providerId?:string,now=Date.now()){
 const row=sql.exec('SELECT * FROM marketing_jobs WHERE id=? AND lease_token=?',id,token).toArray()[0];if(!row)return;
 if(['accepted','delivered','canceled'].includes(String(row.state)))return;
 const state=outcome==='retry'?(Number(row.attempts)>=5?'dead':'pending'):outcome;
 sql.exec('UPDATE marketing_jobs SET state=?,provider_id=COALESCE(provider_id,?),due_at=?,lease_token=NULL,lease_until=0,updated_at=? WHERE id=?',state,providerId||null,now+Math.min(86400000,60000*2**Number(row.attempts)),now,id);
 if(outcome==='accepted')sql.exec('UPDATE marketing_jobs SET accepted_at=COALESCE(accepted_at,?) WHERE id=?',now,id);
}
export function recordMarketingEvent(sql:ShippingSql,input:{id:string;token:string;job_id:string;email:string;event:string;permanent:boolean},now=Date.now()){
 input={...input,email:emailAddress.parse(input.email)};
 const row=sql.exec('SELECT email,state,delivery_status FROM marketing_jobs WHERE id=?',input.job_id).toArray()[0];
 if(!row||String(row.email)!==emailAddress.parse(input.email))return {ignored:true};
 if(sql.exec('SELECT id FROM marketing_events WHERE id=?',input.id).toArray().length)return {duplicate:true};
 if(sql.exec('SELECT token FROM marketing_webhook_tokens WHERE token=?',input.token).toArray().length)return {duplicate:true};
 sql.exec('INSERT INTO marketing_webhook_tokens VALUES(?,?)',input.token,now);
 sql.exec('INSERT INTO marketing_events VALUES(?,?,?,?)',input.id,input.job_id,input.event,now);
 const finalFailure=['complained','unsubscribed'].includes(input.event)||(input.event==='failed'&&input.permanent);
 const oldStatus=String(row.delivery_status||'');
 // Click/open events remain in the event log; they cannot erase delivery or terminal failure evidence.
 if(finalFailure||(!['complained','unsubscribed','failed'].includes(oldStatus)&&(input.event==='delivered'||!oldStatus||oldStatus!=='delivered'&&input.event==='accepted')))
  sql.exec('UPDATE marketing_jobs SET delivery_status=?,updated_at=? WHERE id=?',input.event==='failed'&&!input.permanent?'temporary_failure':input.event,now,input.job_id);
 if(input.event==='delivered')sql.exec("UPDATE marketing_jobs SET state='delivered' WHERE id=? AND state<>'canceled'",input.job_id);
 if(input.event==='accepted')sql.exec("UPDATE marketing_jobs SET state='accepted' WHERE id=? AND state NOT IN ('delivered','canceled')",input.job_id);
 if(['accepted','delivered'].includes(input.event))sql.exec('UPDATE marketing_jobs SET accepted_at=COALESCE(accepted_at,?) WHERE id=?',now,input.job_id);
 if(['complained','unsubscribed'].includes(input.event)||(input.event==='failed'&&input.permanent)){
  sql.exec('INSERT OR IGNORE INTO marketing_suppressions VALUES(?,?,?)',input.email,input.event,now);
  sql.exec("UPDATE marketing_subscribers SET status='suppressed',updated_at=? WHERE email=?",now,input.email);
  sql.exec("UPDATE marketing_jobs SET state='canceled',updated_at=? WHERE email=? AND state IN ('pending','sending')",now,input.email);
 }
 return {recorded:true};
}
