import type {ShippingSql} from './shipping-store';
import {checkoutSave,checkoutRead,type CheckoutInput} from './checkout-core';
import {ShippingError} from './smart-shipping';
import {z} from 'zod';
export function saveMarketingContact(sql:ShippingSql,id:string,email:string,version:number){
 const current=checkoutRead(sql,id);z.string().trim().email().max(254).parse(email);
 if(current.version!==version||!['incomplete','ready_for_complete'].includes(current.status))throw new ShippingError('checkout_contact_conflict',409,'Reload the checkout before updating its contact email.');
 const [draft]=sql.exec('SELECT input_json FROM checkout_drafts WHERE id=?',id).toArray();
 return checkoutSave(sql,{...JSON.parse(String(draft.input_json)),buyer:{email:email.trim().toLowerCase()}},'web',id,version);
}
export function linkMarketingCheckout(sql:ShippingSql,cartId:string,checkoutId:string){
 const [cart]=sql.exec('SELECT id FROM carts WHERE id=?',cartId).toArray();checkoutRead(sql,checkoutId);
 if(!cart)throw new ShippingError('cart_not_found',404,'Cart not found');
 sql.exec('INSERT INTO marketing_checkout_links VALUES(?,?) ON CONFLICT(cart_id) DO UPDATE SET checkout_id=excluded.checkout_id',cartId,checkoutId);
 return {saved:true};
}
export function sharedCheckoutRecoverable(sql:ShippingSql,id:string,email?:string,now=Date.now()):boolean{
 if(!sql.exec("SELECT name FROM sqlite_master WHERE name='checkout_drafts'").toArray().length)return false;
 const [row]=sql.exec(`SELECT s.status,s.created_at,d.input_json,a.stripe_session_id FROM checkout_drafts d JOIN ucp_checkout_sessions s ON s.id=d.id LEFT JOIN ucp_payment_attempts a ON a.session_id=s.id WHERE d.id=?`,id).toArray();
 if(!row||['completed','complete_in_progress'].includes(String(row.status)))return false;
 if(email&&String(JSON.parse(String(row.input_json)).buyer?.email||'').trim().toLowerCase()!==email)return false;
 if(Date.parse(String(row.created_at))<now-7*86400000)return false;
 const [recovery]=sql.exec('SELECT checkout_id FROM checkout_recoveries WHERE original_id=?',id).toArray();
 if(recovery){const child=checkoutRead(sql,String(recovery.checkout_id));if(['completed','complete_in_progress'].includes(child.status))return false;}
 if(row.status==='canceled'&&!recovery){const [released]=sql.exec("SELECT sku FROM ucp_stock_holds WHERE session_id=? AND state='released' LIMIT 1",id).toArray();if(!released)return false;}
 return true;
}
export function recoverCheckoutMarketing(sql:ShippingSql,id:string,subscriberId:string,now=Date.now()){
 const [subscriber]=sql.exec("SELECT email FROM marketing_subscribers WHERE id=? AND status='active'",subscriberId).toArray();
 if(!subscriber||sql.exec('SELECT email FROM marketing_suppressions WHERE email=?',subscriber.email).toArray().length||!sharedCheckoutRecoverable(sql,id,String(subscriber.email),now))throw new ShippingError('recovery_unavailable',409,'This checkout can no longer be recovered.');
 const [previous]=sql.exec('SELECT checkout_id FROM checkout_recoveries WHERE original_id=?',id).toArray();
 if(previous){const state=checkoutRead(sql,String(previous.checkout_id));if(!['canceled','expired'].includes(state.status))return state;}
 const [draft]=sql.exec('SELECT input_json FROM checkout_drafts WHERE id=?',id).toArray();
 const state=checkoutSave(sql,JSON.parse(String(draft.input_json)) as CheckoutInput,'web');
 // The original has no unsettled Stripe attempt. It cannot later start a second payment.
 sql.exec("UPDATE ucp_checkout_sessions SET status='canceled',updated_at=? WHERE id=?",new Date(now).toISOString(),id);
 sql.exec('INSERT INTO checkout_recoveries VALUES(?,?) ON CONFLICT(original_id) DO UPDATE SET checkout_id=excluded.checkout_id',id,state.id);
 return state;
}
