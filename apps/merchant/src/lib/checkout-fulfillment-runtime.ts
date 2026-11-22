import type {Env,DOStub} from '../types';
import {processCommerceOrder} from './commerce-shipment';
/** Payment remains committed if a downstream service is unavailable; durable cron retries the queue. */
export async function wakeCheckoutFulfillment(env:Env,db:DOStub,id:string){
 if(env.CHECKOUT_ORDER_EXPORT_ENABLED!=='true'||env.PANCAKE_ORDER_SYNC_ENABLED!=='true')return;
 try{const current=await db.checkoutGet(id);if(current.order_id&&current.fulfillment)await processCommerceOrder(env,db,current.order_id);}catch{console.warn(JSON.stringify({event:'checkout.fulfillment.pending',checkout_id:id}));}
}
