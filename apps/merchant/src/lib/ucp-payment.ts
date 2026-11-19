import { z } from 'zod';
import type Stripe from 'stripe';
import type { ShippingSql } from './shipping-store';
import { ShippingError } from './smart-shipping';
import { enqueuePodFulfillment } from './pod-core';

// All mutations are called inside the owning store's transactionSync.
export const UCP_PAYMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS ucp_payment_attempts (
 session_id TEXT PRIMARY KEY, request_json TEXT NOT NULL,
 stripe_session_id TEXT UNIQUE, stripe_url TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_receipts (
 provider TEXT NOT NULL, external_id TEXT NOT NULL, order_id TEXT NOT NULL,
 amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(provider,external_id)
);
CREATE TABLE IF NOT EXISTS payment_outbox (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL, event TEXT NOT NULL,
 payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
 UNIQUE(order_id,event)
);`;

const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const item = z.object({
 item: z.object({ id: z.string().min(1), title: z.string().optional() }),
 quantity: z.number().int().min(1).max(1000),
 unit_price: z.object({ amount: money, currency: z.string() }),
 fulfillment_mode: z.enum(['stock','pod']).default('stock'),
});
const total = z.object({ type: z.string(), amount: money, currency: z.string() });
export type PaymentSnapshot = {
 currency: string; items: z.infer<typeof item>[]; email: string;
 subtotal: number; tax: number; shipping: number; amount: number;
};
function fail(code: string, message: string): never {
 throw new ShippingError(code, 409, message);
}
export function paymentSnapshot(session: Record<string, unknown>): PaymentSnapshot {
 const currency = z.string().regex(/^[A-Z]{3}$/).parse(String(session.currency).toUpperCase());
 const items = z.array(item).min(1).max(100).parse(JSON.parse(String(session.line_items)));
 const totals = z.array(total).parse(JSON.parse(String(session.totals)));
 const buyer = z.object({ email: z.string().email() }).parse(JSON.parse(String(session.buyer || '{}')));
 if (new Set(items.map(i => i.item.id)).size !== items.length) fail('duplicate_sku', 'Duplicate checkout SKU.');
 if (items.some(i => i.unit_price.currency.toUpperCase() !== currency) ||
     totals.some(t => t.currency.toUpperCase() !== currency)) fail('currency_mismatch', 'Checkout currencies differ.');
 const subtotal = items.reduce((sum, i) => sum + i.quantity * i.unit_price.amount, 0);
 money.parse(subtotal);
 const amounts = new Map<string, number>();
 for (const t of totals) {
  if (amounts.has(t.type)) fail('duplicate_total', 'Duplicate checkout total.');
  if (!['subtotal','tax','shipping','grand_total'].includes(t.type)) fail('unsupported_total', 'Unsupported checkout adjustment.');
  amounts.set(t.type, t.amount);
 }
 const tax = amounts.get('tax') || 0, shipping = amounts.get('shipping') || 0;
 const amount = money.parse(subtotal + tax + shipping);
 if (amount <= 0 || amounts.get('subtotal') !== subtotal || amounts.get('grand_total') !== amount)
  fail('total_mismatch', 'Checkout total does not match its items and charges.');
 return { currency, items, email: buyer.email, subtotal, tax, shipping, amount };
}

export function checkoutReturnUrl(value: string | undefined, fallback: string, origins: string[]) {
 const url = new URL(value || fallback);
 if (!['https:','http:'].includes(url.protocol) || url.username || url.password ||
     !origins.some(origin => new URL(origin).origin === url.origin))
  fail('return_url_invalid', 'Checkout return URL is not an allowed storefront origin.');
 return url.toString();
}

export function beginUcpPayment(sql: ShippingSql, sessionId: string, successUrl: string, cancelUrl: string, now = Date.now()) {
 const session = sql.exec('SELECT * FROM ucp_checkout_sessions WHERE id=?', sessionId).toArray()[0];
 if (!session) fail('checkout_not_found', 'Checkout not found.');
 const previous = sql.exec('SELECT * FROM ucp_payment_attempts WHERE session_id=?', sessionId).toArray()[0];
 if (session.status === 'completed' || session.status === 'canceled') fail('checkout_closed', 'Checkout is closed.');
 if (previous && !previous.stripe_session_id && now - Date.parse(String(previous.created_at)) >= 23 * 3600_000)
  fail('payment_outcome_unknown', 'Payment creation outcome is too old to retry safely; reconcile with Stripe.');
 if (previous) return { request: JSON.parse(String(previous.request_json)) as Stripe.Checkout.SessionCreateParams,
  stripeId: previous.stripe_session_id as string | null, url: previous.stripe_url as string | null };
 if (session.status !== 'ready_for_complete' || Date.parse(String(session.expires_at)) <= now ||
     !Number.isFinite(Date.parse(String(session.expires_at)))) fail('checkout_not_ready', 'Checkout is not ready or has expired.');
 const snapshot = paymentSnapshot(session);
 const line_items: NonNullable<Stripe.Checkout.SessionCreateParams['line_items']> = snapshot.items.map(i => ({
  price_data: { currency: snapshot.currency.toLowerCase(), unit_amount: i.unit_price.amount,
   product_data: { name: i.item.title || i.item.id } }, quantity: i.quantity,
 }));
 // Explicit fixed charges preserve the merchant's quoted total; no automatic tax recalculation.
 for (const [name, amount] of [['Tax', snapshot.tax], ['Shipping', snapshot.shipping]] as const)
  if (amount) line_items.push({ price_data: { currency: snapshot.currency.toLowerCase(),
   unit_amount: amount, product_data: { name } }, quantity: 1 });
 const request: Stripe.Checkout.SessionCreateParams = { mode: 'payment', line_items,
  success_url: successUrl, cancel_url: cancelUrl, customer_email: snapshot.email,
  metadata: { ucp_checkout_session_id: sessionId } };
 const time = new Date(now).toISOString();
 sql.exec('INSERT INTO ucp_payment_attempts(session_id,request_json,created_at) VALUES(?,?,?)', sessionId, JSON.stringify(request), time);
 sql.exec("UPDATE ucp_checkout_sessions SET status='complete_in_progress',updated_at=? WHERE id=?", time, sessionId);
 return { request, stripeId: null, url: null };
}

export function attachUcpPayment(sql: ShippingSql, sessionId: string, stripeId: string, url: string) {
 const previous = sql.exec('SELECT * FROM ucp_payment_attempts WHERE session_id=?', sessionId).toArray()[0];
 if (!previous || (previous.stripe_session_id && previous.stripe_session_id !== stripeId))
  fail('payment_binding_conflict', 'Checkout already has a different payment attempt.');
 sql.exec('UPDATE ucp_payment_attempts SET stripe_session_id=?,stripe_url=? WHERE session_id=?', stripeId, url, sessionId);
 sql.exec('UPDATE ucp_checkout_sessions SET stripe_session_id=? WHERE id=?', stripeId, sessionId);
}

export const settlementInput = z.object({
 sessionId: z.string().min(1), stripeId: z.string().min(1),
 paymentStatus: z.string(), amount: money, currency: z.string(),
 paymentIntent: z.string().nullable(),
});
export type SettlementInput = z.infer<typeof settlementInput>;
export function settleUcpPayment(sql: ShippingSql, raw: SettlementInput, now = Date.now()) {
 const input = settlementInput.parse(raw);
 if (input.paymentStatus !== 'paid') return { paid: false, orderId: null };
 const session = sql.exec('SELECT * FROM ucp_checkout_sessions WHERE id=?', input.sessionId).toArray()[0];
 if (!session) fail('checkout_not_found', 'Checkout not found for payment.');
 const attempt = sql.exec('SELECT * FROM ucp_payment_attempts WHERE session_id=?', input.sessionId).toArray()[0];
 const boundId = attempt?.stripe_session_id || session.stripe_session_id;
 if ((!attempt && !boundId) || (boundId && boundId !== input.stripeId))
  fail('payment_binding_conflict', 'Payment does not belong to this checkout.');
 const snapshot = paymentSnapshot(session);
 if (snapshot.amount !== input.amount || snapshot.currency !== input.currency.toUpperCase())
  fail('payment_amount_mismatch', 'Paid amount or currency does not match checkout.');
 if (session.status === 'completed') return { paid: true, orderId: String(session.order_id) };
 if (session.status === 'canceled') fail('canceled_checkout_paid', 'Canceled checkout received a payment; manual review required.');
 const time = new Date(now).toISOString(), orderId = crypto.randomUUID(), number = `ORD-${orderId}`;
 sql.exec(`INSERT INTO orders(id,number,status,customer_email,subtotal_cents,tax_cents,shipping_cents,total_cents,currency,stripe_checkout_session_id,stripe_payment_intent_id,created_at)
  VALUES(?,?,'paid',?,?,?,?,?,?,?,?,?)`, orderId, number, snapshot.email, snapshot.subtotal,
  snapshot.tax, snapshot.shipping, snapshot.amount, snapshot.currency, input.stripeId, input.paymentIntent, time);
 for (const i of snapshot.items) {
  if (i.fulfillment_mode === 'stock') {
  sql.exec('UPDATE inventory SET on_hand=on_hand-? WHERE sku=? AND on_hand-reserved>=?', i.quantity, i.item.id, i.quantity);
  if (Number(sql.exec('SELECT changes() AS n').toArray()[0].n) !== 1)
   fail('payment_inventory_conflict', 'Paid checkout inventory needs manual review.');
  }
  sql.exec('INSERT INTO order_items(id,order_id,sku,title,qty,unit_price_cents) VALUES(?,?,?,?,?,?)',
   crypto.randomUUID(), orderId, i.item.id, i.item.title || i.item.id, i.quantity, i.unit_price.amount);
 }
 if(snapshot.items.some(i=>i.fulfillment_mode==='pod')) enqueuePodFulfillment(sql,input.sessionId,orderId,now);
 sql.exec("INSERT INTO payment_receipts VALUES('stripe',?,?,?,?,?)", input.stripeId, orderId, input.amount, snapshot.currency, time);
 sql.exec("INSERT INTO payment_outbox(id,order_id,event,payload,created_at) VALUES(?,?,'payment.paid',?,?)",
  crypto.randomUUID(), orderId, JSON.stringify({ order_id: orderId, source: 'ucp', currency: snapshot.currency, amount_minor: input.amount }), time);
 sql.exec("UPDATE ucp_checkout_sessions SET status='completed',stripe_session_id=?,order_id=?,order_number=?,updated_at=? WHERE id=?",
  input.stripeId, orderId, number, time, input.sessionId);
 if (attempt) sql.exec('UPDATE ucp_payment_attempts SET stripe_session_id=? WHERE session_id=?', input.stripeId, input.sessionId);
 return { paid: true, orderId };
}
