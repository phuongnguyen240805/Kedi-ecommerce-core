import {SignJWT,jwtVerify} from 'jose';
import type {Env} from '../types';
function key(env:Env){if(!env.ORDER_TOKEN_SECRET||env.ORDER_TOKEN_SECRET.length<32)throw Error('Marketing signing key unavailable');return new TextEncoder().encode(env.ORDER_TOKEN_SECRET);}
export async function marketingToken(env:Env,purpose:'confirm'|'unsubscribe'|'recovery',subscriberId:string,extra:Record<string,unknown>={}){
 return new SignJWT({...extra,purpose,subscriber_id:subscriberId,store_id:env.STORE_ID||'default'}).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime(purpose==='unsubscribe'?'365d':'24h').sign(key(env));
}
export async function verifyMarketingToken(env:Env,token:string,purpose:'confirm'|'unsubscribe'|'recovery'){
 const {payload}=await jwtVerify(token,key(env),{algorithms:['HS256']});
 if(payload.purpose!==purpose||payload.store_id!==(env.STORE_ID||'default')||typeof payload.subscriber_id!=='string')throw Error('Invalid marketing token');
 return payload as typeof payload & {subscriber_id:string};
}
export async function verifyMailgunSignature(key:string,input:{timestamp:string;token:string;signature:string},now=Date.now()){
 const timestamp=Number(input.timestamp)*1000;
 // Retried webhook deliveries may be several hours old. A durable token/event inbox prevents replay.
 if(!key||!Number.isFinite(timestamp)||Math.abs(now-timestamp)>24*3600_000||!/^[a-f0-9]{64}$/i.test(input.signature))return false;
 const cryptoKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(key),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 return crypto.subtle.verify('HMAC',cryptoKey,Uint8Array.from(input.signature.match(/../g)!,v=>parseInt(v,16)),new TextEncoder().encode(input.timestamp+input.token));
}
