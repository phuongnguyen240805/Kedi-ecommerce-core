import { z } from 'zod';
import type { ShippingSql } from './shipping-store';
import { ShippingError } from './smart-shipping';
import { observeOrderProgress } from './commerce-progress';
import {
  assertNoOpenChanges,
  createServiceRequest,
  decideServiceRequest,
  orderVersion,
  serviceDetail,
} from './commerce-service';

// Every mutation is called inside a store DO transactionSync. External I/O is
// deliberately outside that transaction, after the durable attempted marker.
export const SHIPPING_WORKFLOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS shipping_legs(
 id TEXT PRIMARY KEY,order_id TEXT NOT NULL,kind TEXT NOT NULL,carrier_id TEXT NOT NULL,
 account_id TEXT NOT NULL,environment TEXT NOT NULL,owner TEXT NOT NULL,service_id TEXT NOT NULL,
 sequence INTEGER NOT NULL DEFAULT 1,request_id TEXT,parent_leg_id TEXT,binding_json TEXT,
 client_code TEXT NOT NULL UNIQUE,tracking_code TEXT,status TEXT NOT NULL DEFAULT 'unbooked',
 observed_at INTEGER NOT NULL DEFAULT 0,observation_json TEXT,last_error TEXT,created_at INTEGER NOT NULL,
 lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,next_poll_at INTEGER NOT NULL DEFAULT 0,
 UNIQUE(carrier_id,account_id,environment,tracking_code),UNIQUE(order_id,kind,sequence));
CREATE TABLE IF NOT EXISTS shipping_commands(
 id TEXT PRIMARY KEY,leg_id TEXT NOT NULL,request_id TEXT,kind TEXT NOT NULL,payload TEXT NOT NULL,
 idempotency_key TEXT NOT NULL UNIQUE,state TEXT NOT NULL DEFAULT 'pending',attempted INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,
 result TEXT,actor TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS shipping_commands_due ON shipping_commands(state,next_at,lease_until);
CREATE TABLE IF NOT EXISTS shipping_inbox(
 id TEXT PRIMARY KEY,source TEXT NOT NULL,account_id TEXT NOT NULL,environment TEXT NOT NULL,
 external_code TEXT NOT NULL,client_code TEXT,event_time INTEGER NOT NULL,payload_hash TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 next_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,
 UNIQUE(source,account_id,environment,payload_hash));
CREATE INDEX IF NOT EXISTS shipping_inbox_due ON shipping_inbox(state,next_at,created_at);
CREATE TABLE IF NOT EXISTS shipping_conflicts(
 id TEXT PRIMARY KEY,leg_id TEXT NOT NULL,code TEXT NOT NULL,details TEXT NOT NULL,created_at INTEGER NOT NULL,
 UNIQUE(leg_id,code,details));
CREATE TABLE IF NOT EXISTS shipping_account_health(
 account_id TEXT PRIMARY KEY,failures INTEGER NOT NULL DEFAULT 0,open_until INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
`;
export const shippingCommandInput = z
  .object({
    idempotency_key: z.string().uuid(),
    leg_id: z.string().uuid(),
    kind: z.enum([
      'create',
      'cancel',
      'address',
      'cod',
      'return',
      'redelivery',
      'reconcile',
    ]),
    request_id: z.string().uuid().optional(),
  })
  .strict();
export type ShippingCommandInput = z.infer<typeof shippingCommandInput>;
export type Leg = {
  id: string;
  order_id: string;
  kind: string;
  carrier_id: string;
  account_id: string;
  environment: 'production' | 'staging';
  owner: 'pancake' | 'direct';
  service_id: string;
  client_code: string;
  tracking_code: string | null;
  status: string;
  observed_at: number;
  observation_json: string | null;
  last_error: string | null;
};
export type Command = {
  id: string;
  leg_id: string;
  request_id: string | null;
  kind: ShippingCommandInput['kind'];
  payload: string;
  state: string;
  attempted: number;
  lease_token: string;
  actor: string;
};
export const observationSchema = z
  .object({
    tracking_code: z.string().trim().min(1).max(100),
    client_code: z.string().min(1).max(100),
    shop_id: z.number().int().positive(),
    status: z.string().min(1).max(60),
    updated_at: z.number().int().positive(),
    cod_amount: z.number().int().nonnegative(),
    recipient: z
      .object({
        name: z.string(),
        phone: z.string(),
        address: z.string(),
        district_id: z.number().int(),
        ward_code: z.string(),
      })
      .optional(),
  })
  .strict();
export type CarrierObservation = z.infer<typeof observationSchema>;
const terminal = new Set([
  'delivered',
  'returned',
  'cancel',
  'exception',
  'lost',
  'damage',
  'scrap',
]);
const stages: Record<string, number> = {
  unbooked: 0,
  ready_to_pick: 1,
  picking: 1,
  money_collect_picking: 1,
  picked: 2,
  storing: 2,
  sorting: 2,
  transporting: 2,
  delivering: 3,
  money_collect_delivering: 3,
  delivery_fail: 3,
  waiting_to_return: 4,
  return: 4,
  return_transporting: 4,
  return_sorting: 4,
  returning: 4,
  return_fail: 4,
  delivered: 5,
  returned: 6,
  cancel: 6,
  exception: 6,
  lost: 6,
  damage: 6,
  scrap: 6,
};
function fail(code: string, message: string, status = 409): never {
  throw new ShippingError(code, status, message);
}
export function shippingLeg(sql: ShippingSql, id: string): Leg {
  const leg = sql.exec('SELECT * FROM shipping_legs WHERE id=?', id).toArray()[0];
  if (!leg) fail('shipping_leg_not_found', 'Không tìm thấy chặng giao hàng.', 404);
  return leg as unknown as Leg;
}
export function ensureOutboundLeg(sql: ShippingSql, id: string, now = Date.now()) {
  const existing = sql
    .exec("SELECT * FROM shipping_legs WHERE order_id=? AND kind='outbound'", id)
    .toArray()[0];
  if (existing) {
    if (existing.owner === 'pancake' && !existing.tracking_code) {
      const legacy = sql
        .exec('SELECT tracking_number FROM commerce_shipments WHERE order_id=?', id)
        .toArray()[0];
      if (legacy?.tracking_number)
        sql.exec(
          'UPDATE shipping_legs SET tracking_code=? WHERE id=?',
          String(legacy.tracking_number),
          existing.id,
        );
    }
    return shippingLeg(sql, String(existing.id));
  }
  const row = sql
    .exec('SELECT snapshot_json,reference FROM commerce_orders WHERE order_id=?', id)
    .toArray()[0];
  if (!row) fail('order_not_found', 'Không tìm thấy đơn.', 404);
  const snapshot = JSON.parse(String(row.snapshot_json)),
    offer = snapshot.shipping?.offer;
  if (
    !offer ||
    typeof offer.provider !== 'string' ||
    !/^[a-z0-9_-]{1,40}$/.test(offer.provider)
  )
    fail('shipping_adapter_missing', 'Chưa xác định được hãng vận chuyển của đơn.');
  const legacy = sql
    .exec('SELECT tracking_number FROM commerce_shipments WHERE order_id=?', id)
    .toArray()[0];
  const legId = crypto.randomUUID();
  sql.exec(
    'INSERT INTO shipping_legs(id,order_id,kind,carrier_id,account_id,environment,owner,service_id,client_code,tracking_code,created_at,binding_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    legId,
    id,
    'outbound',
    offer.provider,
    offer.account_id || 'legacy-ghn',
    offer.environment,
    offer.execution_owner || 'pancake',
    offer.service_id || String(offer.service_type_id),
    String(row.reference),
    legacy?.tracking_number ? String(legacy.tracking_number) : null,
    now,
    offer.account_binding ? JSON.stringify(offer.account_binding) : null,
  );
  return shippingLeg(sql, legId);
}
export function shippingOverview(sql: ShippingSql, id: string) {
  ensureOutboundLeg(sql, id);
  return {
    legs: sql
      .exec(
        'SELECT id,kind,sequence,request_id,client_code,carrier_id,account_id,environment,owner,service_id,tracking_code,status,observed_at,last_error FROM shipping_legs WHERE order_id=? ORDER BY created_at',
        id,
      )
      .toArray(),
    commands: sql
      .exec(
        'SELECT c.id,c.leg_id,c.kind,c.request_id,c.state,c.result,c.created_at,c.updated_at FROM shipping_commands c JOIN shipping_legs l ON l.id=c.leg_id WHERE l.order_id=? ORDER BY c.created_at DESC LIMIT 50',
        id,
      )
      .toArray(),
    conflicts: sql
      .exec(
        'SELECT c.* FROM shipping_conflicts c JOIN shipping_legs l ON l.id=c.leg_id WHERE l.order_id=? ORDER BY c.created_at DESC LIMIT 20',
        id,
      )
      .toArray(),
  };
}
function commandPayload(
  sql: ShippingSql,
  leg: Leg,
  input: ShippingCommandInput,
  now: number,
  existingId = '',
) {
  const order = sql
    .exec(
      'SELECT c.*,o.status FROM commerce_orders c JOIN orders o ON o.id=c.order_id WHERE c.order_id=?',
      leg.order_id,
    )
    .toArray()[0];
  const snapshot = JSON.parse(String(order.snapshot_json));
  if (input.kind === 'reconcile') return {};
  if (input.kind === 'create') {
    assertNoOpenChanges(sql, leg.order_id);
    if (
      leg.kind !== 'outbound' ||
      leg.tracking_code ||
      order.status === 'canceled' ||
      !order.pancake_order_id ||
      !snapshot.dispatch_enabled ||
      (order.method !== 'cod' && order.payment_status !== 'paid')
    )
      fail('shipping_not_ready', 'Đơn chưa đủ điều kiện tạo vận đơn.');
    if (
      sql
        .exec(
          "SELECT id FROM commerce_requests WHERE order_id=? AND status IN ('pending','approved')",
          leg.order_id,
        )
        .toArray().length
    )
      fail('request_pending', 'Đơn đang có yêu cầu thay đổi.');
    if (
      sql
        .exec(
          "SELECT id FROM shipping_commands WHERE leg_id=? AND kind='create' AND id!=?",
          leg.id,
          existingId,
        )
        .toArray().length
    )
      fail(
        'booking_already_requested',
        'Đã có yêu cầu tạo vận đơn; cần tra cứu kết quả cũ.',
      );
    return {
      recipient: snapshot.recipient,
      parcel: snapshot.parcel,
      items: snapshot.items,
      cod_amount: order.method === 'cod' ? snapshot.totals.total_vnd : 0,
      goods_value_vnd: snapshot.parcel.goods_value_vnd,
    };
  }
  if (['cancel', 'address', 'return'].includes(input.kind)) {
    const request = sql
      .exec(
        "SELECT * FROM commerce_requests WHERE id=? AND order_id=? AND status='approved'",
        input.request_id || '',
        leg.order_id,
      )
      .toArray()[0];
    if (!request || request.kind !== (input.kind === 'return' ? 'return' : input.kind))
      fail('approved_request_required', 'Cần yêu cầu tương ứng đã được duyệt.');
    if (input.kind === 'cancel' && !leg.tracking_code) {
      if (
        sql
          .exec(
            "SELECT id FROM shipping_commands WHERE leg_id=? AND kind='create' AND attempted=1",
            leg.id,
          )
          .toArray().length
      )
        fail('booking_unknown', 'Cần tra cứu booking đã gửi trước khi hủy.');
      return { unbooked: true };
    }
    if (!leg.tracking_code) fail('tracking_required', 'Cần xác nhận vận đơn trước.');
    if (input.kind === 'address') {
      const quoteId = JSON.parse(String(request.payload)).quote_id;
      const quote = sql
        .exec(
          'SELECT * FROM commerce_address_quotes WHERE id=? AND order_id=?',
          quoteId,
          leg.order_id,
        )
        .toArray()[0];
      if (!quote || Number(quote.expires_at) <= now)
        fail('quote_expired', 'Cần báo giá địa chỉ còn hạn.');
      const offer = JSON.parse(String(quote.offer));
      if (
        offer.provider !== leg.carrier_id ||
        (offer.account_id || 'legacy-ghn') !== leg.account_id ||
        (offer.execution_owner || 'pancake') !== leg.owner ||
        String(offer.service_id || offer.service_type_id) !== leg.service_id
      )
        fail(
          'carrier_change_requires_replacement',
          'Đổi hãng/dịch vụ cần hủy chặng cũ được xác nhận và chặng thay thế.',
        );
      // Existing ledger handles monetary adjustments. Do not move a parcel while
      // a customer supplement/refund or a COD adjustment is still outstanding.
      if (offer.environment !== leg.environment)
        fail('carrier_environment_mixed', 'Báo giá không khớp môi trường vận đơn.');
      const total =
        Number(snapshot.totals.total_vnd) -
        Number(snapshot.totals.shipping_vnd) +
        Number(offer.customer_fee_vnd);
      const financial = serviceDetail(sql, leg.order_id);
      if (
        sql
          .exec(
            "SELECT id FROM commerce_refund_ledger WHERE order_id=? AND status NOT IN ('succeeded','failed') LIMIT 1",
            leg.order_id,
          )
          .toArray().length ||
        (order.method === 'techcombank_qr' &&
          financial.money.received_vnd - financial.money.refunded_vnd !== total) ||
        (order.method === 'cod' && order.cod_status !== 'to_collect')
      )
        fail(
          'shipping_adjustment_required',
          'Cần thu/hoàn chênh lệch và đối soát xong trước khi sửa vận đơn.',
        );
      return {
        recipient: JSON.parse(String(quote.recipient)),
        cod_amount: order.method === 'cod' ? total : 0,
        total_vnd: total,
        shipping_vnd: Number(offer.customer_fee_vnd),
        quote_id: quoteId,
        quote_expires_at: Number(quote.expires_at),
      };
    }
    return {};
  }
  if (!leg.tracking_code) fail('tracking_required', 'Cần xác nhận vận đơn trước.');
  if (input.kind === 'cod') {
    if (order.method !== 'cod' || order.cod_status !== 'to_collect')
      fail('cod_not_mutable', 'Đơn không còn chờ thu COD.');
    return { cod_amount: snapshot.totals.total_vnd };
  }
  return {};
}
export function enqueueShippingCommand(
  sql: ShippingSql,
  input: ShippingCommandInput,
  actor: string,
  now = Date.now(),
) {
  input = shippingCommandInput.parse(input);
  const old = sql
    .exec(
      'SELECT * FROM shipping_commands WHERE idempotency_key=?',
      input.idempotency_key,
    )
    .toArray()[0];
  if (old) {
    if (
      old.leg_id !== input.leg_id ||
      old.kind !== input.kind ||
      old.request_id !== (input.request_id || null)
    )
      fail('idempotency_conflict', 'Khóa thao tác đã được dùng cho yêu cầu khác.');
    return old;
  }
  const leg = shippingLeg(sql, input.leg_id);
  const payload = commandPayload(sql, leg, input, now);
  if (input.kind === 'cancel' && (payload as { unbooked?: boolean }).unbooked)
    sql.exec(
      "UPDATE shipping_commands SET state='rejected',result='canceled_before_booking',updated_at=? WHERE leg_id=? AND kind='create' AND attempted=0 AND state IN ('pending','manual_review')",
      now,
      leg.id,
    );
  if (
    sql
      .exec(
        "SELECT id FROM shipping_commands WHERE leg_id=? AND kind!='reconcile' AND state IN ('pending','running','unknown','awaiting_auth')",
        leg.id,
      )
      .toArray().length &&
    input.kind !== 'reconcile'
  )
    fail('shipping_command_busy', 'Cần giải quyết thao tác đang mở trước.');
  const id = crypto.randomUUID();
  sql.exec(
    'INSERT INTO shipping_commands(id,leg_id,request_id,kind,payload,idempotency_key,actor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    id,
    leg.id,
    input.request_id || null,
    input.kind,
    JSON.stringify(payload),
    input.idempotency_key,
    actor,
    now,
    now,
  );
  return sql.exec('SELECT * FROM shipping_commands WHERE id=?', id).toArray()[0];
}
export function claimShippingCommand(
  sql: ShippingSql,
  id: string,
  token: string,
  now = Date.now(),
) {
  const c = sql.exec('SELECT * FROM shipping_commands WHERE id=?', id).toArray()[0];
  if (
    !c ||
    !['pending', 'unknown', 'running', 'awaiting_auth'].includes(String(c.state)) ||
    Number(c.lease_until) > now ||
    Number(c.next_at) > now
  )
    return null;
  const leg = shippingLeg(sql, String(c.leg_id));
  if (
    sql
      .exec('SELECT id FROM shipping_legs WHERE id=? AND lease_until>?', leg.id, now)
      .toArray().length
  )
    return null;
  if (
    sql
      .exec(
        'SELECT id FROM shipping_commands WHERE leg_id=? AND id!=? AND lease_until>?',
        leg.id,
        id,
        now,
      )
      .toArray().length
  )
    return null;
  sql.exec(
    "UPDATE shipping_commands SET state='running',lease_token=?,lease_until=?,updated_at=? WHERE id=?",
    token,
    now + 120000,
    now,
    id,
  );
  sql.exec(
    'UPDATE shipping_legs SET lease_token=?,lease_until=? WHERE id=?',
    token,
    now + 120000,
    leg.id,
  );
  return { command: { ...c, lease_token: token } as unknown as Command, leg };
}
export function markShippingAttempt(
  sql: ShippingSql,
  id: string,
  token: string,
  now = Date.now(),
) {
  const c = sql
    .exec(
      'SELECT * FROM shipping_commands WHERE id=? AND lease_token=? AND lease_until>?',
      id,
      token,
      now,
    )
    .toArray()[0];
  if (!c) fail('shipping_lease_lost', 'Phiên thực thi đã thay đổi.');
  if (Number(c.attempted))
    fail('shipping_already_attempted', 'Lệnh đã gửi; chỉ được tra cứu kết quả.');
  const leg = shippingLeg(sql, String(c.leg_id));
  const payload = commandPayload(
    sql,
    leg,
    {
      idempotency_key: String(c.idempotency_key),
      leg_id: leg.id,
      kind: String(c.kind) as ShippingCommandInput['kind'],
      request_id: c.request_id ? String(c.request_id) : undefined,
    },
    now,
    id,
  );
  if (JSON.stringify(payload) !== c.payload)
    fail('shipping_order_changed', 'Nội dung đơn đã thay đổi trước khi gửi lệnh.');
  sql.exec(
    'UPDATE shipping_commands SET attempted=1,payload=?,updated_at=?,lease_until=? WHERE id=?',
    JSON.stringify(payload),
    now,
    now + 120000,
    id,
  );
  sql.exec(
    'UPDATE shipping_legs SET lease_until=? WHERE id=? AND lease_token=?',
    now + 120000,
    leg.id,
    token,
  );
}
function conflict(
  sql: ShippingSql,
  leg: Leg,
  code: string,
  details: string,
  now: number,
) {
  sql.exec(
    'INSERT OR IGNORE INTO shipping_conflicts VALUES(?,?,?,?,?)',
    crypto.randomUUID(),
    leg.id,
    code,
    details,
    now,
  );
  sql.exec('UPDATE shipping_legs SET last_error=? WHERE id=?', code, leg.id);
}
export function observeShipping(
  sql: ShippingSql,
  id: string,
  observation: CarrierObservation,
  now = Date.now(),
  token?: string,
) {
  observation = observationSchema.parse(observation);
  const leg = shippingLeg(sql, id);
  if (
    sql
      .exec(
        'SELECT id FROM shipping_legs WHERE id=? AND lease_until>? AND lease_token!=?',
        id,
        now,
        token || '',
      )
      .toArray().length
  )
    fail('shipping_leg_busy', 'Chặng giao hàng đang được xử lý.');
  if (
    observation.client_code !== leg.client_code ||
    (leg.tracking_code && observation.tracking_code !== leg.tracking_code)
  )
    fail('shipping_identity_mismatch', 'Tham chiếu vận đơn không khớp.');
  if (!(observation.status in stages)) {
    conflict(sql, leg, 'carrier_status_unknown', observation.status, now);
    return { accepted: false };
  }
  if (observation.updated_at < leg.observed_at) return { accepted: false };
  if (terminal.has(leg.status) && leg.status !== observation.status) {
    conflict(sql, leg, 'terminal_conflict', observation.status, now);
    return { accepted: false };
  }
  const redelivery =
    ['delivery_fail', 'waiting_to_return'].includes(leg.status) &&
    ['storing', 'transporting', 'delivering'].includes(observation.status) &&
    observation.updated_at > leg.observed_at;
  if ((stages[observation.status] ?? 0) < (stages[leg.status] ?? 0) && !redelivery) {
    conflict(sql, leg, 'status_regression', observation.status, now);
    return { accepted: false };
  }
  sql.exec(
    'UPDATE shipping_legs SET tracking_code=?,status=?,observed_at=?,observation_json=?,last_error=NULL WHERE id=?',
    observation.tracking_code,
    observation.status,
    observation.updated_at,
    JSON.stringify(observation),
    id,
  );
  if (leg.kind === 'outbound') {
    const canonical =
      observation.status === 'cancel'
        ? 'canceled'
        : ['exception', 'lost', 'damage', 'scrap', 'delivery_fail'].includes(
              observation.status,
            )
          ? 'undeliverable'
          : observation.status === 'picked'
            ? 'picked_up'
            : stages[observation.status] === 2
              ? 'on_the_way'
              : stages[observation.status] === 3
                ? 'out_for_delivery'
                : stages[observation.status] === 4
                  ? 'returning'
                  : observation.status;
    observeOrderProgress(
      sql,
      leg.order_id,
      { carrier_status: canonical, tracking_number: observation.tracking_code },
      now,
    );
    const state =
      observation.status === 'delivered'
        ? 'delivered'
        : observation.status === 'returned'
          ? 'returned'
          : stages[observation.status] >= 2 && stages[observation.status] < 5
            ? 'shipped'
            : 'ready_to_ship';
    if (
      !['cancel', 'exception', 'lost', 'damage', 'scrap'].includes(observation.status)
    ) {
      const current = sql
        .exec(
          'SELECT fulfillment_status FROM commerce_orders WHERE order_id=?',
          leg.order_id,
        )
        .toArray()[0];
      const rank: Record<string, number> = {
        unfulfilled: 0,
        ready_to_ship: 1,
        shipped: 2,
        delivered: 3,
        returned: 4,
      };
      if (rank[state] > (rank[String(current.fulfillment_status)] ?? 0))
        sql.exec(
          'UPDATE commerce_orders SET fulfillment_status=?,updated_at=? WHERE order_id=?',
          state,
          new Date(now).toISOString(),
          leg.order_id,
        );
    }
  }
  // Never mutate payment, COD remittance, refunds, or sellable stock here.
  return { accepted: true };
}
export function finishShippingCommand(
  sql: ShippingSql,
  id: string,
  token: string,
  state: 'verified' | 'rejected' | 'unknown' | 'manual_review' | 'awaiting_auth',
  result: string,
  now = Date.now(),
) {
  const c = sql
    .exec(
      'SELECT * FROM shipping_commands WHERE id=? AND lease_token=? AND lease_until>?',
      id,
      token,
      now,
    )
    .toArray()[0];
  if (!c) fail('shipping_lease_lost', 'Phiên thực thi đã thay đổi.');
  sql.exec(
    'UPDATE shipping_commands SET state=?,result=?,lease_token=NULL,lease_until=0,next_at=?,updated_at=? WHERE id=?',
    state,
    result.slice(0, 300),
    now + 60000,
    now,
    id,
  );
  sql.exec(
    'UPDATE shipping_legs SET lease_token=NULL,lease_until=0,last_error=? WHERE id=? AND lease_token=?',
    state === 'verified' ? null : result.slice(0, 300),
    c.leg_id,
    token,
  );
  return { state };
}
export function shippingDue(sql: ShippingSql, now = Date.now()) {
  return sql
    .exec(
      "SELECT id FROM shipping_commands WHERE state IN ('pending','running','unknown','awaiting_auth') AND lease_until<=? AND next_at<=? ORDER BY next_at,created_at LIMIT 10",
      now,
      now,
    )
    .toArray()
    .map((r) => String(r.id));
}
export function receiveShippingEvent(
  sql: ShippingSql,
  input: {
    source: string;
    account_id: string;
    environment: string;
    external_code: string;
    client_code?: string;
    event_time: number;
    payload_hash: string;
  },
  now = Date.now(),
) {
  const { source, account_id, environment, external_code, event_time, payload_hash } =
    input;
  const existing = sql
    .exec(
      'SELECT id FROM shipping_inbox WHERE source=? AND account_id=? AND environment=? AND payload_hash=?',
      source,
      account_id,
      environment,
      payload_hash,
    )
    .toArray()[0];
  if (existing) return { id: String(existing.id), duplicate: true };
  const id = crypto.randomUUID();
  sql.exec(
    'INSERT INTO shipping_inbox(id,source,account_id,environment,external_code,client_code,event_time,payload_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    id,
    source,
    account_id,
    environment,
    external_code,
    input.client_code || null,
    event_time,
    payload_hash,
    now,
    now,
  );
  return { id, duplicate: false };
}
export function shippingEventsDue(sql: ShippingSql) {
  return sql
    .exec(
      "SELECT * FROM shipping_inbox WHERE state IN ('pending','retry','processing') AND next_at<=? ORDER BY next_at,created_at LIMIT 10",
      Date.now(),
    )
    .toArray();
}
export function linkShippingEvent(sql: ShippingSql, id: string) {
  const now = Date.now();
  const event = sql
    .exec(
      "UPDATE shipping_inbox SET state='processing',next_at=?,attempts=attempts+1 WHERE id=? AND state IN ('pending','retry','processing') AND next_at<=? RETURNING *",
      now + 120000,
      id,
      now,
    )
    .toArray()[0];
  if (!event) return null;
  const leg =
    event.source === 'pancake'
      ? sql
          .exec(
            "SELECT l.* FROM shipping_legs l JOIN commerce_orders c ON c.order_id=l.order_id WHERE c.pancake_order_id=? AND json_extract(c.snapshot_json,'$.shop_id')=? AND l.environment=? AND l.kind='outbound'",
            event.external_code,
            event.account_id,
            event.environment,
          )
          .toArray()[0]
      : sql
          .exec(
            'SELECT * FROM shipping_legs WHERE carrier_id=? AND account_id=? AND environment=? AND (tracking_code=? OR client_code=? OR client_code=?)',
            event.source,
            event.account_id,
            event.environment,
            event.external_code,
            event.external_code,
            event.client_code || '',
          )
          .toArray()[0];
  if (!leg) {
    sql.exec(
      "UPDATE shipping_inbox SET state='unmatched',updated_at=? WHERE id=?",
      Date.now(),
      id,
    );
    return null;
  }
  return leg as unknown as Leg;
}
export function finishShippingEvent(sql: ShippingSql, id: string, success: boolean) {
  sql.exec(
    'UPDATE shipping_inbox SET state=?,updated_at=?,next_at=?+MIN(300000,30000*MAX(1,attempts)) WHERE id=?',
    success ? 'processed' : 'retry',
    Date.now(),
    Date.now(),
    id,
  );
}

export function claimShippingPoll(
  sql: ShippingSql,
  id: string,
  token: string,
  now = Date.now(),
) {
  const updated = sql
    .exec(
      'UPDATE shipping_legs SET lease_token=?,lease_until=? WHERE id=? AND lease_until<=? RETURNING id',
      token,
      now + 120000,
      id,
      now,
    )
    .toArray();
  return updated.length ? shippingLeg(sql, id) : null;
}
export function finishShippingPoll(
  sql: ShippingSql,
  id: string,
  token: string,
  error: string | null,
  now = Date.now(),
) {
  sql.exec(
    'UPDATE shipping_legs SET lease_token=NULL,lease_until=0,next_poll_at=?,last_error=? WHERE id=? AND lease_token=?',
    now + 60000,
    error,
    id,
    token,
  );
}
export function shippingCircuitStatus(sql: ShippingSql) {
  return sql
    .exec('SELECT account_id,failures,open_until FROM shipping_account_health')
    .toArray();
}
export function reportShippingQuotes(
  sql: ShippingSql,
  outcomes: { account_id: string; failed: boolean }[],
  now = Date.now(),
) {
  for (const outcome of outcomes) {
    const old = sql
      .exec(
        'SELECT failures FROM shipping_account_health WHERE account_id=?',
        outcome.account_id,
      )
      .toArray()[0];
    const failures = outcome.failed ? Math.min(20, Number(old?.failures || 0) + 1) : 0;
    const openUntil =
      failures >= 3 ? now + Math.min(300000, 60000 * 2 ** (failures - 3)) : 0;
    sql.exec(
      'INSERT INTO shipping_account_health(account_id,failures,open_until,updated_at) VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET failures=excluded.failures,open_until=excluded.open_until,updated_at=excluded.updated_at',
      outcome.account_id,
      failures,
      openUntil,
      now,
    );
  }
}
export function shippingQueue(sql: ShippingSql) {
  return {
    items: sql
      .exec(
        "SELECT DISTINCT l.order_id,o.number,c.kind,c.state,c.result FROM shipping_commands c JOIN shipping_legs l ON l.id=c.leg_id JOIN orders o ON o.id=l.order_id WHERE c.state IN ('unknown','manual_review','awaiting_auth','rejected') ORDER BY c.updated_at DESC LIMIT 100",
      )
      .toArray(),
    legs: sql
      .exec(
        "SELECT l.order_id,o.number,l.kind,l.last_error FROM shipping_legs l JOIN orders o ON o.id=l.order_id WHERE l.last_error IS NOT NULL OR l.status IN ('lost','damage','exception','scrap') ORDER BY l.created_at DESC LIMIT 100",
      )
      .toArray(),
    unmatched: Number(
      sql
        .exec("SELECT COUNT(*) n FROM shipping_inbox WHERE state='unmatched'")
        .toArray()[0].n,
    ),
    circuits: shippingCircuitStatus(sql),
  };
}
export function retryShippingCommand(
  sql: ShippingSql,
  id: string,
  actor: string,
  now = Date.now(),
) {
  const c = sql.exec('SELECT * FROM shipping_commands WHERE id=?', id).toArray()[0];
  if (!c) fail('shipping_command_not_found', 'Không tìm thấy lệnh.', 404);
  if (Number(c.lease_until) > now)
    fail('shipping_command_busy', 'Lệnh đang được thực thi.');
  if (c.state === 'verified') return { id, state: 'verified' };
  // Preserve attempted and the frozen payload. Retrying an unknown external
  // result means read/reconcile, never another mutation.
  sql.exec(
    "UPDATE shipping_commands SET state='pending',next_at=0,updated_at=? WHERE id=?",
    now,
    id,
  );
  const leg = shippingLeg(sql, String(c.leg_id));
  sql.exec(
    'INSERT INTO commerce_audit VALUES(?,?,?,?,?,?)',
    crypto.randomUUID(),
    leg.order_id,
    'shipping.command.reconcile_requested',
    actor,
    JSON.stringify({ command_id: id, attempted: !!c.attempted }),
    new Date(now).toISOString(),
  );
  return { id, state: 'pending' };
}

export function completeShippingService(sql: ShippingSql, commandId: string) {
  const command = sql
    .exec(
      "SELECT * FROM shipping_commands WHERE id=? AND state='verified' AND result='carrier_and_pos_verified'",
      commandId,
    )
    .toArray()[0];
  if (
    !command ||
    !command.request_id ||
    !['cancel', 'address'].includes(String(command.kind))
  )
    return null;
  const leg = shippingLeg(sql, String(command.leg_id));
  const request = sql
    .exec(
      'SELECT status FROM commerce_requests WHERE id=? AND order_id=?',
      command.request_id,
      leg.order_id,
    )
    .toArray()[0];
  if (request?.status === 'completed') return { completed: true };
  if (request?.status !== 'approved')
    fail('request_changed', 'Yêu cầu đã thay đổi; cần kiểm tra thủ công.');
  return decideServiceRequest(
    sql,
    leg.order_id,
    {
      request_id: String(command.request_id),
      order_version: orderVersion(sql, leg.order_id),
      action: 'complete',
      evidence: 'Đã xác minh trạng thái hãng và đọc lại đơn POS. Lệnh ' + commandId,
      external_cleared: true,
      pricing: 'quoted',
    },
    'shipping-automation',
  );
}
export function queueApprovedShipping(sql: ShippingSql, id: string) {
  const leg = ensureOutboundLeg(sql, id);
  if (leg.owner !== 'direct') return null;
  const request = sql
    .exec(
      "SELECT id,kind FROM commerce_requests WHERE order_id=? AND status='approved' AND kind IN ('cancel','address') ORDER BY created_at LIMIT 1",
      id,
    )
    .toArray()[0];
  if (
    !request ||
    sql.exec('SELECT id FROM shipping_commands WHERE request_id=?', request.id).toArray()
      .length
  )
    return null;
  try {
    return enqueueShippingCommand(
      sql,
      {
        leg_id: leg.id,
        kind: request.kind as 'cancel' | 'address',
        request_id: String(request.id),
        idempotency_key: crypto.randomUUID(),
      },
      'shipping-automation',
    );
  } catch (e) {
    if (!(e instanceof ShippingError)) throw e;
    conflict(sql, leg, e.code, 'approved-request:' + String(request.id), Date.now());
    return { state: 'manual_review', reason: e.code };
  }
}
export function observePosShipping(
  sql: ShippingSql,
  id: string,
  pos: {
    status: number;
    tracking: string | null;
    recipient?: { name: string; phone: string; address: string };
  },
  now = Date.now(),
) {
  const leg = shippingLeg(sql, id);
  const row = sql
    .exec('SELECT snapshot_json FROM commerce_orders WHERE order_id=?', leg.order_id)
    .toArray()[0];
  const snapshot = JSON.parse(String(row.snapshot_json));
  if (pos.tracking && leg.tracking_code && pos.tracking !== leg.tracking_code) {
    conflict(sql, leg, 'pos_tracking_conflict', 'POS tracking changed', now);
    return null;
  }
  if (leg.owner !== 'direct') return null;
  if ([6, 7].includes(pos.status)) {
    if (
      sql
        .exec("SELECT id FROM orders WHERE id=? AND status='canceled'", leg.order_id)
        .toArray().length
    )
      return null;
    const existing = sql
      .exec(
        "SELECT id,kind,status FROM commerce_requests WHERE order_id=? AND status IN ('pending','approved') AND kind IN ('cancel','address') ORDER BY created_at LIMIT 1",
        leg.order_id,
      )
      .toArray()[0];
    if (existing && existing.kind !== 'cancel') {
      conflict(sql, leg, 'pos_cancel_request_conflict', 'Another change is pending', now);
      return null;
    }
    let requestId = existing ? String(existing.id) : null;
    if (!requestId) {
      const detail = createServiceRequest(
        sql,
        leg.order_id,
        {
          idempotency_key: crypto.randomUUID(),
          order_version: orderVersion(sql, leg.order_id),
          kind: 'cancel',
          reason: 'Yêu cầu hủy từ POS đã được đọc lại qua API của đúng shop.',
        },
        'pancake-integration',
        now,
      );
      requestId = detail.requests.find(
        (r) => r.status === 'pending' && r.kind === 'cancel',
      )!.id;
    }
    if (!existing || existing.status === 'pending')
      decideServiceRequest(
        sql,
        leg.order_id,
        {
          request_id: requestId,
          order_version: orderVersion(sql, leg.order_id),
          action: 'approve',
          evidence: 'Đã đọc lại trạng thái hủy POS qua API có xác thực.',
          external_cleared: false,
          pricing: 'quoted',
        },
        'pancake-integration',
        now,
      );
    return queueApprovedShipping(sql, leg.order_id);
  }
  if (pos.recipient) {
    const expected = snapshot.recipient,
      actual = pos.recipient;
    const normalize = (v: string) => v.replace(/^\+84/, '0').replace(/\s/g, '');
    if (
      actual.name !== expected.name ||
      normalize(actual.phone) !== normalize(expected.phone) ||
      actual.address !== expected.address
    )
      conflict(
        sql,
        leg,
        'pos_address_change_requires_quote',
        'Địa chỉ POS đổi; cần báo giá và xác nhận trước khi gửi sang hãng.',
        now,
      );
  }
  return null;
}
export const prepareExternalLegInput = z
  .object({
    idempotency_key: z.string().uuid(),
    order_id: z.string().uuid(),
    request_id: z.string().uuid(),
    kind: z.enum(['reverse', 'replacement']),
    account_id: z.string().min(1).max(40),
    service_id: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/),
  })
  .strict();
export function prepareExternalLeg(
  sql: ShippingSql,
  input: z.infer<typeof prepareExternalLegInput>,
  account: {
    carrier_id: string;
    environment: string;
    execution_owner: string;
    shop_id: number;
    warehouse_id: string;
    from_district_id: number;
    from_ward_code: string;
  },
  actor: string,
  now = Date.now(),
) {
  input = prepareExternalLegInput.parse(input);
  const old = sql
    .exec('SELECT * FROM shipping_legs WHERE id=?', input.idempotency_key)
    .toArray()[0];
  if (old) {
    if (
      old.order_id !== input.order_id ||
      old.request_id !== input.request_id ||
      old.kind !== input.kind ||
      old.account_id !== input.account_id ||
      old.service_id !== input.service_id
    )
      fail('idempotency_conflict', 'Khóa tạo chặng đã dùng cho nội dung khác.');
    return old;
  }
  const request = sql
    .exec(
      "SELECT id FROM commerce_requests WHERE id=? AND order_id=? AND kind='return' AND status='approved'",
      input.request_id,
      input.order_id,
    )
    .toArray()[0];
  if (!request) fail('approved_return_required', 'Cần yêu cầu đổi trả đã được duyệt.');
  const outbound = ensureOutboundLeg(sql, input.order_id);
  if (outbound.environment !== account.environment)
    fail('carrier_environment_mixed', 'Không trộn môi trường giữa các chặng.');
  const sequence = Number(
    sql
      .exec(
        'SELECT COALESCE(MAX(sequence),0)+1 n FROM shipping_legs WHERE order_id=? AND kind=?',
        input.order_id,
        input.kind,
      )
      .toArray()[0].n,
  );
  const clientCode =
    outbound.client_code + '-' + (input.kind === 'reverse' ? 'R' : 'X') + sequence;
  sql.exec(
    'INSERT INTO shipping_legs(id,order_id,kind,sequence,request_id,parent_leg_id,carrier_id,account_id,environment,owner,service_id,client_code,last_error,created_at,binding_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    input.idempotency_key,
    input.order_id,
    input.kind,
    sequence,
    input.request_id,
    outbound.id,
    account.carrier_id,
    input.account_id,
    account.environment,
    account.execution_owner,
    input.service_id,
    clientCode,
    'external_booking_required',
    now,
    JSON.stringify({
      shop_id: account.shop_id,
      warehouse_id: account.warehouse_id,
      from_district_id: account.from_district_id,
      from_ward_code: account.from_ward_code,
    }),
  );
  sql.exec(
    'INSERT INTO commerce_audit VALUES(?,?,?,?,?,?)',
    crypto.randomUUID(),
    input.order_id,
    'shipping.leg.prepared',
    actor,
    JSON.stringify({
      leg_id: input.idempotency_key,
      request_id: input.request_id,
      kind: input.kind,
      client_code: clientCode,
    }),
    new Date(now).toISOString(),
  );
  return shippingLeg(sql, input.idempotency_key);
}
