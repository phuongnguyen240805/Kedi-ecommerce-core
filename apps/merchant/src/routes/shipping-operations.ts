import { OpenAPIHono, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { authMiddleware, adminOnly, hashKey } from '../middleware/auth';
import { ApiError, type HonoEnv } from '../types';
import { ShippingError, hashShipping } from '../lib/smart-shipping';
import { carrierAccounts, carrierWebhookSecret } from '../lib/shipping-registry';
import { shippingCommandInput, prepareExternalLegInput } from '../lib/shipping-workflow';
import { runShippingCommand, processShippingWork } from '../lib/shipping-runner';
import { unwrapShipping } from '../lib/shipping-store';
import { readJson } from '../lib/read-json';

const operations = new OpenAPIHono<HonoEnv>();
operations.use('*', bodyLimit({ maxSize: 16384 }), authMiddleware, adminOnly);
operations.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  try {
    await next();
  } catch (error) {
    if (error instanceof z.ZodError)
      throw ApiError.badRequest('Invalid shipping operation input');
    if (error instanceof ShippingError)
      throw new ApiError(error.code, error.status, error.message);
    throw error;
  }
});
operations.get('/orders/:orderId', async (c) => {
  const id = z.string().uuid().parse(c.req.param('orderId'));
  return c.json(unwrapShipping(await c.var.db.shippingOverview(id)));
});
operations.get('/queue', async (c) => c.json(await c.var.db.shippingQueue()));
operations.post('/commands/:commandId/retry', async (c) => {
  const id = z.string().uuid().parse(c.req.param('commandId'));
  const command = unwrapShipping(
    await c.var.db.shippingRetry(id, c.var.auth.sub || 'admin-api-key'),
  );
  c.executionCtx.waitUntil(runShippingCommand(c.env, c.var.db, id).catch(() => {}));
  return c.json(command, 202);
});
operations.post('/commands', async (c) => {
  const input = shippingCommandInput.parse(await readJson(c.req.raw, 16384));
  const command = unwrapShipping(
    await c.var.db.shippingEnqueue(input, c.var.auth.sub || 'admin-api-key'),
  );
  c.executionCtx.waitUntil(
    runShippingCommand(c.env, c.var.db, String(command.id)).catch(() => {}),
  );
  return c.json({ id: command.id, state: command.state }, 202);
});
operations.post('/reconcile', async (c) => {
  c.executionCtx.waitUntil(processShippingWork(c.env, c.var.db));
  return c.json({ queued: true }, 202);
});
operations.post('/legs', async (c) => {
  const input = prepareExternalLegInput.parse(await readJson(c.req.raw, 16384));
  const account = carrierAccounts(c.env).find(
    (a) =>
      a.id === input.account_id &&
      a.verified &&
      a.warehouse_id === c.env.PANCAKE_WAREHOUSE_ID &&
      a.capabilities.includes('read'),
  );
  if (!account)
    throw new ApiError(
      'carrier_account_unmapped',
      409,
      'Cần tài khoản đã xác minh cho kho và quyền tra cứu.',
    );
  return c.json(
    unwrapShipping(
      await c.var.db.shippingPrepareLeg(
        input,
        account,
        c.var.auth.sub || 'admin-api-key',
      ),
    ),
    201,
  );
});

const events = new OpenAPIHono<HonoEnv>();
events.use('*', bodyLimit({ maxSize: 65536 }));
events.use('*', async (c, next) => {
  try {
    await next();
  } catch (error) {
    if (error instanceof z.ZodError) throw ApiError.badRequest('Invalid shipping event');
    throw error;
  }
});
events.post('/ghn/:accountId', async (c) => {
  const account = carrierAccounts(c.env).find((a) => a.id === c.req.param('accountId'));
  const secret = account && carrierWebhookSecret(c.env, account.id),
    provided = c.req.header('X-Shipping-Secret');
  if (
    !account ||
    !secret ||
    !provided ||
    (await hashKey(secret)) !== (await hashKey(provided))
  )
    throw ApiError.unauthorized('Invalid carrier event authentication');
  const raw = await readJson(c.req.raw, 65536);
  const event = z
    .object({
      ShopID: z.number().int(),
      OrderCode: z.string().min(1).max(100),
      ClientOrderCode: z.string().max(100).nullish(),
      Time: z.string().max(60).optional(),
      Type: z.string().min(1).max(60),
    })
    .parse(raw);
  if (event.ShopID !== account.shop_id) throw ApiError.forbidden('Carrier shop mismatch');
  const received = unwrapShipping(
    await c.var.db.shippingReceive({
      source: 'ghn',
      account_id: account.id,
      environment: account.environment,
      external_code: event.OrderCode,
      client_code: event.ClientOrderCode || undefined,
      event_time: Date.now(),
      payload_hash: await hashShipping(raw),
    }),
  );
  c.executionCtx.waitUntil(processShippingWork(c.env, c.var.db).catch(() => {}));
  return c.json({ accepted: true, duplicate: received.duplicate }, 202);
});
events.post('/pancake', async (c) => {
  const secret = c.env.PANCAKE_ORDER_WEBHOOK_SECRET,
    provided = c.req.header('X-Shipping-Secret');
  if (
    !secret ||
    secret.length < 24 ||
    !provided ||
    (await hashKey(secret)) !== (await hashKey(provided))
  )
    throw ApiError.unauthorized('Invalid POS event authentication');
  const raw = z.record(z.string(), z.unknown()).parse(await readJson(c.req.raw, 65536));
  const data =
    raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)
      ? (raw.data as Record<string, unknown>)
      : raw;
  const shopId = data.shop_id ?? raw.shop_id;
  if (shopId != null && String(shopId) !== c.env.PANCAKE_SHOP_ID)
    throw ApiError.forbidden('POS shop mismatch');
  const digest = await hashShipping(raw);
  // A callback is a hint only. Unknown envelopes are retained as unmatched;
  // they are never interpreted as order mutations.
  const hint = z
    .union([z.string().min(1).max(100), z.number().int().positive()])
    .safeParse(data.id ?? data.order_id);
  const received = unwrapShipping(
    await c.var.db.shippingReceive({
      source: 'pancake',
      account_id: c.env.PANCAKE_SHOP_ID || '',
      environment: c.env.COMMERCE_ENVIRONMENT || 'production',
      external_code: hint.success ? String(hint.data) : 'unmatched:' + digest,
      event_time: Date.now(),
      payload_hash: digest,
    }),
  );
  c.executionCtx.waitUntil(processShippingWork(c.env, c.var.db).catch(() => {}));
  return c.json({ accepted: true, duplicate: received.duplicate }, 202);
});
export const shippingOperations = operations;
export const carrierEvents = events;
for (const router of [operations, events])
  router.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json(
        {
          error: {
            code: 'invalid_shipping_input',
            message: 'Dữ liệu vận chuyển không hợp lệ.',
          },
        },
        400,
      );
    if (error instanceof ShippingError)
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.status as 400 | 404 | 409 | 422 | 502 | 503,
      );
    if (error instanceof ApiError)
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.statusCode as 400 | 401 | 403 | 404 | 409 | 503,
      );
    return c.json(
      {
        error: {
          code: 'shipping_unavailable',
          message: 'Chưa xử lý được vận chuyển. Vui lòng thử tra cứu lại.',
        },
      },
      503,
    );
  });

const reply = {
  description: 'Shipping workflow response',
  content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
};
for (const [method, path, schema] of [
  ['post', '/commands', shippingCommandInput],
  ['post', '/legs', prepareExternalLegInput],
] as const)
  operations.openAPIRegistry.registerPath({
    method,
    path,
    tags: ['Shipping operations'],
    security: [{ bearerAuth: [] }],
    request: { body: { required: true, content: { 'application/json': { schema } } } },
    responses: {
      201: reply,
      202: reply,
      400: { description: 'Invalid input' },
      403: { description: 'Admin permission required' },
      409: { description: 'Conflict or workflow hold' },
    },
  });
operations.openAPIRegistry.registerPath({
  method: 'get',
  path: '/orders/{orderId}',
  tags: ['Shipping operations'],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ orderId: z.string().uuid() }) },
  responses: {
    200: reply,
    403: { description: 'Admin permission required' },
    404: { description: 'Order not found' },
  },
});
operations.openAPIRegistry.registerPath({
  method: 'post',
  path: '/reconcile',
  tags: ['Shipping operations'],
  security: [{ bearerAuth: [] }],
  responses: { 202: reply },
});
operations.openAPIRegistry.registerPath({
  method: 'get',
  path: '/queue',
  tags: ['Shipping operations'],
  security: [{ bearerAuth: [] }],
  responses: { 200: reply },
});
operations.openAPIRegistry.registerPath({
  method: 'post',
  path: '/commands/{commandId}/retry',
  tags: ['Shipping operations'],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ commandId: z.string().uuid() }) },
  responses: { 202: reply, 409: { description: 'Lease active' } },
});
for (const path of ['/ghn/{accountId}', '/pancake'])
  events.openAPIRegistry.registerPath({
    method: 'post',
    path,
    tags: ['Carrier events'],
    request: {
      headers: z.object({ 'X-Shipping-Secret': z.string().min(24) }),
      body: {
        required: true,
        content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
      },
    },
    responses: {
      202: reply,
      400: { description: 'Invalid payload' },
      401: { description: 'Configured webhook secret required' },
      403: { description: 'Shop mismatch' },
    },
  });
