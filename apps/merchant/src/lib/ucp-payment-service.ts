import Stripe from 'stripe';
import type {DOStub,Env} from '../types';
import {ShippingError} from './smart-shipping';
import {checkoutReturnUrl} from './ucp-payment';
async function stripeKey(db:DOStub,env:Env){let key=env.STRIPE_SECRET_KEY;if(!key){const [config]=await db.query<{value:string}>("SELECT value FROM config WHERE key='stripe'",[]);if(config){try{key=JSON.parse(config.value).secret_key;}catch{}}}if(!key)throw new ShippingError('stripe_unavailable',503,'Stripe is not configured for this store.');return key;}
// Only call with a session fetched directly from Stripe or returned by its create API.
export async function applyStripeCheckout(db:DOStub,id:string,session:Stripe.Checkout.Session){
 if(session.metadata?.ucp_checkout_session_id!==id)throw new ShippingError('payment_binding_conflict',409,'Stripe session does not belong to this checkout.');
 if(session.payment_status==='paid'){
  if(session.status!=='complete'||session.amount_total===null||!session.currency)throw new ShippingError('payment_state_conflict',409,'Payment needs merchant review.');
  await db.ucpPaymentSettle({sessionId:id,stripeId:session.id,paymentStatus:session.payment_status,amount:session.amount_total,currency:session.currency,paymentIntent:typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id||null});
 }else if(session.status==='expired')await db.ucpPaymentExpire(id,session.id);
}
export async function reconcileStripeCheckout(db:DOStub,env:Env,id:string){
 const [attempt]=await db.query<{stripe_session_id:string|null}>('SELECT stripe_session_id FROM ucp_payment_attempts WHERE session_id=?',[id]);
 if(!attempt?.stripe_session_id)throw new ShippingError('payment_not_bound',409,'No bound payment is available for reconciliation. Retry the existing payment or contact the shop.');
 const session=await new Stripe(await stripeKey(db,env)).checkout.sessions.retrieve(attempt.stripe_session_id);
 await applyStripeCheckout(db,id,session);
}
export async function closeStripeForPaymentChange(db:DOStub,env:Env,id:string,provider?:Pick<Stripe['checkout']['sessions'],'retrieve'|'create'|'expire'>){
 const [attempt]=await db.query<{stripe_session_id:string|null;request_json:string;created_at:string}>('SELECT stripe_session_id,request_json,created_at FROM ucp_payment_attempts WHERE session_id=?',[id]);
 if(!attempt)throw new ShippingError('payment_not_bound',409,'Payment needs merchant review.');
 const sessions=provider||new Stripe(await stripeKey(db,env)).checkout.sessions;
 if(!attempt.stripe_session_id&&Date.now()-Date.parse(attempt.created_at)>=23*3600000)throw new ShippingError('payment_outcome_unknown',409,'Payment needs merchant review.');
 let session=attempt.stripe_session_id?await sessions.retrieve(attempt.stripe_session_id):await sessions.create(JSON.parse(attempt.request_json),{idempotencyKey:`ucp-checkout:${id}`});
 if(session.metadata?.ucp_checkout_session_id!==id)throw new ShippingError('payment_binding_conflict',409,'Payment needs merchant review.');
 if(!attempt.stripe_session_id){if(!session.url)throw new ShippingError('payment_outcome_unknown',409,'Payment needs merchant review.');await db.ucpPaymentAttach(id,session.id,session.url);}
 if(session.status==='open'){
  try{session=await sessions.expire(session.id);}catch{session=await sessions.retrieve(session.id);}
 }
 if(session.payment_status==='paid')await applyStripeCheckout(db,id,session);
 if(session.status!=='expired'||session.payment_status!=='unpaid')throw new ShippingError('payment_processing',409,'Thanh toán đã nhận hoặc đang xử lý. Không thanh toán lại; kiểm tra trạng thái hoặc liên hệ cửa hàng.');
 return session.id;
}
export async function startStripeCheckout(db:DOStub,env:Env,id:string,base:string,success?:string,cancel?:string,expected?:{version:number;total:number}){
 const key=await stripeKey(db,env);
 const origins=[base,...(env.STORE_URL?[env.STORE_URL]:[])];
 const successUrl=checkoutReturnUrl(success,`${base}/ucp/v1/checkout-sessions/${id}/success`,origins);
 const cancelUrl=checkoutReturnUrl(cancel,`${base}/ucp/v1/checkout-sessions/${id}/cancel`,origins);
 const attempt=await db.ucpPaymentBegin(id,successUrl,cancelUrl,expected);
 const stripe=new Stripe(key);
 const session=attempt.stripeId?await stripe.checkout.sessions.retrieve(attempt.stripeId):
  await stripe.checkout.sessions.create(attempt.request,{idempotencyKey:`ucp-checkout:${id}`});
 if(!session.url){await applyStripeCheckout(db,id,session);throw new ShippingError('stripe_session_closed',409,'Payment session is no longer open. Check the current order status.');}
 await db.ucpPaymentAttach(id,session.id,session.url);return {id:session.id,url:session.url};
}
