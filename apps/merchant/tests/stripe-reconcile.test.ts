import {test} from 'node:test';
import assert from 'node:assert/strict';
import type Stripe from 'stripe';
import {applyStripeCheckout,reconcileStripeCheckout} from '../src/lib/ucp-payment-service';
import type {DOStub} from '../src/types';
function fixture(){const calls:unknown[]=[];return {calls,db:{ucpPaymentSettle:async(input:unknown)=>{calls.push(input);return {paid:true,orderId:'order'};},ucpPaymentExpire:async(id:string,stripe:string)=>{calls.push({expired:id,stripe});return {released:true};}} as DOStub};}
function session(extra:Partial<Stripe.Checkout.Session>={}){return {id:'cs_fixture',metadata:{ucp_checkout_session_id:'checkout'},status:'complete',payment_status:'paid',amount_total:6270,currency:'usd',payment_intent:'pi_fixture',...extra} as Stripe.Checkout.Session;}
test('server-fetched Stripe success forwards exact amount/currency/binding to atomic paid gate',async()=>{const f=fixture();await applyStripeCheckout(f.db,'checkout',session());assert.deepEqual(f.calls,[{sessionId:'checkout',stripeId:'cs_fixture',paymentStatus:'paid',amount:6270,currency:'usd',paymentIntent:'pi_fixture'}]);});
test('async unpaid completion never marks paid; only confirmed expiration releases holds',async()=>{const f=fixture();await applyStripeCheckout(f.db,'checkout',session({payment_status:'unpaid'}));assert.equal(f.calls.length,0);await applyStripeCheckout(f.db,'checkout',session({status:'expired',payment_status:'unpaid'}));assert.deepEqual(f.calls,[{expired:'checkout',stripe:'cs_fixture'}]);});
test('foreign metadata or inconsistent paid state cannot mutate orders',async()=>{for(const s of [session({metadata:{ucp_checkout_session_id:'other'}}),session({status:'open'}),session({amount_total:null}),session({currency:null})]){const f=fixture();await assert.rejects(()=>applyStripeCheckout(f.db,'checkout',s));assert.equal(f.calls.length,0);}});
test('unbound creation outcome never causes a new Stripe session during reconcile',async()=>{const db={query:async()=>[{stripe_session_id:null}]} as unknown as DOStub;await assert.rejects(()=>reconcileStripeCheckout(db,{},'checkout'),/No bound payment/);});
