import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  policySchema,
  calculateShipping,
  ShippingError,
  type ShippingOffer,
  type ShippingCart,
} from '../src/lib/smart-shipping';
import {
  carrierAccounts,
  carrierConfiguration,
  shippingQuoteSetup,
  type CarrierAccount,
} from '../src/lib/shipping-registry';
import * as flow from '../src/lib/shipping-workflow';
import { COMMERCE_SCHEMA, receipt } from '../src/lib/commerce-core';
import {
  SERVICE_SCHEMA,
  serviceDetail,
  createServiceRequest,
  decideServiceRequest,
  orderVersion,
  storeAddressQuote,
} from '../src/lib/commerce-service';
import { shippingResult, type ShippingSql } from '../src/lib/shipping-store';
import { runShippingCommand } from '../src/lib/shipping-runner';
import {
  ghnCommandRequest,
  ghnExecutionAdapter,
  type ExecutionAdapter,
} from '../src/lib/shipping-ghn';
import type { DOStub, Env } from '../src/types';
import { OpenAPIHono } from '@hono/zod-openapi';
import { carrierEvents } from '../src/routes/shipping-operations';
import { ApiError, type HonoEnv } from '../src/types';

const now = Date.now();
const policy = policySchema.parse({
  version: 'test',
  max_delivery_hours: 24,
  subsidy_vnd: 0,
  parcel: { length_cm: 20, width_cm: 20, height_cm: 20, max_weight_g: 20000 },
});
const account: CarrierAccount = {
  id: 'shop-a',
  carrier_id: 'ghn',
  execution_owner: 'direct',
  enabled: true,
  verified: true,
  warehouse_id: 'w',
  environment: 'staging',
  shop_id: 123,
  from_district_id: 1,
  from_ward_code: '001',
  capabilities: [
    'quote',
    'create',
    'read',
    'cancel',
    'address',
    'cod',
    'return',
    'redelivery',
  ],
  cod: true,
  max_weight_g: 20000,
  pancake_partner_id: 5,
};
const env = {
  CARRIER_REGISTRY_JSON: JSON.stringify([account]),
  CARRIER_SECRETS_JSON: JSON.stringify({
    'shop-a': {
      token: 'test-secret-only',
      webhook_secret: 'test-webhook-secret-32-characters',
    },
  }),
  PANCAKE_WAREHOUSE_ID: 'w',
  SMART_SHIPPING_ENABLED: 'true',
  SMART_SHIPPING_POLICY: JSON.stringify(policy),
  SHIPPING_AUTOMATION_ENABLED: 'true',
  PANCAKE_TRACKING_MIRROR_VERIFIED: 'true',
} as Env;
const cart: ShippingCart = {
  id: crypto.randomUUID(),
  status: 'open',
  currency: 'VND',
  region_id: null,
  expires_at: new Date(now + 86400000).toISOString(),
  discount_code: null,
  discount_amount_cents: 0,
  address: [],
  items: [
    {
      sku: 'A',
      qty: 1,
      unit_price_cents: 200000,
      currency: 'VND',
      weight_g: 500,
      requires_shipping: 1,
      variant_status: 'active',
      product_status: 'active',
      current_price: 200000,
      available: 2,
    },
  ],
};
function offer(id: string, fee = 20000, hours = 12): ShippingOffer {
  return {
    id,
    provider: id,
    service_type_id: 2,
    service_name: id,
    currency: 'VND',
    carrier_fee_vnd: fee,
    subsidy_vnd: 0,
    customer_fee_vnd: fee,
    cod_value_vnd: 0,
    estimated_delivery_at: new Date(now + hours * 3600000).toISOString(),
    fee_breakdown: { total: fee },
    source: 'carrier_api',
    environment: 'staging',
  };
}
const request = {
  cart_id: cart.id,
  destination: { district_id: 3, ward_code: '004' },
  payment_method: 'prepaid' as const,
};
afterEach(() => mock.restoreAll());

test('G1 registry scopes verified accounts to warehouse, keeps credentials out of identity, and resolves disabled historical accounts', () => {
  const setup = shippingQuoteSetup(env);
  assert.equal(setup.providers.length, 1);
  assert.ok(!JSON.stringify(setup.config).includes('test-secret-only'));
  assert.equal(carrierConfiguration(env, account).shop_id, 123);
  assert.throws(
    () => shippingQuoteSetup({ ...env, PANCAKE_WAREHOUSE_ID: 'other' }),
    ShippingError,
  );
  assert.throws(
    () =>
      carrierAccounts({
        ...env,
        CARRIER_REGISTRY_JSON: JSON.stringify([account, account]),
      }),
    ShippingError,
  );
  assert.throws(
    () => carrierConfiguration({ ...env, CARRIER_SECRETS_JSON: '{}' }, account),
    ShippingError,
  );
  assert.equal(
    carrierAccounts({
      ...env,
      CARRIER_REGISTRY_JSON: JSON.stringify([{ ...account, enabled: false }]),
    })[0].enabled,
    false,
  );
});
test('G1 one to three providers remain deterministic; a hung adapter and malformed fees cannot erase valid quotes', async () => {
  for (const count of [1, 2, 3]) {
    const result = await calculateShipping(
      cart,
      request,
      { policy, environment: 'staging' },
      Array.from({ length: count }, (_, i) => ({
        code: String(i),
        quote: async () => ({
          offers: [offer(String(i), 30000 - i * 5000)],
          warnings: [],
        }),
      })),
      now,
    );
    assert.equal(result.quote?.recommended_id, String(count - 1));
  }
  const result = await calculateShipping(
    cart,
    request,
    { policy, environment: 'staging' },
    [
      { code: 'hung', timeout_ms: 100, quote: () => new Promise(() => {}) },
      {
        code: 'bad',
        quote: async () => ({
          offers: [{ ...offer('bad'), customer_fee_vnd: 1 }],
          warnings: [],
        }),
      },
      { code: 'ok', quote: async () => ({ offers: [offer('ok')], warnings: [] }) },
    ],
    now,
  );
  assert.equal(result.quote?.offers.length, 1);
  assert.equal(result.warnings[0].code, 'carrier_timeout');
});
test('G1 fastest and balanced policy choose using actual fee and ETA, and separate service account identities', async () => {
  const providers = [
    {
      code: 'test',
      quote: async () => ({
        offers: [
          offer('cheap', 10000, 20),
          offer('fast', 40000, 2),
          offer('middle', 15000, 4),
        ],
        warnings: [],
      }),
    },
  ];
  const fast = await calculateShipping(
    cart,
    request,
    { policy: { ...policy, optimization: 'fastest' }, environment: 'staging' },
    providers,
    now,
  );
  assert.equal(fast.quote?.recommended_id, 'fast');
  const balanced = await calculateShipping(
    cart,
    request,
    { policy: { ...policy, optimization: 'balanced' }, environment: 'staging' },
    providers,
    now,
  );
  assert.equal(balanced.quote?.recommended_id, 'middle');
  mock.method(globalThis, 'fetch', async (url: unknown) =>
    Response.json({
      code: 200,
      data: String(url).includes('available-services')
        ? [{ service_id: 1, service_type_id: 2, short_name: 'GHN' }]
        : String(url).includes('leadtime')
          ? { leadtime: Math.floor((now + 3600000) / 1000) }
          : { total: 20000 },
    }),
  );
  const setup = shippingQuoteSetup(env),
    result = await calculateShipping(cart, request, setup.config, setup.providers, now);
  assert.equal(result.quote?.offers[0].id, 'ghn:shop-a:2');
  assert.equal(result.quote?.offers[0].execution_owner, 'direct');
});

function fixture(owner: 'direct' | 'pancake' = 'direct') {
  const db = new DatabaseSync(':memory:');
  db.exec(
    readFileSync(new URL('../src/do.ts', import.meta.url), 'utf8').match(
      /const SCHEMA = `([\s\S]*?)`;/,
    )![1],
  );
  db.exec(COMMERCE_SCHEMA);
  db.exec(SERVICE_SCHEMA);
  db.exec(flow.SHIPPING_WORKFLOW_SCHEMA);
  const sql: ShippingSql = {
    exec: (q, ...args) => {
      const rows = db.prepare(q).all(...args) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
  const id = crypto.randomUUID(),
    reference = 'HF' + id.replaceAll('-', '');
  const recipient = {
    name: 'Test User',
    phone: '0901234567',
    address: '12 Test Street',
    city: 'HCM',
    district_id: 3,
    ward_code: '004',
  };
  const snapshot = {
    shop_id: 'shop',
    warehouse_id: 'w',
    automation_version: 2,
    dispatch_enabled: true,
    recipient,
    shipping: {
      offer: {
        ...offer('ghn:shop-a:2'),
        provider: 'ghn',
        account_id: 'shop-a',
        execution_owner: owner,
        service_id: '2',
        account_binding: {
          shop_id: 123,
          warehouse_id: 'w',
          from_district_id: 1,
          from_ward_code: '001',
        },
      },
    },
    parcel: { ...policy.parcel, weight_g: 500, goods_value_vnd: 200000 },
    items: [
      {
        sku: 'A',
        title: 'Apple',
        qty: 1,
        unit_price_vnd: 200000,
        weight_g: 500,
        pos_variant_id: 'pos-v',
        pos_product_id: 'pos-p',
      },
    ],
    totals: { subtotal_vnd: 200000, shipping_vnd: 20000, total_vnd: 220000 },
  };
  db.prepare(
    "INSERT INTO orders(id,number,status,customer_email,subtotal_cents,tax_cents,total_cents,currency) VALUES(?,?,'pending','test@example.invalid',200000,0,220000,'VND')",
  ).run(id, reference);
  db.prepare(
    "INSERT INTO commerce_orders(order_id,cart_id,idempotency_key,request_json,snapshot_json,method,payment_status,cod_status,reference,expires_at,pancake_order_id,reservation_state,updated_at) VALUES(?,?,?,?,?,'cod','unpaid','to_collect',?,?,?,'consumed',?)",
  ).run(
    id,
    crypto.randomUUID(),
    crypto.randomUUID(),
    '{}',
    JSON.stringify(snapshot),
    reference,
    now + 86400000,
    reference,
    new Date(now).toISOString(),
  );
  const transaction = <T,>(fn: () => T) => {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  const leg = transaction(() => flow.ensureOutboundLeg(sql, id));
  const stub = {
    shippingClaim: async (
      ...a: Parameters<typeof flow.claimShippingCommand> extends [unknown, ...infer A]
        ? A
        : never
    ) => shippingResult(() => transaction(() => flow.claimShippingCommand(sql, ...a))),
    shippingMark: async (cid: string, token: string) =>
      shippingResult(() => transaction(() => flow.markShippingAttempt(sql, cid, token))),
    shippingObserve: async (lid: string, o: flow.CarrierObservation, token?: string) =>
      shippingResult(() =>
        transaction(() => flow.observeShipping(sql, lid, o, Date.now(), token)),
      ),
    shippingFinish: async (
      cid: string,
      token: string,
      state: Parameters<typeof flow.finishShippingCommand>[3],
      result: string,
    ) =>
      shippingResult(() =>
        transaction(() => flow.finishShippingCommand(sql, cid, token, state, result)),
      ),
    commerceServiceSnapshot: async () =>
      shippingResult(() => ({
        snapshot,
        version: orderVersion(sql, id),
        method: 'cod',
        pos_id: reference,
      })),
    commerceReceipt: async () => shippingResult(() => receipt(sql, id)),
    shippingServiceComplete: async (cid: string) =>
      shippingResult(() => transaction(() => flow.completeShippingService(sql, cid))),
  } as unknown as DOStub;
  const enqueue = (kind: flow.ShippingCommandInput['kind'], requestId?: string) =>
    transaction(() =>
      flow.enqueueShippingCommand(
        sql,
        {
          leg_id: leg.id,
          kind,
          request_id: requestId,
          idempotency_key: crypto.randomUUID(),
        },
        'ops',
      ),
    );
  const observation = (
    status = 'ready_to_pick',
    time = now,
  ): flow.CarrierObservation => ({
    tracking_code: 'CODE',
    client_code: reference,
    shop_id: 123,
    status,
    updated_at: time,
    cod_amount: 220000,
    recipient,
  });
  return {
    db,
    sql,
    id,
    reference,
    snapshot,
    leg,
    stub,
    enqueue,
    observation,
    transaction,
  };
}
test('G2 lease and durable attempt survive process death; unknown booking never calls create twice', async () => {
  const f = fixture(),
    c = f.enqueue('create');
  let sends = 0,
    lookupFails = true;
  const adapter: ExecutionAdapter = {
    prepare: async () => ({ path: 'create', body: {} }),
    send: async () => {
      sends++;
      throw Error('timeout');
    },
    read: async () => {
      if (lookupFails) throw Error('read timeout');
      return f.observation();
    },
  };
  const hooks = {
    adapter: () => adapter,
    mirror: async () => {},
    preflight: async () => {},
  };
  await runShippingCommand(env, f.stub, String(c.id), hooks);
  assert.equal(sends, 1);
  assert.equal(
    f.db.prepare('SELECT state FROM shipping_commands').get()?.state,
    'unknown',
  );
  f.db.exec('UPDATE shipping_commands SET next_at=0');
  await runShippingCommand(env, f.stub, String(c.id), hooks);
  assert.equal(sends, 1);
  f.db.exec('UPDATE shipping_commands SET next_at=0');
  lookupFails = false;
  await runShippingCommand(env, f.stub, String(c.id), hooks);
  assert.equal(sends, 1);
  assert.equal(
    f.db.prepare('SELECT state FROM shipping_commands').get()?.state,
    'verified',
  );
  assert.throws(() => f.enqueue('create'), ShippingError);
  f.db.close();
});
test('G2 command identity, owner, account binding, lease exclusion and pre-I/O revalidation are enforced', async () => {
  const f = fixture(),
    input = {
      leg_id: f.leg.id,
      kind: 'create' as const,
      idempotency_key: crypto.randomUUID(),
    };
  const c = f.transaction(() => flow.enqueueShippingCommand(f.sql, input, 'ops'));
  assert.equal(flow.enqueueShippingCommand(f.sql, input, 'ops').id, c.id);
  assert.throws(
    () => flow.enqueueShippingCommand(f.sql, { ...input, kind: 'reconcile' }, 'ops'),
    ShippingError,
  );
  assert.ok(flow.claimShippingCommand(f.sql, String(c.id), 'first'));
  assert.equal(flow.claimShippingCommand(f.sql, String(c.id), 'other'), null);
  assert.throws(
    () => flow.markShippingAttempt(f.sql, String(c.id), 'other'),
    ShippingError,
  );
  f.db.exec("UPDATE orders SET status='canceled'");
  assert.throws(
    () => flow.markShippingAttempt(f.sql, String(c.id), 'first'),
    ShippingError,
  );
  assert.equal(
    f.db.prepare('SELECT attempted FROM shipping_commands').get()?.attempted,
    0,
  );
  f.db.close();
});
test('G3 stale, regressing, foreign, terminal-conflicting events do not corrupt progress or money', () => {
  const f = fixture();
  flow.observeShipping(f.sql, f.leg.id, f.observation('transporting', now));
  assert.equal(
    flow.observeShipping(f.sql, f.leg.id, f.observation('ready_to_pick', now - 1))
      .accepted,
    false,
  );
  assert.equal(
    flow.observeShipping(f.sql, f.leg.id, f.observation('ready_to_pick', now + 1))
      .accepted,
    false,
  );
  assert.throws(
    () =>
      flow.observeShipping(f.sql, f.leg.id, {
        ...f.observation(),
        client_code: 'FOREIGN',
      }),
    ShippingError,
  );
  flow.observeShipping(f.sql, f.leg.id, f.observation('delivered', now + 2));
  assert.equal(
    flow.observeShipping(f.sql, f.leg.id, f.observation('cancel', now + 3)).accepted,
    false,
  );
  const r = receipt(f.sql, f.id);
  assert.equal(r.fulfillment_status, 'delivered');
  assert.equal(r.payment_status, 'unpaid');
  assert.equal(r.cod_status, 'to_collect');
  assert.equal(f.db.prepare('SELECT count(*) n FROM shipping_conflicts').get()?.n, 2);
  f.db.close();
});
test('G3 duplicate callbacks are deduplicated and unmatched tracking is retained for review', () => {
  const f = fixture(),
    event = {
      source: 'ghn',
      account_id: 'shop-a',
      environment: 'staging',
      external_code: 'UNMATCHED',
      event_time: now,
      payload_hash: 'hash',
    };
  const first = flow.receiveShippingEvent(f.sql, event);
  assert.equal(flow.receiveShippingEvent(f.sql, event).id, first.id);
  assert.equal(flow.receiveShippingEvent(f.sql, event).duplicate, true);
  assert.equal(flow.linkShippingEvent(f.sql, first.id), null);
  assert.equal(
    f.db.prepare('SELECT state FROM shipping_inbox').get()?.state,
    'unmatched',
  );
  f.db.close();
});
test('G4 confirmed carrier cancellation plus POS readback completes approved request once; checkbox cannot bypass proof', async () => {
  const f = fixture();
  flow.observeShipping(f.sql, f.leg.id, f.observation());
  let detail = f.transaction(() =>
    createServiceRequest(
      f.sql,
      f.id,
      {
        idempotency_key: crypto.randomUUID(),
        order_version: orderVersion(f.sql, f.id),
        kind: 'cancel',
        reason: 'Khách yêu cầu hủy giỏ quà trước khi giao.',
      },
      'customer',
    ),
  );
  const requestId = detail.requests[0].id;
  detail = f.transaction(() =>
    decideServiceRequest(
      f.sql,
      f.id,
      {
        order_version: detail.order_version,
        request_id: requestId,
        action: 'approve',
        evidence: 'Shop duyệt yêu cầu hủy của khách hàng.',
        external_cleared: false,
        pricing: 'quoted',
      },
      'ops',
    ),
  );
  assert.throws(
    () =>
      f.transaction(() =>
        decideServiceRequest(
          f.sql,
          f.id,
          {
            order_version: detail.order_version,
            request_id: requestId,
            action: 'complete',
            evidence: 'Đã đánh dấu xác nhận bên vận chuyển.',
            external_cleared: true,
            pricing: 'quoted',
          },
          'ops',
        ),
      ),
    /xác minh lệnh/,
  );
  const c = f.enqueue('cancel', requestId);
  let reads = 0,
    sends = 0;
  const adapter: ExecutionAdapter = {
    read: async () =>
      f.observation(++reads === 1 ? 'ready_to_pick' : 'cancel', now + reads),
    prepare: async () => ({ path: 'cancel', body: {} }),
    send: async () => {
      sends++;
    },
  };
  await runShippingCommand(env, f.stub, String(c.id), {
    adapter: () => adapter,
    mirror: async () => {},
  });
  assert.equal(sends, 1);
  assert.equal(serviceDetail(f.sql, f.id).requests[0].status, 'completed');
  assert.equal(receipt(f.sql, f.id).order_status, 'canceled');
  assert.equal(receipt(f.sql, f.id).payment_status, 'unpaid');
  flow.completeShippingService(f.sql, String(c.id));
  assert.equal(f.db.prepare('SELECT count(*) n FROM commerce_requests').get()?.n, 1);
  f.db.close();
});
test('G4 POS-owned labels cannot be mutated through the direct adapter', async () => {
  const f = fixture('pancake');
  const c = f.enqueue('create');
  let sends = 0;
  await runShippingCommand(
    {
      ...env,
      CARRIER_REGISTRY_JSON: JSON.stringify([
        { ...account, execution_owner: 'pancake', pancake_account_id: 9 },
      ]),
    },
    f.stub,
    String(c.id),
    {
      adapter: () => ({
        read: async () => f.observation(),
        prepare: async () => ({ path: 'create', body: {} }),
        send: async () => {
          sends++;
        },
      }),
      mirror: async () => {},
    },
  );
  assert.equal(sends, 0);
  assert.equal(
    f.db.prepare('SELECT state FROM shipping_commands').get()?.state,
    'manual_review',
  );
  f.db.close();
});
test('G0 GHN HTTP 200 result:false and wrong tracking are never success; OTP returns awaiting_auth', async () => {
  const cfg = carrierConfiguration(env, account);
  for (const data of [
    [{ order_code: 'CODE', result: false }],
    [{ order_code: 'OTHER', result: true }],
  ]) {
    mock.method(globalThis, 'fetch', async () => Response.json({ code: 200, data }));
    await assert.rejects(() =>
      ghnCommandRequest(cfg, 'v2/switch-status/cancel', { order_codes: ['CODE'] }),
    );
    mock.restoreAll();
  }
  mock.method(globalThis, 'fetch', async () =>
    Response.json(
      { code: 400, code_message: 'OTP_NOT_VALID', data: null },
      { status: 400 },
    ),
  );
  await assert.rejects(
    () => ghnCommandRequest(cfg, 'v2/shipping-order/update', {}),
    (e) => e instanceof ShippingError && e.code === 'carrier_awaiting_auth',
  );
});
test('G0 GHN authenticated detail rejects a wrong shop and wrong client reference', async () => {
  const f = fixture(),
    adapter = ghnExecutionAdapter(carrierConfiguration(env, account));
  mock.method(globalThis, 'fetch', async () =>
    Response.json({
      code: 200,
      data: {
        order_code: 'CODE',
        client_order_code: f.reference,
        shop_id: 999,
        status: 'ready_to_pick',
        updated_date: new Date().toISOString(),
        cod_amount: 220000,
      },
    }),
  );
  await assert.rejects(() => adapter.read(f.leg), /tài khoản/);
  f.db.close();
});

function approve(
  f: ReturnType<typeof fixture>,
  kind: 'cancel' | 'address' | 'return',
  quoteId?: string,
) {
  let detail = f.transaction(() =>
    createServiceRequest(
      f.sql,
      f.id,
      {
        idempotency_key: crypto.randomUUID(),
        order_version: orderVersion(f.sql, f.id),
        kind,
        quote_id: quoteId,
        ...(kind === 'return' ? { items: [{ sku: 'A', qty: 1 }] } : {}),
        reason: 'Yêu cầu của khách hàng đã được xác minh.',
      },
      'customer',
    ),
  );
  const request = detail.requests.find((r) => r.kind === kind && r.status === 'pending')!;
  detail = f.transaction(() =>
    decideServiceRequest(
      f.sql,
      f.id,
      {
        request_id: request.id,
        order_version: detail.order_version,
        action: 'approve',
        evidence: 'Shop đã xác minh và duyệt yêu cầu của khách.',
        external_cleared: false,
        pricing: 'quoted',
      },
      'ops',
    ),
  );
  return request.id;
}
test('G3 a poll and command cannot write the same leg concurrently; expired leases recover read-only', () => {
  const f = fixture(),
    command = f.enqueue('create');
  assert.ok(flow.claimShippingPoll(f.sql, f.leg.id, 'poll', now));
  assert.equal(
    flow.claimShippingCommand(f.sql, String(command.id), 'command', now),
    null,
  );
  assert.throws(
    () => flow.observeShipping(f.sql, f.leg.id, f.observation(), now, 'other'),
    /đang được xử lý/,
  );
  assert.ok(
    flow.claimShippingCommand(f.sql, String(command.id), 'recovered', now + 120001),
  );
  f.db.close();
});
test('G3 scoped account/environment keys accept identical tracking codes without mixing callbacks', () => {
  const f = fixture();
  flow.observeShipping(f.sql, f.leg.id, f.observation());
  const second = crypto.randomUUID();
  f.db
    .prepare(
      'INSERT INTO shipping_legs(id,order_id,kind,carrier_id,account_id,environment,owner,service_id,client_code,tracking_code,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      second,
      f.id,
      'reverse',
      'ghn',
      'another-account',
      'staging',
      'direct',
      '2',
      'ANOTHER',
      'CODE',
      now,
    );
  const event = flow.receiveShippingEvent(f.sql, {
    source: 'ghn',
    account_id: 'another-account',
    environment: 'staging',
    external_code: 'CODE',
    event_time: now,
    payload_hash: 'second',
  });
  assert.equal(flow.linkShippingEvent(f.sql, event.id)?.id, second);
  const wrong = flow.receiveShippingEvent(f.sql, {
    source: 'ghn',
    account_id: 'another-account',
    environment: 'production',
    external_code: 'CODE',
    event_time: now,
    payload_hash: 'wrong-env',
  });
  assert.equal(flow.linkShippingEvent(f.sql, wrong.id), null);
  f.db.close();
});
test('G4 address commands preserve account/service, require valid quotes and settled money, and freeze the new COD', () => {
  const f = fixture();
  flow.observeShipping(f.sql, f.leg.id, f.observation());
  const quotedOffer = {
    ...f.snapshot.shipping.offer,
    customer_fee_vnd: 30000,
    carrier_fee_vnd: 30000,
    cod_value_vnd: 230000,
  };
  const q = storeAddressQuote(
    f.sql,
    f.id,
    orderVersion(f.sql, f.id),
    { ...f.snapshot.recipient, address: '99 New Street' },
    quotedOffer,
  );
  const requestId = approve(f, 'address', q.id),
    command = f.enqueue('address', requestId);
  assert.equal(JSON.parse(String(command.payload)).cod_amount, 230000);
  const c = flow.claimShippingCommand(f.sql, String(command.id), 'address');
  assert.ok(c);
  f.db.exec("UPDATE commerce_orders SET method='techcombank_qr',payment_status='paid'");
  assert.throws(
    () => flow.markShippingAttempt(f.sql, String(command.id), 'address'),
    /thu\/hoàn chênh lệch/,
  );
  f.db.close();
});
test('G4 already-delivered return uses a separate reverse/replacement leg and never overwrites outbound tracking', () => {
  const f = fixture();
  flow.observeShipping(f.sql, f.leg.id, f.observation('delivered'));
  const requestId = approve(f, 'return'),
    input = {
      idempotency_key: crypto.randomUUID(),
      order_id: f.id,
      request_id: requestId,
      kind: 'reverse' as const,
      account_id: account.id,
      service_id: '2' as const,
    };
  const reverse = flow.prepareExternalLeg(f.sql, input, account, 'ops');
  assert.equal(flow.prepareExternalLeg(f.sql, input, account, 'ops').id, reverse.id);
  assert.throws(
    () =>
      flow.prepareExternalLeg(f.sql, { ...input, kind: 'replacement' }, account, 'ops'),
    ShippingError,
  );
  const reverseLeg = flow.shippingLeg(f.sql, String(reverse.id));
  flow.observeShipping(f.sql, reverseLeg.id, {
    ...f.observation('delivered'),
    client_code: reverseLeg.client_code,
    tracking_code: 'REVERSE',
  });
  const result = receipt(f.sql, f.id);
  assert.equal(result.tracking_number, 'CODE');
  assert.equal(result.shipping_legs.length, 2);
  assert.equal(result.payment_status, 'unpaid');
  assert.equal(result.fulfillment_status, 'delivered');
  f.db.close();
});
test('G4 authenticated POS cancellation creates one approved request and one durable carrier command', () => {
  const f = fixture();
  flow.observeShipping(f.sql, f.leg.id, f.observation());
  f.transaction(() =>
    flow.observePosShipping(f.sql, f.leg.id, { status: 6, tracking: 'CODE' }),
  );
  f.transaction(() =>
    flow.observePosShipping(f.sql, f.leg.id, { status: 6, tracking: 'CODE' }),
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM commerce_requests').get()?.n, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM shipping_commands').get()?.n, 1);
  assert.equal(receipt(f.sql, f.id).order_status, 'pending');
  f.db.close();
});
test('G4 unbooked cancellation requires a verified GHN absence and verified POS cancellation; timeout is not absence', async () => {
  const f = fixture(),
    requestId = approve(f, 'cancel'),
    command = f.enqueue('cancel', requestId);
  let posStatus = 1,
    writes = 0;
  const adapter: ExecutionAdapter = {
    read: async () => {
      throw new ShippingError('carrier_order_not_found', 404, 'No order');
    },
    prepare: async () => {
      throw Error('Must not dispatch');
    },
    send: async () => {
      throw Error('Must not dispatch');
    },
  };
  mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    if (init.method === 'PUT') {
      writes++;
      assert.deepEqual(JSON.parse(String(init.body)), { status: 6 });
      posStatus = 6;
      return Response.json({ success: true });
    }
    return Response.json({
      data: {
        id: f.reference,
        custom_id: f.reference,
        total_price: 200000,
        money_to_collect: 220000,
        cod: 220000,
        prepaid: 0,
        status: posStatus,
        partner: null,
      },
    });
  });
  await runShippingCommand(
    { ...env, PANCAKE_SHOP_ID: 'shop', PANCAKE_API_KEY: 'fixture-secret' },
    f.stub,
    String(command.id),
    { adapter: () => adapter },
  );
  assert.equal(writes, 1);
  assert.equal(receipt(f.sql, f.id).order_status, 'canceled');
  assert.equal(
    f.db.prepare('SELECT state FROM shipping_commands').get()?.state,
    'verified',
  );
  f.db.close();
  const pending = fixture(),
    r = approve(pending, 'cancel'),
    c = pending.enqueue('cancel', r);
  await runShippingCommand(env, pending.stub, String(c.id), {
    adapter: () => ({
      ...adapter,
      read: async () => {
        throw Error('timeout');
      },
    }),
  });
  assert.equal(receipt(pending.sql, pending.id).order_status, 'pending');
  pending.db.close();
});
test('G1 persistent account circuit opens after three failures and leaves other accounts available', () => {
  const f = fixture();
  for (let i = 0; i < 3; i++)
    flow.reportShippingQuotes(f.sql, [{ account_id: 'shop-a', failed: true }], now);
  flow.reportShippingQuotes(f.sql, [{ account_id: 'another', failed: false }], now);
  const states = flow.shippingCircuitStatus(f.sql);
  assert.equal(
    Number(states.find((s) => s.account_id === 'shop-a')?.open_until),
    now + 60000,
  );
  assert.equal(states.find((s) => s.account_id === 'another')?.open_until, 0);
  flow.reportShippingQuotes(
    f.sql,
    [{ account_id: 'shop-a', failed: false }],
    now + 60001,
  );
  assert.equal(
    flow.shippingCircuitStatus(f.sql).find((s) => s.account_id === 'shop-a')?.failures,
    0,
  );
  f.db.close();
});
test('G5 actual GHN adapter and POS mirror book once and verify address edits without a second dispatch or false payment', async () => {
  const f = fixture();
  let created = 0,
    edited = 0,
    posWrites = 0,
    tracking = '',
    status = 1;
  let recipient = { ...f.snapshot.recipient };
  let posAddress: Record<string, unknown> = {
    full_name: recipient.name,
    phone_number: recipient.phone,
    address: recipient.address,
    province_id: 'P',
    district_id: 'D',
    commune_id: 'W',
  };
  mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    const u = new URL(String(url)),
      path = u.pathname;
    if (path.endsWith('master-data/province'))
      return Response.json({ code: 200, data: [{ ProvinceID: 1, ProvinceName: 'HCM' }] });
    if (path.endsWith('master-data/district'))
      return Response.json({
        code: 200,
        data: [{ DistrictID: 3, DistrictName: 'District 3', ProvinceID: 1 }],
      });
    if (path.endsWith('master-data/ward'))
      return Response.json({
        code: 200,
        data: [{ WardCode: '004', WardName: 'Ward 4', DistrictID: 3 }],
      });
    if (path.includes('/geo/'))
      return Response.json({
        data: [
          {
            id: path.endsWith('provinces') ? 'P' : path.endsWith('districts') ? 'D' : 'W',
            name: path.endsWith('provinces')
              ? 'HCM'
              : path.endsWith('districts')
                ? 'District 3'
                : 'Ward 4',
          },
        ],
      });
    if (path.endsWith('shipping-order/create')) {
      created++;
      const body = JSON.parse(String(init.body));
      assert.equal(body.client_order_code, f.reference);
      assert.equal(body.cod_amount, 220000);
      assert.equal(body.payment_type_id, 1);
      assert.equal(body.to_district_name, 'District 3');
      tracking = 'DIRECT-CODE';
      return Response.json({ code: 200, data: { order_code: tracking } });
    }
    if (path.endsWith('shipping-order/update')) {
      edited++;
      const body = JSON.parse(String(init.body));
      assert.equal(body.order_code, tracking);
      assert.equal(body.cod_amount, undefined);
      recipient = { ...recipient, address: body.to_address };
      return Response.json({ code: 200, data: null });
    }
    if (path.includes('shipping-order/detail'))
      return Response.json({
        code: 200,
        data: {
          order_code: tracking,
          client_order_code: f.reference,
          shop_id: 123,
          status: 'ready_to_pick',
          updated_date: new Date(now + created + edited).toISOString(),
          cod_amount: 220000,
          to_name: recipient.name,
          to_phone: recipient.phone,
          to_address: recipient.address,
          to_district_id: recipient.district_id,
          to_ward_code: recipient.ward_code,
        },
      });
    if (init.method === 'PUT') {
      posWrites++;
      const body = JSON.parse(String(init.body));
      assert.equal(body.is_send_to_ghn, undefined);
      assert.equal(body.shop_partner_id, undefined);
      if (body.status !== undefined) status = body.status;
      if (body.shipping_address) posAddress = body.shipping_address;
      return Response.json({ success: true });
    }
    return Response.json({
      data: {
        id: f.reference,
        custom_id: f.reference,
        total_price: 200000,
        money_to_collect: 220000,
        cod: 220000,
        prepaid: 0,
        status,
        partner: posWrites ? { partner_id: 5, extend_code: tracking } : null,
        shipping_address: posAddress,
        items: [{ variation_id: 'pos-v', product_id: 'pos-p', quantity: 1 }],
      },
    });
  });
  const runtimeEnv = {
    ...env,
    PANCAKE_SHOP_ID: 'shop',
    PANCAKE_API_KEY: 'fixture-secret',
  };
  const command = f.enqueue('create');
  assert.equal(
    (await runShippingCommand(runtimeEnv, f.stub, String(command.id)))?.state,
    'verified',
  );
  assert.equal(receipt(f.sql, f.id).tracking_number, 'DIRECT-CODE');
  const q = storeAddressQuote(
    f.sql,
    f.id,
    orderVersion(f.sql, f.id),
    { ...recipient, address: '99 New Street' },
    f.snapshot.shipping.offer,
  );
  const requestId = approve(f, 'address', q.id),
    change = f.enqueue('address', requestId);
  assert.equal(
    (await runShippingCommand(runtimeEnv, f.stub, String(change.id)))?.state,
    'verified',
  );
  assert.equal(serviceDetail(f.sql, f.id).recipient.address, '99 New Street');
  assert.equal(serviceDetail(f.sql, f.id).requests[0].status, 'completed');
  assert.equal(created, 1);
  assert.equal(edited, 1);
  assert.equal(posWrites, 2);
  assert.equal(receipt(f.sql, f.id).payment_status, 'unpaid');
  f.db.close();
});
test('G3 callback boundary rejects missing/wrong secrets and foreign shops before durable acceptance; duplicates return 202', async () => {
  const f = fixture(),
    app = new OpenAPIHono<HonoEnv>();
  const stub = {
    shippingReceive: async (input: Parameters<typeof flow.receiveShippingEvent>[1]) =>
      shippingResult(() => flow.receiveShippingEvent(f.sql, input)),
    shippingServiceDue: async () => ({ requests: [], completions: [] }),
    shippingDue: async () => [],
    shippingEventsDue: async () => [],
    shippingPollDue: async () => [],
  } as unknown as DOStub;
  app.use('*', async (c, next) => {
    c.set('db', stub);
    await next();
  });
  app.route('/events', carrierEvents);
  app.onError((error, c) =>
    c.json(
      { error: 'rejected' },
      error instanceof ApiError ? (error.statusCode as 400 | 401 | 403) : 500,
    ),
  );
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => waits.push(p),
    passThroughOnException() {},
    props: {},
  };
  const payload = {
    ShopID: 123,
    OrderCode: 'CODE',
    ClientOrderCode: f.reference,
    Type: 'switch_status',
    Status: 'delivered',
  };
  const send = (body: unknown, secret?: string) =>
    app.request(
      '/events/ghn/shop-a',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { 'X-Shipping-Secret': secret } : {}),
        },
        body: JSON.stringify(body),
      },
      env,
      ctx as ExecutionContext,
    );
  assert.equal((await send(payload)).status, 401);
  assert.equal((await send(payload, 'wrong')).status, 401);
  const secret = 'test-webhook-secret-32-characters';
  assert.equal((await send({ ...payload, ShopID: 999 }, secret)).status, 403);
  assert.equal((await send({ ShopID: 123 }, secret)).status, 400);
  assert.equal((await send(payload, secret)).status, 202);
  const repeated = await send(payload, secret);
  assert.equal(repeated.status, 202);
  assert.equal(((await repeated.json()) as { duplicate: boolean }).duplicate, true);
  assert.equal(f.db.prepare('SELECT count(*) n FROM shipping_inbox').get()?.n, 1);
  assert.equal(receipt(f.sql, f.id).payment_status, 'unpaid');
  await Promise.allSettled(waits);
  f.db.close();
});

test('G5 a POS cancellation observed immediately before booking blocks create before the durable attempt', async () => {
  const f = fixture(),
    command = f.enqueue('create');
  let sends = 0;
  mock.method(globalThis, 'fetch', async () =>
    Response.json({
      data: {
        id: f.reference,
        custom_id: f.reference,
        total_price: 200000,
        money_to_collect: 220000,
        cod: 220000,
        prepaid: 0,
        status: 6,
        partner: null,
      },
    }),
  );
  const adapter: ExecutionAdapter = {
    read: async () => f.observation(),
    prepare: async () => ({ path: 'create', body: {} }),
    send: async () => {
      sends++;
    },
  };
  await runShippingCommand(
    { ...env, PANCAKE_SHOP_ID: 'shop', PANCAKE_API_KEY: 'fixture-secret' },
    f.stub,
    String(command.id),
    { adapter: () => adapter, mirror: async () => {} },
  );
  assert.equal(sends, 0);
  assert.equal(
    f.db.prepare('SELECT attempted FROM shipping_commands').get()?.attempted,
    0,
  );
  assert.equal(
    f.db.prepare('SELECT state FROM shipping_commands').get()?.state,
    'manual_review',
  );
  f.db.close();
});
test('G3 legitimate redelivery can leave waiting-to-return; loss remains an operational exception without receiving money', () => {
  const f = fixture();
  flow.observeShipping(f.sql, f.leg.id, f.observation('waiting_to_return', now));
  assert.equal(
    flow.observeShipping(f.sql, f.leg.id, f.observation('storing', now + 1)).accepted,
    true,
  );
  flow.observeShipping(f.sql, f.leg.id, f.observation('lost', now + 2));
  const r = receipt(f.sql, f.id);
  assert.equal(r.shipping_legs[0].needs_attention, true);
  assert.equal(r.progress.exception, 'delivery_failed');
  assert.equal(r.cod_status, 'to_collect');
  assert.equal(r.payment_status, 'unpaid');
  assert.equal(flow.shippingQueue(f.sql).legs.length, 1);
  f.db.close();
});
