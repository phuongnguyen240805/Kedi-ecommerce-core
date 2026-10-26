import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { authMiddleware, adminOnly } from '../middleware/auth';
import { ApiError, type HonoEnv } from '../types';
import {
  checkoutInput,
  evidenceInput,
  fulfillmentInput,
  bankResolutionInput,
  type CommerceReceipt,
} from '../lib/commerce-core';
import { commerceToken, verifyCommerceToken } from '../lib/commerce-token';
import {
  ShippingError,
  shippingConfiguration,
  hashShipping,
  policyIdentity,
} from '../lib/smart-shipping';
import { unwrapShipping } from '../lib/shipping-store';
import { processCommerceOrder as syncCommerceOrder } from '../lib/commerce-shipment';
import { syncCommerceShipment } from '../lib/commerce-shipment';

const app = new OpenAPIHono<HonoEnv>();
app.use('*', bodyLimit({ maxSize: 8192 }), authMiddleware);
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  try {
    await next();
  } catch (error) {
    if (error instanceof ShippingError)
      throw new ApiError(error.code, error.status, error.message);
    throw error;
  }
});
const response = {
  description: 'Commerce response',
  content: {
    'application/json': { schema: z.record(z.string(), z.unknown()) },
  },
};
const responses = {
  200: response,
  400: { description: 'Invalid input' },
  401: { description: 'Not authenticated' },
  403: { description: 'Not authorized' },
  404: { description: 'Order not found' },
  409: { description: 'Checkout changed or invalid state' },
  422: { description: 'Unsupported cart' },
  503: { description: 'Feature not configured' },
};
const params = z.object({ orderId: z.string().uuid() });
app.openapi(createRoute({method:'get',path:'/admin/storage-bookmark',tags:['Commerce operations'],middleware:[adminOnly] as const,responses}),async c=>{
 const stub=c.env.MERCHANT.get(c.env.MERCHANT.idFromName(c.env.STORE_OBJECT_NAME||'default'));
 return c.json(await stub.commerceStorageBookmark(),200);
});
function bank(env: HonoEnv['Bindings']) {
  return /^\d{6,20}$/.test(env.TECHCOMBANK_ACCOUNT_NUMBER || '') &&
    (env.TECHCOMBANK_ACCOUNT_NAME || '').trim().length >= 2
    ? {
        account_number: env.TECHCOMBANK_ACCOUNT_NUMBER!,
        account_name: env.TECHCOMBANK_ACCOUNT_NAME!.trim(),
      }
    : null;
}
function presentation(order: CommerceReceipt) {
  let qr_url: string | null = null;
  if (
    order.bank &&
    order.payment_status === 'pending' &&
    order.expires_at > Date.now()
  ) {
    const url = new URL(
      `https://img.vietqr.io/image/techcombank-${order.bank.account_number}-compact2.png`,
    );
    url.searchParams.set('amount', String(order.total_vnd));
    url.searchParams.set('addInfo', order.reference);
    url.searchParams.set('accountName', order.bank.account_name);
    qr_url = url.href;
  }
  return {
    ...order,
    qr_url,
    payment_expired:
      order.payment_method === 'techcombank_qr' &&
      order.expires_at <= Date.now() &&
      order.payment_status !== 'paid',
  };
}
function actor(c: { var: HonoEnv['Variables'] }) {
  return c.var.auth.sub || 'admin-api-key';
}
app.openapi(
  createRoute({
    method: 'get',
    path: '/methods',
    tags: ['Commerce phase 1'],
    responses,
  }),
  (c) =>
    c.json(
      {
        enabled: c.env.COMMERCE_CHECKOUT_ENABLED === 'true',
        methods: [
          {
            id: 'cod',
            label: 'Thanh toán khi nhận hàng',
            enabled: c.env.COMMERCE_CHECKOUT_ENABLED === 'true',
          },
          {
            id: 'techcombank_qr',
            label: 'Chuyển khoản QR Techcombank',
            enabled:
              c.env.COMMERCE_CHECKOUT_ENABLED === 'true' && !!bank(c.env),
          },
        ],
        bank: bank(c.env),
        verification: 'manual_bank_statement',
      },
      200,
    ),
);
app.openapi(
  createRoute({
    method: 'post',
    path: '/checkout/confirm',
    tags: ['Commerce phase 1'],
    middleware: [adminOnly] as const,
    request: {
      body: { content: { 'application/json': { schema: checkoutInput } } },
    },
    responses,
  }),
  async (c) => {
    if (!c.env.ORDER_TOKEN_SECRET || c.env.ORDER_TOKEN_SECRET.length < 32)
      throw new ShippingError(
        'tracking_not_configured',
        503,
        'Chưa cấu hình bảo vệ tra cứu đơn.',
      );
    const input = c.req.valid('json');
    const replay = unwrapShipping(await c.var.db.commerceReplay(input));
    if (replay)
      return c.json(
        {
          ...presentation(replay),
          tracking_token: await commerceToken(
            replay.order_id,
            c.env.ORDER_TOKEN_SECRET,
          ),
        },
        200,
      );
    if (c.env.COMMERCE_CHECKOUT_ENABLED !== 'true')
      throw new ShippingError(
        'checkout_disabled',
        503,
        'Checkout giai đoạn 1 chưa được bật.',
      );
    const shipping = shippingConfiguration(c.env);
    if (!c.env.COMMERCE_ENVIRONMENT)
      throw new ShippingError(
        'commerce_environment_missing',
        503,
        'Cần chỉ rõ môi trường checkout.',
      );
    const order = unwrapShipping(
      await c.var.db.confirmCommerceCheckout(input, {
        policy: shipping.policy,
        policy_key: await hashShipping(policyIdentity(shipping)),
        environment: c.env.COMMERCE_ENVIRONMENT,
        bank: bank(c.env),
        shop_id: c.env.PANCAKE_SHOP_ID || '',
        warehouse_id: c.env.PANCAKE_WAREHOUSE_ID || '',
        dispatch_enabled: c.env.PANCAKE_GHN_DISPATCH_ENABLED === 'true',
        dispatch_account_id: c.env.PANCAKE_GHN_ACCOUNT_ID,
      }),
    );
    if (
      c.env.PANCAKE_ORDER_SYNC_ENABLED === 'true' &&
      order.payment_method === 'cod'
    )
      c.executionCtx.waitUntil(
        syncCommerceOrder(c.env, c.var.db, order.order_id).catch(() =>
          console.warn(
            JSON.stringify({
              event: 'commerce.pos.needs_attention',
              order_id: order.order_id,
            }),
          ),
        ),
      );
    return c.json(
      {
        ...presentation(order),
        tracking_token: await commerceToken(
          order.order_id,
          c.env.ORDER_TOKEN_SECRET,
        ),
      },
      200,
    );
  },
);
app.openapi(
  createRoute({
    method: 'post',
    path: '/track',
    tags: ['Commerce phase 1'],
    request: {
      body: {
        content: {
          'application/json': {
            schema: z
              .object({
                order_id: z.string().uuid(),
                token: z.string().regex(/^[a-f0-9]{64}$/),
              })
              .strict(),
          },
        },
      },
    },
    responses,
  }),
  async (c) => {
    const { order_id, token } = c.req.valid('json');
    if (
      !c.env.ORDER_TOKEN_SECRET ||
      !(await verifyCommerceToken(order_id, token, c.env.ORDER_TOKEN_SECRET))
    )
      throw ApiError.notFound(
        'Không tìm thấy đơn hoặc mã tra cứu không hợp lệ.',
      );
    const order = unwrapShipping(await c.var.db.commerceReceipt(order_id));
    if (Date.now() > order.expires_at + 90 * 86400_000)
      throw ApiError.notFound('Mã tra cứu hết hạn. Vui lòng liên hệ shop.');
    if (order.pos_sync_status === 'synced' && c.env.PANCAKE_ORDER_SYNC_ENABLED === 'true')
      c.executionCtx.waitUntil(syncCommerceShipment(c.env, c.var.db, order_id).catch(() => {
        console.warn(JSON.stringify({ event: 'commerce.shipment.needs_attention', order_id }));
      }));
    return c.json(presentation(order), 200);
  },
);
for (const kind of [
  'bank_transfer',
  'cod_collected',
  'cod_reconciled',
] as const) {
  app.openapi(
    createRoute({
      method: 'post',
      path: `/admin/orders/{orderId}/${kind}`,
      tags: ['Commerce operations'],
      middleware: [adminOnly] as const,
      request: {
        params,
        body: { content: { 'application/json': { schema: evidenceInput } } },
      },
      responses,
    }),
    async (c) => {
      const order = unwrapShipping(
        await c.var.db.commerceEvidence(
          c.req.valid('param').orderId,
          kind,
          c.req.valid('json'),
          actor(c),
        ),
      );
      if (
        kind === 'bank_transfer' &&
        order.payment_status === 'paid' &&
        c.env.PANCAKE_ORDER_SYNC_ENABLED === 'true'
      )
        c.executionCtx.waitUntil(
          syncCommerceOrder(c.env, c.var.db, order.order_id).catch(() =>
            console.warn(
              JSON.stringify({
                event: 'commerce.pos.needs_attention',
                order_id: order.order_id,
              }),
            ),
          ),
        );
      return c.json(presentation(order), 200);
    },
  );
}
app.openapi(
  createRoute({
    method: 'post',
    path: '/admin/orders/{orderId}/fulfillment',
    tags: ['Commerce operations'],
    middleware: [adminOnly] as const,
    request: {
      params,
      body: { content: { 'application/json': { schema: fulfillmentInput } } },
    },
    responses,
  }),
  async (c) =>
    c.json(
      presentation(
        unwrapShipping(
          await c.var.db.commerceFulfillment(
            c.req.valid('param').orderId,
            c.req.valid('json'),
            actor(c),
          ),
        ),
      ),
      200,
    ),
);
app.openapi(
  createRoute({
    method: 'post', path: '/admin/orders/{orderId}/dispatch', tags: ['Commerce operations'],
    description: 'Authorize and send one order through Pancake, independently of automatic booking for future orders.',
    middleware: [adminOnly] as const,
    request: { params, body: { content: { 'application/json': { schema: z.object({ evidence: z.string().trim().min(10).max(1000) }).strict() } } } },
    responses,
  }),
  async c => {
    const id = c.req.valid('param').orderId;
    unwrapShipping(await c.var.db.commerceShipmentAuthorize(id, c.env.PANCAKE_GHN_ACCOUNT_ID || '', c.req.valid('json').evidence, actor(c)));
    await syncCommerceShipment({ ...c.env, PANCAKE_GHN_DISPATCH_ENABLED: 'true' }, c.var.db, id);
    return c.json(presentation(unwrapShipping(await c.var.db.commerceReceipt(id))), 200);
  },
);
app.openapi(
  createRoute({
    method: 'post',
    path: '/admin/orders/{orderId}/sync-pos',
    tags: ['Commerce operations'],
    middleware: [adminOnly] as const,
    request: { params },
    responses,
  }),
  async (c) =>
    c.json(
      await syncCommerceOrder(c.env, c.var.db, c.req.valid('param').orderId),
      200,
    ),
);
app.openapi(
  createRoute({
    method: 'get',
    path: '/admin/exceptions',
    tags: ['Commerce operations'],
    middleware: [adminOnly] as const,
    responses,
  }),
  async (c) => {
    // Lazily initialize new tables without modifying historical orders.
    const stub = c.env.MERCHANT.get(
      c.env.MERCHANT.idFromName(c.env.STORE_OBJECT_NAME || 'default'),
    );
    await stub.commerceOverviewInit();
    const items = await c.var.db.query(
      `SELECT c.order_id,o.number,c.method,c.payment_status,c.cod_status,c.fulfillment_status,c.pancake_order_id,c.expires_at,b.state AS pos_sync_status,b.last_error,s.state AS shipment_status,s.last_error AS shipment_error
 FROM commerce_orders c JOIN orders o ON o.id=c.order_id LEFT JOIN commerce_outbox b ON b.order_id=c.order_id LEFT JOIN commerce_shipments s ON s.order_id=c.order_id
 WHERE c.payment_status='needs_attention' OR (c.payment_status='pending' AND c.expires_at<?) OR (b.state IS NOT NULL AND b.state!='synced') OR s.state='needs_attention' OR (c.fulfillment_status='delivered' AND c.cod_status NOT IN ('reconciled','not_applicable'))
 ORDER BY c.updated_at LIMIT 100`,
      [Date.now()],
    );
    return c.json({ items }, 200);
  },
);
export const commerce = app;
app.openapi(
  createRoute({
    method: 'post',
    path: '/admin/orders/{orderId}/cancel',
    tags: ['Commerce operations'],
    middleware: [adminOnly] as const,
    request: {
      params,
      body: {
        content: {
          'application/json': {
            schema: z
              .object({ evidence: z.string().trim().min(10).max(1000) })
              .strict(),
          },
        },
      },
    },
    responses,
  }),
  async (c) =>
    c.json(
      presentation(
        unwrapShipping(
          await c.var.db.commerceCancel(
            c.req.valid('param').orderId,
            c.req.valid('json').evidence,
            actor(c),
          ),
        ),
      ),
      200,
    ),
);

app.openapi(
  createRoute({
    method: 'post',
    path: '/admin/orders/{orderId}/resolve-bank',
    tags: ['Commerce operations'],
    middleware: [adminOnly] as const,
    request: {
      params,
      body: {
        content: { 'application/json': { schema: bankResolutionInput } },
      },
    },
    responses,
  }),
  async (c) => {
    const order = unwrapShipping(
      await c.var.db.commerceResolveBank(
        c.req.valid('param').orderId,
        c.req.valid('json'),
        actor(c),
      ),
    );
    if (c.env.PANCAKE_ORDER_SYNC_ENABLED === 'true')
      c.executionCtx.waitUntil(
        syncCommerceOrder(c.env, c.var.db, order.order_id).catch(() =>
          console.warn(
            JSON.stringify({
              event: 'commerce.pos.needs_attention',
              order_id: order.order_id,
            }),
          ),
        ),
      );
    return c.json(presentation(order), 200);
  },
);
