import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  COMMERCE_SCHEMA,
  checkoutInput,
  confirmCheckout,
  recordEvidence,
  receipt,
  claimOutbox,
  markCreateAttempt,
  finishOutbox,
  updateFulfillment,
  cancelPendingOrder,
  resolveBankException,
  type CheckoutConfig,
} from '../src/lib/commerce-core';
import { commerceToken, verifyCommerceToken } from '../src/lib/commerce-token';
import { SERVICE_SCHEMA, expireServiceHold, serviceDetail, createServiceRequest, decideServiceRequest, createRefund, recordRefundResult, recordAddressAdjustment, startActionSession, verifyActionSession, assertActionSession, assertNoOpenChanges, storeAddressQuote, serviceNotificationClaim, serviceNotificationFinish } from '../src/lib/commerce-service';
import { ensureSchemaObjects } from '../src/lib/sql-schema';
import { PANCAKE_SCHEMA } from '../src/lib/pancake-store';
import {
  SHIPPING_SCHEMA,
  loadShippingCart,
  storeShippingQuote,
  selectShippingQuote,
  type ShippingSql,
  shippingResult,
} from '../src/lib/shipping-store';
import {
  policySchema,
  calculateShipping,
  type ShippingOffer,
} from '../src/lib/smart-shipping';
import { syncCommerceOrder } from '../src/lib/commerce-pos';
import type { DOStub } from '../src/types';
import { authorizeShipment, claimShipment, markShipmentAttempt, finishShipment, type ShipmentResult } from '../src/lib/commerce-shipment-store';
import { syncCommerceShipment } from '../src/lib/commerce-shipment';
import { resolveProgress } from '../src/lib/commerce-progress';
import { assertPancakeMoney, parsePancakeOrder } from '../src/lib/commerce-pancake-api';
import { resolvePosAddress } from '../src/lib/commerce-pos-address';
const now = Date.now();
const config: CheckoutConfig = {
  policy: policySchema.parse({
    version: 'test',
    max_delivery_hours: 24,
    subsidy_vnd: 10000,
    parcel: {
      length_cm: 25,
      width_cm: 20,
      height_cm: 15,
      max_weight_g: 10000,
      packaging_weight_g: 100,
    },
  }),
  policy_key: '',
  environment: 'staging',
  shop_id: 'shop',
  warehouse_id: 'w',
  bank: { account_number: '50398838675', account_name: 'NGUYEN XUAN PHUONG' },
};
afterEach(() => mock.restoreAll());

test('five progress stages map POS codes conservatively and keep exceptions outside the happy path', () => {
  for (const [status, stage] of [[0,'placed'],[17,'placed'],[1,'confirmed'],[8,'confirmed'],[11,'confirmed'],[20,'confirmed'],[9,'pickup'],[2,'shipping'],[3,'delivered'],[16,'delivered']] as const)
    assert.equal(resolveProgress({pos_status:status}).stage, stage);
  assert.equal(resolveProgress({tracking_number:'LABEL'}).stage, 'pickup');
  assert.equal(resolveProgress({pos_status:999}).stage, 'placed');
  for (const [status, exception] of [[6,'canceled'],[7,'canceled'],[4,'returning'],[5,'returned'],[15,'partial_return']] as const) {
    const result=resolveProgress({pos_status:status},'shipping');
    assert.equal(result.exception,exception);assert.notEqual(result.stage,'delivered');
  }
  assert.equal(resolveProgress({carrier_status:'undeliverable'}).exception,'delivery_failed');
  assert.equal(resolveProgress({carrier_status:'canceled'}).exception,'delivery_failed');
});

test('POS observations persist exact milestone times and history without dispatching or changing payment', async () => {
  const f=await shipmentFixture();let status=0,writes=0;
  mock.method(globalThis,'fetch',async(url:unknown,init:RequestInit)=>{
    if(init.method!=='GET')writes++;
    const path=new URL(String(url)).pathname;
    if(path.endsWith('/partners'))return Response.json({data:[{id:5,name:'GHN',accounts:[{id:745268}]}]});
    return Response.json({data:{id:f.order.reference,status,total_price:200000,money_to_collect:220000,cod:220000,prepaid:0,partner:null}});
  });
  const env={...integrationEnv(),PANCAKE_GHN_DISPATCH_ENABLED:'false'};
  for(const [next,stage] of [[0,'placed'],[1,'confirmed'],[9,'pickup'],[2,'shipping'],[3,'delivered']] as const){
    status=next;f.db.exec('UPDATE commerce_shipments SET next_attempt_at=0');
    await syncCommerceShipment(env as never,f.stub,f.order.order_id);
    const result=receipt(f.sql,f.order.order_id);
    assert.equal(result.progress.stage,stage);assert.equal(result.payment_status,'unpaid');assert.equal(result.cod_status,'to_collect');
    if(stage!=='placed')assert.ok(result.progress.timestamps[stage]);
  }
  const result=receipt(f.sql,f.order.order_id);
  assert.deepEqual(result.progress.history.map(e=>e.stage),['delivered','shipping','pickup','confirmed']);
  assert.equal(writes,0);f.db.close();
});

test('a canceled POS observation is retained even when its amounts changed and never dispatches', async()=>{
  const f=await shipmentFixture();
  mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
    assert.equal(init.method,'GET');
    return Response.json({data:{id:f.order.reference,status:6,total_price:0,money_to_collect:0,cod:0,prepaid:0}});
  });
  await syncCommerceShipment(integrationEnv() as never,f.stub,f.order.order_id);
  const result=receipt(f.sql,f.order.order_id);
  assert.equal(result.progress.exception,'canceled');assert.equal(result.progress.stage,'placed');
  assert.equal(result.shipment_status,'canceled');assert.equal(result.payment_status,'unpaid');f.db.close();
});

const integrationEnv = () => ({
  PANCAKE_ORDER_SYNC_ENABLED: 'true', PANCAKE_GHN_DISPATCH_ENABLED: 'true', PANCAKE_GHN_ACCOUNT_ID: '745268',
  PANCAKE_PAYMENT_MAPPING_VERIFIED: 'true', PANCAKE_API_KEY: 'test-key', PANCAKE_SHOP_ID: 'shop', PANCAKE_WAREHOUSE_ID: 'w',
  COMMERCE_ENVIRONMENT: 'production' as const, SMART_SHIPPING_ENABLED: 'true', SMART_SHIPPING_POLICY: JSON.stringify(config.policy),
  GHN_TOKEN: 'test-ghn-token', GHN_SHOP_ID: '1', GHN_FROM_DISTRICT_ID: '1', GHN_FROM_WARD_CODE: '001', GHN_ENVIRONMENT: 'production',
});
function locationMock(path: string) {
  if (path.endsWith('/master-data/province')) return Response.json({ code: 200, data: [{ ProvinceID: 2, ProvinceName: 'HCM' }] });
  if (path.endsWith('/master-data/district')) return Response.json({ code: 200, data: [{ DistrictID: 3, ProvinceID: 2, DistrictName: 'Test District' }] });
  if (path.endsWith('/master-data/ward')) return Response.json({ code: 200, data: [{ WardCode: '0004', DistrictID: 3, WardName: 'Test Ward' }] });
  if (path.endsWith('/geo/provinces')) return Response.json({ data: [{ id: '701', name: 'HCM' }] });
  if (path.endsWith('/geo/districts')) return Response.json({ data: [{ id: '70101', name: 'Test District' }] });
  if (path.endsWith('/geo/communes')) return Response.json({ data: [{ id: '7010101', name: 'Test Ward' }] });
  return null;
}

test('live Pancake response shape distinguishes goods, gross payable, prepaid and actual COD', () => {
  for (const prepaid of [0, 68000]) {
    const pos = parsePancakeOrder({ data: { id: 'HFREF', total_price: 48000, money_to_collect: 68000, prepaid, cod: 68000 - prepaid } });
    assert.doesNotThrow(() => assertPancakeMoney(pos, { reference: 'HFREF', total_vnd: 68000, amount_to_collect_vnd: 68000 - prepaid }));
    assert.throws(() => assertPancakeMoney(pos, { reference: 'OTHER', total_vnd: 68000, amount_to_collect_vnd: 68000 - prepaid }));
    assert.throws(() => assertPancakeMoney(pos, { reference: 'HFREF', total_vnd: 68001, amount_to_collect_vnd: 68000 - prepaid }));
  }
});

test('address mapping resolves GHN IDs inside each parent and rejects ambiguous POS wards', async () => {
  const f = await fixture();
  let ambiguous = false;
  mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    if (ambiguous && path.endsWith('/geo/communes')) return Response.json({ data: [{ id: 'a', name: 'Test Ward' }, { id: 'b', name: 'Test Ward' }] });
    return locationMock(path)!;
  });
  const address = await resolvePosAddress(integrationEnv() as never, f.input.recipient);
  assert.equal(address.district_id, '70101');
  assert.equal(address.commune_id, '7010101');
  ambiguous = true;
  await assert.rejects(() => resolvePosAddress(integrationEnv() as never, f.input.recipient), /đối chiếu/);
  f.db.close();
});

async function shipmentFixture(enabled = true) {
  const f = await fixture(), order = f.checkout();
  const snapshot = JSON.parse(String(f.db.prepare('SELECT snapshot_json FROM commerce_orders').get()!.snapshot_json));
  snapshot.dispatch_enabled = enabled; snapshot.automation_version = enabled ? 2 : 1; snapshot.dispatch_account_id = '745268'; snapshot.shipping.offer.environment = 'production';
  f.db.prepare('UPDATE commerce_orders SET snapshot_json=?').run(JSON.stringify(snapshot));
  f.transaction(() => { claimOutbox(f.sql, order.order_id, 'pos'); finishOutbox(f.sql, order.order_id, 'pos', order.reference, null); });
  const db = {
    commerceShipmentClaim: async (id: string, token: string) => shippingResult(() => f.transaction(() => claimShipment(f.sql, id, token))),
    commerceShipmentMark: async (id: string, token: string, partner: number, account: number) => shippingResult(() => f.transaction(() => markShipmentAttempt(f.sql, id, token, partner, account))),
    commerceShipmentFinish: async (id: string, token: string, result: ShipmentResult) => shippingResult(() => f.transaction(() => finishShipment(f.sql, id, token, result))),
  } as DOStub;
  return { ...f, order, stub: db };
}

test('Pancake dispatch persists verified tracking, maps pickup separately, and never sends a second request', async () => {
  const f = await shipmentFixture(); let sends = 0, tracking = '', carrierStatus = 'request_received';
  mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    const path = new URL(String(url)).pathname, location = locationMock(path);
    if (location) return location;
    if (path.endsWith('/partners')) return Response.json({ data: [{ id: 5, name: 'GHN', accounts: [{ id: 745268 }] }] });
    if (init.method === 'PUT') {
      sends++; const body = JSON.parse(String(init.body));
      assert.equal(body.is_send_to_ghn, true); assert.equal(body.is_free_ship_ghn, true);
      assert.equal(body.shipping_fee, 20000); assert.equal(body.is_free_shipping, false); assert.equal(body.customer_pay_fee, true);
      assert.equal(body.shop_partner_id, 745268); assert.equal(body.shipping_address.commune_id, '7010101');
      tracking = 'GHN-VERIFIED'; return Response.json({ success: true });
    }
    return Response.json({ data: { id: f.order.reference, total_price: 200000, money_to_collect: 220000, cod: 220000, prepaid: 0, status: 1, items: [{ quantity: 1, variation_info: { weight: 1100 } }],
      partner: tracking ? { partner_id: 5, extend_code: tracking, system_created: true, partner_status: carrierStatus } : null } });
  });
  await syncCommerceShipment(integrationEnv() as never, f.stub, f.order.order_id);
  let result = receipt(f.sql, f.order.order_id);
  assert.equal(result.tracking_number, 'GHN-VERIFIED'); assert.equal(result.fulfillment_status, 'ready_to_ship');
  assert.equal(result.shipment_status, 'booked'); assert.equal(result.payment_status, 'unpaid');
  f.db.exec('UPDATE commerce_shipments SET next_attempt_at=0'); carrierStatus = 'picked_up';
  await syncCommerceShipment(integrationEnv() as never, f.stub, f.order.order_id);
  assert.equal(receipt(f.sql, f.order.order_id).fulfillment_status, 'shipped');
  f.db.exec('UPDATE commerce_shipments SET next_attempt_at=0'); carrierStatus = 'delivered_cod';
  await syncCommerceShipment(integrationEnv() as never, f.stub, f.order.order_id);
  result = receipt(f.sql, f.order.order_id);
  assert.equal(result.fulfillment_status, 'delivered'); assert.equal(result.payment_status, 'unpaid'); assert.equal(result.cod_status, 'to_collect');
  assert.equal(sends, 1); f.db.close();
});

test('timeout or silently ignored dispatch only reconciles on retries and never fabricates a tracking number', async () => {
  for (const timeout of [true, false]) {
    const f = await shipmentFixture(); let sends = 0;
    mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
      const path = new URL(String(url)).pathname, location = locationMock(path); if (location) return location;
      if (path.endsWith('/partners')) return Response.json({ data: [{ id: 5, name: 'GHN', accounts: [{ id: 745268 }] }] });
      if (init.method === 'PUT') { sends++; if (timeout) throw Error('timeout'); return Response.json({ success: true }); }
      return Response.json({ data: { id: f.order.reference, total_price: 200000, money_to_collect: 220000, cod: 220000, prepaid: 0, status: 1, items: [{ quantity: 1, variation_info: { weight: 1100 } }], partner: null } });
    });
    await assert.rejects(() => syncCommerceShipment(integrationEnv() as never, f.stub, f.order.order_id));
    f.db.exec('UPDATE commerce_shipments SET next_attempt_at=0');
    await assert.rejects(() => syncCommerceShipment(integrationEnv() as never, f.stub, f.order.order_id));
    const result = receipt(f.sql, f.order.order_id);
    assert.equal(result.tracking_number, null); assert.equal(result.shipment_status, 'needs_attention'); assert.equal(sends, 1);
    mock.restoreAll(); f.db.close();
  }
});

test('historical test orders and unpaid bank transfers never enter automatic shipping; lease serializes sends', async () => {
  const old = await shipmentFixture(false);
  assert.equal(claimShipment(old.sql, old.order.order_id, 'old'), null); old.db.close();
  const f = await shipmentFixture();
  assert.ok(claimShipment(f.sql, f.order.order_id, 'first'));
  assert.equal(claimShipment(f.sql, f.order.order_id, 'second'), null);
  assert.throws(() => markShipmentAttempt(f.sql, f.order.order_id, 'second', 5, 745268), /thay đổi/);
  f.db.exec("UPDATE commerce_orders SET method='techcombank_qr',payment_status='pending';UPDATE commerce_shipments SET lease_until=0");
  assert.equal(claimShipment(f.sql, f.order.order_id, 'bank'), null); f.db.close();
});

test('one-order dispatch authorization is audited, rejects an active lease, and never clears a previous attempt', async () => {
  const f = await shipmentFixture();
  claimShipment(f.sql, f.order.order_id, 'one');
  markShipmentAttempt(f.sql, f.order.order_id, 'one', 5, 745268);
  assert.throws(() => authorizeShipment(f.sql, f.order.order_id, '745268', 'Customer requested this shipment', 'admin'), /kiểm tra vận đơn/);
  finishShipment(f.sql, f.order.order_id, 'one', { error: 'shipment_result_uncertain' });
  f.transaction(() => authorizeShipment(f.sql, f.order.order_id, '745268', 'Customer requested this shipment', 'admin'));
  assert.equal(f.db.prepare('SELECT attempted FROM commerce_shipments').get()?.attempted, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM commerce_audit WHERE action='shipment.authorized'").get()?.n, 1);
  assert.throws(() => authorizeShipment(f.sql, f.order.order_id, 'other', 'Customer requested this shipment', 'admin'), /khớp cấu hình/);
  f.db.exec("UPDATE commerce_orders SET method='techcombank_qr',payment_status='pending'");
  assert.throws(() => authorizeShipment(f.sql, f.order.order_id, '745268', 'Customer requested this shipment', 'admin'), /chưa đủ điều kiện/);
  f.db.close();
});

test('tracking reconciliation works with booking disabled and never calls a carrier creation endpoint', async () => {
  const f = await shipmentFixture(); let tracking: string | null = null;
  mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    assert.equal(init.method, 'GET');
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/partners')) return Response.json({ data: [{ id: 5, name: 'GHN', accounts: [{ id: 745268 }] }] });
    return Response.json({ data: { id: f.order.reference, total_price: 200000, money_to_collect: 220000, cod: 220000, prepaid: 0,
      partner: tracking ? { partner_id: 5, extend_code: tracking, system_created: true, partner_status: 'request_received' } : null } });
  });
  const env = { ...integrationEnv(), PANCAKE_GHN_DISPATCH_ENABLED: 'false' };
  await syncCommerceShipment(env as never, f.stub, f.order.order_id);
  assert.equal(receipt(f.sql, f.order.order_id).shipment_status, 'pending');
  f.db.exec('UPDATE commerce_shipments SET next_attempt_at=0'); tracking = 'GHN-MANUAL';
  await syncCommerceShipment(env as never, f.stub, f.order.order_id);
  assert.equal(receipt(f.sql, f.order.order_id).tracking_number, 'GHN-MANUAL'); f.db.close();
});

test('changed COD, account, and parcel weight block dispatch before recording an attempt', async () => {
  for (const failure of ['cod', 'account', 'weight']) {
    const f = await shipmentFixture();
    mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
      assert.equal(init.method, 'GET');
      const path = new URL(String(url)).pathname, location = locationMock(path); if (location) return location;
      if (path.endsWith('/partners')) return Response.json({ data: [{ id: 5, name: 'GHN', accounts: [{ id: 745268 }] }] });
      return Response.json({ data: { id: f.order.reference, total_price: 200000, money_to_collect: 220000, cod: failure === 'cod' ? 219999 : 220000, prepaid: 0,
        shop_partner_id: failure === 'account' ? 999 : 745268, partner: null, items: [{ quantity: 1, variation_info: { weight: failure === 'weight' ? 1 : 1100 } }] } });
    });
    await assert.rejects(() => syncCommerceShipment(integrationEnv() as never, f.stub, f.order.order_id));
    assert.equal(f.db.prepare('SELECT attempted FROM commerce_shipments').get()?.attempted, 0);
    mock.restoreAll(); f.db.close();
  }
});
test('SKU rename preserves order snapshot and releases reservation by stable variant ID', async () => {
  const f = await fixture('techcombank_qr'),
    order = f.checkout();
  f.db.exec(
    "UPDATE variants SET sku='APPLE-NEW';UPDATE inventory SET sku='APPLE-NEW';UPDATE warehouse_inventory SET sku='APPLE-NEW'",
  );
  f.transaction(() =>
    cancelPendingOrder(
      f.sql,
      order.order_id,
      'Verified cancellation before bank receipt',
      'accountant',
    ),
  );
  assert.equal(
    f.db.prepare('SELECT reserved FROM warehouse_inventory').get()?.reserved,
    0,
  );
  assert.equal(receipt(f.sql, order.order_id).items[0].sku, 'APPLE');
  f.db.close();
});
async function fixture(method: 'cod' | 'techcombank_qr' = 'cod',owner?:'direct'|'pancake') {
  const db = new DatabaseSync(':memory:');
  const source = readFileSync(new URL('../src/do.ts', import.meta.url), 'utf8');
  db.exec(source.match(/const SCHEMA = `([\s\S]*?)`;/)![1]);
  db.exec(PANCAKE_SCHEMA);
  db.exec(SHIPPING_SCHEMA);
  db.exec(COMMERCE_SCHEMA);
  ensureSchemaObjects({exec:(q:string)=>{const rows=db.prepare(q).all() as Record<string,unknown>[];return {toArray:()=>rows};}},SERVICE_SCHEMA);
  db.exec(`INSERT INTO currencies(id,code,display_name,decimal_places) VALUES('vnd','VND','VND',0);
 INSERT INTO products(id,title,status) VALUES('p','Apple','active');
 INSERT INTO variants(id,product_id,sku,title,price_cents,currency,weight_g,status) VALUES('v','p','APPLE','Apple',100000,'VND',500,'active');
 INSERT INTO variant_prices(id,variant_id,currency_id,price_cents) VALUES('vp','v','vnd',100000);
 INSERT INTO pancake_sync_state(shop_id,warehouse_id) VALUES('shop','w');
 INSERT INTO pancake_links(shop_id,kind,source_id,target_id,seen_token) VALUES('shop','warehouse','w','local-w','1'),('shop','product','pos-p','p','1'),('shop','variation','pos-v','v','1');
 INSERT INTO warehouses(id,display_name,address_line1,city,postal_code,country_code) VALUES('local-w','Test warehouse','Address','City','','VN');
 INSERT INTO inventory(id,sku,on_hand,reserved) VALUES('i','APPLE',10,0);
 INSERT INTO warehouse_inventory(id,sku,warehouse_id,on_hand,reserved) VALUES('wi','APPLE','local-w',10,0);`);
  db.prepare('UPDATE pancake_sync_state SET last_completed_at=?').run(
    new Date(now).toISOString(),
  );
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO carts(id,customer_email,currency,expires_at,shipping_name,shipping_line1,shipping_city,shipping_country) VALUES(?,'guest@cart.invalid','VND',?,'Test User','12 Test Street','HCM','VN')",
  ).run(id, new Date(now + 86400_000).toISOString());
  db.prepare(
    "INSERT INTO cart_items(id,cart_id,sku,title,qty,unit_price_cents,currency) VALUES('ci',?,'APPLE','Apple',2,100000,'VND')",
  ).run(id);
  const sql: ShippingSql = {
    exec: (q, ...args) => {
      const rows = db.prepare(q).all(...args) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
  const transaction = <T>(fn: () => T) => {
    db.exec('BEGIN');
    try {
      const value = fn();
      db.exec('COMMIT');
      return value;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  const offer: ShippingOffer = {
    id: 'ghn:2',
    provider: 'ghn',
    execution_owner:owner,
    service_type_id: 2,
    service_name: 'Test',
    currency: 'VND',
    carrier_fee_vnd: 30000,
    subsidy_vnd: 10000,
    customer_fee_vnd: 20000,
    cod_value_vnd: method === 'cod' ? 220000 : 0,
    estimated_delivery_at: new Date(now + 3600_000).toISOString(),
    fee_breakdown: { total: 30000 },
    source: 'carrier_api',
    environment: 'staging',
  };
  const shippingConfig = {
    token: 'fake-test-token',
    shop_id: 1,
    from_district_id: 1,
    from_ward_code: '001',
    environment: 'staging' as const,
    policy: config.policy,
  };
  const quote = (
    await calculateShipping(
      loadShippingCart(sql, id),
      {
        cart_id: id,
        destination: { district_id: 3, ward_code: '0004' },
        payment_method: method === 'cod' ? 'cod' : 'prepaid',
      },
      shippingConfig,
      [{ code: 'ghn', quote: async () => ({ offers: [offer], warnings: [] }) }],
      now,
    )
  ).quote!;
  storeShippingQuote(sql, quote, now);
  selectShippingQuote(sql, id, quote.id, offer.id, quote.policy_key, now);
  const cfg = { ...config, policy_key: quote.policy_key };
  const input = checkoutInput.parse({
    cart_id: id,
    idempotency_key: crypto.randomUUID(),
    payment_method: method,
    customer_email: 'qa@example.test',
    recipient: {
      name: 'Test User',
      phone: '0901234567',
      address: '12 Test Street',
      city: 'HCM',
      district_id: 3,
      ward_code: '0004',
    },
    expected_total_vnd: 220000,
  });
  const checkout = () =>
    transaction(() => confirmCheckout(sql, input, cfg, now));
  return { db, sql, transaction, input, cfg, checkout };
}

test('checkout freezes direct dispatch separately from the legacy Pancake flag',async()=>{
  for(const enabled of [false,true]){
    const f=await fixture('cod','direct');f.cfg.dispatch_enabled=true;f.cfg.direct_dispatch_enabled=enabled;
    f.checkout();const snapshot=JSON.parse(String(f.db.prepare('SELECT snapshot_json FROM commerce_orders').get()?.snapshot_json));
    assert.equal(snapshot.dispatch_enabled,enabled);f.db.close();
  }
});

test('service requests deduplicate, reject changed retries and hold dispatch until rejected',async()=>{
  const f=await fixture(),order=f.checkout();
  const v=serviceDetail(f.sql,order.order_id).order_version;
  const input={idempotency_key:crypto.randomUUID(),order_version:v,kind:'cancel' as const,reason:'Khách không còn nhu cầu đặt giỏ quà.'};
  const first=f.transaction(()=>createServiceRequest(f.sql,order.order_id,input,'customer',now));
  assert.equal(first.requests.length,1);assert.throws(()=>assertNoOpenChanges(f.sql,order.order_id),/tạm dừng/);
  assert.equal(f.transaction(()=>createServiceRequest(f.sql,order.order_id,input,'customer',now)).requests.length,1);
  assert.throws(()=>f.transaction(()=>createServiceRequest(f.sql,order.order_id,{...input,reason:'Một lý do khác đã được thay đổi.'},'customer',now)),/thay đổi/);
  const result=f.transaction(()=>decideServiceRequest(f.sql,order.order_id,{request_id:first.requests[0].id,order_version:first.order_version,action:'reject',evidence:'Đã liên hệ khách và xác nhận giữ đơn.',external_cleared:false},'ops',now));
  assert.equal(result.requests[0].status,'rejected');assert.doesNotThrow(()=>assertNoOpenChanges(f.sql,order.order_id));f.db.close();
});
test('stale order version and active external lease prevent customer changes',async()=>{
  const f=await fixture(),o=f.checkout(),v=serviceDetail(f.sql,o.order_id).order_version;
  f.db.prepare('UPDATE orders SET status=status WHERE id=?').run(o.order_id);
  const input={idempotency_key:crypto.randomUUID(),order_version:v,kind:'cancel' as const,reason:'Đề nghị hủy đơn trước khi chuẩn bị.'};
  assert.throws(()=>f.transaction(()=>createServiceRequest(f.sql,o.order_id,input,'customer',now)),/vừa thay đổi/);
  f.db.prepare('UPDATE commerce_outbox SET lease_until=? WHERE order_id=?').run(now+60_000,o.order_id);
  assert.throws(()=>f.transaction(()=>createServiceRequest(f.sql,o.order_id,{...input,order_version:serviceDetail(f.sql,o.order_id).order_version},'customer',now)),/đang đồng bộ/);f.db.close();
});
test('approved cancellation completes atomically, releases held stock and cannot complete twice',async()=>{
  const f=await fixture('techcombank_qr'),o=f.checkout();let d=serviceDetail(f.sql,o.order_id);
  d=f.transaction(()=>createServiceRequest(f.sql,o.order_id,{idempotency_key:crypto.randomUUID(),order_version:d.order_version,kind:'cancel',reason:'Khách xác nhận muốn hủy đơn chưa thanh toán.'},'customer',now));
  const id=d.requests[0].id;
  d=f.transaction(()=>decideServiceRequest(f.sql,o.order_id,{request_id:id,order_version:d.order_version,action:'approve',evidence:'Đã kiểm tra chưa nhận tiền và chưa giao POS.',external_cleared:false},'ops',now));
  d=f.transaction(()=>decideServiceRequest(f.sql,o.order_id,{request_id:id,order_version:d.order_version,action:'complete',evidence:'Đã ngừng xử lý đơn và kiểm tra kho giữ.',external_cleared:false},'ops',now));
  assert.equal(receipt(f.sql,o.order_id).order_status,'canceled');assert.equal(f.db.prepare('SELECT reserved FROM inventory').get()?.reserved,0);
  assert.throws(()=>f.transaction(()=>decideServiceRequest(f.sql,o.order_id,{request_id:id,order_version:d.order_version,action:'complete',evidence:'Thử hoàn tất một lần nữa không hợp lệ.',external_cleared:false},'ops',now)),/kết thúc/);f.db.close();
});
test('paid cancellation creates a refund obligation; external uncertain creation needs explicit clearance',async()=>{
  const f=await fixture('techcombank_qr'),o=f.checkout();
  f.transaction(()=>recordEvidence(f.sql,o.order_id,'bank_transfer',proof(o),'finance',now));
  f.db.prepare('UPDATE commerce_outbox SET create_attempted=1 WHERE order_id=?').run(o.order_id);
  let d=serviceDetail(f.sql,o.order_id);
  d=f.transaction(()=>createServiceRequest(f.sql,o.order_id,{idempotency_key:crypto.randomUUID(),order_version:d.order_version,kind:'cancel',reason:'Yêu cầu hủy đơn đã thanh toán và hoàn tiền.'},'customer',now));
  const id=d.requests[0].id;
  d=f.transaction(()=>decideServiceRequest(f.sql,o.order_id,{request_id:id,order_version:d.order_version,action:'approve',evidence:'Shop duyệt yêu cầu của khách hàng.',external_cleared:false},'ops',now));
  assert.throws(()=>f.transaction(()=>decideServiceRequest(f.sql,o.order_id,{request_id:id,order_version:d.order_version,action:'complete',evidence:'Chưa xác minh bên POS đã ngừng xử lý.',external_cleared:false},'ops',now)),/POS/);
  d=f.transaction(()=>decideServiceRequest(f.sql,o.order_id,{request_id:id,order_version:d.order_version,action:'complete',evidence:'Đã xác minh POS không còn đơn hoạt động.',external_cleared:true},'ops',now));
  assert.equal(d.refunds.length,1);assert.equal(d.refunds[0].amount_vnd,o.total_vnd);assert.equal(d.money.refundable_vnd,0);f.db.close();
});
test('refund ledger caps aggregate amounts, reserves unknown outcomes, and requires independent confirmation',async()=>{
  const f=await fixture('techcombank_qr'),o=f.checkout();f.transaction(()=>recordEvidence(f.sql,o.order_id,'bank_transfer',proof(o),'finance',now));
  let d=serviceDetail(f.sql,o.order_id);
  d=f.transaction(()=>createRefund(f.sql,o.order_id,{idempotency_key:crypto.randomUUID(),order_version:d.order_version,amount_vnd:100000,reason:'Hoàn một phần theo quyết định CSKH.'},'finance-a',now));
  const id=String(d.refunds[0].id);
  assert.throws(()=>f.transaction(()=>createRefund(f.sql,o.order_id,{idempotency_key:crypto.randomUUID(),order_version:d.order_version,amount_vnd:130000,reason:'Lệnh hoàn vượt số tiền còn khả dụng.'},'finance-b',now)),/vượt/);
  d=f.transaction(()=>recordRefundResult(f.sql,o.order_id,{refund_id:id,order_version:d.order_version,status:'unknown',evidence:'Ngân hàng chưa trả kết quả, cần đối soát.'},'finance-a',now));
  assert.equal(d.money.refundable_vnd,120000);
  assert.throws(()=>f.transaction(()=>recordRefundResult(f.sql,o.order_id,{refund_id:id,order_version:d.order_version,status:'succeeded',reference:'BANK-REF-001',evidence:'Chứng từ giao dịch đã hoàn tiền thành công.'},'finance-a',now)),/người xác nhận khác/);
  d=f.transaction(()=>recordRefundResult(f.sql,o.order_id,{refund_id:id,order_version:d.order_version,status:'succeeded',reference:'BANK-REF-001',evidence:'Kế toán thứ hai đối soát chứng từ thành công.'},'finance-b',now));
  assert.equal(d.money.refunded_vnd,100000);assert.equal(d.money.refundable_vnd,120000);f.db.close();
});
test('failed refunds free the reserved amount and cannot be silently reopened',async()=>{
  const f=await fixture('techcombank_qr'),o=f.checkout();f.transaction(()=>recordEvidence(f.sql,o.order_id,'bank_transfer',proof(o),'finance',now));let d=serviceDetail(f.sql,o.order_id);
  d=f.transaction(()=>createRefund(f.sql,o.order_id,{idempotency_key:crypto.randomUUID(),order_version:d.order_version,amount_vnd:o.total_vnd,reason:'Hoàn tiền theo yêu cầu khách hàng.'},'finance-a',now));
  d=f.transaction(()=>recordRefundResult(f.sql,o.order_id,{refund_id:String(d.refunds[0].id),order_version:d.order_version,status:'failed',evidence:'Đã xác minh ngân hàng từ chối và chưa trừ tiền.'},'finance-b',now));
  assert.equal(d.money.refundable_vnd,o.total_vnd);f.db.close();
});
test('verification attempts persist, expire, bind to order and reject reused codes',async()=>{
  const f=await fixture(),o=f.checkout(),id=crypto.randomUUID();f.transaction(()=>startActionSession(f.sql,o.order_id,id,'correct',now));
  for(let i=0;i<5;i++)assert.equal(f.transaction(()=>verifyActionSession(f.sql,o.order_id,id,'wrong','token',now)).verified,false);
  assert.equal(f.transaction(()=>verifyActionSession(f.sql,o.order_id,id,'correct','token',now)).verified,false);
  const id2=crypto.randomUUID();f.transaction(()=>startActionSession(f.sql,o.order_id,id2,'correct',now+61_000));
  assert.equal(f.transaction(()=>verifyActionSession(f.sql,o.order_id,id2,'correct','token',now+62_000)).verified,true);
  assert.equal(f.transaction(()=>verifyActionSession(f.sql,o.order_id,id2,'correct','token',now+62_000)).verified,false);
  assert.doesNotThrow(()=>assertActionSession(f.sql,o.order_id,'token',now+63_000));
  assert.throws(()=>assertActionSession(f.sql,crypto.randomUUID(),'token',now+63_000),/xác minh/);
  assert.throws(()=>assertActionSession(f.sql,o.order_id,'token',now+1_000_000),/xác minh/);f.db.close();
});
test('address change is quoted against order version and leaves the original intact until approval',async()=>{
  const f=await fixture(),o=f.checkout();let d=serviceDetail(f.sql,o.order_id);
  const snap=JSON.parse(String(f.db.prepare('SELECT snapshot_json FROM commerce_orders').get()?.snapshot_json));
  const next={...f.input.recipient,address:'99 New Street'};
  const quote=f.transaction(()=>storeAddressQuote(f.sql,o.order_id,d.order_version,next,snap.shipping.offer,now));
  d=f.transaction(()=>createServiceRequest(f.sql,o.order_id,{idempotency_key:crypto.randomUUID(),order_version:d.order_version,kind:'address',reason:'Khách yêu cầu giao đến địa chỉ mới.',quote_id:quote.id},'customer',now));
  assert.equal(d.recipient.address,'12 Test Street');
  const id=d.requests[0].id;
  d=f.transaction(()=>decideServiceRequest(f.sql,o.order_id,{request_id:id,order_version:d.order_version,action:'approve',evidence:'Shop đồng ý giữ nguyên phí đã báo cho khách.',external_cleared:false},'ops',now));
  d=f.transaction(()=>decideServiceRequest(f.sql,o.order_id,{request_id:id,order_version:d.order_version,action:'complete',evidence:'Đã kiểm tra báo giá và địa chỉ trước xuất hàng.',external_cleared:false},'ops',now));
  assert.equal(d.recipient.address,'99 New Street');assert.equal(receipt(f.sql,o.order_id).total_vnd,o.total_vnd);f.db.close();
});
test('expired address quote cannot change a frozen order',async()=>{
  const f=await fixture(),o=f.checkout(),d=serviceDetail(f.sql,o.order_id),snap=JSON.parse(String(f.db.prepare('SELECT snapshot_json FROM commerce_orders').get()?.snapshot_json));
  const quote=storeAddressQuote(f.sql,o.order_id,d.order_version,f.input.recipient,snap.shipping.offer,now);
  assert.throws(()=>f.transaction(()=>createServiceRequest(f.sql,o.order_id,{idempotency_key:crypto.randomUUID(),order_version:d.order_version,kind:'address',reason:'Thay đổi địa chỉ khi báo giá đã hết hạn.',quote_id:quote.id},'customer',now+300_001)),/báo giá/);f.db.close();
});
test('returns cap per-item quantities across open requests and never restock on request completion',async()=>{
  const f=await fixture(),o=f.checkout();f.db.prepare("UPDATE commerce_orders SET pancake_order_id='pos-return' WHERE order_id=?").run(o.order_id);for(const state of ['ready_to_ship','shipped','delivered'] as const)f.transaction(()=>updateFulfillment(f.sql,o.order_id,{state,tracking_number:'GHN-return',evidence:'Bằng chứng trạng thái vận chuyển hợp lệ.'},'ops'));
  let d=serviceDetail(f.sql,o.order_id);d=f.transaction(()=>createServiceRequest(f.sql,o.order_id,{idempotency_key:crypto.randomUUID(),order_version:d.order_version,kind:'return',reason:'Một phần trái cây bị dập khi nhận hàng.',items:[{sku:'APPLE',qty:1}]},'customer'));
  assert.throws(()=>f.transaction(()=>createServiceRequest(f.sql,o.order_id,{idempotency_key:crypto.randomUUID(),order_version:d.order_version,kind:'return',reason:'Yêu cầu thêm vượt số lượng đã mua.',items:[{sku:'APPLE',qty:2}]},'customer')),/vượt/);
  assert.equal(f.db.prepare('SELECT on_hand FROM inventory').get()?.on_hand,10);f.db.close();
});
test('service notifications are leased and failed deliveries are retryable independently',async()=>{
  const f=await fixture(),o=f.checkout(),d=serviceDetail(f.sql,o.order_id);createServiceRequest(f.sql,o.order_id,{idempotency_key:crypto.randomUUID(),order_version:d.order_version,kind:'cancel',reason:'Khách đề nghị hủy đơn trước khi xử lý.'},'customer',now);
  const jobs=f.transaction(()=>serviceNotificationClaim(f.sql,now));assert.equal(jobs.length,1);assert.equal(f.transaction(()=>serviceNotificationClaim(f.sql,now)).length,0);
  serviceNotificationFinish(f.sql,String(jobs[0].id),false,now);assert.equal(f.transaction(()=>serviceNotificationClaim(f.sql,now+900_001)).length,1);f.db.close();
});
test('prepaid address increase requires the exact supplemental receipt before totals and recipient change',async()=>{
  const f=await fixture('techcombank_qr'),o=f.checkout();f.transaction(()=>recordEvidence(f.sql,o.order_id,'bank_transfer',proof(o),'finance',now));let d=serviceDetail(f.sql,o.order_id);
  const snap=JSON.parse(String(f.db.prepare('SELECT snapshot_json FROM commerce_orders').get()?.snapshot_json));
  const quote=storeAddressQuote(f.sql,o.order_id,d.order_version,{...f.input.recipient,address:'99 New Street'},{...snap.shipping.offer,customer_fee_vnd:40000,carrier_fee_vnd:50000},now);
  assert.equal(quote.customer_difference_vnd,20000);
  d=f.transaction(()=>createServiceRequest(f.sql,o.order_id,{idempotency_key:crypto.randomUUID(),order_version:d.order_version,kind:'address',reason:'Khách đồng ý phí mới khi đổi địa chỉ.',quote_id:quote.id},'customer',now));const requestId=d.requests[0].id;
  d=f.transaction(()=>decideServiceRequest(f.sql,o.order_id,{request_id:requestId,order_version:d.order_version,action:'approve',evidence:'Đã xác minh phương án giao và phí tăng.',external_cleared:false,pricing:'quoted'},'ops',now));
  const complete=()=>decideServiceRequest(f.sql,o.order_id,{request_id:requestId,order_version:d.order_version,action:'complete',evidence:'Đã nhận đủ tiền và xác nhận vận chuyển.',external_cleared:false,pricing:'quoted'},'ops',now);
  assert.throws(()=>f.transaction(complete),/chênh lệch/);assert.equal(serviceDetail(f.sql,o.order_id).recipient.address,'12 Test Street');
  d=f.transaction(()=>recordAddressAdjustment(f.sql,o.order_id,{order_version:d.order_version,request_id:requestId,transaction_id:'BANK-EXTRA-001',amount_vnd:20000,evidence:'Chứng từ ngân hàng xác nhận tiền phí bổ sung.',received_at:new Date(now).toISOString()},'finance',now));
  d=f.transaction(complete);assert.equal(d.recipient.address,'99 New Street');assert.equal(receipt(f.sql,o.order_id).total_vnd,240000);assert.equal(receipt(f.sql,o.order_id).payment_status,'paid');f.db.close();
});
test('prepaid address decrease requires a confirmed partial refund before applying the lower total',async()=>{
  const f=await fixture('techcombank_qr'),o=f.checkout();f.transaction(()=>recordEvidence(f.sql,o.order_id,'bank_transfer',proof(o),'finance',now));let d=serviceDetail(f.sql,o.order_id);
  const snap=JSON.parse(String(f.db.prepare('SELECT snapshot_json FROM commerce_orders').get()?.snapshot_json));
  const quote=storeAddressQuote(f.sql,o.order_id,d.order_version,f.input.recipient,{...snap.shipping.offer,customer_fee_vnd:10000},now);
  d=f.transaction(()=>createServiceRequest(f.sql,o.order_id,{idempotency_key:crypto.randomUUID(),order_version:d.order_version,kind:'address',reason:'Khách đổi địa chỉ có phí thấp hơn.',quote_id:quote.id},'customer',now));const requestId=d.requests[0].id;
  d=f.transaction(()=>decideServiceRequest(f.sql,o.order_id,{request_id:requestId,order_version:d.order_version,action:'approve',evidence:'Đã duyệt địa chỉ mới và phần phí giảm.',external_cleared:false,pricing:'quoted'},'ops',now));
  d=f.transaction(()=>createRefund(f.sql,o.order_id,{request_id:requestId,idempotency_key:crypto.randomUUID(),order_version:d.order_version,amount_vnd:10000,reason:'Hoàn phần chênh lệch phí giao hàng đã nhận.'},'finance-a',now));
  d=f.transaction(()=>recordRefundResult(f.sql,o.order_id,{refund_id:String(d.refunds[0].id),order_version:d.order_version,status:'succeeded',reference:'BANK-SHIPPING-REFUND',evidence:'Kế toán xác minh hoàn phần phí chênh lệch.'},'finance-b',now));
  d=f.transaction(()=>decideServiceRequest(f.sql,o.order_id,{request_id:requestId,order_version:d.order_version,action:'complete',evidence:'Đã hoàn tiền chênh lệch và xác minh giao mới.',external_cleared:false,pricing:'quoted'},'ops',now));
  assert.equal(receipt(f.sql,o.order_id).total_vnd,210000);assert.equal(d.money.refunded_vnd,10000);f.db.close();
});
test('settling an initially unpaid address change creates the confirmation outbox exactly once',async()=>{
  const f=await fixture('techcombank_qr'),o=f.checkout();let d=serviceDetail(f.sql,o.order_id);const snap=JSON.parse(String(f.db.prepare('SELECT snapshot_json FROM commerce_orders').get()?.snapshot_json));
  const quote=storeAddressQuote(f.sql,o.order_id,d.order_version,f.input.recipient,{...snap.shipping.offer,customer_fee_vnd:40000},now);
  d=f.transaction(()=>createServiceRequest(f.sql,o.order_id,{idempotency_key:crypto.randomUUID(),order_version:d.order_version,kind:'address',reason:'Khách chưa trả tiền và muốn đổi địa chỉ.',quote_id:quote.id},'customer',now));const id=d.requests[0].id;
  d=f.transaction(()=>decideServiceRequest(f.sql,o.order_id,{request_id:id,order_version:d.order_version,action:'approve',evidence:'Shop duyệt địa chỉ và hướng dẫn trả tổng mới.',external_cleared:false,pricing:'quoted'},'ops',now));
  d=f.transaction(()=>recordAddressAdjustment(f.sql,o.order_id,{request_id:id,order_version:d.order_version,transaction_id:'BANK-NEW-TOTAL',amount_vnd:240000,evidence:'Kế toán xác minh đã nhận đầy đủ tổng tiền mới.',received_at:new Date(now).toISOString()},'finance',now));
  f.transaction(()=>decideServiceRequest(f.sql,o.order_id,{request_id:id,order_version:d.order_version,action:'complete',evidence:'Hoàn tất thay đổi sau khi nhận đủ tổng tiền mới.',external_cleared:false,pricing:'quoted'},'ops',now));
  assert.equal(receipt(f.sql,o.order_id).order_status,'paid');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM commerce_outbox').get()?.n,1);f.db.close();
});
test('late credit after cancellation remains canceled and can be refunded with bank evidence',async()=>{
  const f=await fixture('techcombank_qr'),o=f.checkout();f.transaction(()=>cancelPendingOrder(f.sql,o.order_id,'Đã kiểm tra chưa có tiền trước khi hủy.','ops'));
  f.transaction(()=>recordEvidence(f.sql,o.order_id,'bank_transfer',proof(o),'finance',now));let d=serviceDetail(f.sql,o.order_id);
  d=f.transaction(()=>createRefund(f.sql,o.order_id,{idempotency_key:crypto.randomUUID(),order_version:d.order_version,amount_vnd:o.total_vnd,reason:'Hoàn khoản chuyển muộn sau khi đơn đã hủy.'},'finance-a',now));
  f.transaction(()=>recordRefundResult(f.sql,o.order_id,{refund_id:String(d.refunds[0].id),order_version:d.order_version,status:'succeeded',reference:'BANK-LATE-REFUND',evidence:'Đã đối soát chứng từ hoàn khoản nhận muộn.'},'finance-b',now));
  assert.equal(receipt(f.sql,o.order_id).order_status,'canceled');assert.equal(receipt(f.sql,o.order_id).payment_status,'refunded');assert.throws(()=>assertNoOpenChanges(f.sql,o.order_id),/đối soát/);f.db.close();
});
test('configured hold expiry releases only an eligible unpaid order and refuses a paid order',async()=>{
  const f=await fixture('techcombank_qr'),o=f.checkout();assert.throws(()=>f.transaction(()=>expireServiceHold(f.sql,o.order_id,now)),/đủ điều kiện/);
  f.transaction(()=>expireServiceHold(f.sql,o.order_id,Number(o.expires_at)+1));assert.equal(receipt(f.sql,o.order_id).order_status,'canceled');assert.equal(f.db.prepare('SELECT reserved FROM inventory').get()?.reserved,0);f.db.close();
  const paid=await fixture('techcombank_qr'),p=paid.checkout();paid.transaction(()=>recordEvidence(paid.sql,p.order_id,'bank_transfer',proof(p),'finance',now));assert.throws(()=>paid.transaction(()=>expireServiceHold(paid.sql,p.order_id,Number(p.expires_at)+1)),/đủ điều kiện/);paid.db.close();
});
test('return completion requires a traceable resolution and never increases sellable stock',async()=>{
  const f=await fixture(),o=f.checkout();f.db.prepare("UPDATE commerce_orders SET pancake_order_id='pos-quality',fulfillment_status='delivered' WHERE order_id=?").run(o.order_id);let d=serviceDetail(f.sql,o.order_id);
  d=f.transaction(()=>createServiceRequest(f.sql,o.order_id,{idempotency_key:crypto.randomUUID(),order_version:d.order_version,kind:'return',reason:'Kiểm tra lô hàng có trái cây bị dập.',items:[{sku:'APPLE',qty:1}]},'customer',now));const id=d.requests[0].id;
  d=f.transaction(()=>decideServiceRequest(f.sql,o.order_id,{request_id:id,order_version:d.order_version,action:'approve',evidence:'Shop duyệt kiểm tra hàng đã nhận lại.',external_cleared:false,pricing:'quoted'},'ops',now));
  assert.throws(()=>f.transaction(()=>decideServiceRequest(f.sql,o.order_id,{request_id:id,order_version:d.order_version,action:'complete',evidence:'Chưa có mã theo dõi đơn giao bù.',external_cleared:false,pricing:'quoted',resolution:'replacement'},'ops',now)),/mã đơn/);
  f.transaction(()=>decideServiceRequest(f.sql,o.order_id,{request_id:id,order_version:d.order_version,action:'complete',evidence:'Kiểm tra lô và cách ly hàng thu hồi.',external_cleared:false,pricing:'quoted',resolution:'return_inspection',lot_reference:'LOT-TEST-001',disposition:'quarantine'},'ops',now));
  assert.equal(f.db.prepare('SELECT disposition FROM commerce_return_outcomes').get()?.disposition,'quarantine');assert.equal(f.db.prepare('SELECT on_hand FROM inventory').get()?.on_hand,10);f.db.close();
});
test('COD creates order, snapshot, unpaid payment, holds and outbox atomically; exact retry does not duplicate', async () => {
  const f = await fixture();
  const first = f.checkout(),
    second = f.checkout();
  assert.equal(first.order_id, second.order_id);
  assert.equal(first.payment_status, 'unpaid');
  assert.equal(first.cod_status, 'to_collect');
  assert.equal(first.amount_to_collect_vnd, 220000);
  for (const table of [
    'orders',
    'order_items',
    'commerce_orders',
    'commerce_outbox',
  ])
    assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n, 1);
  assert.equal(
    f.db.prepare('SELECT reserved FROM warehouse_inventory').get()?.reserved,
    2,
  );
  assert.equal(
    f.db.prepare('SELECT status FROM carts').get()?.status,
    'checked_out',
  );
  f.db.close();
});
test('changed retry and second key for same cart cannot create a second order', async () => {
  const f = await fixture();
  f.checkout();
  assert.throws(
    () =>
      f.transaction(() =>
        confirmCheckout(f.sql, { ...f.input, note: 'changed' }, f.cfg, now),
      ),
    /thay đổi/,
  );
  assert.throws(
    () =>
      f.transaction(() =>
        confirmCheckout(
          f.sql,
          { ...f.input, idempotency_key: crypto.randomUUID() },
          f.cfg,
          now,
        ),
      ),
    /đã có đơn/,
  );
  f.db.close();
});
test('late SQL failure rolls back inventory, order, items, cart and outbox', async () => {
  const f = await fixture();
  f.db.exec(
    "CREATE TRIGGER fail_items BEFORE INSERT ON order_items BEGIN SELECT RAISE(ABORT,'disk failure'); END",
  );
  assert.throws(f.checkout, /disk failure/);
  for (const table of ['orders', 'commerce_orders', 'commerce_outbox'])
    assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n, 0);
  assert.equal(
    f.db.prepare('SELECT reserved FROM warehouse_inventory').get()?.reserved,
    0,
  );
  assert.equal(f.db.prepare('SELECT status FROM carts').get()?.status, 'open');
  f.db.close();
});
test('expired quote, changed price, stock, address, method, policy and environment all block checkout', async () => {
  for (const change of [
    'expiry',
    'price',
    'stock',
    'address',
    'method',
    'policy',
    'environment',
  ]) {
    const f = await fixture();
    let input = f.input,
      cfg = f.cfg,
      time = now;
    if (change === 'expiry') time += 300001;
    if (change === 'price')
      f.db.exec('UPDATE variant_prices SET price_cents=99999');
    if (change === 'stock')
      f.db.exec('UPDATE warehouse_inventory SET reserved=9');
    if (change === 'address')
      input = {
        ...input,
        recipient: { ...input.recipient, address: 'Changed Street' },
      };
    if (change === 'method')
      input = { ...input, payment_method: 'techcombank_qr' };
    if (change === 'policy') cfg = { ...cfg, policy_key: 'changed' };
    if (change === 'environment') cfg = { ...cfg, environment: 'production' };
    assert.throws(
      () => f.transaction(() => confirmCheckout(f.sql, input, cfg, time)),
      undefined,
      change,
    );
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get()?.n, 0);
    f.db.close();
  }
});
test('integer money, cart total confirmation, fresh inventory and verified SKU mapping are enforced', async () => {
  for (const change of ['total', 'stale', 'mapping', 'bank', 'currency']) {
    const f = await fixture('techcombank_qr');
    let input = f.input,
      cfg = f.cfg;
    if (change === 'total') input = { ...input, expected_total_vnd: 219999 };
    if (change === 'stale')
      f.db.exec("UPDATE pancake_sync_state SET last_completed_at='2000-01-01'");
    if (change === 'mapping')
      f.db.exec("DELETE FROM pancake_links WHERE kind='variation'");
    if (change === 'bank') cfg = { ...cfg, bank: null };
    if (change === 'currency')
      f.db.exec('UPDATE currencies SET decimal_places=2');
    assert.throws(
      () => f.transaction(() => confirmCheckout(f.sql, input, cfg, now)),
      undefined,
      change,
    );
    f.db.close();
  }
  assert.equal(
    checkoutInput.safeParse({ expected_total_vnd: 1.1 }).success,
    false,
  );
});
function proof(order: ReturnType<typeof receipt>, amount = order.total_vnd) {
  return {
    transaction_id: 'TCB-001',
    amount_vnd: amount,
    currency: 'VND' as const,
    reference: order.reference,
    received_at: new Date(now).toISOString(),
    evidence: 'Sao ke TCB: credit transaction verified',
  };
}
test('bank QR stays pending without evidence; exact receipt is deduplicated and prepaid COD is zero', async () => {
  const f = await fixture('techcombank_qr');
  const order = f.checkout();
  assert.equal(order.payment_status, 'pending');
  assert.equal(order.pos_sync_status, 'waiting_payment');
  const p = proof(order);
  const paid = f.transaction(() =>
    recordEvidence(
      f.sql,
      order.order_id,
      'bank_transfer',
      p,
      'accountant',
      now,
    ),
  );
  assert.equal(paid.payment_status, 'paid');
  assert.equal(paid.amount_to_collect_vnd, 0);
  f.transaction(() =>
    recordEvidence(
      f.sql,
      order.order_id,
      'bank_transfer',
      p,
      'accountant',
      now,
    ),
  );
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM commerce_transactions').get()?.n,
    1,
  );
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM commerce_outbox').get()?.n,
    1,
  );
  assert.throws(
    () =>
      f.transaction(() =>
        recordEvidence(
          f.sql,
          order.order_id,
          'bank_transfer',
          { ...p, amount_vnd: 123 },
          'accountant',
          now,
        ),
      ),
    /dữ liệu khác/,
  );
  f.db.close();
});
test('underpayment, overpayment, wrong reference and late payment need attention; further receipts never auto-clear exceptions', async () => {
  for (const change of ['under', 'over', 'reference', 'late']) {
    const f = await fixture('techcombank_qr'),
      order = f.checkout();
    const p = proof(
      order,
      change === 'under' ? 1 : change === 'over' ? 230000 : 220000,
    );
    if (change === 'reference') p.reference = 'wrong-ref';
    const result = f.transaction(() =>
      recordEvidence(
        f.sql,
        order.order_id,
        'bank_transfer',
        p,
        'accountant',
        change === 'late' ? now + 86400_001 : now,
      ),
    );
    assert.equal(result.payment_status, 'needs_attention');
    assert.equal(
      f.db.prepare('SELECT COUNT(*) n FROM commerce_outbox').get()?.n,
      0,
    );
    const again = f.transaction(() =>
      recordEvidence(
        f.sql,
        order.order_id,
        'bank_transfer',
        { ...proof(order), transaction_id: 'TCB-002' },
        'accountant',
        now,
      ),
    );
    assert.equal(again.payment_status, 'needs_attention');
    f.db.close();
  }
});
test('delivered never implies collected; collected never implies reconciled; stale fulfillment is rejected', async () => {
  const f = await fixture(),
    order = f.checkout();
  f.transaction(() => {
    claimOutbox(f.sql, order.order_id, 'lease', now);
    finishOutbox(f.sql, order.order_id, 'lease', 'pos-001', null);
  });
  for (const state of ['ready_to_ship', 'shipped', 'delivered'] as const)
    f.transaction(() =>
      updateFulfillment(
        f.sql,
        order.order_id,
        {
          state,
          tracking_number: 'GHN-001',
          evidence: 'Verified POS shipping evidence',
        },
        'ops',
      ),
    );
  assert.equal(receipt(f.sql, order.order_id).payment_status, 'unpaid');
  assert.throws(
    () =>
      updateFulfillment(
        f.sql,
        order.order_id,
        { state: 'shipped', evidence: 'Stale POS event' },
        'ops',
      ),
    /lùi/,
  );
  assert.throws(
    () =>
      recordEvidence(
        f.sql,
        order.order_id,
        'cod_reconciled',
        proof(order),
        'accountant',
        now,
      ),
    /thu COD/,
  );
  const collected = f.transaction(() =>
    recordEvidence(
      f.sql,
      order.order_id,
      'cod_collected',
      proof(order),
      'ops',
      now,
    ),
  );
  assert.equal(collected.cod_status, 'collected');
  const reconciled = f.transaction(() =>
    recordEvidence(
      f.sql,
      order.order_id,
      'cod_reconciled',
      { ...proof(order), transaction_id: 'settlement-1' },
      'accountant',
      now,
    ),
  );
  assert.equal(reconciled.cod_status, 'reconciled');
  f.db.close();
});
test('cancellation releases held stock once; canceled bank credit is audited and never dispatched', async () => {
  const f = await fixture('techcombank_qr'),
    order = f.checkout();
  f.transaction(() =>
    cancelPendingOrder(
      f.sql,
      order.order_id,
      'Bank statement checked, no funds received',
      'accountant',
    ),
  );
  f.transaction(() =>
    cancelPendingOrder(
      f.sql,
      order.order_id,
      'Duplicate cancellation request',
      'accountant',
    ),
  );
  assert.equal(
    f.db.prepare('SELECT reserved FROM warehouse_inventory').get()?.reserved,
    0,
  );
  const late = f.transaction(() =>
    recordEvidence(
      f.sql,
      order.order_id,
      'bank_transfer',
      proof(order),
      'accountant',
      now,
    ),
  );
  assert.equal(late.payment_status, 'needs_attention');
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM commerce_outbox').get()?.n,
    0,
  );
  f.db.close();
});
test('outbox lease serializes dispatch and records uncertain creation before I/O; stock consumed once', async () => {
  const f = await fixture(),
    o = f.checkout();
  f.transaction(() => claimOutbox(f.sql, o.order_id, 'a', now));
  assert.throws(() => claimOutbox(f.sql, o.order_id, 'b', now), /Đang đồng bộ/);
  f.transaction(() => markCreateAttempt(f.sql, o.order_id, 'a'));
  f.transaction(() => finishOutbox(f.sql, o.order_id, 'a', null, 'timeout'));
  const retry = f.transaction(() => claimOutbox(f.sql, o.order_id, 'b', now));
  assert.equal(retry?.create_attempted, 1);
  f.transaction(() => finishOutbox(f.sql, o.order_id, 'b', '123', null));
  assert.equal(
    f.db.prepare('SELECT reserved FROM warehouse_inventory').get()?.reserved,
    0,
  );
  assert.equal(
    f.db.prepare('SELECT on_hand FROM warehouse_inventory').get()?.on_hand,
    8,
  );
  assert.equal(claimOutbox(f.sql, o.order_id, 'c', now), null);
  f.db.close();
});
test('order capability rejects tampering, cross-order and cross-store tokens', async () => {
  const id = crypto.randomUUID(),
    secret = 'private-test-secret-longer-than-32-characters',
    token = await commerceToken(id, secret);
  assert.equal(await verifyCommerceToken(id, token, secret), true);
  assert.equal(
    await verifyCommerceToken(crypto.randomUUID(), token, secret),
    false,
  );
  assert.equal(
    await verifyCommerceToken(id, token, secret + ':other-store'),
    false,
  );
  assert.equal(await verifyCommerceToken(id, '0'.repeat(64), secret), false);
  assert.equal(await verifyCommerceToken(id, 'invalid', secret), false);
});
test('POS timeout never repeats create even when lookup currently returns empty', async () => {
  const f = await fixture(),
    order = f.checkout();
  const calls: string[] = [];
  const db = {
    commerceClaim: async (id: string, token: string) =>
      shippingResult(() => f.transaction(() => claimOutbox(f.sql, id, token))),
    commerceMarkCreate: async (id: string, token: string) =>
      shippingResult(() =>
        f.transaction(() => markCreateAttempt(f.sql, id, token)),
      ),
    commerceFinish: async (
      id: string,
      token: string,
      pos: string | null,
      error: string | null,
    ) =>
      shippingResult(() =>
        f.transaction(() => finishOutbox(f.sql, id, token, pos, error)),
      ),
  } as DOStub;
  const env = {
    PANCAKE_ORDER_SYNC_ENABLED: 'true',
    PANCAKE_API_KEY: 'test-key',
    PANCAKE_SHOP_ID: 'shop',
    PANCAKE_WAREHOUSE_ID: 'w',
    SMART_SHIPPING_ENABLED: 'true',
    SMART_SHIPPING_POLICY: JSON.stringify(config.policy),
    GHN_TOKEN: 'test-ghn-token', GHN_SHOP_ID: '1', GHN_FROM_DISTRICT_ID: '1', GHN_FROM_WARD_CODE: '001',
  };
  mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const path = new URL(String(_url)).pathname;
    if (path.endsWith('/master-data/province')) return Response.json({ code: 200, data: [{ ProvinceID: 2, ProvinceName: 'HCM' }] });
    if (path.endsWith('/master-data/district')) return Response.json({ code: 200, data: [{ DistrictID: 3, ProvinceID: 2, DistrictName: 'Test District' }] });
    if (path.endsWith('/master-data/ward')) return Response.json({ code: 200, data: [{ WardCode: '0004', DistrictID: 3, WardName: 'Test Ward' }] });
    if (path.endsWith('/geo/provinces')) return Response.json({ data: [{ id: '701', name: 'HCM' }] });
    if (path.endsWith('/geo/districts')) return Response.json({ data: [{ id: '70101', name: 'Test District' }] });
    if (path.endsWith('/geo/communes')) return Response.json({ data: [{ id: '7010101', name: 'Test Ward' }] });
    calls.push(init.method || 'GET');
    if (init.method === 'POST') throw Error('timeout');
    return Response.json({ data: [] });
  });
  await assert.rejects(() =>
    syncCommerceOrder(env as never, db, order.order_id),
  );
  await assert.rejects(() =>
    syncCommerceOrder(env as never, db, order.order_id),
  );
  assert.equal(calls.filter((c) => c === 'POST').length, 1);
  assert.equal(
    receipt(f.sql, order.order_id).pos_sync_status,
    'needs_attention',
  );
  f.db.close();
});
test('bank exception resolution accounts for all receipts and requires proof of excess refund', async () => {
  const f = await fixture('techcombank_qr'),
    order = f.checkout();
  f.transaction(() =>
    recordEvidence(
      f.sql,
      order.order_id,
      'bank_transfer',
      proof(order, 230000),
      'accountant',
      now,
    ),
  );
  assert.throws(
    () =>
      resolveBankException(
        f.sql,
        order.order_id,
        {
          transaction_ids: ['TCB-001'],
          evidence: 'Verified receipt and refund evidence',
          refunded_vnd: 10000,
        },
        'accountant',
      ),
    /mã chứng từ/,
  );
  const result = f.transaction(() =>
    resolveBankException(
      f.sql,
      order.order_id,
      {
        transaction_ids: ['TCB-001'],
        evidence: 'Verified bank receipt and bank refund 10000 VND',
        refunded_vnd: 10000,
        refund_reference: 'TCB-refund-verified',
      },
      'accountant',
    ),
  );
  assert.equal(result.payment_status, 'paid');
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM commerce_audit').get()?.n,
    1,
  );
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM commerce_outbox').get()?.n,
    1,
  );
  f.db.close();
});
test('tax included in COD quotation matches final integer checkout total', async () => {
  const f = await fixture();
  f.db.exec(
    "INSERT INTO tax_rates(id,display_name,rate_percentage,country_code) VALUES('vat','VAT',10,'VN')",
  );
  const cart = loadShippingCart(f.sql, f.input.cart_id);
  assert.equal(cart.tax_extra_vnd, 20000);
  const cfg = {
    token: 'fake-test-token',
    shop_id: 1,
    from_district_id: 1,
    from_ward_code: '001',
    environment: 'staging' as const,
    policy: f.cfg.policy,
  };
  const old = JSON.parse(
    String(
      f.sql.exec('SELECT quote_json FROM shipping_quotes').toArray()[0]
        .quote_json,
    ),
  );
  const quote = (
    await calculateShipping(
      cart,
      old.request,
      cfg,
      [
        {
          code: 'fixture',
          quote: async ({ parcel }) => {
            assert.equal(parcel.goods_value_vnd, 220000);
            return {
              offers: [{ ...old.offers[0], cod_value_vnd: 240000 }],
              warnings: [],
            };
          },
        },
      ],
      now,
    )
  ).quote!;
  storeShippingQuote(f.sql, quote, now);
  selectShippingQuote(
    f.sql,
    cart.id,
    quote.id,
    quote.offers[0].id,
    quote.policy_key,
    now,
  );
  const order = f.transaction(() =>
    confirmCheckout(
      f.sql,
      { ...f.input, expected_total_vnd: 240000 },
      { ...f.cfg, policy_key: quote.policy_key },
      now,
    ),
  );
  assert.equal(order.total_vnd, 240000);
  assert.equal(order.amount_to_collect_vnd, 240000);
  assert.equal(order.totals.tax_vnd, 20000);
  f.db.close();
});
