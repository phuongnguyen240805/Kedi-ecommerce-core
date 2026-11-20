import { z } from 'zod';
import type { ShippingSql } from './shipping-store';
import { ShippingError } from './smart-shipping';

export const POD_SCHEMA = `
CREATE TABLE IF NOT EXISTS pod_mappings(sku TEXT PRIMARY KEY,version TEXT NOT NULL,config TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pod_artworks(id TEXT PRIMARY KEY,cart_id TEXT NOT NULL,object_key TEXT NOT NULL,
 sha256 TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,approved_at INTEGER);
CREATE TABLE IF NOT EXISTS pod_audit(id TEXT PRIMARY KEY,subject_id TEXT NOT NULL,event TEXT NOT NULL,evidence TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pod_quotes(id TEXT PRIMARY KEY,cart_id TEXT NOT NULL,snapshot TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pod_checkouts(cart_id TEXT PRIMARY KEY,quote_id TEXT NOT NULL,checkout_id TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS pod_fulfillments(id TEXT PRIMARY KEY,order_id TEXT NOT NULL UNIQUE,
 reference TEXT NOT NULL UNIQUE,body TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',
 external_id TEXT UNIQUE,attempted_at INTEGER,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,
 status_json TEXT,last_error TEXT,updated_at INTEGER NOT NULL);
`;
const minor = z.number().int().nonnegative().max(100_000_000);
export const podAddress = z.object({ first_name:z.string().trim().min(1).max(80),last_name:z.string().trim().min(1).max(80),
 email:z.string().email().max(254),phone:z.string().max(40).default(''),country:z.string().regex(/^[A-Z]{2}$/),
 region:z.string().max(100).default(''),address1:z.string().trim().min(3).max(200),address2:z.string().max(200).default(''),
 city:z.string().trim().min(1).max(100),zip:z.string().trim().min(1).max(30) }).strict();
export const podMapping = z.object({ product_id:z.string().regex(/^[a-zA-Z0-9_-]+$/),variant_id:z.number().int().positive(),
 blueprint_id:z.number().int().positive(),print_provider_id:z.number().int().positive(),
 placement:z.enum(['front','back']),min_width:z.number().int().min(100).max(15000),min_height:z.number().int().min(100).max(15000),
 countries:z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),production_cost_minor:minor,
 cost_verified_until:z.number().int().positive(),minimum_margin_minor:minor.default(0),
 tax_bps:z.number().int().min(0).max(10000),tax_policy_ref:z.string().min(3).max(200),
 // A live merchant must explicitly verify its Printify account bills in USD.
 currency:z.literal('USD'),enabled:z.boolean(), }).strict();
export const podQuoteInput=z.object({cart_id:z.string().uuid(),recipient:podAddress,
 lines:z.array(z.object({sku:z.string().min(1).max(150),qty:z.number().int().min(1).max(99),artwork_id:z.string().uuid()}).strict()).min(1).max(20)}).strict();
export type PodQuoteInput=z.infer<typeof podQuoteInput>;
export type PodMapping=z.infer<typeof podMapping>;
export type PodLine={sku:string;qty:number;title:string;unit_minor:number;artwork_id:string;sha256:string;mapping_version:string;mapping:PodMapping};
export type PodSnapshot={cart_id:string;recipient:z.infer<typeof podAddress>;lines:PodLine[];subtotal:number;tax:number;shipping:number;amount:number;cost:number;expires_at:number};
function fail(code:string,message:string):never{throw new ShippingError(code,409,message);}
export function podQuotePlan(sql:ShippingSql,raw:PodQuoteInput,now=Date.now()){
 const input=podQuoteInput.parse(raw);
 const cart=sql.exec('SELECT * FROM carts WHERE id=?',input.cart_id).toArray()[0];
 if(!cart||cart.status!=='open'||cart.currency!=='USD'||!Number.isFinite(Date.parse(String(cart.expires_at)))||Date.parse(String(cart.expires_at))<=now)fail('pod_cart_invalid','An open USD cart is required.');
 if(String(cart.customer_email).toLowerCase()!==input.recipient.email.toLowerCase())fail('pod_contact_changed','Start a new draft to change the contact email.');
 if(new Set(input.lines.map(l=>l.sku)).size!==input.lines.length)fail('pod_duplicate_sku','Combine quantities for the same SKU.');
 const lines:PodLine[]=input.lines.map(l=>{
  const row=sql.exec(`SELECT v.*,p.status AS product_status,COALESCE(vp.price_cents,CASE WHEN v.currency='USD' THEN v.price_cents END) AS retail
   FROM variants v JOIN products p ON p.id=v.product_id
   LEFT JOIN variant_prices vp ON vp.variant_id=v.id AND vp.currency_id=(SELECT id FROM currencies WHERE code='USD' AND status='active') WHERE v.sku=?`,l.sku).toArray()[0];
  const stored=sql.exec('SELECT * FROM pod_mappings WHERE sku=?',l.sku).toArray()[0];
  const art=sql.exec('SELECT * FROM pod_artworks WHERE id=? AND cart_id=?',l.artwork_id,input.cart_id).toArray()[0];
  if(!row||row.status!=='active'||row.product_status!=='active'||!stored)fail('pod_mapping_missing','This product is not available for POD.');
  const mapping=podMapping.parse(JSON.parse(String(stored.config)));
  if(!mapping.enabled||mapping.cost_verified_until<=now||!mapping.countries.includes(input.recipient.country))fail('pod_destination_unavailable','POD cost or destination is not verified.');
  if(!art||!art.approved_at||Number(art.width)<mapping.min_width||Number(art.height)<mapping.min_height)fail('pod_artwork_unapproved','Artwork must be approved and meet print dimensions.');
  return {...l,title:String(row.title),unit_minor:minor.parse(row.retail),sha256:String(art.sha256),mapping_version:String(stored.version),mapping};
 });
 const subtotal=minor.parse(lines.reduce((n,l)=>n+l.unit_minor*l.qty,0));
 const cost=minor.parse(lines.reduce((n,l)=>n+l.mapping.production_cost_minor*l.qty,0));
 const tax=minor.parse(lines.reduce((n,l)=>n+Math.round(l.unit_minor*l.qty*l.mapping.tax_bps/10000),0));
 if(lines.some(l=>l.unit_minor-l.mapping.production_cost_minor<l.mapping.minimum_margin_minor))fail('pod_margin_invalid','Product margin requires merchant review.');
 return {cart_id:input.cart_id,recipient:input.recipient,lines,subtotal,tax,cost};
}
export function storePodQuote(sql:ShippingSql,plan:ReturnType<typeof podQuotePlan>,shipping:number,now=Date.now()){
 minor.parse(shipping);const id=crypto.randomUUID();const snapshot:PodSnapshot={...plan,shipping,amount:minor.parse(plan.subtotal+plan.tax+shipping),expires_at:now+10*60_000};
 sql.exec('INSERT INTO pod_quotes VALUES(?,?,?,?)',id,plan.cart_id,JSON.stringify(snapshot),snapshot.expires_at);
 return {id,currency:'USD',subtotal:plan.subtotal,tax:plan.tax,shipping,total:snapshot.amount,expires_at:snapshot.expires_at};
}
export function checkoutPodQuote(sql:ShippingSql,cartId:string,quoteId:string,expected:number,now=Date.now()){
 const row=sql.exec('SELECT * FROM pod_quotes WHERE id=? AND cart_id=?',quoteId,cartId).toArray()[0];
 if(!row)fail('pod_quote_expired','Request a fresh quote.');
 const snapshot=JSON.parse(String(row.snapshot)) as PodSnapshot;
 if(snapshot.amount!==expected)fail('pod_total_changed','Confirm the current checkout total.');
 const previous=sql.exec('SELECT * FROM pod_checkouts WHERE cart_id=?',cartId).toArray()[0];
 if(previous){if(previous.quote_id!==quoteId)fail('pod_checkout_exists','Cart already has a payment checkout.');return {id:String(previous.checkout_id)};}
 if(Number(row.expires_at)<=now)fail('pod_quote_expired','Request a fresh quote.');
 const fresh=podQuotePlan(sql,{cart_id:cartId,recipient:snapshot.recipient,lines:snapshot.lines.map(({sku,qty,artwork_id})=>({sku,qty,artwork_id}))},now);
 if(fresh.subtotal!==snapshot.subtotal||fresh.tax!==snapshot.tax||fresh.lines.some((l,i)=>l.mapping_version!==snapshot.lines[i].mapping_version||l.sha256!==snapshot.lines[i].sha256))fail('pod_quote_changed','Catalog or artwork changed; request a new quote.');
 const id=crypto.randomUUID(),time=new Date(now).toISOString();
 const items=snapshot.lines.map(l=>({id:crypto.randomUUID(),item:{id:l.sku,title:l.title},quantity:l.qty,
  unit_price:{amount:l.unit_minor,currency:'USD'},total_price:{amount:l.unit_minor*l.qty,currency:'USD'},fulfillment_mode:'pod'}));
 const totals=[{type:'subtotal',amount:snapshot.subtotal,currency:'USD'},{type:'tax',amount:snapshot.tax,currency:'USD'},
  {type:'shipping',amount:snapshot.shipping,currency:'USD'},{type:'grand_total',amount:snapshot.amount,currency:'USD'}];
 sql.exec("INSERT INTO ucp_checkout_sessions(id,status,currency,line_items,buyer,totals,expires_at,created_at,updated_at) VALUES(?,'ready_for_complete','USD',?,?,?,?,?,?)",
  id,JSON.stringify(items),JSON.stringify({email:snapshot.recipient.email}),JSON.stringify(totals),new Date(snapshot.expires_at).toISOString(),time,time);
 sql.exec('INSERT INTO pod_checkouts VALUES(?,?,?)',cartId,quoteId,id);
 sql.exec("UPDATE carts SET status='checked_out',updated_at=? WHERE id=?",time,cartId);
 return {id};
}
export function enqueuePodFulfillment(sql:ShippingSql,checkoutId:string,orderId:string,now=Date.now()){
 const link=sql.exec('SELECT q.snapshot FROM pod_checkouts c JOIN pod_quotes q ON q.id=c.quote_id WHERE c.checkout_id=?',checkoutId).toArray()[0];
 if(!link)fail('pod_checkout_missing','POD checkout snapshot is missing.');
 const snapshot=JSON.parse(String(link.snapshot)) as PodSnapshot;
 sql.exec('UPDATE orders SET shipping_name=?,shipping_phone=?,ship_to=? WHERE id=?',
  `${snapshot.recipient.first_name} ${snapshot.recipient.last_name}`,snapshot.recipient.phone,
  JSON.stringify({line1:snapshot.recipient.address1,line2:snapshot.recipient.address2,city:snapshot.recipient.city,state:snapshot.recipient.region,postal_code:snapshot.recipient.zip,country:snapshot.recipient.country}),orderId);
 const id=crypto.randomUUID();sql.exec('INSERT INTO pod_fulfillments(id,order_id,reference,body,state,updated_at) VALUES(?,?,?,?,?,?)',id,orderId,'kedi-'+orderId,String(link.snapshot),'queued',now);
}
export function approvePodArtwork(sql:ShippingSql,id:string,evidence:string,now=Date.now()){
 z.string().min(10).max(1000).parse(evidence);
 const art=sql.exec('SELECT id FROM pod_artworks WHERE id=?',id).toArray()[0];if(!art)fail('pod_artwork_missing','Artwork not found.');
 sql.exec('INSERT INTO pod_audit VALUES(?,?,?,?,?)',crypto.randomUUID(),id,'artwork.approved',evidence,now);
 sql.exec('UPDATE pod_artworks SET approved_at=? WHERE id=?',now,id);return {approved:true};
}
export function reviewPodArtwork(sql:ShippingSql,id:string,evidence:string,approve:boolean,now=Date.now()){
 z.string().min(10).max(1000).parse(evidence);
 const art=sql.exec('SELECT a.id,c.status FROM pod_artworks a JOIN carts c ON c.id=a.cart_id WHERE a.id=?',id).toArray()[0];
 if(!art||art.status!=='open')fail('pod_artwork_locked','Only artwork in an open cart can be reviewed.');
 sql.exec('INSERT INTO pod_audit VALUES(?,?,?,?,?)',crypto.randomUUID(),id,approve?'artwork.approved':'artwork.rejected',evidence,now);
 sql.exec('UPDATE pod_artworks SET approved_at=? WHERE id=?',approve?now:null,id);
 return {approved:approve};
}
export function savePodMappingDraft(sql:ShippingSql,sku:string,raw:unknown,actor:string){
 z.string().min(1).max(150).parse(sku);const config=podMapping.parse(raw);
 if(config.enabled)fail('pod_activation_deferred','Draft mappings must remain disabled.');
 const variant=sql.exec("SELECT v.id FROM variants v JOIN products p ON p.id=v.product_id JOIN variant_prices vp ON vp.variant_id=v.id JOIN currencies c ON c.id=vp.currency_id WHERE v.sku=? AND v.status='active' AND p.status='active' AND c.code='USD' AND c.status='active' AND vp.price_cents>0",sku).toArray()[0];
 if(!variant)fail('pod_sku_unavailable','An active Fufuni SKU with an explicit USD price is required.');
 const version=crypto.randomUUID();
 sql.exec("INSERT INTO pod_mappings VALUES(?,?,?) ON CONFLICT(sku) DO UPDATE SET version=excluded.version,config=excluded.config WHERE json_extract(pod_mappings.config,'$.enabled')=0",sku,version,JSON.stringify(config));
 if(Number(sql.exec('SELECT changes() n').toArray()[0].n)!==1)fail('pod_mapping_active','Disable an active mapping through the production review process first.');
 sql.exec('INSERT INTO pod_audit VALUES(?,?,?,?,?)',crypto.randomUUID(),sku,'mapping.draft_saved',JSON.stringify({actor,version}),Date.now());
 return {version,enabled:false};
}
export function claimPodFulfillment(sql:ShippingSql,id:string,token:string,now=Date.now()){
 const row=sql.exec("SELECT f.*,o.status AS order_status FROM pod_fulfillments f JOIN orders o ON o.id=f.order_id WHERE f.id=? AND EXISTS(SELECT 1 FROM payment_receipts r WHERE r.order_id=o.id AND r.provider='stripe')",id).toArray()[0];
 if(!row||(!row.attempted_at&&['pending','canceled','refunded'].includes(String(row.order_status)))||Number(row.lease_until)>now||['delivered','canceled'].includes(String(row.state))||(row.state==='needs_review'&&!row.external_id))return null;
 // Record attempted before external I/O. Expired leases can reconcile only.
 sql.exec("UPDATE pod_fulfillments SET state=?,attempted_at=COALESCE(attempted_at,?),lease_token=?,lease_until=?,updated_at=? WHERE id=?",row.attempted_at?'submission_unknown':'submitting',now,token,now+60_000,now,id);
 return {id,reference:String(row.reference),snapshot:JSON.parse(String(row.body)) as PodSnapshot,externalId:row.external_id?String(row.external_id):null,reconcileOnly:!!row.attempted_at};
}
export function finishPodFulfillment(sql:ShippingSql,id:string,token:string,result:{state:'accepted'|'submission_unknown'|'needs_review'|'in_production'|'shipped'|'delivered'|'canceled';externalId?:string;status?:unknown},now=Date.now()){
 const row=sql.exec('SELECT * FROM pod_fulfillments WHERE id=? AND lease_token=?',id,token).toArray()[0];
 if(!row)fail('pod_lease_lost','POD lease is no longer owned.');
 if(row.external_id&&result.externalId&&row.external_id!==result.externalId)fail('pod_external_conflict','POD external order changed.');
 sql.exec('UPDATE pod_fulfillments SET state=?,external_id=COALESCE(external_id,?),status_json=?,lease_token=NULL,lease_until=0,updated_at=? WHERE id=?',
  result.state,result.externalId||null,JSON.stringify(result.status||null),now,id);
}
