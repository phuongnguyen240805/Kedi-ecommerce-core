import {checkoutRead,checkoutSave,checkoutInput} from './checkout-core';
import type {ShippingSql} from './shipping-store';
import {ShippingError} from './smart-shipping';

export function paymentChangeAvailability(state:ReturnType<typeof checkoutRead>){
 const allowed=state.payment?.method!=='cod'&&!!state.payment&&
  (state.status==='complete_in_progress'||(state.status==='canceled'&&state.payment.method==='stripe'));
 return {change_allowed:allowed,change_requires_no_payment:true};
}

// Called only inside the owning store's transactionSync. Keep the original
// payment/reference for late-funds review; never reuse it for another method.
export function changeCheckoutPayment(sql:ShippingSql,id:string,version:number,expiredStripeId?:string){
 const [prior]=sql.exec('SELECT replacement_id FROM checkout_payment_changes WHERE original_id=?',id).toArray();
 if(prior)return checkoutRead(sql,String(prior.replacement_id));
 const current=checkoutRead(sql,id);
 if(current.version!==version)throw new ShippingError('checkout_changed',409,'Checkout changed. Reload before changing payment.');
 if(!paymentChangeAvailability(current).change_allowed)throw new ShippingError('payment_change_blocked',409,'Đơn đã được xác nhận hoặc thanh toán. Liên hệ cửa hàng để đổi phương thức; không đặt lại đơn.');
 const [order]=sql.exec('SELECT status FROM orders WHERE id=?',current.order_id).toArray();
 if(!order||!['pending','canceled'].includes(String(order.status))||sql.exec('SELECT external_id FROM payment_receipts WHERE order_id=?',current.order_id).toArray().length)
  throw new ShippingError('payment_already_received',409,'Đã nhận thanh toán. Không thanh toán lại; liên hệ cửa hàng.');
 if(current.payment?.method==='stripe'){
  const [attempt]=sql.exec('SELECT stripe_session_id FROM ucp_payment_attempts WHERE session_id=?',id).toArray();
  if(!expiredStripeId||attempt?.stripe_session_id!==expiredStripeId)throw new ShippingError('stripe_close_required',409,'Cần xác nhận phiên Stripe cũ đã đóng trước khi đổi phương thức.');
 }else if(sql.exec('SELECT transaction_id FROM checkout_bank_evidence WHERE session_id=?',id).toArray().length){
  throw new ShippingError('bank_review_required',409,'Có giao dịch ngân hàng cần kiểm tra. Không thanh toán lại; liên hệ cửa hàng.');
 }
 if(current.fulfillment)throw new ShippingError('fulfillment_started',409,'Đơn đang xử lý. Liên hệ cửa hàng để đổi phương thức.');
 for(const h of sql.exec("SELECT sku,qty FROM ucp_stock_holds WHERE session_id=? AND state='held'",id).toArray()){
  sql.exec('UPDATE inventory SET reserved=reserved-? WHERE sku=? AND reserved>=?',h.qty,h.sku,h.qty);
  if(Number(sql.exec('SELECT changes() n').toArray()[0].n)!==1)throw new ShippingError('inventory_hold_conflict',409,'Inventory needs review.');
 }
 sql.exec("UPDATE ucp_stock_holds SET state='released' WHERE session_id=? AND state='held'",id);
 sql.exec("UPDATE orders SET status='canceled' WHERE id=? AND status='pending'",current.order_id);
 sql.exec("UPDATE ucp_checkout_sessions SET status='canceled',updated_at=? WHERE id=?",new Date().toISOString(),id);
 const [draft]=sql.exec('SELECT input_json FROM checkout_drafts WHERE id=?',id).toArray();
 const {payment_method:_method,carrier_quote_id:_quote,shipping_option_id:_delivery,...input}=checkoutInput.parse(JSON.parse(String(draft.input_json)));
 const replacement=checkoutSave(sql,input,'web');
 sql.exec('INSERT INTO checkout_payment_changes VALUES(?,?,?,?)',id,replacement.id,current.payment!.method,new Date().toISOString());
 return replacement;
}
