import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { UCP_PAYMENT_SCHEMA, beginUcpPayment, attachUcpPayment, settleUcpPayment, paymentSnapshot, checkoutReturnUrl } from '../src/lib/ucp-payment';
import type { ShippingSql } from '../src/lib/shipping-store';

function fixture() {
 const db = new DatabaseSync(':memory:');
 const source = readFileSync(new URL('../src/do.ts', import.meta.url), 'utf8');
 db.exec(source.match(/const SCHEMA = `([\s\S]*?)`;/)![1]);
 db.exec(UCP_PAYMENT_SCHEMA);
 db.exec("INSERT INTO inventory(sku,on_hand,reserved) VALUES('shirt',10,2)");
 const session = { id: 'checkout', currency: 'USD',
  line_items: JSON.stringify([{ item: { id: 'shirt', title: 'Shirt' }, quantity: 2, unit_price: { amount: 1500, currency: 'USD' } }]),
  buyer: JSON.stringify({ email: 'buyer@example.test' }),
  totals: JSON.stringify([{ type:'subtotal', amount:3000, currency:'USD' }, { type:'tax', amount:300, currency:'USD' },
   { type:'shipping', amount:500, currency:'USD' }, { type:'grand_total', amount:3800, currency:'USD' }]),
 };
 db.prepare("INSERT INTO ucp_checkout_sessions(id,status,currency,line_items,buyer,totals,expires_at,created_at,updated_at) VALUES(?,'ready_for_complete',?,?,?,?,?,'now','now')")
  .run(session.id,session.currency,session.line_items,session.buyer,session.totals,new Date(Date.now()+3600000).toISOString());
 const sql: ShippingSql = { exec: (q,...p) => { const rows=db.prepare(q).all(...p) as Record<string,unknown>[]; return {toArray:()=>rows}; } };
 // DO transactionSync is represented by a real SQLite transaction, not a SQL mock.
 const tx = <T>(fn:()=>T):T => { db.exec('BEGIN'); try { const r=fn();db.exec('COMMIT');return r; } catch(e){db.exec('ROLLBACK');throw e;} };
 const start = () => tx(() => beginUcpPayment(sql,session.id,'https://shop.test/ok','https://shop.test/cancel'));
 const paid = { sessionId:session.id, stripeId:'cs_test', paymentStatus:'paid', amount:3800, currency:'usd', paymentIntent:'pi_test' };
 return { db,sql,session,tx,start,paid };
}

test('Stripe request charges every quoted component and retries freeze the original payload',()=>{
 const f=fixture(), a=f.start();
 const amounts=a.request.line_items!.reduce((sum,i)=>sum+i.price_data!.unit_amount! * i.quantity!,0);
 assert.equal(amounts,3800);
 assert.equal(a.request.line_items!.length,3);
 const b=f.tx(()=>beginUcpPayment(f.sql,'checkout','https://shop.test/different','https://shop.test/other'));
 assert.deepEqual(a,b);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ucp_payment_attempts').get()!.n,1);
});
test('paid settlement matches actual schema, persists items, ledger, outbox and deducts stock once',()=>{
 const f=fixture();f.start();f.tx(()=>attachUcpPayment(f.sql,'checkout','cs_test','https://checkout.stripe.com/test'));
 const a=f.tx(()=>settleUcpPayment(f.sql,f.paid));
 const b=f.tx(()=>settleUcpPayment(f.sql,f.paid));
 assert.deepEqual(a,b);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM order_items').get()!.n,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM payment_receipts').get()!.n,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM payment_outbox').get()!.n,1);
 assert.equal(f.db.prepare('SELECT on_hand FROM inventory').get()!.on_hand,8);
 assert.equal(f.db.prepare('SELECT reserved FROM inventory').get()!.reserved,2);
 assert.equal(f.db.prepare('SELECT stripe_checkout_session_id FROM orders').get()!.stripe_checkout_session_id,'cs_test');
});
test('delayed/unpaid completion cannot create paid orders; later paid event can settle',()=>{
 const f=fixture();f.start();
 assert.deepEqual(f.tx(()=>settleUcpPayment(f.sql,{...f.paid,paymentStatus:'unpaid'})),{paid:false,orderId:null});
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n,0);
 assert.equal(f.tx(()=>settleUcpPayment(f.sql,f.paid)).paid,true);
});
test('wrong amount, currency and session binding never create orders',()=>{
 for(const patch of [{amount:3799},{currency:'eur'},{stripeId:'other'}]){
  const f=fixture();f.start();attachUcpPayment(f.sql,'checkout','cs_test','https://checkout.stripe.com/test');
  assert.throws(()=>f.tx(()=>settleUcpPayment(f.sql,{...f.paid,...patch})));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n,0);
 }
});
test('late SQL failure rolls back order, stock, receipt and session together',()=>{
 const f=fixture();f.start();
 f.db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON payment_outbox BEGIN SELECT RAISE(ABORT,'test failure'); END;");
 assert.throws(()=>f.tx(()=>settleUcpPayment(f.sql,f.paid)),/test failure/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM payment_receipts').get()!.n,0);
 assert.equal(f.db.prepare('SELECT on_hand FROM inventory').get()!.on_hand,10);
 assert.equal(f.db.prepare('SELECT status FROM ucp_checkout_sessions').get()!.status,'complete_in_progress');
});
test('expired and canceled checkout, bad totals, duplicate SKU, and insufficient stock fail closed',()=>{
 const f=fixture();
 assert.throws(()=>beginUcpPayment(f.sql,'checkout','https://shop.test/ok','https://shop.test/cancel',Date.now()+7200000));
 assert.throws(()=>paymentSnapshot({...f.session,totals:'[]'}));
 const items=JSON.parse(f.session.line_items);assert.throws(()=>paymentSnapshot({...f.session,line_items:JSON.stringify([...items,...items])}));
 f.start();f.db.exec("UPDATE inventory SET on_hand=2");
 assert.throws(()=>f.tx(()=>settleUcpPayment(f.sql,f.paid)),/inventory/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n,0);
 f.db.exec("UPDATE ucp_checkout_sessions SET status='canceled'");
 assert.throws(()=>f.tx(()=>settleUcpPayment(f.sql,f.paid)),/Canceled/);
});
test('another store database cannot settle a foreign payment, and return URL rejects foreign origins',()=>{
 const a=fixture(),b=fixture();a.start();
 assert.throws(()=>b.tx(()=>settleUcpPayment(b.sql,a.paid)),/belong/);
 assert.equal(checkoutReturnUrl(undefined,'https://shop.test/ok',['https://shop.test']),'https://shop.test/ok');
 assert.throws(()=>checkoutReturnUrl('https://evil.test','https://shop.test/ok',['https://shop.test']));
 assert.throws(()=>checkoutReturnUrl('https://user:pass@shop.test','https://shop.test/ok',['https://shop.test']));
});
