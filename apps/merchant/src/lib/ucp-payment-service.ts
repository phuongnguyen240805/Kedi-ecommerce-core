import Stripe from 'stripe';
import type {DOStub,Env} from '../types';
import {ShippingError} from './smart-shipping';
import {checkoutReturnUrl} from './ucp-payment';
export async function startStripeCheckout(db:DOStub,env:Env,id:string,base:string,success?:string,cancel?:string){
 let key=env.STRIPE_SECRET_KEY;
 if(!key){const [config]=await db.query<{value:string}>("SELECT value FROM config WHERE key='stripe'",[]);
  if(config){try{key=JSON.parse(config.value).secret_key;}catch{ /* fail closed below */ }}}
 if(!key)throw new ShippingError('stripe_unavailable',503,'Stripe is not configured for this store.');
 const origins=[base,...(env.STORE_URL?[env.STORE_URL]:[])];
 const successUrl=checkoutReturnUrl(success,`${base}/ucp/v1/checkout-sessions/${id}/success`,origins);
 const cancelUrl=checkoutReturnUrl(cancel,`${base}/ucp/v1/checkout-sessions/${id}/cancel`,origins);
 const attempt=await db.ucpPaymentBegin(id,successUrl,cancelUrl);
 const stripe=new Stripe(key);
 const session=attempt.stripeId?await stripe.checkout.sessions.retrieve(attempt.stripeId):
  await stripe.checkout.sessions.create(attempt.request,{idempotencyKey:`ucp-checkout:${id}`});
 if(!session.url)throw new ShippingError('stripe_session_closed',409,'Payment session is no longer open.');
 await db.ucpPaymentAttach(id,session.id,session.url);return {id:session.id,url:session.url};
}
