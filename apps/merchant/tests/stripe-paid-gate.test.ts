import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import Stripe from 'stripe';
import {webhooks} from '../src/routes/webhooks';
import type {DOStub,HonoEnv} from '../src/types';

test('signed Stripe completed-unpaid waits; delayed paid succeeds; invalid signature cannot settle',async()=>{
 const calls:unknown[]=[];
 const stub={query:async()=>[],ucpPaymentSettle:async(input:unknown)=>{calls.push(input);return {paid:true,orderId:'order'};}} as unknown as DOStub;
 const app=new Hono<HonoEnv>();app.use('*',async(c,next)=>{c.set('db',stub);await next();});app.route('/v1/webhooks',webhooks);
 app.onError((error,c)=>c.json({error:error.message},400));
 const send=async(type:string,payment_status:string,valid=true)=>{
  const payload=JSON.stringify({id:'evt_test',type,data:{object:{id:'cs_test',payment_status,currency:'usd',amount_total:3300,payment_intent:'pi_test',metadata:{ucp_checkout_session_id:'checkout'}}}});
  const signature=Stripe.webhooks.generateTestHeaderString({payload,secret:'whsec_fixture'});
  return app.request('https://merchant.test/v1/webhooks/stripe',{method:'POST',body:payload,headers:{'stripe-signature':valid?signature:'invalid'}},
   {STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture'});
 };
 assert.equal((await send('checkout.session.completed','unpaid')).status,200);assert.equal(calls.length,0);
 assert.equal((await send('checkout.session.async_payment_succeeded','paid')).status,200);assert.equal(calls.length,1);
 assert.equal((await send('checkout.session.completed','paid',false)).status,400);assert.equal(calls.length,1);
});
