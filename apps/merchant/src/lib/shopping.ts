import {z} from 'zod';
import {SignJWT,jwtVerify} from 'jose';
import type {CanonicalOffer} from './product-feeds';
import type {ShippingSql} from './shipping-store';
export const shoppingSelection=z.object({item_id:z.string().min(1).max(100),qty:z.number().int().min(1).max(99),country:z.string().regex(/^[A-Z]{2}$/)}).strict();
export type ShoppingSelection=z.infer<typeof shoppingSelection>;
export function shoppingSearch(offers:CanonicalOffer[],query:string,country:string){
 const words=query.toLocaleLowerCase().normalize('NFKC').split(/\s+/).filter(Boolean);
 return offers.filter(o=>o.target_countries.includes(country)&&o.availability==='in_stock'&&words.every(w=>(o.title+' '+o.description+' '+(o.color||'')+' '+(o.size||'')).toLocaleLowerCase().normalize('NFKC').includes(w))).slice(0,20);
}
export function selectedOffer(offers:CanonicalOffer[],selection:ShoppingSelection){
 const o=offers.find(o=>o.item_id===selection.item_id&&o.target_countries.includes(selection.country)&&o.availability==='in_stock');
 if(!o)throw Error('Product unavailable for this destination');
 if(o.mode!=='pod'||o.currency!=='USD')throw Error('This cart pilot supports USD custom print products only; use the product page for other products');
 return o;
}
function key(secret:string){if(secret.length<32)throw Error('Shopping signing key unavailable');return new TextEncoder().encode(secret);}
export async function signShopping(secret:string,store:string,purpose:'shopping-cart'|'shopping-handoff',selection:ShoppingSelection){
 return new SignJWT({...shoppingSelection.parse(selection),purpose,store_id:store}).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime(purpose==='shopping-cart'?'1h':'10m').setJti(crypto.randomUUID()).sign(key(secret));
}
export async function verifyShopping(secret:string,store:string,purpose:'shopping-cart'|'shopping-handoff',token:string){
 if(token.length>3000)throw Error('Invalid capability');
 const {payload}=await jwtVerify(token,key(secret),{algorithms:['HS256'],requiredClaims:['exp','iat','jti']});
 if(payload.purpose!==purpose||payload.store_id!==store||typeof payload.jti!=='string')throw Error('Invalid capability');
 return {selection:shoppingSelection.parse({item_id:payload.item_id,qty:payload.qty,country:payload.country}),id:payload.jti,expires_at:payload.exp!*1000};
}
export const SHOPPING_SCHEMA='CREATE TABLE IF NOT EXISTS shopping_handoffs(id TEXT PRIMARY KEY,expires_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS shopping_handoffs_expiry ON shopping_handoffs(expires_at); CREATE TABLE IF NOT EXISTS shopping_budget(key TEXT PRIMARY KEY,n INTEGER NOT NULL,expires_at INTEGER NOT NULL);';
export function allowShoppingAi(sql:ShippingSql,client:string,now=Date.now()){
 if(!/^[a-f0-9]{64}$/.test(client))throw Error('Invalid shopping client');
 sql.exec('DELETE FROM shopping_budget WHERE expires_at<?',now);
 const limits=[{key:'client:'+client+':'+Math.floor(now/3600000),limit:10,expires:now+3600000},{key:'store:'+Math.floor(now/86400000),limit:200,expires:now+86400000}];
 for(const item of limits)if(Number(sql.exec('SELECT n FROM shopping_budget WHERE key=?',item.key).toArray()[0]?.n||0)>=item.limit)throw Error('Shopping AI request allowance reached');
 for(const item of limits)sql.exec('INSERT INTO shopping_budget VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET n=n+1',item.key,item.expires);
 return true;
}
// Called inside the owning DO transaction. Only selections cross the handoff; no charge or order is created.
export function consumeShopping(sql:ShippingSql,offers:CanonicalOffer[],id:string,selection:ShoppingSelection,expiresAt:number,now=Date.now()){
 if(expiresAt<=now)throw Error('Handoff expired');
 const offer=selectedOffer(offers,selection);
 const [variant]=sql.exec('SELECT sku FROM variants WHERE id=?',offer.item_id).toArray();if(!variant)throw Error('Product unavailable');
 sql.exec('DELETE FROM shopping_handoffs WHERE expires_at<?',now);
 if(sql.exec('SELECT id FROM shopping_handoffs WHERE id=?',id).toArray().length)throw Error('Handoff already used');
 sql.exec('INSERT INTO shopping_handoffs VALUES(?,?)',id,expiresAt);
 return {sku:String(variant.sku),qty:selection.qty,country:selection.country,title:offer.title,price:offer.price};
}
