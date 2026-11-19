import { z } from 'zod';
import { ShippingError, type ShippingOffer } from './smart-shipping';
import type { ShippingSql } from './shipping-store';
import { cancelPendingOrder, checkoutInput, receipt } from './commerce-core';

// All writes in this module run inside the owning store DO transactionSync.
export const SERVICE_SCHEMA = `
CREATE TABLE IF NOT EXISTS commerce_versions(order_id TEXT PRIMARY KEY,version INTEGER NOT NULL DEFAULT 1);
CREATE TRIGGER IF NOT EXISTS commerce_order_revision AFTER UPDATE ON orders BEGIN
 UPDATE commerce_versions SET version=version+1 WHERE order_id=NEW.id; END;
CREATE TRIGGER IF NOT EXISTS commerce_payment_revision AFTER UPDATE ON commerce_orders BEGIN
 UPDATE commerce_versions SET version=version+1 WHERE order_id=NEW.order_id; END;
CREATE TABLE IF NOT EXISTS commerce_requests(
 id TEXT PRIMARY KEY,order_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,payload TEXT NOT NULL,result TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 UNIQUE(order_id,idempotency_key));
CREATE INDEX IF NOT EXISTS commerce_requests_queue ON commerce_requests(status,updated_at);
CREATE TABLE IF NOT EXISTS commerce_refund_ledger(
 id TEXT PRIMARY KEY,order_id TEXT NOT NULL,request_id TEXT,amount_vnd INTEGER NOT NULL CHECK(amount_vnd>0),
 reason TEXT NOT NULL,status TEXT NOT NULL,idempotency_key TEXT NOT NULL,reference TEXT UNIQUE,
 evidence TEXT,actor TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 UNIQUE(order_id,idempotency_key));
CREATE TABLE IF NOT EXISTS commerce_action_sessions(
 id TEXT PRIMARY KEY,order_id TEXT NOT NULL,code_hash TEXT NOT NULL,token_hash TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS commerce_sessions_order ON commerce_action_sessions(order_id,created_at);
CREATE TABLE IF NOT EXISTS commerce_service_rates(order_id TEXT NOT NULL,kind TEXT NOT NULL,requested_at INTEGER NOT NULL,PRIMARY KEY(order_id,kind));
CREATE TABLE IF NOT EXISTS commerce_address_quotes(
 id TEXT PRIMARY KEY,order_id TEXT NOT NULL,version INTEGER NOT NULL,recipient TEXT NOT NULL,
 offer TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS commerce_service_notifications(
 id TEXT PRIMARY KEY,order_id TEXT NOT NULL,event TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS commerce_service_evidence(
 id TEXT PRIMARY KEY,order_id TEXT NOT NULL,object_key TEXT NOT NULL,mime TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS commerce_return_outcomes(
 request_id TEXT PRIMARY KEY,order_id TEXT NOT NULL,resolution TEXT NOT NULL,reference TEXT,
 lot_reference TEXT,disposition TEXT,evidence TEXT NOT NULL,actor TEXT NOT NULL,created_at INTEGER NOT NULL);
`;
const text = z.string().trim().min(10).max(1000);
const uuid = z.string().uuid();
export const requestInput = z
  .object({
    idempotency_key: uuid,
    order_version: z.number().int().positive(),
    kind: z.enum(['cancel', 'address', 'return']),
    reason: text,
    quote_id: uuid.optional(),
    items: z
      .array(
        z
          .object({
            sku: z.string().min(1).max(200),
            qty: z.number().int().min(1).max(100),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    evidence_ids: z.array(uuid).max(5).optional(),
  })
  .strict();
export type ServiceRequest = z.infer<typeof requestInput>;
export const decisionInput = z
  .object({
    order_version: z.number().int().positive(),
    request_id: uuid,
    action: z.enum(['approve', 'reject', 'complete']),
    evidence: text,
    message: z.string().trim().min(3).max(500).optional(),
    pricing: z.enum(['quoted', 'shop_absorbs']).default('quoted'),
    resolution: z
      .enum(['refund', 'replacement', 'return_inspection', 'information'])
      .optional(),
    replacement_reference: z.string().trim().min(3).max(120).optional(),
    lot_reference: z.string().trim().min(3).max(120).optional(),
    disposition: z.enum(['quarantine', 'discard', 'accepted']).optional(),
    external_cleared: z.boolean().default(false),
  })
  .strict();
export const refundInput = z
  .object({
    idempotency_key: uuid,
    order_version: z.number().int().positive(),
    amount_vnd: z.number().int().positive().max(2_000_000_000),
    reason: text,
    request_id: uuid.optional(),
  })
  .strict();
export const refundResultInput = z
  .object({
    order_version: z.number().int().positive(),
    refund_id: uuid,
    status: z.enum(['processing', 'unknown', 'failed', 'succeeded']),
    reference: z.string().trim().min(3).max(120).optional(),
    evidence: text,
  })
  .strict();
export const adjustmentInput = z
  .object({
    request_id: uuid,
    order_version: z.number().int().positive(),
    transaction_id: z.string().trim().min(3).max(120),
    amount_vnd: z.number().int().positive().max(2_000_000_000),
    evidence: text,
    received_at: z.string().datetime({ offset: true }),
  })
  .strict();
function fail(code: string, message: string, status = 409): never {
  throw new ShippingError(code, status, message);
}
function orderRow(sql: ShippingSql, id: string) {
  const r = sql
    .exec(
      'SELECT c.*,o.status,o.total_cents,o.ship_to,o.customer_email FROM commerce_orders c JOIN orders o ON o.id=c.order_id WHERE c.order_id=?',
      id,
    )
    .toArray()[0];
  if (!r) fail('order_not_found', 'Không tìm thấy đơn hàng.', 404);
  return r;
}
export function orderVersion(sql: ShippingSql, id: string) {
  orderRow(sql, id);
  const current = sql
    .exec('SELECT version FROM commerce_versions WHERE order_id=?', id)
    .toArray()[0];
  if (current) return Number(current.version);
  sql.exec('INSERT OR IGNORE INTO commerce_versions(order_id) VALUES(?)', id);
  return Number(
    sql.exec('SELECT version FROM commerce_versions WHERE order_id=?', id).toArray()[0]
      .version,
  );
}
function checkVersion(sql: ShippingSql, id: string, expected: number) {
  if (orderVersion(sql, id) !== expected)
    fail('order_changed', 'Đơn hàng vừa thay đổi. Vui lòng tải lại trước khi xác nhận.');
}
function bump(sql: ShippingSql, id: string) {
  sql.exec('UPDATE commerce_versions SET version=version+1 WHERE order_id=?', id);
}
function audit(
  sql: ShippingSql,
  id: string,
  action: string,
  actor: string,
  evidence: unknown,
  now = Date.now(),
) {
  sql.exec(
    'INSERT INTO commerce_audit(id,order_id,action,actor,evidence,created_at) VALUES(?,?,?,?,?,?)',
    crypto.randomUUID(),
    id,
    action,
    actor,
    JSON.stringify(evidence),
    new Date(now).toISOString(),
  );
  sql.exec(
    'INSERT INTO commerce_service_notifications(id,order_id,event,next_attempt_at,created_at) VALUES(?,?,?,?,?)',
    crypto.randomUUID(),
    id,
    action,
    now,
    now,
  );
}
export function assertNoOpenChanges(sql: ShippingSql, id: string) {
  if (
    sql
      .exec(
        "SELECT id FROM commerce_requests WHERE order_id=? AND kind IN ('cancel','address') AND status IN ('pending','approved') LIMIT 1",
        id,
      )
      .toArray().length
  )
    fail(
      'order_change_pending',
      'Đơn có yêu cầu thay đổi đang chờ xử lý; tạm dừng xuất hàng.',
    );
  const d = serviceDetail(sql, id),
    order = orderRow(sql, id);
  if (
    sql
      .exec(
        "SELECT id FROM commerce_refund_ledger WHERE order_id=? AND status IN ('pending','processing','unknown') LIMIT 1",
        id,
      )
      .toArray().length ||
    (d.money.received_vnd > 0 &&
      d.money.received_vnd - d.money.refunded_vnd !== Number(order.total_cents))
  )
    fail(
      'refund_reconciliation_required',
      'Cần đối soát khoản thu/hoàn trước khi xuất hàng.',
    );
}
function assertNoLease(sql: ShippingSql, id: string, now: number) {
  if (
    sql
      .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='shipping_legs'")
      .toArray().length &&
    sql
      .exec('SELECT id FROM shipping_legs WHERE order_id=? AND lease_until>?', id, now)
      .toArray().length
  )
    fail('order_busy', 'Đơn đang đối soát vận chuyển. Vui lòng đợi kết quả.');
  if (
    sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='shipping_commands'",
      )
      .toArray().length &&
    sql
      .exec(
        'SELECT c.id FROM shipping_commands c JOIN shipping_legs l ON l.id=c.leg_id WHERE l.order_id=? AND c.lease_until>?',
        id,
        now,
      )
      .toArray().length
  )
    fail('order_busy', 'Đơn đang thực thi lệnh vận chuyển. Vui lòng đợi kết quả.');
  if (
    sql
      .exec(
        'SELECT order_id FROM commerce_outbox WHERE order_id=? AND lease_until>?',
        id,
        now,
      )
      .toArray().length ||
    sql
      .exec(
        'SELECT order_id FROM commerce_shipments WHERE order_id=? AND lease_until>?',
        id,
        now,
      )
      .toArray().length
  )
    fail('order_busy', 'Đơn đang đồng bộ. Vui lòng đợi rồi thử lại.');
}
export function serviceDetail(sql: ShippingSql, id: string) {
  const order = orderRow(sql, id),
    snapshot = JSON.parse(String(order.snapshot_json));

  const requests = sql
    .exec(
      'SELECT id,kind,status,payload,result,created_at,updated_at FROM commerce_requests WHERE order_id=? ORDER BY created_at DESC',
      id,
    )
    .toArray()
    .map((r) => {
      const payload = JSON.parse(String(r.payload)) as ServiceRequest;
      const q = payload.quote_id
        ? sql
            .exec(
              'SELECT recipient,offer,expires_at FROM commerce_address_quotes WHERE id=? AND order_id=?',
              payload.quote_id,
              id,
            )
            .toArray()[0]
        : null;
      const offer = q ? JSON.parse(String(q.offer)) : null;
      return {
        id: String(r.id),
        kind: String(r.kind),
        status: String(r.status),
        result: r.result,
        created_at: Number(r.created_at),
        updated_at: Number(r.updated_at),
        payload,
        address_quote: q
          ? {
              recipient: JSON.parse(String(q.recipient)),
              customer_fee_vnd: Number(offer.customer_fee_vnd),
              carrier_fee_vnd: Number(offer.carrier_fee_vnd),
              expires_at: Number(q.expires_at),
            }
          : null,
      };
    });
  const refunds = sql
    .exec(
      'SELECT id,request_id,amount_vnd,reason,status,created_at,updated_at FROM commerce_refund_ledger WHERE order_id=? ORDER BY created_at DESC',
      id,
    )
    .toArray();
  const paid = Number(
    sql
      .exec(
        "SELECT COALESCE(SUM(amount_vnd),0) AS n FROM commerce_transactions WHERE order_id=? AND kind IN ('bank_transfer','cod_collected')",
        id,
      )
      .toArray()[0].n,
  );
  const reserved = Number(
    sql
      .exec(
        "SELECT COALESCE(SUM(amount_vnd),0) AS n FROM commerce_refund_ledger WHERE order_id=? AND status<>'failed'",
        id,
      )
      .toArray()[0].n,
  );
  // Legacy excess-refund evidence must also reduce the refundable balance.
  const legacy = sql
    .exec(
      "SELECT evidence FROM commerce_audit WHERE order_id=? AND action='bank.exception_resolved'",
      id,
    )
    .toArray()
    .reduce((n, r) => n + Number(JSON.parse(String(r.evidence)).refunded_vnd || 0), 0);
  const pending = requests.some(
    (r) =>
      ['pending', 'approved'].includes(String(r.status)) &&
      ['cancel', 'address'].includes(String(r.kind)),
  );
  const terminal = ['canceled', 'refunded'].includes(String(order.status));
  const delivered = ['delivered', 'returned'].includes(String(order.fulfillment_status));
  return {
    order_version: orderVersion(sql, id),
    shipping_automation: snapshot.shipping?.offer?.execution_owner === 'direct',
    recipient: snapshot.recipient,
    note: snapshot.note || '',
    requests,
    refunds,
    money: {
      received_vnd: paid,
      refundable_vnd: Math.max(0, paid - reserved - legacy),
      refunded_vnd:
        legacy +
        refunds
          .filter((r) => r.status === 'succeeded')
          .reduce((n, r) => n + Number(r.amount_vnd), 0),
    },
    allowed_actions: {
      cancel: !terminal && !delivered && !pending,
      address: !terminal && !delivered && !pending,
      return: !terminal && delivered,
    },
    action_hint: pending
      ? 'Shop đang xử lý yêu cầu thay đổi của đơn.'
      : 'Yêu cầu cần được shop xác nhận; gửi yêu cầu chưa thay đổi đơn hàng.',
    timeline: sql
      .exec(
        'SELECT action,created_at FROM commerce_audit WHERE order_id=? ORDER BY created_at DESC LIMIT 100',
        id,
      )
      .toArray(),
  };
}
export function createServiceRequest(
  sql: ShippingSql,
  id: string,
  input: ServiceRequest,
  actor: string,
  now = Date.now(),
) {
  input = requestInput.parse(input);
  const encoded = JSON.stringify(input);
  const previous = sql
    .exec(
      'SELECT id,payload FROM commerce_requests WHERE order_id=? AND idempotency_key=?',
      id,
      input.idempotency_key,
    )
    .toArray()[0];
  if (previous) {
    if (previous.payload !== encoded)
      fail('idempotency_conflict', 'Nội dung yêu cầu đã thay đổi.');
    return serviceDetail(sql, id);
  }
  if (
    sql.exec('SELECT id FROM commerce_requests WHERE order_id=?', id).toArray().length >=
    50
  )
    fail('request_limit', 'Đơn đã đạt giới hạn yêu cầu. Vui lòng liên hệ shop.', 429);
  checkVersion(sql, id, input.order_version);
  const detail = serviceDetail(sql, id);
  if (!detail.allowed_actions[input.kind])
    fail('action_not_allowed', 'Trạng thái đơn không cho phép yêu cầu này.');
  if (input.kind !== 'return') assertNoLease(sql, id, now);
  const order = orderRow(sql, id),
    snapshot = JSON.parse(String(order.snapshot_json));
  for (const evidenceId of input.evidence_ids || [])
    if (
      !sql
        .exec(
          'SELECT id FROM commerce_service_evidence WHERE id=? AND order_id=?',
          evidenceId,
          id,
        )
        .toArray().length
    )
      fail('evidence_invalid', 'Ảnh không thuộc đơn hàng.', 400);
  if (input.kind === 'address') {
    const quote = sql
      .exec(
        'SELECT * FROM commerce_address_quotes WHERE id=? AND order_id=?',
        input.quote_id || '',
        id,
      )
      .toArray()[0];
    if (
      !quote ||
      Number(quote.expires_at) <= now ||
      Number(quote.version) !== input.order_version
    )
      fail('quote_expired', 'Cần báo giá địa chỉ mới còn hạn.');
  }
  if (input.kind === 'return') {
    if (
      !input.items?.length ||
      new Set(input.items.map((i) => i.sku)).size !== input.items.length
    )
      fail('return_items_invalid', 'Chọn sản phẩm và số lượng không trùng.', 400);
    const previousItems = sql
      .exec(
        "SELECT payload FROM commerce_requests WHERE order_id=? AND kind='return' AND status<>'rejected'",
        id,
      )
      .toArray()
      .flatMap((r) => (JSON.parse(String(r.payload)) as ServiceRequest).items || []);
    for (const item of input.items) {
      const purchased = snapshot.items.find(
        (i: { sku: string; qty: number }) => i.sku === item.sku,
      );
      const claimed = previousItems
        .filter((i) => i.sku === item.sku)
        .reduce((n, i) => n + i.qty, 0);
      if (!purchased || item.qty + claimed > purchased.qty)
        fail(
          'return_qty_exceeded',
          'Số lượng yêu cầu vượt sản phẩm đã mua hoặc đã yêu cầu xử lý.',
        );
    }
  }
  const requestId = crypto.randomUUID();
  sql.exec(
    'INSERT INTO commerce_requests(id,order_id,kind,status,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    requestId,
    id,
    input.kind,
    'pending',
    input.idempotency_key,
    encoded,
    now,
    now,
  );
  bump(sql, id);
  audit(
    sql,
    id,
    'request.created',
    actor,
    { request_id: requestId, kind: input.kind },
    now,
  );
  return serviceDetail(sql, id);
}
export function storeAddressQuote(
  sql: ShippingSql,
  id: string,
  version: number,
  recipient: z.infer<typeof checkoutInput>['recipient'],
  offer: ShippingOffer,
  now = Date.now(),
) {
  checkVersion(sql, id, version);
  if (!serviceDetail(sql, id).allowed_actions.address)
    fail('action_not_allowed', 'Không thể đổi địa chỉ lúc này.');
  const quoteId = crypto.randomUUID(),
    expires = now + 300_000;
  sql.exec('DELETE FROM commerce_address_quotes WHERE expires_at<?', now - 86_400_000);
  sql.exec(
    'INSERT INTO commerce_address_quotes VALUES(?,?,?,?,?,?)',
    quoteId,
    id,
    version,
    JSON.stringify(recipient),
    JSON.stringify(offer),
    expires,
  );
  return {
    id: quoteId,
    expires_at: expires,
    recipient,
    carrier_fee_vnd: offer.carrier_fee_vnd,
    customer_fee_vnd: offer.customer_fee_vnd,
    customer_difference_vnd:
      offer.customer_fee_vnd -
      Number(JSON.parse(String(orderRow(sql, id).snapshot_json)).totals.shipping_vnd),
    requires_shop_approval: true,
  };
}
export function serviceSnapshot(sql: ShippingSql, id: string) {
  const r = orderRow(sql, id);
  return {
    snapshot: JSON.parse(String(r.snapshot_json)),
    version: orderVersion(sql, id),
    method: String(r.method),
    pos_id: r.pancake_order_id ? String(r.pancake_order_id) : null,
  };
}
export function decideServiceRequest(
  sql: ShippingSql,
  id: string,
  input: z.infer<typeof decisionInput>,
  actor: string,
  now = Date.now(),
) {
  input = decisionInput.parse(input);
  checkVersion(sql, id, input.order_version);
  assertNoLease(sql, id, now);
  const request = sql
    .exec(
      'SELECT * FROM commerce_requests WHERE id=? AND order_id=?',
      input.request_id,
      id,
    )
    .toArray()[0];
  if (!request) fail('request_not_found', 'Không tìm thấy yêu cầu.', 404);
  if (['completed', 'rejected'].includes(String(request.status)))
    fail('request_closed', 'Yêu cầu đã kết thúc.');
  if (input.action === 'approve' && request.status !== 'pending')
    fail('request_transition', 'Yêu cầu đã được duyệt.');
  if (input.action === 'complete' && request.status !== 'approved')
    fail('request_transition', 'Cần duyệt yêu cầu trước khi hoàn tất.');
  const order = orderRow(sql, id),
    snapshot = JSON.parse(String(order.snapshot_json));
  if (
    input.action === 'complete' &&
    ['cancel', 'address'].includes(String(request.kind)) &&
    snapshot.shipping?.offer?.execution_owner === 'direct'
  ) {
    const proof = sql
      .exec(
        "SELECT c.id FROM shipping_commands c JOIN shipping_legs l ON l.id=c.leg_id WHERE l.order_id=? AND c.request_id=? AND c.kind=? AND c.state='verified' AND c.result='carrier_and_pos_verified' LIMIT 1",
        id,
        input.request_id,
        request.kind,
      )
      .toArray()[0];
    if (!proof)
      fail(
        'shipping_verification_required',
        'Cần xác minh lệnh vận chuyển và POS; không xác nhận bằng ô đánh dấu.',
      );
  }
  if (input.action === 'complete' && request.kind === 'cancel') {
    if (['delivered', 'returned'].includes(String(order.fulfillment_status)))
      fail('already_delivered', 'Đơn đã giao/hoàn; cần xử lý đổi trả.');
    const uncertain = sql
      .exec('SELECT create_attempted FROM commerce_outbox WHERE order_id=?', id)
      .toArray()[0];
    const shipment = sql
      .exec('SELECT attempted FROM commerce_shipments WHERE order_id=?', id)
      .toArray()[0];
    if (
      (order.pancake_order_id || uncertain?.create_attempted || shipment?.attempted) &&
      !input.external_cleared
    )
      fail(
        'external_confirmation_required',
        'Cần xác nhận POS/vận đơn đã ngừng xử lý trước khi hủy.',
      );
    if (
      !order.pancake_order_id &&
      !uncertain?.create_attempted &&
      !shipment?.attempted &&
      ['unpaid', 'pending', 'canceled'].includes(String(order.payment_status))
    ) {
      cancelPendingOrder(sql, id, input.evidence, actor);
    } else {
      // Consumed stock remains outside sellable inventory until a separate inspected receipt.
      if (order.reservation_state === 'held')
        for (const item of snapshot.items) {
          const variant = sql
            .exec('SELECT sku FROM variants WHERE id=?', item.local_variant_id)
            .toArray()[0];
          if (!variant)
            fail('reservation_sku_missing', 'Cần đối soát SKU trước khi giải phóng kho.');
          sql.exec(
            'UPDATE warehouse_inventory SET reserved=MAX(0,reserved-?) WHERE sku=? AND warehouse_id=?',
            item.qty,
            variant.sku,
            snapshot.fufuni_warehouse_id,
          );
          sql.exec(
            'UPDATE inventory SET reserved=MAX(0,reserved-?) WHERE sku=?',
            item.qty,
            variant.sku,
          );
        }
      sql.exec(
        "UPDATE commerce_orders SET reservation_state=CASE WHEN reservation_state='held' THEN 'released' ELSE reservation_state END,cod_status=CASE WHEN cod_status='to_collect' THEN 'not_applicable' ELSE cod_status END,updated_at=? WHERE order_id=?",
        new Date(now).toISOString(),
        id,
      );
      sql.exec("UPDATE orders SET status='canceled' WHERE id=?", id);
      sql.exec("UPDATE commerce_outbox SET state='canceled' WHERE order_id=?", id);
    }
  }
  if (input.action === 'complete' && request.kind === 'address') {
    if (['canceled', 'refunded'].includes(String(order.status)))
      fail('address_order_closed', 'Không đổi địa chỉ đơn đã đóng.');
    if (
      ['delivered', 'returned'].includes(String(order.fulfillment_status)) ||
      (order.fulfillment_status === 'shipped' && !input.external_cleared)
    )
      fail(
        'address_in_transit',
        'Cần xác nhận của vận chuyển khi hàng đang giao; không sửa địa chỉ lần giao đã hoàn tất.',
      );
    const payload = JSON.parse(String(request.payload)) as ServiceRequest;
    const quote = sql
      .exec(
        'SELECT * FROM commerce_address_quotes WHERE id=? AND order_id=?',
        payload.quote_id,
        id,
      )
      .toArray()[0];
    if (!quote || (Number(quote.expires_at) <= now && !input.external_cleared))
      fail(
        'quote_expired',
        'Báo giá hết hạn. Cần xác minh lại phương án và chi phí với vận chuyển.',
      );
    if (!input.external_cleared && order.pancake_order_id)
      fail(
        'external_confirmation_required',
        'Cần cập nhật POS/vận đơn và xác nhận chi phí trước.',
      );
    const recipient = JSON.parse(String(quote.recipient)),
      offer = JSON.parse(String(quote.offer));
    if (
      input.pricing === 'shop_absorbs' &&
      Number(offer.customer_fee_vnd) !== Number(snapshot.totals.shipping_vnd) &&
      !input.external_cleared
    )
      fail(
        'external_confirmation_required',
        'Shop chịu chênh lệch cần xác minh phí/COD mới với vận chuyển.',
      );
    const shipping =
      input.pricing === 'shop_absorbs'
        ? Number(snapshot.totals.shipping_vnd)
        : Number(offer.customer_fee_vnd);
    const newTotal =
      Number(order.total_cents) - Number(snapshot.totals.shipping_vnd) + shipping;
    const financial = serviceDetail(sql, id);
    const pendingRefund = sql
      .exec(
        "SELECT id FROM commerce_refund_ledger WHERE order_id=? AND status NOT IN ('succeeded','failed') LIMIT 1",
        id,
      )
      .toArray().length;
    const net = financial.money.received_vnd - financial.money.refunded_vnd;
    if (
      pendingRefund ||
      (order.method === 'techcombank_qr' &&
        financial.money.received_vnd > 0 &&
        net !== newTotal) ||
      (order.method === 'cod' && order.cod_status !== 'to_collect')
    )
      fail(
        'address_payment_unsettled',
        'Cần thu/hoàn chênh lệch và đối soát xong trước khi đổi địa chỉ.',
      );
    audit(
      sql,
      id,
      'address.changed',
      actor,
      {
        before: snapshot.recipient,
        after: recipient,
        old_shipping_vnd: snapshot.totals.shipping_vnd,
        new_shipping_vnd: shipping,
        quote_id: quote.id,
        pricing: input.pricing,
      },
      now,
    );
    snapshot.recipient = recipient;
    snapshot.totals.shipping_vnd = shipping;
    snapshot.totals.total_vnd = newTotal;
    snapshot.shipping = {
      ...snapshot.shipping,
      destination: {
        district_id: recipient.district_id,
        ward_code: recipient.ward_code,
      },
      offer: {
        ...offer,
        customer_fee_vnd: shipping,
        cod_value_vnd: order.method === 'cod' ? newTotal : 0,
      },
    };
    snapshot.address_change = {
      quote_id: quote.id,
      carrier_fee_vnd: offer.carrier_fee_vnd,
      shop_absorbs_difference: input.pricing === 'shop_absorbs',
    };
    sql.exec(
      'UPDATE commerce_orders SET snapshot_json=?,updated_at=? WHERE order_id=?',
      JSON.stringify(snapshot),
      new Date(now).toISOString(),
      id,
    );
    sql.exec(
      'UPDATE orders SET shipping_cents=?,total_cents=? WHERE id=?',
      shipping,
      newTotal,
      id,
    );
    if (order.method === 'techcombank_qr' && net === newTotal)
      reconcileServicePayment(sql, id, orderVersion(sql, id), input.evidence, actor, now);
    sql.exec(
      'UPDATE orders SET ship_to=?,shipping_name=?,shipping_phone=? WHERE id=?',
      JSON.stringify(recipient),
      recipient.name,
      recipient.phone,
      id,
    );
  }
  if (input.action === 'reject' && request.kind === 'address') {
    const financial = serviceDetail(sql, id);
    if (
      financial.money.received_vnd > 0 &&
      financial.money.received_vnd - financial.money.refunded_vnd !==
        Number(order.total_cents)
    )
      fail(
        'address_payment_unsettled',
        'Cần đối soát khoản chênh lệch trước khi từ chối thay đổi địa chỉ.',
      );
  }
  if (input.action === 'complete' && request.kind === 'return') {
    if (!input.resolution)
      fail('return_resolution_required', 'Cần chọn phương án xử lý hàng lỗi/đổi trả.');
    if (
      input.resolution === 'refund' &&
      !sql
        .exec(
          "SELECT id FROM commerce_refund_ledger WHERE order_id=? AND request_id=? AND status<>'failed'",
          id,
          input.request_id,
        )
        .toArray().length
    )
      fail('return_refund_missing', 'Cần lập nghĩa vụ hoàn tiền cho yêu cầu này.');
    if (input.resolution === 'replacement' && !input.replacement_reference)
      fail(
        'replacement_reference_required',
        'Cần mã đơn/vận đơn giao bù có thể truy vết.',
      );
    if (
      input.resolution === 'return_inspection' &&
      (!input.lot_reference || !input.disposition)
    )
      fail('inspection_required', 'Cần mã lô và kết quả kiểm tra hàng thu hồi.');
    if (snapshot.shipping?.offer?.execution_owner === 'direct') {
      if (
        input.resolution === 'replacement' &&
        !sql
          .exec(
            "SELECT id FROM shipping_legs WHERE order_id=? AND request_id=? AND kind='replacement' AND tracking_code IS NOT NULL AND status NOT IN ('cancel','lost','damage','scrap','exception') AND (tracking_code=? OR client_code=? OR id=?)",
            id,
            input.request_id,
            input.replacement_reference || '',
            input.replacement_reference || '',
            input.replacement_reference || '',
          )
          .toArray().length
      )
        fail(
          'replacement_not_verified',
          'Cần chặng giao bù đã được tra cứu xác minh, liên kết đúng yêu cầu.',
        );
      const reverse = sql
        .exec(
          "SELECT status FROM shipping_legs WHERE order_id=? AND request_id=? AND kind='reverse' ORDER BY sequence DESC LIMIT 1",
          id,
          input.request_id,
        )
        .toArray()[0];
      if (
        input.resolution === 'return_inspection' &&
        reverse &&
        !['delivered', 'returned'].includes(String(reverse.status))
      )
        fail(
          'return_receipt_unconfirmed',
          'Chặng thu hồi chưa xác nhận nhận hàng; chưa hoàn tất kiểm tra lô.',
        );
    }
    sql.exec(
      'INSERT INTO commerce_return_outcomes VALUES(?,?,?,?,?,?,?,?,?)',
      input.request_id,
      id,
      input.resolution,
      input.replacement_reference || null,
      input.lot_reference || null,
      input.disposition || null,
      input.evidence,
      actor,
      now,
    );
    // Inspection is a traceability event. POS remains stock authority; never silently add returned fruit to sellable stock.
  }
  const status =
    input.action === 'approve'
      ? 'approved'
      : input.action === 'reject'
        ? 'rejected'
        : 'completed';
  sql.exec(
    'UPDATE commerce_requests SET status=?,result=?,updated_at=? WHERE id=?',
    status,
    input.message || 'Shop đã cập nhật yêu cầu. Vui lòng liên hệ nếu cần thêm thông tin.',
    now,
    input.request_id,
  );
  if (input.action === 'complete' && request.kind === 'cancel') {
    const available = serviceDetail(sql, id).money.refundable_vnd;
    if (available > 0)
      createRefund(
        sql,
        id,
        {
          idempotency_key: input.request_id,
          order_version: orderVersion(sql, id),
          amount_vnd: available,
          reason: 'Hoàn tiền cho yêu cầu hủy đơn đã được xác nhận.',
          request_id: input.request_id,
        },
        actor,
        now,
      );
  }
  bump(sql, id);
  audit(
    sql,
    id,
    'request.' + status,
    actor,
    {
      request_id: input.request_id,
      evidence: input.evidence,
      external_cleared: input.external_cleared,
    },
    now,
  );
  return serviceDetail(sql, id);
}
export function createRefund(
  sql: ShippingSql,
  id: string,
  input: z.infer<typeof refundInput>,
  actor: string,
  now = Date.now(),
) {
  assertNoLease(sql, id, now);
  input = refundInput.parse(input);
  const existing = sql
    .exec(
      'SELECT * FROM commerce_refund_ledger WHERE order_id=? AND idempotency_key=?',
      id,
      input.idempotency_key,
    )
    .toArray()[0];
  if (existing) {
    if (
      Number(existing.amount_vnd) !== input.amount_vnd ||
      existing.reason !== input.reason ||
      String(existing.request_id || '') !== (input.request_id || '')
    )
      fail('idempotency_conflict', 'Lệnh hoàn tiền đã thay đổi.');
    return serviceDetail(sql, id);
  }
  checkVersion(sql, id, input.order_version);
  const detail = serviceDetail(sql, id);
  if (input.amount_vnd > detail.money.refundable_vnd)
    fail('refund_exceeds_received', 'Số tiền vượt khoản thực nhận còn được phép hoàn.');
  if (
    input.request_id &&
    !sql
      .exec(
        "SELECT id FROM commerce_requests WHERE id=? AND order_id=? AND status IN ('approved','completed')",
        input.request_id,
        id,
      )
      .toArray().length
  )
    fail('request_not_approved', 'Yêu cầu liên quan chưa được duyệt.');
  sql.exec(
    'INSERT INTO commerce_refund_ledger(id,order_id,request_id,amount_vnd,reason,status,idempotency_key,actor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    crypto.randomUUID(),
    id,
    input.request_id || null,
    input.amount_vnd,
    input.reason,
    'pending',
    input.idempotency_key,
    actor,
    now,
    now,
  );
  bump(sql, id);
  audit(
    sql,
    id,
    'refund.created',
    actor,
    { amount_vnd: input.amount_vnd, reason: input.reason },
    now,
  );
  return serviceDetail(sql, id);
}
export function recordRefundResult(
  sql: ShippingSql,
  id: string,
  input: z.infer<typeof refundResultInput>,
  actor: string,
  now = Date.now(),
) {
  input = refundResultInput.parse(input);
  checkVersion(sql, id, input.order_version);
  const r = sql
    .exec(
      'SELECT * FROM commerce_refund_ledger WHERE id=? AND order_id=?',
      input.refund_id,
      id,
    )
    .toArray()[0];
  if (!r) fail('refund_not_found', 'Không tìm thấy lệnh hoàn tiền.', 404);
  if (['succeeded', 'failed'].includes(String(r.status)))
    fail('refund_closed', 'Lệnh hoàn tiền đã kết thúc.');
  if (input.status === 'succeeded' && r.actor === actor)
    fail(
      'refund_second_reviewer',
      'Cần người xác nhận khác người tạo/đang xử lý lệnh hoàn tiền.',
    );
  if (input.status === 'succeeded' && !input.reference)
    fail(
      'refund_reference_required',
      'Cần mã giao dịch và chứng từ xác nhận hoàn tiền.',
      400,
    );
  if (
    input.reference &&
    sql
      .exec(
        'SELECT id FROM commerce_refund_ledger WHERE reference=? AND id<>?',
        input.reference,
        input.refund_id,
      )
      .toArray().length
  )
    fail('refund_reference_used', 'Mã giao dịch hoàn tiền đã được dùng.');
  sql.exec(
    'UPDATE commerce_refund_ledger SET status=?,reference=COALESCE(?,reference),evidence=?,updated_at=? WHERE id=?',
    input.status,
    input.reference || null,
    input.evidence,
    now,
    input.refund_id,
  );
  if (input.status === 'succeeded') {
    const state = orderRow(sql, id),
      d = serviceDetail(sql, id);
    if (state.status === 'canceled' && d.money.received_vnd === d.money.refunded_vnd)
      sql.exec(
        "UPDATE commerce_orders SET payment_status='refunded',updated_at=? WHERE order_id=?",
        new Date(now).toISOString(),
        id,
      );
  }
  bump(sql, id);
  audit(
    sql,
    id,
    'refund.' + input.status,
    actor,
    {
      refund_id: input.refund_id,
      reference: input.reference,
      evidence: input.evidence,
    },
    now,
  );
  return serviceDetail(sql, id);
}
export function reconcileServicePayment(
  sql: ShippingSql,
  id: string,
  version: number,
  evidence: string,
  actor: string,
  now = Date.now(),
) {
  text.parse(evidence);
  checkVersion(sql, id, version);
  const order = orderRow(sql, id),
    d = serviceDetail(sql, id);
  if (
    order.status === 'canceled' ||
    order.method !== 'techcombank_qr' ||
    d.money.received_vnd - d.money.refunded_vnd !== Number(order.total_cents) ||
    sql
      .exec(
        "SELECT id FROM commerce_refund_ledger WHERE order_id=? AND status NOT IN ('succeeded','failed')",
        id,
      )
      .toArray().length
  )
    fail(
      'reconciliation_incomplete',
      'Cần đối soát đủ tiền thực nhận, tiền hoàn và trạng thái đơn.',
    );
  const snapshot = JSON.parse(String(order.snapshot_json));
  if (order.reservation_state === 'held')
    for (const item of snapshot.items) {
      const stock = sql
        .exec(
          'SELECT wi.on_hand,wi.reserved FROM warehouse_inventory wi JOIN variants v ON v.sku=wi.sku WHERE v.id=? AND wi.warehouse_id=?',
          item.local_variant_id,
          snapshot.fufuni_warehouse_id,
        )
        .toArray()[0];
      if (!stock || Number(stock.on_hand) < Number(stock.reserved))
        fail(
          'reconciliation_stock_changed',
          'Kho đã thay đổi. Cần đối soát với POS trước khi xác nhận.',
        );
    }
  sql.exec(
    "UPDATE commerce_orders SET payment_status='paid',payment_version=payment_version+1,updated_at=? WHERE order_id=?",
    new Date(now).toISOString(),
    id,
  );
  if (!order.pancake_order_id) {
    sql.exec("UPDATE orders SET status='paid' WHERE id=?", id);
    sql.exec(
      'INSERT OR IGNORE INTO commerce_outbox(id,order_id,event,created_at) VALUES(?,?,?,?)',
      crypto.randomUUID(),
      id,
      'order.confirmed',
      new Date(now).toISOString(),
    );
  }
  audit(
    sql,
    id,
    'payment.reconciled',
    actor,
    {
      evidence,
      received_vnd: d.money.received_vnd,
      refunded_vnd: d.money.refunded_vnd,
    },
    now,
  );
  return serviceDetail(sql, id);
}
export function recordAddressAdjustment(
  sql: ShippingSql,
  id: string,
  input: z.infer<typeof adjustmentInput>,
  actor: string,
  now = Date.now(),
) {
  input = adjustmentInput.parse(input);
  const previous = sql
    .exec(
      "SELECT * FROM commerce_transactions WHERE kind='bank_transfer' AND provider_transaction_id=?",
      input.transaction_id,
    )
    .toArray()[0];
  if (previous) {
    if (
      previous.order_id !== id ||
      Number(previous.amount_vnd) !== input.amount_vnd ||
      previous.evidence !== input.evidence
    )
      fail('transaction_conflict', 'Chứng từ đã được dùng với dữ liệu khác.');
    return serviceDetail(sql, id);
  }
  checkVersion(sql, id, input.order_version);
  const order = orderRow(sql, id);
  const request = sql
    .exec(
      "SELECT payload FROM commerce_requests WHERE id=? AND order_id=? AND kind='address' AND status='approved'",
      input.request_id,
      id,
    )
    .toArray()[0];
  if (!request || order.method !== 'techcombank_qr' || order.status === 'canceled')
    fail(
      'adjustment_not_allowed',
      'Chỉ ghi nhận tiền bổ sung cho đổi địa chỉ đã được duyệt.',
    );
  const payload = JSON.parse(String(request.payload)),
    quote = sql
      .exec(
        'SELECT offer FROM commerce_address_quotes WHERE id=? AND order_id=?',
        payload.quote_id,
        id,
      )
      .toArray()[0];
  if (!quote) fail('quote_missing', 'Không tìm thấy báo giá.');
  const snapshot = JSON.parse(String(order.snapshot_json)),
    fee = Number(JSON.parse(String(quote.offer)).customer_fee_vnd);
  const target = Number(order.total_cents) - Number(snapshot.totals.shipping_vnd) + fee,
    d = serviceDetail(sql, id);
  if (
    d.money.received_vnd - d.money.refunded_vnd + input.amount_vnd > target ||
    Date.parse(input.received_at) > now + 60_000
  )
    fail(
      'adjustment_amount_invalid',
      'Số tiền bổ sung hoặc thời gian nhận không hợp lệ.',
    );
  sql.exec(
    'INSERT INTO commerce_transactions(id,order_id,kind,provider_transaction_id,amount_vnd,currency,reference,evidence,actor,received_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    crypto.randomUUID(),
    id,
    'bank_transfer',
    input.transaction_id,
    input.amount_vnd,
    'VND',
    order.reference,
    input.evidence,
    actor,
    input.received_at,
    new Date(now).toISOString(),
  );
  sql.exec(
    "UPDATE commerce_orders SET payment_status='needs_attention',payment_version=payment_version+1,updated_at=? WHERE order_id=?",
    new Date(now).toISOString(),
    id,
  );
  audit(
    sql,
    id,
    'address.adjustment_received',
    actor,
    {
      request_id: input.request_id,
      transaction_id: input.transaction_id,
      amount_vnd: input.amount_vnd,
    },
    now,
  );
  return serviceDetail(sql, id);
}

// Verification failures are committed rather than thrown, so retry limits cannot roll back.
export function startActionSession(
  sql: ShippingSql,
  id: string,
  sessionId: string,
  hash: string,
  now = Date.now(),
) {
  orderRow(sql, id);
  const recent = sql
    .exec(
      'SELECT created_at FROM commerce_action_sessions WHERE order_id=? AND created_at>? ORDER BY created_at DESC',
      id,
      now - 3_600_000,
    )
    .toArray();
  if (
    recent.length >= 6 ||
    (recent.length && Number(recent[0].created_at) > now - 60_000)
  )
    fail('verification_rate_limited', 'Vui lòng đợi trước khi gửi lại mã.', 429);
  sql.exec('DELETE FROM commerce_action_sessions WHERE expires_at<?', now - 86_400_000);
  sql.exec(
    'INSERT INTO commerce_action_sessions(id,order_id,code_hash,expires_at,created_at) VALUES(?,?,?,?,?)',
    sessionId,
    id,
    hash,
    now + 600_000,
    now,
  );
  return {
    session_id: sessionId,
    email: String(orderRow(sql, id).customer_email),
  };
}
export function verifyActionSession(
  sql: ShippingSql,
  id: string,
  sessionId: string,
  hash: string,
  tokenHash: string,
  now = Date.now(),
) {
  const s = sql
    .exec(
      'SELECT * FROM commerce_action_sessions WHERE id=? AND order_id=?',
      sessionId,
      id,
    )
    .toArray()[0];
  if (!s || s.token_hash || Number(s.expires_at) <= now || Number(s.attempts) >= 5)
    return { verified: false };
  sql.exec(
    'UPDATE commerce_action_sessions SET attempts=attempts+1 WHERE id=?',
    sessionId,
  );
  if (s.code_hash !== hash) return { verified: false };
  sql.exec(
    'UPDATE commerce_action_sessions SET token_hash=?,expires_at=? WHERE id=?',
    tokenHash,
    now + 900_000,
    sessionId,
  );
  return { verified: true };
}
export function assertActionSession(
  sql: ShippingSql,
  id: string,
  tokenHash: string,
  now = Date.now(),
) {
  if (
    !sql
      .exec(
        'SELECT id FROM commerce_action_sessions WHERE order_id=? AND token_hash=? AND expires_at>?',
        id,
        tokenHash,
        now,
      )
      .toArray().length
  )
    fail('verification_required', 'Vui lòng xác minh email để thao tác đơn.', 403);
}
export function serviceActionAccess(
  sql: ShippingSql,
  id: string,
  hash: string,
  kind?: 'quote' | 'evidence',
  now = Date.now(),
) {
  assertActionSession(sql, id, hash, now);
  if (!kind) return;
  const interval = kind === 'quote' ? 10000 : 2000;
  const r = sql
    .exec(
      'SELECT requested_at FROM commerce_service_rates WHERE order_id=? AND kind=?',
      id,
      kind,
    )
    .toArray()[0];
  if (r && Number(r.requested_at) > now - interval)
    fail('service_rate_limited', 'Vui lòng đợi trước khi gửi lại thao tác.', 429);
  sql.exec(
    'INSERT INTO commerce_service_rates VALUES(?,?,?) ON CONFLICT(order_id,kind) DO UPDATE SET requested_at=excluded.requested_at',
    id,
    kind,
    now,
  );
}
export function serviceQueue(sql: ShippingSql) {
  return {
    requests: sql
      .exec(
        "SELECT r.id,r.order_id,o.number,r.kind,r.status,r.created_at,r.updated_at FROM commerce_requests r JOIN orders o ON o.id=r.order_id WHERE r.status IN ('pending','approved') ORDER BY r.updated_at LIMIT 200",
      )
      .toArray(),
    refunds: sql
      .exec(
        "SELECT r.id,r.order_id,o.number,r.amount_vnd,r.status,r.created_at FROM commerce_refund_ledger r JOIN orders o ON o.id=r.order_id WHERE r.status IN ('pending','processing','unknown') ORDER BY r.updated_at LIMIT 200",
      )
      .toArray(),
    notification_failures: sql
      .exec(
        "SELECT id,order_id,event,attempts,created_at FROM commerce_service_notifications WHERE state<>'sent' AND attempts>=8 ORDER BY created_at LIMIT 100",
      )
      .toArray(),
  };
}
export function serviceNotificationClaim(sql: ShippingSql, now = Date.now()) {
  const jobs = sql
    .exec(
      "SELECT n.*,o.customer_email,o.number FROM commerce_service_notifications n JOIN orders o ON o.id=n.order_id WHERE n.state<>'sent' AND n.attempts<8 AND n.next_attempt_at<=? ORDER BY n.created_at LIMIT 10",
      now,
    )
    .toArray();
  for (const job of jobs)
    sql.exec(
      "UPDATE commerce_service_notifications SET attempts=attempts+1,state='sending',next_attempt_at=? WHERE id=?",
      now + 300_000,
      job.id,
    );
  return jobs;
}
export function serviceNotificationFinish(
  sql: ShippingSql,
  id: string,
  sent: boolean,
  now = Date.now(),
) {
  sql.exec(
    'UPDATE commerce_service_notifications SET state=?,next_attempt_at=? WHERE id=?',
    sent ? 'sent' : 'pending',
    now + 900_000,
    id,
  );
}
export function serviceRecovery(sql: ShippingSql, number: string, email: string) {
  const r = sql
    .exec(
      'SELECT o.id,o.customer_email FROM orders o JOIN commerce_orders c ON c.order_id=o.id WHERE o.number=? AND lower(o.customer_email)=lower(?)',
      number,
      email,
    )
    .toArray()[0];
  return r ? { order_id: String(r.id), email: String(r.customer_email) } : null;
}
export function storeServiceEvidence(
  sql: ShippingSql,
  id: string,
  key: string,
  mime: string,
  hash: string,
) {
  assertActionSession(sql, id, hash);
  if (
    sql.exec('SELECT id FROM commerce_service_evidence WHERE order_id=?', id).toArray()
      .length >= 15
  )
    fail('evidence_limit', 'Đã đạt giới hạn ảnh cho đơn.', 429);
  const evidenceId = crypto.randomUUID();
  sql.exec(
    'INSERT INTO commerce_service_evidence VALUES(?,?,?,?,?)',
    evidenceId,
    id,
    key,
    mime,
    Date.now(),
  );
  return { id: evidenceId };
}
export function readServiceEvidence(sql: ShippingSql, id: string, evidenceId: string) {
  const r = sql
    .exec(
      'SELECT object_key,mime FROM commerce_service_evidence WHERE id=? AND order_id=?',
      evidenceId,
      id,
    )
    .toArray()[0];
  if (!r) fail('evidence_not_found', 'Không tìm thấy ảnh.', 404);
  return { key: String(r.object_key), mime: String(r.mime) };
}

export function expireServiceHold(sql: ShippingSql, id: string, now = Date.now()) {
  const r = orderRow(sql, id);
  if (
    Number(r.expires_at) > now ||
    r.reservation_state !== 'held' ||
    !['pending', 'unpaid'].includes(String(r.payment_status))
  )
    fail('expiry_not_allowed', 'Đơn không đủ điều kiện hết hạn giữ hàng.');
  assertNoOpenChanges(sql, id);
  assertNoLease(sql, id, now);
  cancelPendingOrder(
    sql,
    id,
    'Hết hạn giữ hàng theo chính sách tự hủy đã được shop bật.',
    'system:hold-expiry',
  );
  audit(
    sql,
    id,
    'order.hold_expired',
    'system:hold-expiry',
    { expires_at: r.expires_at },
    now,
  );
  return { order_id: id };
}
export function assertLegacyResolution(sql: ShippingSql, id: string) {
  if (
    sql
      .exec(
        "SELECT id FROM commerce_refund_ledger WHERE order_id=? AND status<>'failed' LIMIT 1",
        id,
      )
      .toArray().length
  )
    fail(
      'use_service_reconciliation',
      'Đơn có sổ hoàn tiền mới; dùng đối soát thu/hoàn để tránh ghi nhận tiền hoàn hai lần.',
    );
}
