import { z } from 'zod';
import {
  ShippingError,
  validateShippingCart,
  type ShippingPolicy,
} from './smart-shipping';
import {
  loadShippingCart,
  readShippingSelection,
  type ShippingSql,
} from './shipping-store';
import { cartTaxSummary } from './commerce-money';
import { readOrderProgress } from './commerce-progress';

export const checkoutInput = z
  .object({
    cart_id: z.string().uuid(),
    idempotency_key: z.string().uuid(),
    payment_method: z.enum(['cod', 'techcombank_qr']),
    customer_email: z.string().email().max(254),
    recipient: z
      .object({
        name: z.string().trim().min(2).max(100),
        phone: z.string().regex(/^(0[35789]\d{8}|\+84[35789]\d{8})$/),
        address: z.string().trim().min(5).max(300),
        city: z.string().trim().min(2).max(100),
        district_id: z.number().int().positive(),
        ward_code: z.string().regex(/^[A-Za-z0-9]{1,12}$/),
      })
      .strict(),
    expected_total_vnd: z.number().int().positive().max(2_000_000_000),
    note: z.string().trim().max(1000).default(''),
  })
  .strict();
export type CheckoutInput = z.infer<typeof checkoutInput>;
export type BankAccount = { account_number: string; account_name: string };
export type CheckoutConfig = {
  policy: ShippingPolicy;
  policy_key: string;
  environment: 'production' | 'staging';
  shop_id: string;
  warehouse_id: string;
  bank: BankAccount | null;
  dispatch_enabled?: boolean;
  dispatch_account_id?: string;
};
export const COMMERCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS commerce_orders(
 order_id TEXT PRIMARY KEY REFERENCES orders(id),cart_id TEXT NOT NULL UNIQUE,idempotency_key TEXT NOT NULL UNIQUE,
 request_json TEXT NOT NULL,snapshot_json TEXT NOT NULL,method TEXT NOT NULL,payment_status TEXT NOT NULL,
 cod_status TEXT NOT NULL,fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled',reference TEXT NOT NULL UNIQUE,
 expires_at INTEGER NOT NULL,bank_json TEXT,pancake_order_id TEXT UNIQUE,payment_version INTEGER NOT NULL DEFAULT 0,
 reservation_state TEXT NOT NULL DEFAULT 'held',updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS commerce_transactions(
 id TEXT PRIMARY KEY,order_id TEXT NOT NULL,kind TEXT NOT NULL,provider_transaction_id TEXT NOT NULL,
 amount_vnd INTEGER NOT NULL,currency TEXT NOT NULL,reference TEXT NOT NULL,evidence TEXT NOT NULL,
 actor TEXT NOT NULL,received_at TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(kind,provider_transaction_id));
CREATE TABLE IF NOT EXISTS commerce_outbox(
 id TEXT PRIMARY KEY,order_id TEXT NOT NULL,event TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',
 lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,create_attempted INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,created_at TEXT NOT NULL,UNIQUE(order_id,event));
CREATE TABLE IF NOT EXISTS commerce_audit(
 id TEXT PRIMARY KEY,order_id TEXT NOT NULL,action TEXT NOT NULL,actor TEXT NOT NULL,evidence TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_commerce_audit_order_action ON commerce_audit(order_id,action,created_at);
CREATE TABLE IF NOT EXISTS commerce_shipments(
 order_id TEXT PRIMARY KEY REFERENCES commerce_orders(order_id),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','submitted','booked','needs_attention','delivered','returned','canceled')),
 lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,attempted INTEGER NOT NULL DEFAULT 0,
 tracking_number TEXT UNIQUE,partner_id INTEGER,account_id INTEGER,partner_status TEXT,
 last_error TEXT,next_attempt_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_commerce_shipments_due ON commerce_shipments(next_attempt_at);
`;
function fail(code: string, message: string, status = 409): never {
  throw new ShippingError(code, status, message);
}
export function money(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_000_000_000)
    fail('invalid_money', 'Giá trị VND không hợp lệ.', 400);
  return value;
}
function row(sql: ShippingSql, id: string) {
  const r = sql
    .exec(
      'SELECT c.*,o.number,o.total_cents,o.status,o.tracking_number,o.created_at AS order_created_at FROM commerce_orders c JOIN orders o ON o.id=c.order_id WHERE c.order_id=?',
      id,
    )
    .toArray()[0];
  if (!r) fail('order_not_found', 'Không tìm thấy đơn hàng.', 404);
  return r;
}
function enqueue(sql: ShippingSql, id: string, event: string, time: string) {
  sql.exec(
    'INSERT OR IGNORE INTO commerce_outbox(id,order_id,event,created_at) VALUES(?,?,?,?)',
    crypto.randomUUID(),
    id,
    event,
    time,
  );
}
export function receipt(sql: ShippingSql, id: string) {
  const r = row(sql, id);
  const shipment = sql.exec('SELECT state,last_error,partner_status,updated_at FROM commerce_shipments WHERE order_id=?', id).toArray()[0];
  const snapshot = JSON.parse(String(r.snapshot_json));
  return {
    order_id: id,
    number: String(r.number),
    order_status: String(r.status),
    payment_method: String(r.method),
    payment_status: String(r.payment_status),
    cod_status: String(r.cod_status),
    fulfillment_status: String(r.fulfillment_status),
    progress: readOrderProgress(sql, id, { fulfillment_status: String(r.fulfillment_status), status: String(r.status), tracking_number: r.tracking_number, created_at: r.order_created_at }),
    status_checked_at: shipment && !shipment.last_error ? new Date(Number(shipment.updated_at)).toISOString() : null,
    currency: 'VND' as const,
    total_vnd: Number(r.total_cents),
    amount_to_collect_vnd:
      r.method === 'cod' && r.cod_status === 'to_collect'
        ? Number(r.total_cents)
        : 0,
    reference: String(r.reference),
    expires_at: Number(r.expires_at),
    bank: r.bank_json ? (JSON.parse(String(r.bank_json)) as BankAccount) : null,
    totals: snapshot.totals as {
      subtotal_vnd: number;
      discount_vnd: number;
      shipping_vnd: number;
      tax_vnd: number;
      total_vnd: number;
    },
    items: snapshot.items as {
      sku: string;
      title: string;
      qty: number;
      unit_price_vnd: number;
    }[],
    tracking_number: r.tracking_number ? String(r.tracking_number) : null,
    shipment_status: shipment ? String(shipment.state) : 'pending',
    shipment_error: shipment?.last_error ? String(shipment.last_error) : null,
    carrier_status: shipment?.partner_status ? String(shipment.partner_status) : null,
    pos_sync_status: r.pancake_order_id
      ? 'synced'
      : String(
          sql
            .exec(
              'SELECT state FROM commerce_outbox WHERE order_id=? ORDER BY created_at DESC LIMIT 1',
              id,
            )
            .toArray()[0]?.state || 'waiting_payment',
        ),
  };
}
export type CommerceReceipt = ReturnType<typeof receipt>;
export function replayCheckout(sql: ShippingSql, input: CheckoutInput) {
  const previous = sql
    .exec(
      'SELECT order_id,request_json FROM commerce_orders WHERE idempotency_key=?',
      input.idempotency_key,
    )
    .toArray()[0];
  if (!previous) return null;
  if (previous.request_json !== JSON.stringify(input))
    fail('idempotency_conflict', 'Yêu cầu đặt đơn đã thay đổi.');
  return receipt(sql, String(previous.order_id));
}
/** Called inside a single DO transactionSync. No external I/O occurs here. */
export function confirmCheckout(
  sql: ShippingSql,
  input: CheckoutInput,
  config: CheckoutConfig,
  now = Date.now(),
) {
  const encoded = JSON.stringify(input);
  const previous = sql
    .exec(
      'SELECT order_id,request_json FROM commerce_orders WHERE idempotency_key=?',
      input.idempotency_key,
    )
    .toArray()[0];
  if (previous) {
    if (previous.request_json !== encoded)
      fail('idempotency_conflict', 'Yêu cầu đặt đơn đã thay đổi.');
    return receipt(sql, String(previous.order_id));
  }
  if (
    sql
      .exec(
        'SELECT order_id FROM commerce_orders WHERE cart_id=?',
        input.cart_id,
      )
      .toArray().length
  )
    fail('cart_already_ordered', 'Giỏ đã có đơn. Vui lòng mở lại đơn đã đặt.');
  const cart = loadShippingCart(sql, input.cart_id);
  const parcel = validateShippingCart(cart, config.policy, now);
  if (
    cart.address[0] !== input.recipient.name ||
    cart.address[1] !== input.recipient.address ||
    cart.address[3] !== input.recipient.city ||
    cart.address[6] !== 'VN'
  )
    fail(
      'shipping_selection_mismatch',
      'Địa chỉ đã đổi. Vui lòng lưu địa chỉ và tính phí lại.',
    );
  const vnd = sql
    .exec(
      "SELECT decimal_places FROM currencies WHERE code='VND' AND status='active'",
    )
    .toArray()[0];
  if (vnd?.decimal_places !== 0)
    fail('currency_invalid', 'Cần tiền VND với đơn vị đồng nguyên.', 503);
  // MVP deliberately rejects vouchers until per-customer redemption and tax-discount rules are verified.
  if (cart.discount_code || cart.discount_amount_cents)
    fail(
      'discount_not_supported',
      'Mã giảm giá chưa được hỗ trợ trong checkout giai đoạn 1.',
      422,
    );
  const selection = readShippingSelection(
    sql,
    input.cart_id,
    config.policy_key,
    now,
  );
  if (!selection)
    fail('shipping_quote_required', 'Cần chọn báo giá vận chuyển còn hạn.');
  if (selection.offer.environment !== config.environment)
    fail(
      'shipping_environment_mismatch',
      'Báo giá không thuộc môi trường bán hàng.',
    );
  if (
    selection.payment_method !==
      (input.payment_method === 'cod' ? 'cod' : 'prepaid') ||
    selection.destination.district_id !== input.recipient.district_id ||
    selection.destination.ward_code !== input.recipient.ward_code
  )
    fail(
      'shipping_selection_mismatch',
      'Địa chỉ hoặc phương thức thanh toán đã đổi. Vui lòng tính phí lại.',
    );
  const [warehouse] = sql
    .exec(
      "SELECT target_id FROM pancake_links WHERE kind='warehouse' AND shop_id=? AND source_id=?",
      config.shop_id,
      config.warehouse_id,
    )
    .toArray();
  if (!warehouse)
    fail('warehouse_unverified', 'Chưa xác minh kho Pancake của shop.', 503);
  const state = sql
    .exec(
      'SELECT last_completed_at FROM pancake_sync_state WHERE shop_id=? AND warehouse_id=?',
      config.shop_id,
      config.warehouse_id,
    )
    .toArray()[0];
  if (
    !state ||
    !Number.isFinite(Date.parse(String(state.last_completed_at))) ||
    Date.parse(String(state.last_completed_at)) < now - 2 * 3600_000
  )
    fail('inventory_stale', 'Tồn kho POS quá cũ. Shop cần đồng bộ lại.', 503);
  const items = sql
    .exec(
      `SELECT ci.*,v.id AS local_variant_id,v.tax_code,v.weight_g,p.source_id AS pos_product_id,l.source_id AS pos_variant_id FROM cart_items ci
 JOIN variants v ON v.sku=ci.sku LEFT JOIN pancake_links l ON l.kind='variation' AND l.target_id=v.id AND l.shop_id=?
 LEFT JOIN pancake_links p ON p.kind='product' AND p.target_id=v.product_id AND p.shop_id=? WHERE ci.cart_id=? ORDER BY ci.sku`,
      config.shop_id,
      config.shop_id,
      input.cart_id,
    )
    .toArray();
  if (items.some((i) => !i.pos_variant_id || !i.pos_product_id))
    fail('sku_mapping_missing', 'SKU chưa được ánh xạ Pancake.', 422);
  if (new Set(items.map((i) => i.sku)).size !== items.length)
    fail('duplicate_sku', 'Giỏ có SKU trùng. Vui lòng cập nhật lại.');
  const { tax_vnd: tax, tax_inclusive: inclusive } = cartTaxSummary(
    sql,
    input.cart_id,
  );
  const subtotal = money(
    items.reduce(
      (sum, i) => sum + Number(i.qty) * Number(i.unit_price_cents),
      0,
    ),
  );
  const shipping = money(selection.offer.customer_fee_vnd);
  const total = money(subtotal + shipping + (inclusive ? 0 : tax));
  if (total !== input.expected_total_vnd)
    fail(
      'checkout_total_changed',
      'Tổng tiền thay đổi. Vui lòng kiểm tra giỏ và xác nhận lại.',
    );
  if (input.payment_method === 'cod' && selection.offer.cod_value_vnd !== total)
    fail('cod_quote_mismatch', 'Cước COD cần tính lại theo tổng tiền có thuế.');
  if (input.payment_method === 'techcombank_qr' && !config.bank)
    fail(
      'bank_not_configured',
      'Shop chưa cấu hình tài khoản Techcombank.',
      503,
    );
  const id = crypto.randomUUID(),
    reference = 'HF' + id.replaceAll('-', '').toUpperCase();
  const time = new Date(now).toISOString();
  const snapshot = {
    recipient: input.recipient,
    customer_email: input.customer_email,
    note: input.note,
    shop_id: config.shop_id,
    warehouse_id: config.warehouse_id,
    fufuni_warehouse_id: warehouse.target_id,
    shipping: selection,
    parcel,
    dispatch_enabled: config.dispatch_enabled === true,
    dispatch_account_id: config.dispatch_account_id || null,
    automation_version: 2,
    items: items.map((i) => ({
      sku: String(i.sku),
      title: String(i.title),
      qty: Number(i.qty),
      unit_price_vnd: Number(i.unit_price_cents),
      pos_product_id: String(i.pos_product_id),
      pos_variant_id: String(i.pos_variant_id),
      local_variant_id: String(i.local_variant_id),
      weight_g: Number(i.weight_g),
    })),
    totals: {
      subtotal_vnd: subtotal,
      discount_vnd: 0,
      shipping_vnd: shipping,
      tax_vnd: tax,
      total_vnd: total,
    },
    tax_inclusive: inclusive,
  };
  for (const item of items) {
    const changed = sql
      .exec(
        'UPDATE warehouse_inventory SET reserved=reserved+?,updated_at=? WHERE sku=? AND warehouse_id=? AND on_hand-reserved>=? RETURNING id',
        item.qty,
        time,
        item.sku,
        warehouse.target_id,
        item.qty,
      )
      .toArray();
    if (changed.length !== 1)
      fail('insufficient_stock', 'Sản phẩm không đủ tồn khả dụng.');
    sql.exec(
      'UPDATE inventory SET reserved=reserved+?,updated_at=? WHERE sku=?',
      item.qty,
      time,
      item.sku,
    );
  }
  sql.exec(
    `INSERT INTO orders(id,number,status,customer_email,region_id,warehouse_id,shipping_name,shipping_phone,ship_to,subtotal_cents,tax_cents,shipping_cents,total_cents,currency,locale,created_at)
 VALUES(?,?,'pending',?,?,?,?,?,?,?,?,?,?,'VND','vi-VN',?)`,
    id,
    reference,
    input.customer_email,
    cart.region_id,
    warehouse.target_id,
    input.recipient.name,
    input.recipient.phone,
    JSON.stringify(input.recipient),
    subtotal,
    tax,
    shipping,
    total,
    time,
  );
  for (const item of items)
    sql.exec(
      'INSERT INTO order_items(id,order_id,sku,title,qty,unit_price_cents) VALUES(?,?,?,?,?,?)',
      crypto.randomUUID(),
      id,
      item.sku,
      item.title,
      item.qty,
      item.unit_price_cents,
    );
  sql.exec(
    `INSERT INTO commerce_orders(order_id,cart_id,idempotency_key,request_json,snapshot_json,method,payment_status,cod_status,reference,expires_at,bank_json,updated_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.cart_id,
    input.idempotency_key,
    encoded,
    JSON.stringify(snapshot),
    input.payment_method,
    input.payment_method === 'cod' ? 'unpaid' : 'pending',
    input.payment_method === 'cod' ? 'to_collect' : 'not_applicable',
    reference,
    now + 24 * 3600_000,
    input.payment_method === 'techcombank_qr'
      ? JSON.stringify(config.bank)
      : null,
    time,
  );
  sql.exec(
    "UPDATE carts SET status='checked_out',updated_at=? WHERE id=?",
    time,
    input.cart_id,
  );
  if (input.payment_method === 'cod') enqueue(sql, id, 'order.confirmed', time);
  return receipt(sql, id);
}
export const evidenceInput = z
  .object({
    transaction_id: z.string().trim().min(3).max(120),
    amount_vnd: z.number().int().positive().max(2_000_000_000),
    currency: z.literal('VND'),
    reference: z.string().min(2).max(100),
    received_at: z.string().datetime({ offset: true }),
    evidence: z.string().trim().min(10).max(1000),
  })
  .strict();
export type EvidenceInput = z.infer<typeof evidenceInput>;
export function recordEvidence(
  sql: ShippingSql,
  id: string,
  kind: 'bank_transfer' | 'cod_collected' | 'cod_reconciled',
  input: EvidenceInput,
  actor: string,
  now = Date.now(),
) {
  const r = row(sql, id);
  const time = new Date(now).toISOString();
  const previous = sql
    .exec(
      'SELECT * FROM commerce_transactions WHERE kind=? AND provider_transaction_id=?',
      kind,
      input.transaction_id,
    )
    .toArray()[0];
  if (previous) {
    if (
      previous.order_id !== id ||
      previous.amount_vnd !== input.amount_vnd ||
      previous.reference !== input.reference ||
      previous.currency !== input.currency ||
      previous.evidence !== input.evidence ||
      previous.received_at !== input.received_at
    )
      fail(
        'transaction_conflict',
        'Mã giao dịch đã được sử dụng với dữ liệu khác.',
      );
    return receipt(sql, id);
  }
  if (Date.parse(input.received_at) > now + 60_000)
    fail('invalid_received_at', 'Thời gian nhận tiền không hợp lệ.', 400);
  if (
    (kind === 'bank_transfer' && r.method !== 'techcombank_qr') ||
    (kind !== 'bank_transfer' && r.method !== 'cod')
  )
    fail(
      'payment_method_mismatch',
      'Chứng từ không phù hợp phương thức thanh toán.',
    );
  if (kind === 'cod_reconciled' && r.cod_status !== 'collected')
    fail('cod_not_collected', 'Cần xác nhận thu COD trước đối soát.');
  if (
    (kind === 'cod_collected' && r.cod_status !== 'to_collect') ||
    (kind === 'bank_transfer' && r.payment_status === 'paid') ||
    (r.status === 'canceled' && kind !== 'bank_transfer')
  )
    fail(
      'payment_transition_invalid',
      'Trạng thái không cho phép ghi nhận giao dịch mới.',
    );
  sql.exec(
    'INSERT INTO commerce_transactions(id,order_id,kind,provider_transaction_id,amount_vnd,currency,reference,evidence,actor,received_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    crypto.randomUUID(),
    id,
    kind,
    input.transaction_id,
    input.amount_vnd,
    input.currency,
    input.reference,
    input.evidence,
    actor,
    input.received_at,
    time,
  );
  if (
    r.status === 'canceled' ||
    r.payment_status === 'needs_attention' ||
    input.reference !== r.reference ||
    input.amount_vnd !== r.total_cents ||
    (kind === 'bank_transfer' && Number(r.expires_at) < now)
  ) {
    sql.exec(
      "UPDATE commerce_orders SET payment_status='needs_attention',updated_at=? WHERE order_id=?",
      time,
      id,
    );
    return receipt(sql, id);
  }
  if (kind === 'bank_transfer') {
    sql.exec(
      "UPDATE commerce_orders SET payment_status='paid',payment_version=payment_version+1,updated_at=? WHERE order_id=?",
      time,
      id,
    );
    sql.exec("UPDATE orders SET status='paid' WHERE id=?", id);
    enqueue(sql, id, 'order.confirmed', time);
  } else
    sql.exec(
      'UPDATE commerce_orders SET cod_status=?,payment_status=?,payment_version=payment_version+1,updated_at=? WHERE order_id=?',
      kind === 'cod_collected' ? 'collected' : 'reconciled',
      'paid',
      time,
      id,
    );
  return receipt(sql, id);
}
export const fulfillmentInput = z
  .object({
    state: z.enum(['ready_to_ship', 'shipped', 'delivered', 'returned']),
    tracking_number: z.string().trim().max(100).optional(),
    evidence: z.string().trim().min(10).max(1000),
  })
  .strict();
export function updateFulfillment(
  sql: ShippingSql,
  id: string,
  input: z.infer<typeof fulfillmentInput>,
  actor: string,
) {
  const r = row(sql, id);
  const ranks: Record<string, number> = {
    unfulfilled: 0,
    ready_to_ship: 1,
    shipped: 2,
    delivered: 3,
    returned: 4,
  };
  if (r.method === 'techcombank_qr' && r.payment_status !== 'paid')
    fail('payment_pending', 'Đơn chuyển khoản chưa xác nhận nhận tiền.');
  if (!r.pancake_order_id)
    fail('pos_order_required', 'Cần có đơn Pancake trước xử lý giao hàng.');
  const old = ranks[String(r.fulfillment_status)],
    next = ranks[input.state];
  if (next < old || (next > old + 1 && input.state !== 'returned'))
    fail(
      'fulfillment_transition_invalid',
      'Không thể bỏ bước hoặc lùi trạng thái giao hàng.',
    );
  if (input.state === 'shipped' && !input.tracking_number && !r.tracking_number)
    fail(
      'tracking_required',
      'Cần mã vận đơn trước khi ghi nhận đã giao hãng.',
    );
  const time = new Date().toISOString();
  sql.exec(
    'INSERT INTO commerce_audit(id,order_id,action,actor,evidence,created_at) VALUES(?,?,?,?,?,?)',
    crypto.randomUUID(),
    id,
    'fulfillment.' + input.state,
    actor,
    input.evidence,
    time,
  );
  sql.exec(
    'UPDATE commerce_orders SET fulfillment_status=?,updated_at=? WHERE order_id=?',
    input.state,
    time,
    id,
  );
  if (input.state === 'shipped' || input.state === 'delivered')
    sql.exec(
      'UPDATE orders SET status=?,tracking_number=COALESCE(?,tracking_number) WHERE id=?',
      input.state,
      input.tracking_number || null,
      id,
    );
  return receipt(sql, id);
}
export function claimOutbox(
  sql: ShippingSql,
  id: string,
  token: string,
  now = Date.now(),
) {
  const r = sql
    .exec(
      'SELECT * FROM commerce_outbox WHERE order_id=? AND event=?',
      id,
      'order.confirmed',
    )
    .toArray()[0];
  if (!r) fail('outbox_not_found', 'Đơn chưa đủ điều kiện đồng bộ.', 404);
  if (r.state === 'canceled') fail('order_canceled', 'Đơn đã hủy.');
  if (r.state === 'synced') return null;
  if (Number(r.lease_until) > now)
    fail('pos_sync_busy', 'Đang đồng bộ đơn Pancake.');
  sql.exec(
    'UPDATE commerce_outbox SET lease_token=?,lease_until=? WHERE id=?',
    token,
    now + 60_000,
    r.id,
  );
  return {
    create_attempted: Number(r.create_attempted),
    snapshot: JSON.parse(String(row(sql, id).snapshot_json)),
    order: receipt(sql, id),
  };
}
function reservationSku(sql: ShippingSql, item: { local_variant_id: string }) {
  const current = sql
    .exec('SELECT sku FROM variants WHERE id=?', item.local_variant_id)
    .toArray()[0];
  if (!current)
    fail(
      'reservation_variant_missing',
      'SKU đang giữ hàng đã thay đổi. Cần kiểm tra kho.',
    );
  return String(current.sku);
}
export function finishOutbox(
  sql: ShippingSql,
  id: string,
  token: string,
  posId: string | null,
  error: string | null,
) {
  const r = sql
    .exec(
      'SELECT * FROM commerce_outbox WHERE order_id=? AND lease_token=?',
      id,
      token,
    )
    .toArray()[0];
  if (!r) fail('pos_lease_lost', 'Phiên đồng bộ đã thay đổi.');
  sql.exec(
    'UPDATE commerce_outbox SET state=?,last_error=?,lease_token=NULL,lease_until=0 WHERE id=?',
    posId ? 'synced' : 'needs_attention',
    error,
    r.id,
  );
  if (posId) {
    const order = row(sql, id);
    if (order.reservation_state === 'held') {
      const snapshot = JSON.parse(String(order.snapshot_json));
      for (const item of snapshot.items) {
        // POS has accepted the order. Locally consume the held quantity until the
        // next POS inventory snapshot, rather than double-reserving both channels.
        sql.exec(
          'UPDATE warehouse_inventory SET on_hand=MAX(0,on_hand-?),reserved=MAX(0,reserved-?) WHERE sku=? AND warehouse_id=?',
          item.qty,
          item.qty,
          reservationSku(sql, item),
          snapshot.fufuni_warehouse_id,
        );
        sql.exec(
          'UPDATE inventory SET on_hand=MAX(0,on_hand-?),reserved=MAX(0,reserved-?) WHERE sku=?',
          item.qty,
          item.qty,
          reservationSku(sql, item),
        );
      }
    }
    sql.exec(
      "UPDATE commerce_orders SET pancake_order_id=?,reservation_state='consumed' WHERE order_id=?",
      posId,
      id,
    );
  }
}
export function markCreateAttempt(sql: ShippingSql, id: string, token: string) {
  const r = sql
    .exec(
      'UPDATE commerce_outbox SET create_attempted=1 WHERE order_id=? AND lease_token=? AND lease_until>? RETURNING id',
      id,
      token,
      Date.now(),
    )
    .toArray();
  if (!r.length) fail('pos_lease_lost', 'Phiên đồng bộ đã thay đổi.');
}
export function cancelPendingOrder(
  sql: ShippingSql,
  id: string,
  evidence: string,
  actor: string,
) {
  const order = row(sql, id);
  if (order.status === 'canceled') return receipt(sql, id);
  const outbox = sql
    .exec(
      'SELECT create_attempted,lease_until FROM commerce_outbox WHERE order_id=?',
      id,
    )
    .toArray()[0];
  if (
    order.payment_status === 'paid' ||
    order.payment_status === 'needs_attention' ||
    order.pancake_order_id ||
    (outbox &&
      (Number(outbox.create_attempted) ||
        Number(outbox.lease_until) > Date.now()))
  )
    fail(
      'cancel_needs_reconciliation',
      'Cần đối soát tiền và POS trước hủy đơn.',
    );
  if (order.reservation_state === 'held') {
    const snapshot = JSON.parse(String(order.snapshot_json));
    for (const item of snapshot.items) {
      sql.exec(
        'UPDATE warehouse_inventory SET reserved=MAX(0,reserved-?) WHERE sku=? AND warehouse_id=?',
        item.qty,
        reservationSku(sql, item),
        snapshot.fufuni_warehouse_id,
      );
      sql.exec(
        'UPDATE inventory SET reserved=MAX(0,reserved-?) WHERE sku=?',
        item.qty,
        reservationSku(sql, item),
      );
    }
  }
  sql.exec(
    "UPDATE commerce_orders SET reservation_state='released',payment_status='canceled',cod_status='not_applicable',updated_at=? WHERE order_id=?",
    new Date().toISOString(),
    id,
  );
  sql.exec("UPDATE orders SET status='canceled' WHERE id=?", id);
  sql.exec("UPDATE commerce_outbox SET state='canceled' WHERE order_id=?", id);
  sql.exec(
    'INSERT INTO commerce_audit(id,order_id,action,actor,evidence,created_at) VALUES(?,?,?,?,?,?)',
    crypto.randomUUID(),
    id,
    'order.canceled',
    actor,
    evidence,
    new Date().toISOString(),
  );
  return receipt(sql, id);
}
export const bankResolutionInput = z
  .object({
    transaction_ids: z.array(z.string().min(3).max(120)).min(1).max(20),
    evidence: z.string().trim().min(20).max(1000),
    refunded_vnd: z.number().int().nonnegative().max(2_000_000_000).default(0),
    refund_reference: z.string().trim().min(3).max(120).optional(),
  })
  .strict();
/** An accountant allocates audited receipts; no client assertion can mark paid. */
export function resolveBankException(
  sql: ShippingSql,
  id: string,
  input: z.infer<typeof bankResolutionInput>,
  actor: string,
) {
  const order = row(sql, id);
  if (
    order.method !== 'techcombank_qr' ||
    order.payment_status !== 'needs_attention' ||
    order.status === 'canceled'
  )
    fail(
      'resolution_not_allowed',
      'Đơn cần được xử lý thủ công ngoài checkout này.',
    );
  const ids = new Set(input.transaction_ids);
  if (ids.size !== input.transaction_ids.length)
    fail('resolution_duplicate', 'Không chọn chứng từ trùng.', 400);
  const rows = sql
    .exec(
      "SELECT provider_transaction_id,amount_vnd FROM commerce_transactions WHERE order_id=? AND kind='bank_transfer'",
      id,
    )
    .toArray();
  if (
    rows.length !== ids.size ||
    rows.some((r) => !ids.has(String(r.provider_transaction_id)))
  )
    fail('resolution_incomplete', 'Cần đối soát toàn bộ chứng từ của đơn.');
  const gross = money(rows.reduce((sum, r) => sum + Number(r.amount_vnd), 0));
  if (
    gross - input.refunded_vnd !== order.total_cents ||
    (input.refunded_vnd > 0 && !input.refund_reference)
  )
    fail(
      'resolution_money_mismatch',
      'Tiền nhận trừ tiền đã hoàn phải bằng tổng đơn, kèm mã chứng từ hoàn tiền.',
    );
  const snapshot = JSON.parse(String(order.snapshot_json));
  if (
    snapshot.items.some(
      (i: { sku: string; qty: number; local_variant_id: string }) => {
        const stock = sql
          .exec(
            'SELECT on_hand,reserved FROM warehouse_inventory WHERE sku=? AND warehouse_id=?',
            reservationSku(sql, i),
            snapshot.fufuni_warehouse_id,
          )
          .toArray()[0];
        return !stock || Number(stock.on_hand) < Number(stock.reserved);
      },
    )
  )
    fail(
      'resolution_stock_changed',
      'Kho không còn đủ hàng cho các đơn đang giữ. Cần xử lý với POS.',
    );
  const time = new Date().toISOString();
  sql.exec(
    'INSERT INTO commerce_audit(id,order_id,action,actor,evidence,created_at) VALUES(?,?,?,?,?,?)',
    crypto.randomUUID(),
    id,
    'bank.exception_resolved',
    actor,
    JSON.stringify(input),
    time,
  );
  sql.exec(
    "UPDATE commerce_orders SET payment_status='paid',payment_version=payment_version+1,updated_at=? WHERE order_id=?",
    time,
    id,
  );
  sql.exec("UPDATE orders SET status='paid' WHERE id=?", id);
  enqueue(sql, id, 'order.confirmed', time);
  return receipt(sql, id);
}
