import {processShippingWork} from '../lib/shipping-runner';
import {shippingQuoteSetup} from '../lib/shipping-registry';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { authMiddleware, adminOnly, hashKey } from '../middleware/auth';
import { ApiError, type HonoEnv } from '../types';
import { commerceToken, verifyCommerceToken } from '../lib/commerce-token';
import { unwrapShipping } from '../lib/shipping-store';
import {
  requestInput,
  decisionInput,
  refundInput,
  refundResultInput,
  adjustmentInput,
} from '../lib/commerce-service';
import { checkoutInput } from '../lib/commerce-core';
import { ShippingError } from '../lib/smart-shipping';
import { sendMailgunEmail } from '../mailgun';

const app = new OpenAPIHono<HonoEnv>();
app.use('*', bodyLimit({ maxSize: 750_000 }), authMiddleware);
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  const path=c.req.path;
  const existingWork=path.includes('/admin/')||path.endsWith('/detail');
  if (c.env.COMMERCE_SERVICE_ENABLED !== 'true'&&!existingWork)
    throw new ApiError(
      'service_disabled',
      503,
      'Chức năng quản lý yêu cầu chưa được bật. Vui lòng liên hệ shop.',
    );
  try {
    await next();
  } catch (e) {
    if (e instanceof ShippingError)
      throw new ApiError(e.code, e.status, e.message);
    throw e;
  }
});
const response = {
  description: 'Order service response',
  content: {
    'application/json': { schema: z.record(z.string(), z.unknown()) },
  },
};
const responses = {
  200: response,
  400: { description: 'Invalid input' },
  401: { description: 'Authentication required' },
  403: { description: 'Verification or finance permission required' },
  404: { description: 'Order not found' },
  409: { description: 'Order changed or invalid transition' },
  429: { description: 'Too many attempts' },
  503: { description: 'Service not configured' },
};
const tracking = z.object({
  order_id: z.string().uuid(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
const action = tracking.extend({
  action_token: z.string().regex(/^[a-f0-9]{64}$/),
});
const params = z.object({ orderId: z.string().uuid() });
const body = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
});
function actor(c: { var: HonoEnv['Variables'] }) {
  return c.var.auth.sub || 'admin-api-key';
}
export const commerceFinance = async (
  c: Parameters<typeof adminOnly>[0],
  next: () => Promise<void>,
) => {
  const subject = c.var.auth.sub;
  const allowed = (c.env.COMMERCE_SERVICE_FINANCE_SUBJECTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    !subject ||
    (!allowed.includes(subject) &&
      !c.var.auth.permissions?.includes('commerce:finance'))
  )
    throw ApiError.forbidden(
      'Cần tài khoản kế toán có quyền commerce:finance; không dùng khóa quản trị chung.',
    );
  await next();
};
export const commerceFinanceIfEnabled = async (
  c: Parameters<typeof adminOnly>[0],
  next: () => Promise<void>,
) =>
  c.env.COMMERCE_SERVICE_ENABLED === 'true'||typeof c.env.COMMERCE_SERVICE_FINANCE_SUBJECTS==='string' ? commerceFinance(c, next) : next();
async function authorize(
  c: Parameters<typeof adminOnly>[0],
  input: z.infer<typeof tracking>,
) {
  const secret = c.env.ORDER_TOKEN_SECRET;
  if (
    !secret ||
    !(await verifyCommerceToken(input.order_id, input.token, secret))
  )
    throw ApiError.notFound('Không tìm thấy đơn hoặc mã tra cứu không hợp lệ.');
  const receipt = unwrapShipping(
    await c.var.db.commerceReceipt(input.order_id),
  );
  if (Date.now() > receipt.expires_at + 90 * 86400_000)
    throw ApiError.notFound('Mã tra cứu đã hết hạn.');
}
app.openapi(
  createRoute({
    method: 'post',
    path: '/detail',
    tags: ['Order service'],
    request: { body: body(tracking.strict()) },
    responses,
  }),
  async (c) => {
    const input = c.req.valid('json');
    await authorize(c, input);
    const detail=unwrapShipping(await c.var.db.commerceServiceDetail(input.order_id));
    if(c.env.COMMERCE_SERVICE_ENABLED!=='true'){
      detail.allowed_actions={cancel:false,address:false,return:false};
      detail.action_hint='Shop tạm ngừng nhận yêu cầu mới qua website. Các yêu cầu đã gửi vẫn được xử lý; vui lòng liên hệ shop nếu cần hỗ trợ.';
    }
    return c.json(detail,200);
  },
);
app.openapi(
  createRoute({
    method: 'post',
    path: '/recover',
    tags: ['Order service'],
    request: {
      body: body(
        z
          .object({
            number: z.string().trim().min(3).max(100),
            email: z.string().email().max(254),
          })
          .strict(),
      ),
    },
    responses,
  }),
  async (c) => {
    const input = c.req.valid('json');
    const found = await c.var.db.commerceRecovery(input.number, input.email);
    if (
      found &&
      c.env.MAILGUN_API_KEY &&
      c.env.MAILGUN_DOMAIN &&
      c.env.ORDER_TOKEN_SECRET &&
      c.env.STORE_URL
    ) {
      try {
        unwrapShipping(
          await c.var.db.commerceActionStart(
            found.order_id,
            crypto.randomUUID(),
            crypto.randomUUID(),
          ),
        );
        const url = new URL('/order-tracking', c.env.STORE_URL);
        if (url.protocol === 'https:') {
          url.hash = new URLSearchParams({
            order_id: found.order_id,
            token: await commerceToken(
              found.order_id,
              c.env.ORDER_TOKEN_SECRET,
            ),
          }).toString();
          c.executionCtx.waitUntil(
            sendMailgunEmail(c.env, {
              to: found.email,
              subject: 'Halifruit — đường dẫn tra cứu đơn',
              text: `Mở đường dẫn riêng để xem đơn: ${url.href}\nKhông chia sẻ đường dẫn này.`,
            })
              .then(() => {})
              .catch(() => {
                console.warn(
                  JSON.stringify({
                    event: 'commerce.recovery.delivery_failed',
                  }),
                );
              }),
          );
        }
      } catch {
        /* Same public response for absent, limited or unavailable orders. */
      }
    }
    return c.json(
      {
        message:
          'Nếu thông tin khớp, đường dẫn tra cứu sẽ được gửi tới email đã đặt hàng.',
      },
      200,
    );
  },
);
app.openapi(
  createRoute({
    method: 'post',
    path: '/verification/start',
    tags: ['Order service'],
    request: { body: body(tracking.strict()) },
    responses,
  }),
  async (c) => {
    const input = c.req.valid('json');
    await authorize(c, input);
    if (!c.env.MAILGUN_API_KEY || !c.env.MAILGUN_DOMAIN)
      throw new ApiError(
        'verification_unavailable',
        503,
        'Chưa cấu hình email xác minh. Vui lòng liên hệ shop.',
      );
    const session = crypto.randomUUID();
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const code = String(random[0] % 1_000_000).padStart(6, '0');
    const hash = await commerceToken(
      `${input.order_id}:${session}:${code}`,
      c.env.ORDER_TOKEN_SECRET!,
    );
    const result = unwrapShipping(
      await c.var.db.commerceActionStart(input.order_id, session, hash),
    );
    const sent = await sendMailgunEmail(c.env, {
      to: result.email,
      subject: 'Halifruit — mã xác minh thao tác đơn hàng',
      text: `Mã xác minh của bạn: ${code}. Có hiệu lực 10 phút, tối đa 5 lần thử. Không cung cấp mã cho người khác. Nếu bạn không yêu cầu, hãy bỏ qua email này.`,
    });
    if (!sent.success)
      throw new ApiError(
        'verification_delivery_failed',
        503,
        'Chưa gửi được email xác minh. Vui lòng thử lại sau.',
      );
    return c.json({ session_id: session, expires_in_seconds: 600 }, 200);
  },
);
app.openapi(
  createRoute({
    method: 'post',
    path: '/verification/confirm',
    tags: ['Order service'],
    request: {
      body: body(
        tracking
          .extend({
            session_id: z.string().uuid(),
            code: z.string().regex(/^\d{6}$/),
          })
          .strict(),
      ),
    },
    responses,
  }),
  async (c) => {
    const input = c.req.valid('json');
    await authorize(c, input);
    const hash = await commerceToken(
      `${input.order_id}:${input.session_id}:${input.code}`,
      c.env.ORDER_TOKEN_SECRET!,
    );
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    const result = await c.var.db.commerceActionVerify(
      input.order_id,
      input.session_id,
      hash,
      await hashKey(token),
    );
    if (!result.verified)
      throw ApiError.forbidden(
        'Mã không hợp lệ, hết hạn hoặc đã vượt số lần thử.',
      );
    return c.json({ action_token: token, expires_in_seconds: 900 }, 200);
  },
);
app.openapi(
  createRoute({
    method: 'post',
    path: '/requests',
    tags: ['Order service'],
    request: { body: body(action.extend({ request: requestInput }).strict()) },
    responses,
  }),
  async (c) => {
    const input = c.req.valid('json');
    await authorize(c, input);
    return c.json(
      unwrapShipping(
        await c.var.db.commerceServiceRequest(
          input.order_id,
          input.request,
          await hashKey(input.action_token),
        ),
      ),
      200,
    );
  },
);
app.openapi(
  createRoute({
    method: 'post',
    path: '/evidence',
    tags: ['Order service'],
    request: {
      body: body(
        action
          .extend({
            mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
            base64: z
              .string()
              .min(8)
              .max(700_000)
              .regex(/^[A-Za-z0-9+/]*={0,2}$/),
          })
          .strict(),
      ),
    },
    responses,
  }),
  async (c) => {
    const input = c.req.valid('json');
    await authorize(c, input);
    const hash = await hashKey(input.action_token);
    unwrapShipping(
      await c.var.db.commerceActionAssert(input.order_id, hash, 'evidence'),
    );
    if (!c.env.COMMERCE_EVIDENCE_BUCKET)
      throw new ApiError(
        'evidence_unavailable',
        503,
        'Chưa cấu hình lưu ảnh riêng tư. Bạn vẫn có thể gửi mô tả và liên hệ shop bổ sung ảnh.',
      );
    const bytes = Uint8Array.from(atob(input.base64), (ch) => ch.charCodeAt(0));
    const valid =
      input.mime === 'image/jpeg'
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : input.mime === 'image/png'
          ? bytes.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10'
          : String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
            String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    if (!valid) throw ApiError.invalidRequest('Ảnh không đúng định dạng.');
    const key = `order-evidence/${encodeURIComponent(c.env.STORE_ID || 'default')}/${crypto.randomUUID()}`;
    await c.env.COMMERCE_EVIDENCE_BUCKET.put(key, bytes, {
      httpMetadata: { contentType: input.mime },
    });
    try {
      return c.json(
        unwrapShipping(
          await c.var.db.commerceEvidenceStore(
            input.order_id,
            key,
            input.mime,
            hash,
          ),
        ),
        200,
      );
    } catch (e) {
      await c.env.COMMERCE_EVIDENCE_BUCKET.delete(key);
      throw e;
    }
  },
);
app.openapi(
  createRoute({
    method: 'post',
    path: '/admin/orders/{orderId}/evidence',
    tags: ['Order service admin'],
    middleware: [adminOnly] as const,
    request: {
      params,
      body: body(z.object({ evidence_id: z.string().uuid() }).strict()),
    },
    responses,
  }),
  async (c) => {
    if (!c.env.COMMERCE_EVIDENCE_BUCKET)
      throw new ApiError('evidence_unavailable', 503, 'Chưa cấu hình lưu ảnh.');
    const info = unwrapShipping(
      await c.var.db.commerceEvidenceRead(
        c.req.valid('param').orderId,
        c.req.valid('json').evidence_id,
      ),
    );
    const object = await c.env.COMMERCE_EVIDENCE_BUCKET.get(info.key);
    if (!object) throw ApiError.notFound('Ảnh không còn được lưu.');
    const bytes = new Uint8Array(await object.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return c.json({ mime: info.mime, base64: btoa(binary) }, 200);
  },
);
app.openapi(
  createRoute({
    method: 'post',
    path: '/address-quotes',
    tags: ['Order service'],
    request: {
      body: body(
        action
          .extend({
            order_version: z.number().int().positive(),
            recipient: checkoutInput.shape.recipient,
          })
          .strict(),
      ),
    },
    responses,
  }),
  async (c) => {
    const input = c.req.valid('json');
    await authorize(c, input);
    const tokenHash = await hashKey(input.action_token);
    unwrapShipping(
      await c.var.db.commerceActionAssert(input.order_id, tokenHash, 'quote'),
    );
    const state = unwrapShipping(
      await c.var.db.commerceServiceSnapshot(input.order_id),
    );
    if (state.version !== input.order_version)
      throw ApiError.conflict('Đơn vừa thay đổi. Vui lòng tải lại.');
    const snapshot = state.snapshot;
    const {config,providers} = shippingQuoteSetup(c.env),
      now = Date.now();
    // Quote the frozen parcel, never reprice purchased products from the live cart/catalog.
    const quoted = await Promise.allSettled(providers.map(provider=>provider.quote({
      config,
      parcel: snapshot.parcel,
      request: {
        cart_id: input.order_id,
        destination: {
          district_id: input.recipient.district_id,
          ward_code: input.recipient.ward_code,
        },
        payment_method: state.method === 'cod' ? 'cod' : 'prepaid',
      },
      now,
      signal: AbortSignal.timeout(12_000),
    })));
    const result={offers:quoted.flatMap(r=>r.status==='fulfilled'?r.value.offers:[])};
    const offer = result.offers
      .filter(
        (o) =>
          Date.parse(o.estimated_delivery_at) > now &&
          Date.parse(o.estimated_delivery_at) <=
            now + config.policy.max_delivery_hours * 3_600_000,
      )
      .sort((a, b) => a.carrier_fee_vnd - b.carrier_fee_vnd)[0];
    if (!offer)
      throw new ApiError(
        'no_carrier_quote',
        422,
        'Chưa có phương án giao phù hợp cho địa chỉ mới.',
      );
    return c.json(
      unwrapShipping(
        await c.var.db.commerceAddressQuote(
          input.order_id,
          input.order_version,
          input.recipient,
          offer,
          tokenHash,
        ),
      ),
      200,
    );
  },
);
app.openapi(
  createRoute({
    method: 'get',
    path: '/admin/queue',
    tags: ['Order service admin'],
    middleware: [adminOnly] as const,
    responses,
  }),
  async (c) => c.json(await c.var.db.commerceServiceQueue(), 200),
);
app.openapi(
  createRoute({
    method: 'get',
    path: '/admin/orders/{orderId}',
    tags: ['Order service admin'],
    middleware: [adminOnly] as const,
    request: { params },
    responses,
  }),
  async (c) => {
    const id = c.req.valid('param').orderId;
    return c.json(
      {
        ...unwrapShipping(await c.var.db.commerceServiceDetail(id)),
        receipt: unwrapShipping(await c.var.db.commerceReceipt(id)),
        audit: await c.var.db.query(
          'SELECT action,actor,evidence,created_at FROM commerce_audit WHERE order_id=? ORDER BY created_at DESC LIMIT 100',
          [id],
        ),
        transactions: await c.var.db.query(
          'SELECT kind,amount_vnd,provider_transaction_id,received_at FROM commerce_transactions WHERE order_id=? ORDER BY received_at DESC',
          [id],
        ),
      },
      200,
    );
  },
);
app.openapi(
  createRoute({
    method: 'post',
    path: '/admin/orders/{orderId}/decision',
    tags: ['Order service admin'],
    middleware: [adminOnly] as const,
    request: { params, body: body(decisionInput) },
    responses,
  }),
  async (c) => {
    const result=unwrapShipping(await c.var.db.commerceServiceDecision(c.req.valid('param').orderId,c.req.valid('json'),actor(c)));
    if(c.env.SHIPPING_AUTOMATION_ENABLED==='true')c.executionCtx.waitUntil(processShippingWork(c.env,c.var.db).catch(()=>{}));
    return c.json(result,200);
  },
);
app.openapi(
  createRoute({
    method: 'post',
    path: '/admin/orders/{orderId}/refunds',
    tags: ['Order service admin'],
    middleware: [adminOnly, commerceFinance] as const,
    request: { params, body: body(refundInput) },
    responses,
  }),
  async (c) =>
    c.json(
      unwrapShipping(
        await c.var.db.commerceRefundCreate(
          c.req.valid('param').orderId,
          c.req.valid('json'),
          actor(c),
        ),
      ),
      200,
    ),
);
app.openapi(
  createRoute({
    method: 'post',
    path: '/admin/orders/{orderId}/refund-result',
    tags: ['Order service admin'],
    middleware: [adminOnly, commerceFinance] as const,
    request: { params, body: body(refundResultInput) },
    responses,
  }),
  async (c) =>
    c.json(
      unwrapShipping(
        await c.var.db.commerceRefundResult(
          c.req.valid('param').orderId,
          c.req.valid('json'),
          actor(c),
        ),
      ),
      200,
    ),
);
app.openapi(
  createRoute({
    method: 'post',
    path: '/admin/orders/{orderId}/adjustment-payment',
    tags: ['Order service admin'],
    middleware: [adminOnly, commerceFinance] as const,
    request: { params, body: body(adjustmentInput) },
    responses,
  }),
  async (c) =>
    c.json(
      unwrapShipping(
        await c.var.db.commerceAddressAdjustment(
          c.req.valid('param').orderId,
          c.req.valid('json'),
          actor(c),
        ),
      ),
      200,
    ),
);
app.openapi(
  createRoute({
    method: 'post',
    path: '/admin/orders/{orderId}/reconcile',
    tags: ['Order service admin'],
    middleware: [adminOnly, commerceFinance] as const,
    request: {
      params,
      body: body(
        z
          .object({
            order_version: z.number().int().positive(),
            evidence: z.string().trim().min(20).max(1000),
          })
          .strict(),
      ),
    },
    responses,
  }),
  async (c) =>
    c.json(
      unwrapShipping(
        await c.var.db.commerceServiceReconcile(
          c.req.valid('param').orderId,
          c.req.valid('json').order_version,
          c.req.valid('json').evidence,
          actor(c),
        ),
      ),
      200,
    ),
);
export const commerceService = app;
