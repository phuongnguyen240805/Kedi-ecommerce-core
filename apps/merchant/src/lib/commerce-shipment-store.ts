import { receipt } from './commerce-core';
import type { ShippingSql } from './shipping-store';
import { ShippingError } from './smart-shipping';
import { observeOrderProgress } from './commerce-progress';

export function authorizeShipment(sql: ShippingSql, id: string, account: string, evidence: string, actor: string, now = Date.now()) {
  const row = sql.exec('SELECT c.*,o.status FROM commerce_orders c JOIN orders o ON o.id=c.order_id WHERE c.order_id=?', id).toArray()[0];
  if (!row) throw new ShippingError('order_not_found', 404, 'Không tìm thấy đơn.');
  const snapshot = JSON.parse(String(row.snapshot_json));
  if (!row.pancake_order_id || row.status === 'canceled' || (row.method !== 'cod' && row.payment_status !== 'paid'))
    throw new ShippingError('shipment_not_ready', 409, 'Đơn chưa đủ điều kiện gửi hàng.');
  if (snapshot.automation_version !== 2 || snapshot.dispatch_account_id !== account)
    throw new ShippingError('shipment_account_changed', 409, 'Đơn không khớp cấu hình vận chuyển hiện tại.');
  const job = sql.exec('SELECT lease_until FROM commerce_shipments WHERE order_id=?', id).toArray()[0];
  if (Number(job?.lease_until) > now) throw new ShippingError('shipment_busy', 409, 'Đang kiểm tra vận đơn.');
  snapshot.dispatch_enabled = true;
  sql.exec('UPDATE commerce_orders SET snapshot_json=? WHERE order_id=?', JSON.stringify(snapshot), id);
  // Enabling one order never clears the durable attempt marker.
  sql.exec('UPDATE commerce_shipments SET next_attempt_at=0 WHERE order_id=?', id);
  sql.exec('INSERT INTO commerce_audit(id,order_id,action,actor,evidence,created_at) VALUES(?,?,?,?,?,?)',
    crypto.randomUUID(), id, 'shipment.authorized', actor, evidence, new Date(now).toISOString());
  return receipt(sql, id);
}

export function claimShipment(sql: ShippingSql, id: string, token: string, now = Date.now()) {
  const row = sql.exec('SELECT c.*,o.status FROM commerce_orders c JOIN orders o ON o.id=c.order_id WHERE c.order_id=?', id).toArray()[0];
  if (!row) throw new ShippingError('order_not_found', 404, 'Không tìm thấy đơn.');
  const snapshot = JSON.parse(String(row.snapshot_json));
  if (!row.pancake_order_id || row.status === 'canceled' || snapshot.automation_version !== 2) return null;
  if (row.method !== 'cod' && row.payment_status !== 'paid') return null;
  sql.exec('INSERT OR IGNORE INTO commerce_shipments(order_id,updated_at) VALUES(?,?)', id, now);
  const job = sql.exec('SELECT * FROM commerce_shipments WHERE order_id=?', id).toArray()[0];
  if (Number(job.lease_until) > now || Number(job.next_attempt_at) > now || ['returned', 'canceled'].includes(String(job.state))) return null;
  sql.exec('UPDATE commerce_shipments SET lease_token=?,lease_until=? WHERE order_id=?', token, now + 120_000, id);
  return { attempted: Number(job.attempted), pos_id: String(row.pancake_order_id), snapshot, order: receipt(sql, id) };
}

export function markShipmentAttempt(sql: ShippingSql, id: string, token: string, partner: number, account: number, now = Date.now()) {
  const updated = sql.exec("UPDATE commerce_shipments SET attempted=1,state='submitted',partner_id=?,account_id=?,updated_at=? WHERE order_id=? AND lease_token=? AND lease_until>? RETURNING order_id",
    partner, account, now, id, token, now).toArray();
  if (!updated.length) throw new ShippingError('shipment_lease_lost', 409, 'Phiên gửi vận đơn đã thay đổi.');
}

export type ShipmentResult = { tracking_number?: string; partner_id?: number; account_id?: number; partner_status?: string; pos_status?: number; error?: string; awaiting_dispatch?: boolean };
export function finishShipment(sql: ShippingSql, id: string, token: string, result: ShipmentResult, now = Date.now()) {
  const job = sql.exec('SELECT * FROM commerce_shipments WHERE order_id=? AND lease_token=?', id, token).toArray()[0];
  if (!job) throw new ShippingError('shipment_lease_lost', 409, 'Phiên gửi vận đơn đã thay đổi.');
  observeOrderProgress(sql, id, { pos_status: result.pos_status, carrier_status: result.partner_status, tracking_number: result.tracking_number }, now);
  const tracking = result.tracking_number || (job.tracking_number ? String(job.tracking_number) : null);
  if (job.tracking_number && result.tracking_number && job.tracking_number !== result.tracking_number)
    throw new ShippingError('shipment_tracking_changed', 409, 'Mã vận đơn thay đổi. Cần đối soát.');
  const status = result.partner_status || (job.partner_status ? String(job.partner_status) : null);
  const terminal = result.pos_status === 6 || result.pos_status === 7 ? 'canceled' : status === 'delivered' || status === 'delivered_cod' ? 'delivered'
    : status === 'returned' || status === 'returned_cod' ? 'returned' : status === 'canceled' ? 'canceled' : null;
  const state = result.error ? 'needs_attention' : terminal || (tracking ? 'booked' : result.awaiting_dispatch ? 'pending' : 'submitted');
  sql.exec('UPDATE commerce_shipments SET state=?,tracking_number=?,partner_id=COALESCE(?,partner_id),account_id=COALESCE(?,account_id),partner_status=?,last_error=?,lease_token=NULL,lease_until=0,next_attempt_at=?,updated_at=? WHERE order_id=?',
    state, tracking, result.partner_id || null, result.account_id || null, status, result.error || null, now + 60_000, now, id);
  if (!tracking || result.error) return;
  // A label means ready for pickup; it does not mean the parcel has been shipped.
  const moving = ['picked_up', 'waiting_on_the_way', 'on_the_way', 'contact_delivery_company', 'out_for_delivery', 'delay_delivery', 'inform_recipient', 'undeliverable', 'waiting_for_return', 'returning'].includes(status || '');
  const fulfillment = terminal === 'delivered' ? 'delivered' : terminal === 'returned' ? 'returned' : moving ? 'shipped' : 'ready_to_ship';
  const current = receipt(sql, id);
  const ranks: Record<string, number> = { unfulfilled: 0, ready_to_ship: 1, shipped: 2, delivered: 3, returned: 4 };
  sql.exec('UPDATE orders SET tracking_number=? WHERE id=?', tracking, id);
  if (terminal !== 'canceled' && ranks[fulfillment] > (ranks[current.fulfillment_status] ?? 0)) {
    sql.exec('UPDATE commerce_orders SET fulfillment_status=?,updated_at=? WHERE order_id=?', fulfillment, new Date(now).toISOString(), id);
    if (fulfillment === 'shipped' || fulfillment === 'delivered') sql.exec('UPDATE orders SET status=? WHERE id=?', fulfillment, id);
  }
  // Payment and COD reconciliation require their own evidence; carrier delivery never marks them paid.
  if (job.tracking_number !== tracking || job.partner_status !== status)
    sql.exec('INSERT INTO commerce_audit(id,order_id,action,actor,evidence,created_at) VALUES(?,?,?,?,?,?)',
      crypto.randomUUID(), id, 'shipment.updated', 'pancake', JSON.stringify({ tracking_number: tracking, partner_status: status }), new Date(now).toISOString());
}
