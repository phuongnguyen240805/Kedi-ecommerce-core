import {z} from 'zod';
import type {ShippingSql} from './shipping-store';
import {ShippingError} from './smart-shipping';
export const FEED_SCHEMA='CREATE TABLE IF NOT EXISTS feed_offers(sku TEXT PRIMARY KEY,config TEXT NOT NULL,updated_at INTEGER NOT NULL);';
const publicUrl=z.string().url().refine(value=>{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&u.hostname!=='localhost'&&!/^(\d{1,3}\.){3}\d{1,3}$/.test(u.hostname);},'Public HTTPS URL required');
export const feedOffer=z.object({title:z.string().min(1).max(150),description:z.string().trim().min(1).max(5000).refine(v=>v.replace(/<[^>]*>/g,'').trim().length>0,'Description must contain text'),brand:z.string().trim().min(1).max(100),seller_name:z.string().min(1).max(100),
 url:publicUrl,image_url:publicUrl,currency:z.string().regex(/^[A-Z]{3}$/),store_country:z.string().regex(/^[A-Z]{2}$/),target_countries:z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(100),
 mode:z.enum(['stock','pod']),approved:z.boolean(),availability_verified_until:z.number().int(),group_id:z.string().max(50).optional(),size:z.string().max(100).optional(),color:z.string().max(100).optional(),
 gtin:z.string().regex(/^\d{8}$|^\d{12,14}$/).optional(),identifier_exists:z.boolean(),google_category:z.string().max(200).optional(),gender:z.enum(['male','female','unisex']).optional(),age_group:z.enum(['newborn','infant','toddler','kids','adult']).optional(),
 mpn:z.string().trim().min(1).max(70).optional(),return_policy_url:publicUrl.optional()}).strict();
export type FeedOffer=z.infer<typeof feedOffer>;
export type CanonicalOffer=FeedOffer&{item_id:string;price:string;availability:'in_stock'|'out_of_stock';product_id:string;sku:string;unit_price:number;decimal_places:number};
function validGtin(gtin:string){let sum=0;for(let i=gtin.length-2,weight=3;i>=0;i--,weight=weight===3?1:3)sum+=Number(gtin[i])*weight;return (10-sum%10)%10===Number(gtin.at(-1));}
export function canonicalOffer(row:Record<string,unknown>,now=Date.now()):CanonicalOffer{
 const config=feedOffer.parse(JSON.parse(String(row.config)));
 if(!config.approved)throw Error('not_approved');
 if(row.variant_status!=='active'||row.product_status!=='active')throw Error('inactive_product');
 const price=z.number().int().positive().max(1_000_000_000).parse(row.price_minor),decimals=z.number().int().min(0).max(4).parse(row.decimal_places);
 if(config.gtin&&!validGtin(config.gtin))throw Error('invalid_gtin');
 if((config.gtin||config.mpn)&&!config.identifier_exists)throw Error('conflicting_identifier');
 if(config.identifier_exists&&!config.gtin&&!config.mpn)throw Error('missing_identifier');
 if((['166','1604','187'].includes(config.google_category||'')||config.google_category?.startsWith('Apparel'))&&(!config.size||!config.color||!config.gender||!config.age_group))throw Error('missing_apparel_attributes');
 if(config.group_id&&(config.group_id===String(row.variant_id)||!config.size&&!config.color))throw Error('invalid_variant_group');
 const available=config.availability_verified_until>now&&(config.mode==='pod'?row.pod_available===1:Number(row.available)>0);
 return {...config,sku:String(row.sku||row.variant_id),unit_price:price,decimal_places:decimals,item_id:String(row.variant_id),product_id:String(row.product_id),price:`${(price/10**decimals).toFixed(decimals)} ${config.currency}`,availability:available?'in_stock':'out_of_stock'};
}
export function feedSnapshot(sql:ShippingSql,now=Date.now()){
 const count=Number(sql.exec('SELECT count(*) n FROM feed_offers').toArray()[0].n);
 if(count>2000)throw new ShippingError('feed_snapshot_too_large',503,'Feed needs a paginated publisher before exceeding 2000 offers.');
 const records=sql.exec(`SELECT f.sku,f.config,v.id AS variant_id,v.product_id,v.status AS variant_status,p.status AS product_status,
 cur.decimal_places,COALESCE(vp.price_cents,CASE WHEN v.currency=json_extract(f.config,'$.currency') THEN v.price_cents END) AS price_minor,
 COALESCE(i.on_hand-i.reserved,0) AS available,
 CASE WHEN json_extract(m.config,'$.enabled')=1 AND json_extract(m.config,'$.cost_verified_until')>? THEN 1 ELSE 0 END AS pod_available
 FROM feed_offers f LEFT JOIN variants v ON v.sku=f.sku LEFT JOIN products p ON p.id=v.product_id
 LEFT JOIN currencies cur ON cur.code=json_extract(f.config,'$.currency') AND cur.status='active'
 LEFT JOIN variant_prices vp ON vp.variant_id=v.id AND vp.currency_id=cur.id
 LEFT JOIN inventory i ON i.sku=v.sku LEFT JOIN pod_mappings m ON m.sku=v.sku ORDER BY v.id`,now).toArray();
 const offers:CanonicalOffer[]=[],errors:{sku:string;reason:string}[]=[];
 for(const record of records){try{offers.push(canonicalOffer(record,now));}catch(e){errors.push({sku:String(record.sku),reason:e instanceof z.ZodError?'invalid_offer_contract':e instanceof Error?e.message:'invalid_offer'});}}
 const rejected=new Set<string>();
 const groups=new Map<string,CanonicalOffer[]>();for(const offer of offers)if(offer.group_id)groups.set(offer.group_id,[...(groups.get(offer.group_id)||[]),offer]);
 for(const [group,variants] of groups){const signatures=variants.map(v=>JSON.stringify({size:v.size||'',color:v.color||''}));const fields=variants.map(v=>[v.size?'size':'',v.color?'color':''].filter(Boolean).join(','));if(new Set(variants.map(v=>v.product_id)).size>1||new Set(signatures).size!==signatures.length||new Set(fields).size>1||records.some(v=>String(v.variant_id)===group)){for(const variant of variants)rejected.add(variant.item_id);}}
 for(const record of records)if(rejected.has(String(record.variant_id)))errors.push({sku:String(record.sku),reason:'invalid_variant_group_membership'});
 return {generated_at:new Date(now).toISOString(),offers:offers.filter(v=>!rejected.has(v.item_id)),errors};
}
export function openAiRecord(o:CanonicalOffer){return {item_id:o.item_id,title:o.title,description:o.description.replace(/<[^>]*>/g,''),url:o.url,brand:o.brand,seller_name:o.seller_name,image_url:o.image_url,
 price:o.price,availability:o.availability,target_countries:o.target_countries,store_country:o.store_country,is_eligible_search:true,is_eligible_checkout:false,
 ...(o.group_id?{group_id:o.group_id,listing_has_variations:true,variant_dict:{...(o.size?{size:o.size}:{}),...(o.color?{color:o.color}:{})}}:{}),
 ...(o.size?{size:o.size}:{}),...(o.color?{color:o.color}:{}),...(o.gtin?{gtin:o.gtin}:{}),...(o.mpn?{mpn:o.mpn}:{}),...(o.return_policy_url?{return_policy:o.return_policy_url}:{})};}
export const escapeFeedXml=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
export function googleItem(o:CanonicalOffer){const fields:Record<string,string>={id:o.item_id,title:o.title,description:o.description.replace(/<[^>]*>/g,''),link:o.url,image_link:o.image_url,price:o.price,availability:o.availability,brand:o.brand,condition:'new',identifier_exists:o.identifier_exists?'yes':'no'};
 for(const key of ['size','color','gtin','mpn','gender','age_group'] as const)if(o[key])fields[key]=o[key]!;
 if(o.group_id)fields.item_group_id=o.group_id;if(o.google_category)fields.google_product_category=o.google_category;
 return '<item>'+Object.entries(fields).map(([k,v])=>`<g:${k}>${escapeFeedXml(v)}</g:${k}>`).join('')+'</item>';
}
export function putFeedOffer(sql:ShippingSql,sku:string,raw:FeedOffer,storeUrl:string){
 const config=feedOffer.parse(raw);
 if(new URL(config.url).origin!==new URL(storeUrl).origin)throw new ShippingError('feed_wrong_origin',400,'Product URL must belong to this storefront.');
 if(!sql.exec('SELECT id FROM variants WHERE sku=?',sku).toArray().length)throw new ShippingError('feed_variant_missing',404,'Variant not found.');
 const exists=sql.exec('SELECT sku FROM feed_offers WHERE sku=?',sku).toArray().length;
 if(!exists&&Number(sql.exec('SELECT count(*) n FROM feed_offers').toArray()[0].n)>=2000)throw new ShippingError('feed_limit',409,'Feed publisher capacity reached.');
 sql.exec('INSERT INTO feed_offers VALUES(?,?,?) ON CONFLICT(sku) DO UPDATE SET config=excluded.config,updated_at=excluded.updated_at',sku,JSON.stringify(config),Date.now());return {saved:true};
}
