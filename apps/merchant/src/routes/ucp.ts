import {bodyLimit} from 'hono/body-limit';
import { storeApiBase } from '../lib/stores';
import { startStripeCheckout } from '../lib/ucp-payment-service';
/**
 * MIT License
 *
 * Copyright (c) 2025 ygwyg
 * Copyright (c) 2026 Ronan Le Meillat - SCTG Development
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import type Stripe from 'stripe';
import { getDb, type Database } from '../db';
import { ApiError, uuid, now, type HonoEnv } from '../types';
import { resolveVariantPrice, getCurrencyIdFromCode } from '../lib/pricing';
import { ErrorResponse } from '../schemas';
import {
  UCPCheckoutSessionSchema,
  CreateCheckoutBodySchema,
  UpdateCheckoutBodySchema,
  PatchCheckoutBodySchema,
  CompleteCheckoutBodySchema,
  EstimateShippingBodySchema,
  SessionIdParamSchema,
  ProductsQuerySchema,
  ProductIdParamSchema,
  UCPShippingOptionSchema,
  UCPEnvelopeSchema,
  UCPPaymentHandlerSchema,
} from './ucp-schemas';

// ============================================================
// UCP - UNIVERSAL COMMERCE PROTOCOL
// ============================================================
//
// Legacy UCP adapter pinned to the declared protocol version; conformance upgrades are tracked separately.
// See: https://ucp.dev/specification/overview
//
// Capabilities implemented:
// - dev.ucp.shopping.checkout (checkout sessions)
// - dev.ucp.common.identity_linking (OAuth 2.0)
// - dev.ucp.shopping.order (order webhooks)
//
// ============================================================

async function assertLegacySession(db:Database,id:string){
 const exists=await db.query("SELECT name FROM sqlite_master WHERE name='checkout_drafts'",[]);
 if(exists.length&&(await db.query('SELECT id FROM checkout_drafts WHERE id=?',[id])).length)throw ApiError.forbidden('Use the authenticated merchant checkout for this session');
}

const UCP_VERSION = '2026-01-11';

export const ucp = new OpenAPIHono<HonoEnv>();
ucp.use("*",bodyLimit({maxSize:64000}));

// ============================================================
// TYPES
// ============================================================

interface UCPCapability {
  name: string;
  version: string;
  spec: string;
  schema: string;
  extends?: string;
  config?: Record<string, unknown>;
}

interface UCPCheckoutSession {
  id: string;
  status: 'incomplete' | 'requires_escalation' | 'ready_for_complete' | 'complete_in_progress' | 'completed' | 'canceled';
  currency: string;
  line_items: UCPLineItem[];
  buyer?: UCPBuyer;
  totals: UCPTotal[];
  messages: UCPMessage[];
  links: UCPLink[];
  payment: UCPPaymentResponse;
  continue_url?: string;
  expires_at?: string;
  order?: UCPOrderConfirmation;
}

interface UCPLineItem {
  id: string;
  item: { id: string; title?: string; description?: string; image_url?: string };
  quantity: number;
  unit_price: { amount: number; currency: string };
  total_price: { amount: number; currency: string };
}

interface UCPBuyer {
  first_name?: string;
  last_name?: string;
  full_name?: string;
  email?: string;
  phone_number?: string;
}

interface UCPTotal {
  type: 'subtotal' | 'tax' | 'shipping' | 'discount' | 'grand_total';
  amount: number;
  currency: string;
  label?: string;
}

interface UCPMessage {
  type: 'error' | 'warning' | 'info';
  code: string;
  content: string;
  severity?: 'recoverable' | 'requires_buyer_input' | 'requires_buyer_review';
}

interface UCPLink {
  rel: string;
  href: string;
  title?: string;
}

interface UCPPaymentResponse {
  handlers: UCPPaymentHandler[];
  instruments?: UCPPaymentInstrument[];
}

interface UCPPaymentHandler {
  id: string;
  name: string;
  version: string;
  spec: string;
  config_schema?: string;
  instrument_schemas: string[];
  config?: Record<string, unknown>;
}

interface UCPPaymentInstrument {
  handler_id: string;
  type: string;
  details?: Record<string, unknown>;
}

interface UCPOrderConfirmation {
  id: string;
  number: string;
  permalink_url?: string;
}

// ============================================================
// HELPERS
// ============================================================

function ucpEnvelope(capabilities: { name: string; version: string }[]) {
  return {
    version: UCP_VERSION,
    capabilities,
  };
}

function activeCapabilities(): { name: string; version: string }[] {
  return [
    { name: 'dev.ucp.shopping.checkout', version: UCP_VERSION },
    { name: 'dev.ucp.shopping.browse', version: UCP_VERSION },
    { name: 'dev.ucp.shopping.catalog', version: UCP_VERSION },
    { name: 'dev.ucp.common.identity_linking', version: UCP_VERSION },
    { name: 'dev.ucp.shopping.order', version: UCP_VERSION },
  ];
}

function parseUCPAgentHeader(header: string | null): { profile?: string } {
  if (!header) return {};
  const match = header.match(/profile="([^"]+)"/);
  return { profile: match?.[1] };
}

async function getStripeConfig(db: Database, env: Pick<import('../types').Env, 'STRIPE_SECRET_KEY' | 'STRIPE_WEBHOOK_SECRET'>): Promise<{ secretKey: string | null; webhookSecret: string | null }> {
  if (env.STRIPE_SECRET_KEY) return { secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET || null };
  const [config] = await db.query<{ value: string }>(
    `SELECT value FROM config WHERE key = 'stripe'`,
    []
  );
  if (!config) return { secretKey: null, webhookSecret: null };
  try {
    const parsed = JSON.parse(config.value);
    return { 
      secretKey: parsed.secret_key || null,
      webhookSecret: parsed.webhook_secret || null,
    };
  } catch {
    return { secretKey: null, webhookSecret: null };
  }
}

interface TaxResult {
  taxAmount: number;
  taxRate: number;
  taxLabel: string;
}

/**
 * Looks up the default region tax rate and computes the tax amount.
 * Returns { taxAmount: 0 } if no default region or tax rate configured.
 */
async function computeTax(db: Database, subtotal: number): Promise<TaxResult> {
  const rates=await db.query<{rate_percentage:number;display_name:string;country_code:string|null;tax_code:string|null}>("SELECT rate_percentage,display_name,country_code,tax_code FROM tax_rates WHERE status='active'",[]);
  const [region]=await db.query<{tax_inclusive:number}>("SELECT tax_inclusive FROM regions WHERE is_default=1",[]);
  // This legacy UCP adapter lacks destination/tax-code inputs. Do not guess a tax jurisdiction.
  if(rates.length>1||rates.some(rate=>rate.country_code||rate.tax_code)||(rates.length&&region?.tax_inclusive===1))
    throw ApiError.invalidRequest('This tax policy requires merchant checkout with destination and item tax context');
  const rate=rates[0];if(!rate)return {taxAmount:0,taxRate:0,taxLabel:''};
  if(!Number.isFinite(rate.rate_percentage)||rate.rate_percentage<0||rate.rate_percentage>100)throw ApiError.invalidRequest('Invalid tax configuration');
  return {taxAmount:Math.round(subtotal*rate.rate_percentage/100),taxRate:rate.rate_percentage,taxLabel:rate.display_name};
}

// ============================================================
// /.well-known/ucp - UCP PROFILE ENDPOINT
// ============================================================

const routeGetUCPProfile = createRoute({
  method: 'get',
  path: '/.well-known/ucp',
  tags: ['UCP'],
  summary: 'UCP discovery profile',
  description: 'Returns the UCP capabilities, services, and payment handlers for this merchant.',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ucp: z.object({
              version: z.string(),
              services: z.record(z.string(), z.unknown()),
              capabilities: z.array(z.object({
                name: z.string(),
                version: z.string(),
                spec: z.string(),
                schema: z.string(),
              })),
            }),
            payment: z.object({ handlers: z.array(UCPPaymentHandlerSchema) }),
          }),
        },
      },
      description: 'UCP profile',
    },
  },
});
ucp.openapi(routeGetUCPProfile, async (c) => {
  const baseUrl = storeApiBase(c.req.url, c.env);
  const db = getDb(c.var.db);
  const stripeConfig = await getStripeConfig(db, c.env);
  
  // Build payment handlers based on Stripe config
  const paymentHandlers: UCPPaymentHandler[] = [];
  
  if (stripeConfig.secretKey) {
    // Stripe checkout redirect handler
    paymentHandlers.push({
      id: 'stripe_checkout',
      name: 'com.stripe.checkout',
      version: UCP_VERSION,
      spec: 'https://stripe.com/docs/payments/checkout',
      instrument_schemas: [
        'https://ucp.dev/schemas/shopping/types/card_payment_instrument.json',
      ],
      config: {
        type: 'REDIRECT',
        description: 'Secure checkout via Stripe',
      },
    });
  }
  
  const profile = {
    ucp: {
      version: UCP_VERSION,
      services: {
        'dev.ucp.shopping': {
          version: UCP_VERSION,
          spec: 'https://ucp.dev/specification/checkout',
          rest: {
            schema: 'https://ucp.dev/services/shopping/rest.openapi.json',
            endpoint: `${baseUrl}/ucp/v1`,
          },
        },
        'dev.ucp.common': {
          version: UCP_VERSION,
          spec: 'https://ucp.dev/specification/identity-linking',
          rest: {
            schema: 'https://ucp.dev/services/common/rest.openapi.json',
            endpoint: baseUrl,
          },
        },
      },
      capabilities: [
        {
          name: 'dev.ucp.shopping.checkout',
          version: UCP_VERSION,
          spec: 'https://ucp.dev/specification/checkout',
          schema: 'https://ucp.dev/schemas/shopping/checkout.json',
        },
        {
          name: 'dev.ucp.shopping.browse',
          version: UCP_VERSION,
          spec: 'https://ucp.dev/specification/browse',
          schema: 'https://ucp.dev/schemas/shopping/browse.json',
        },
        {
          name: 'dev.ucp.shopping.catalog',
          version: UCP_VERSION,
          spec: 'https://ucp.dev/specification/catalog',
          schema: 'https://ucp.dev/schemas/shopping/catalog.json',
        },
        {
          name: 'dev.ucp.common.identity_linking',
          version: UCP_VERSION,
          spec: 'https://ucp.dev/specification/identity-linking',
          schema: 'https://ucp.dev/schemas/common/identity_linking.json',
        },
        {
          name: 'dev.ucp.shopping.order',
          version: UCP_VERSION,
          spec: 'https://ucp.dev/specification/order',
          schema: 'https://ucp.dev/schemas/shopping/order.json',
        },
      ] as UCPCapability[],
    },
    payment: {
      handlers: paymentHandlers,
    },
    // Signing keys would be added here for webhook verification
    // signing_keys: []
  };
  
  return c.json(profile);
});

// ============================================================
// UCP CHECKOUT CAPABILITY - REST BINDING
// ============================================================

// POST /ucp/v1/checkout-sessions - Create Checkout
const routePostCheckoutSession = createRoute({
  method: 'post',
  path: '/ucp/v1/checkout-sessions',
  tags: ['UCP'],
  summary: 'Create checkout session',
  description: 'Creates a UCP checkout session from a list of line items.',
  request: {
    body: { content: { 'application/json': { schema: CreateCheckoutBodySchema } } },
  },
  responses: {
    201: { content: { 'application/json': { schema: UCPCheckoutSessionSchema } }, description: 'Checkout session created' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid request' },
  },
});
ucp.openapi(routePostCheckoutSession, async (c) => {
  const ucpAgent = parseUCPAgentHeader(c.req.header('UCP-Agent') || null);
  const body = c.req.valid('json');
  const { line_items, buyer, currency, payment } = body;
  
  const db = getDb(c.var.db);
  const baseUrl = storeApiBase(c.req.url, c.env);
  
  // Resolve line items from catalog
  const resolvedItems: UCPLineItem[] = [];
  const messages: UCPMessage[] = [];
  let subtotal = 0;
  const seenSkus=new Set<string>();

  // Resolve currency_id from ISO code
  const currencyId = await getCurrencyIdFromCode(db, currency);
  if (!currencyId) {
    throw ApiError.invalidRequest(`Currency ${currency} not configured or inactive`);
  }
  
  for (const item of line_items) {
    const itemId = item.item?.id;
    const quantity = item.quantity || 1;
    
    if (!itemId) {
      messages.push({
        type: 'error',
        code: 'invalid_item',
        content: 'Line item missing item.id',
        severity: 'recoverable',
      });
      continue;
    }
    
    // Look up variant by ID or SKU
    const [variant] = await db.query<any>(
      `SELECT v.*, p.title as product_title, p.description as product_description
       FROM variants v
       JOIN products p ON v.product_id = p.id
       WHERE (v.id = ? OR v.sku = ?) AND v.status='active' AND p.status='active'`,
      [itemId, itemId]
    );
    
    if (!variant) {
      messages.push({
        type: 'error',
        code: 'item_not_found',
        content: `Item ${itemId} not found`,
        severity: 'recoverable',
      });
      continue;
    }
    
    // Check inventory
    const [inv] = await db.query<any>(
      `SELECT on_hand, reserved FROM inventory WHERE sku = ?`,
      [variant.sku]
    );
    const available = inv ? inv.on_hand - inv.reserved : 0;
    
    if (available < quantity) {
      messages.push({
        type: 'error',
        code: 'insufficient_inventory',
        content: `Only ${available} of ${variant.sku} available`,
        severity: 'recoverable',
      });
    }

    // Resolve price from variant_prices using multi-currency pricing
    let unitPrice: number;
    try {
      unitPrice = await resolveVariantPrice(db, variant.id, currencyId);
    } catch (error) {
      messages.push({
        type: 'error',
        code: 'price_not_available',
        content: `Price not configured for variant ${variant.sku} in currency ${currency}`,
        severity: 'recoverable',
      });
      continue;
    }

    if(seenSkus.has(variant.sku))throw ApiError.invalidRequest('Duplicate variant; combine quantities in one line');
    seenSkus.add(variant.sku);
    if(!Number.isSafeInteger(unitPrice)||unitPrice<=0||unitPrice>1_000_000_000)throw ApiError.invalidRequest('Invalid configured price');
    const totalPrice = unitPrice * quantity;
    subtotal += totalPrice;
    if(!Number.isSafeInteger(subtotal)||subtotal>1_000_000_000)throw ApiError.invalidRequest('Checkout amount exceeds supported limit');
    
    resolvedItems.push({
      id: uuid(),
      item: {
        id: variant.sku,
        title: variant.title || variant.product_title,
        description: variant.product_description,
        image_url: variant.image_url,
      },
      quantity,
      unit_price: { amount: unitPrice, currency: currency.toUpperCase() },
      total_price: { amount: totalPrice, currency: currency.toUpperCase() },
    });
  }
  
  // Create checkout session in DB
  const sessionId = uuid();
  const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(); // 6 hours
  
  const hasErrors = messages.some(m => m.type === 'error');
  const hasBuyerRequiredErrors = messages.some(m => m.severity === 'requires_buyer_input' || m.severity === 'requires_buyer_review');
  
  let status: UCPCheckoutSession['status'] = 'incomplete';
  if (!hasErrors && resolvedItems.length > 0) {
    // Check if we have enough info to be ready
    status = buyer?.email ? 'ready_for_complete' : 'incomplete';
  }
  if (hasBuyerRequiredErrors) {
    status = 'requires_escalation';
  }
  
  // Store session
  const { taxAmount, taxLabel } = await computeTax(db, subtotal);
  const grandTotal = subtotal + taxAmount;
  const totalsForStore: UCPTotal[] = [
    { type: 'subtotal', amount: subtotal, currency: currency.toUpperCase() },
    ...(taxAmount > 0 ? [{ type: 'tax' as const, amount: taxAmount, currency: currency.toUpperCase(), label: taxLabel }] : []),
    { type: 'grand_total', amount: grandTotal, currency: currency.toUpperCase() },
  ];

  await db.run(
    `INSERT INTO ucp_checkout_sessions (id, status, currency, line_items, buyer, totals, messages, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      status,
      currency.toUpperCase(),
      JSON.stringify(resolvedItems),
      JSON.stringify(buyer || null),
      JSON.stringify(totalsForStore),
      JSON.stringify(messages),
      expiresAt,
      now(),
      now(),
    ]
  );
  
  // Build payment handlers
  const stripeConfig = await getStripeConfig(db, c.env);
  const paymentHandlers: UCPPaymentHandler[] = [];
  
  if (stripeConfig.secretKey) {
    paymentHandlers.push({
      id: 'stripe_checkout',
      name: 'com.stripe.checkout',
      version: UCP_VERSION,
      spec: 'https://stripe.com/docs/payments/checkout',
      instrument_schemas: ['https://ucp.dev/schemas/shopping/types/card_payment_instrument.json'],
      config: {
        type: 'REDIRECT',
      },
    });
  }
  
  const response: UCPCheckoutSession & { ucp: ReturnType<typeof ucpEnvelope> } = {
    ucp: ucpEnvelope(activeCapabilities()),
    id: sessionId,
    status,
    currency: currency.toUpperCase(),
    line_items: resolvedItems,
    buyer: buyer || undefined,
    totals: totalsForStore,
    messages,
    links: [
      { rel: 'privacy_policy', href: `${baseUrl}/privacy`, title: 'Privacy Policy' },
      { rel: 'terms_of_service', href: `${baseUrl}/terms`, title: 'Terms of Service' },
    ],
    payment: { handlers: paymentHandlers },
    continue_url: status === 'requires_escalation' ? `${baseUrl}/checkout/${sessionId}` : undefined,
    expires_at: expiresAt,
  };
  
  return c.json(response, 201);
});

// GET /ucp/v1/checkout-sessions/:id - Get Checkout
const routeGetCheckoutSession = createRoute({
  method: 'get',
  path: '/ucp/v1/checkout-sessions/{id}',
  tags: ['UCP'],
  summary: 'Get checkout session',
  request: { params: SessionIdParamSchema },
  responses: {
    200: { content: { 'application/json': { schema: UCPCheckoutSessionSchema } }, description: 'Checkout session' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
  },
});
// @ts-expect-error handler returns DB-sourced data whose shape matches the schema at runtime
ucp.openapi(routeGetCheckoutSession, async (c) => {
  const sessionId = c.req.param('id');
  const db = getDb(c.var.db);
  const baseUrl = storeApiBase(c.req.url, c.env);
  await assertLegacySession(db,sessionId);
  
  const [session] = await db.query<any>(
    `SELECT * FROM ucp_checkout_sessions WHERE id = ?`,
    [sessionId]
  );
  
  if (!session) {
    throw ApiError.notFound('Checkout session not found');
  }
  
  // Check expiration
  if (session.expires_at && new Date(session.expires_at) < new Date() && !['completed','canceled','complete_in_progress'].includes(session.status)) {
    await db.run(`UPDATE ucp_checkout_sessions SET status = 'canceled' WHERE id = ? AND status NOT IN ('completed','complete_in_progress')`, [sessionId]);
    session.status = 'canceled';
  }
  
  const stripeConfig = await getStripeConfig(db, c.env);
  const paymentHandlers: UCPPaymentHandler[] = [];
  
  if (stripeConfig.secretKey) {
    paymentHandlers.push({
      id: 'stripe_checkout',
      name: 'com.stripe.checkout',
      version: UCP_VERSION,
      spec: 'https://stripe.com/docs/payments/checkout',
      instrument_schemas: ['https://ucp.dev/schemas/shopping/types/card_payment_instrument.json'],
      config: { type: 'REDIRECT' },
    });
  }
  
  const response = {
    ucp: ucpEnvelope(activeCapabilities()),
    id: session.id,
    status: session.status,
    currency: session.currency,
    line_items: JSON.parse(session.line_items || '[]'),
    buyer: JSON.parse(session.buyer || 'null') || undefined,
    totals: JSON.parse(session.totals || '[]'),
    messages: JSON.parse(session.messages || '[]'),
    links: [
      { rel: 'privacy_policy', href: `${baseUrl}/privacy`, title: 'Privacy Policy' },
      { rel: 'terms_of_service', href: `${baseUrl}/terms`, title: 'Terms of Service' },
    ],
    payment: {
      handlers: paymentHandlers,
      instruments: JSON.parse(session.payment_instruments || 'null') || undefined,
    },
    continue_url: session.status === 'requires_escalation' ? `${baseUrl}/checkout/${sessionId}` : undefined,
    expires_at: session.expires_at,
    order: session.order_id ? {
      id: session.order_id,
      number: session.order_number,
      permalink_url: `${baseUrl}/orders/${session.order_id}`,
    } : undefined,
  };
  
  return c.json(response);
});

// PUT /ucp/v1/checkout-sessions/:id - Update Checkout (full replacement)
const routePutCheckoutSession = createRoute({
  method: 'put',
  path: '/ucp/v1/checkout-sessions/{id}',
  tags: ['UCP'],
  summary: 'Update checkout session',
  description: 'Full replacement of line items, buyer, and currency with price re-resolution.',
  request: {
    params: SessionIdParamSchema,
    body: { content: { 'application/json': { schema: UpdateCheckoutBodySchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: UCPCheckoutSessionSchema } }, description: 'Updated session' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid request' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
  },
});
// @ts-expect-error handler returns DB-sourced data whose shape matches the schema at runtime
ucp.openapi(routePutCheckoutSession, async (c) => {
  const sessionId = c.req.param('id');
  const body = c.req.valid('json');
  const db = getDb(c.var.db);
  const baseUrl = storeApiBase(c.req.url, c.env);
  await assertLegacySession(db,sessionId);
  
  const [session] = await db.query<any>(
    `SELECT * FROM ucp_checkout_sessions WHERE id = ?`,
    [sessionId]
  );
  
  if (!session) {
    throw ApiError.notFound('Checkout session not found');
  }
  
  if (['completed', 'canceled', 'complete_in_progress'].includes(session.status)) {
    throw ApiError.invalidRequest(`Cannot update ${session.status} checkout session`);
  }
  
  if(Date.parse(session.expires_at)<=Date.now())throw ApiError.invalidRequest('Checkout has expired');
  const { line_items, buyer, currency, payment } = body;
  
  // Determine the effective currency for this update.
  // If the payload supplies a currency, use it; otherwise keep the session currency.
  const activeCurrency = (currency ?? session.currency).toUpperCase();

  // Resolve currency_id for pricing lookups (variant_prices uses currency UUIDs).
  const currencyId = await getCurrencyIdFromCode(db, activeCurrency);
  if (!currencyId) {
    throw ApiError.invalidRequest(`Currency ${activeCurrency} is not configured or is inactive`);
  }

  // Re-resolve line items
  const resolvedItems: UCPLineItem[] = [];
  const messages: UCPMessage[] = [];
  let subtotal = 0;
  const seenSkus=new Set<string>();
  
  for (const item of line_items || []) {
    const itemId = item.item?.id;
    const quantity = item.quantity || 1;
    
    if (!itemId) continue;
    
    const [variant] = await db.query<any>(
      `SELECT v.*, p.title as product_title, p.description as product_description
       FROM variants v
       JOIN products p ON v.product_id = p.id
       WHERE (v.id = ? OR v.sku = ?) AND v.status='active' AND p.status='active'`,
      [itemId, itemId]
    );
    
    if (!variant) {
      messages.push({
        type: 'error',
        code: 'item_not_found',
        content: `Item ${itemId} not found`,
        severity: 'recoverable',
      });
      continue;
    }

    const [inventory]=await db.query<{on_hand:number;reserved:number}>('SELECT on_hand,reserved FROM inventory WHERE sku=?',[variant.sku]);
    if(!inventory||inventory.on_hand-inventory.reserved<quantity)messages.push({type:'error',code:'insufficient_inventory',content:'Requested quantity is unavailable',severity:'recoverable'});
    // Resolve price via variant_prices for the active currency
    let unitPrice: number;
    try {
      unitPrice = await resolveVariantPrice(db, variant.id, currencyId);
    } catch (err) {
      messages.push({
        type: 'error',
        code: 'price_not_available',
        content: `Price not configured for variant ${variant.sku} in currency ${activeCurrency}`,
        severity: 'recoverable',
      });
      continue;
    }

    if(seenSkus.has(variant.sku))throw ApiError.invalidRequest('Duplicate variant; combine quantities in one line');
    seenSkus.add(variant.sku);
    if(!Number.isSafeInteger(unitPrice)||unitPrice<=0||unitPrice>1_000_000_000)throw ApiError.invalidRequest('Invalid configured price');
    const totalPrice = unitPrice * quantity;
    subtotal += totalPrice;
    if(!Number.isSafeInteger(subtotal)||subtotal>1_000_000_000)throw ApiError.invalidRequest('Checkout amount exceeds supported limit');
    
    resolvedItems.push({
      id: uuid(),
      item: {
        id: variant.sku,
        title: variant.title || variant.product_title,
        description: variant.product_description,
        image_url: variant.image_url,
      },
      quantity,
      unit_price: { amount: unitPrice, currency: activeCurrency },
      total_price: { amount: totalPrice, currency: activeCurrency },
    });
  }
  
  const hasErrors = messages.some(m => m.type === 'error');
  let status: UCPCheckoutSession['status'] = 'incomplete';
  if (!hasErrors && resolvedItems.length > 0) {
    status = buyer?.email ? 'ready_for_complete' : 'incomplete';
  }
  
  const { taxAmount: updatedTaxAmount, taxLabel: updatedTaxLabel } = await computeTax(db, subtotal);
  const updatedGrandTotal = subtotal + updatedTaxAmount;
  const totals = [
    { type: 'subtotal', amount: subtotal, currency: activeCurrency },
    ...(updatedTaxAmount > 0 ? [{ type: 'tax' as const, amount: updatedTaxAmount, currency: activeCurrency, label: updatedTaxLabel }] : []),
    { type: 'grand_total', amount: updatedGrandTotal, currency: activeCurrency },
  ];
  
  const updatedCheckout = await db.run(
    `UPDATE ucp_checkout_sessions 
     SET status = ?, currency = ?, line_items = ?, buyer = ?, totals = ?, messages = ?, updated_at = ?
     WHERE id = ? AND status NOT IN ('completed','canceled','complete_in_progress')`,
    [
      status,
      activeCurrency,
      JSON.stringify(resolvedItems),
      JSON.stringify(buyer || null),
      JSON.stringify(totals),
      JSON.stringify(messages),
      now(),
      sessionId,
    ]
  );
  if (!updatedCheckout.changes) throw ApiError.invalidRequest('Checkout changed while updating');
  
  const stripeConfig = await getStripeConfig(db, c.env);
  const paymentHandlers: UCPPaymentHandler[] = [];
  
  if (stripeConfig.secretKey) {
    paymentHandlers.push({
      id: 'stripe_checkout',
      name: 'com.stripe.checkout',
      version: UCP_VERSION,
      spec: 'https://stripe.com/docs/payments/checkout',
      instrument_schemas: ['https://ucp.dev/schemas/shopping/types/card_payment_instrument.json'],
      config: { type: 'REDIRECT' },
    });
  }
  
  return c.json({
    ucp: ucpEnvelope(activeCapabilities()),
    id: sessionId,
    status,
    currency: activeCurrency,
    line_items: resolvedItems,
    buyer: buyer || undefined,
    totals,
    messages,
    links: [
      { rel: 'privacy_policy', href: `${baseUrl}/privacy`, title: 'Privacy Policy' },
      { rel: 'terms_of_service', href: `${baseUrl}/terms`, title: 'Terms of Service' },
    ],
    payment: { handlers: paymentHandlers },
    expires_at: session.expires_at,
  });
});

// POST /ucp/v1/checkout-sessions/:id/complete - Complete Checkout
const routePostComplete = createRoute({
  method: 'post',
  path: '/ucp/v1/checkout-sessions/{id}/complete',
  tags: ['UCP'],
  summary: 'Complete checkout session',
  description: 'Initiates configured Stripe payment and returns a provider redirect. If no handler is configured, returns service unavailable without changing checkout state.',
  request: {
    params: SessionIdParamSchema,
    body: { content: { 'application/json': { schema: CompleteCheckoutBodySchema } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: UCPCheckoutSessionSchema } }, description: 'Session escalated or completed' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid state' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
  },
});
// @ts-expect-error handler returns DB-sourced data whose shape matches the schema at runtime
ucp.openapi(routePostComplete, async (c) => {
  const sessionId = c.req.param('id');
  const body = c.req.valid('json');
  const { payment_data, risk_signals } = body;
  
  const db = getDb(c.var.db);
  const baseUrl = storeApiBase(c.req.url, c.env);
  await assertLegacySession(db,sessionId);
  
  const [session] = await db.query<any>(
    `SELECT * FROM ucp_checkout_sessions WHERE id = ?`,
    [sessionId]
  );
  
  if (!session) {
    throw ApiError.notFound('Checkout session not found');
  }
  
  if (session.status === 'completed') {
    throw ApiError.invalidRequest('Checkout already completed');
  }
  if (session.status === 'canceled') {
    throw ApiError.invalidRequest('Checkout was canceled');
  }
  if (!['ready_for_complete', 'complete_in_progress'].includes(session.status)) {
    throw ApiError.invalidRequest(`Cannot complete checkout in ${session.status} state`);
  }
  
  if(session.status!=='complete_in_progress'&&Date.parse(session.expires_at)<=Date.now())throw ApiError.invalidRequest('Checkout has expired');
  const lineItems = JSON.parse(session.line_items || '[]');
  const buyer = JSON.parse(session.buyer || '{}');
  const totals = JSON.parse(session.totals || '[]');

  const stripeConfig = await getStripeConfig(db, c.env);

  // For UCP, we use Stripe Checkout redirect flow
  // The payment_data should indicate the handler being used
  if (stripeConfig.secretKey && payment_data?.handler_id === 'stripe_checkout') {
    const stripeSession = await startStripeCheckout(c.var.db, c.env, sessionId, baseUrl,
      payment_data.success_url, payment_data.cancel_url);

    // Return requires_escalation with continue_url pointing to Stripe
    return c.json({
      ucp: ucpEnvelope(activeCapabilities()),
      id: sessionId,
      status: 'requires_escalation' as const,
      currency: session.currency,
      line_items: lineItems,
      buyer: buyer || undefined,
      totals,
      messages: [{
        type: 'info' as const,
        code: 'payment_required',
        content: 'Redirect to payment provider to complete purchase',
      }],
      links: [
        { rel: 'privacy_policy', href: `${baseUrl}/privacy`, title: 'Privacy Policy' },
        { rel: 'terms_of_service', href: `${baseUrl}/terms`, title: 'Terms of Service' },
      ],
      payment: {
        handlers: [{
          id: 'stripe_checkout',
          name: 'com.stripe.checkout',
          version: UCP_VERSION,
          spec: 'https://stripe.com/docs/payments/checkout',
          instrument_schemas: [],
        }],
      },
      continue_url: stripeSession.url,
      expires_at: session.expires_at,
    });
  }
  
  throw ApiError.serviceUnavailable('No configured checkout handler; contact the merchant');
});

// DELETE /ucp/v1/checkout-sessions/:id - Cancel Checkout
const routeDeleteCheckoutSession = createRoute({
  method: 'delete',
  path: '/ucp/v1/checkout-sessions/{id}',
  tags: ['UCP'],
  summary: 'Cancel checkout session',
  request: { params: SessionIdParamSchema },
  responses: {
    200: { content: { 'application/json': { schema: UCPCheckoutSessionSchema } }, description: 'Session canceled' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Cannot cancel completed session' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
  },
});
// @ts-expect-error handler returns DB-sourced data whose shape matches the schema at runtime
ucp.openapi(routeDeleteCheckoutSession, async (c) => {
  const sessionId = c.req.param('id');
  const db = getDb(c.var.db);
  const baseUrl = storeApiBase(c.req.url, c.env);
  await assertLegacySession(db,sessionId);
  
  const [session] = await db.query<any>(
    `SELECT * FROM ucp_checkout_sessions WHERE id = ?`,
    [sessionId]
  );
  
  if (!session) {
    throw ApiError.notFound('Checkout session not found');
  }
  
  if (['completed', 'complete_in_progress'].includes(session.status)) {
    throw ApiError.invalidRequest('Cannot cancel a checkout with a payment in progress');
  }
  
  await db.run(
    `UPDATE ucp_checkout_sessions SET status = 'canceled', updated_at = ? WHERE id = ? AND status NOT IN ('completed','complete_in_progress')`,
    [now(), sessionId]
  );
  
  return c.json({
    ucp: ucpEnvelope(activeCapabilities()),
    id: sessionId,
    status: 'canceled' as const,
    currency: session.currency,
    line_items: JSON.parse(session.line_items || '[]'),
    buyer: JSON.parse(session.buyer || 'null') || undefined,
    totals: JSON.parse(session.totals || '[]'),
    messages: [{
      type: 'info' as const,
      code: 'checkout_canceled',
      content: 'Checkout session has been canceled',
    }],
    links: [
      { rel: 'privacy_policy', href: `${baseUrl}/privacy`, title: 'Privacy Policy' },
      { rel: 'terms_of_service', href: `${baseUrl}/terms`, title: 'Terms of Service' },
    ],
    payment: { handlers: [] },
  });
});

// PATCH /ucp/v1/checkout-sessions/:id - Partial update (buyer or quantities)
const routePatchCheckoutSession = createRoute({
  method: 'patch',
  path: '/ucp/v1/checkout-sessions/{id}',
  tags: ['UCP'],
  summary: 'Partial update of checkout session',
  description: 'Updates buyer info and/or item quantities without full re-resolution. Taxes are recalculated if quantities change.',
  request: {
    params: SessionIdParamSchema,
    body: { content: { 'application/json': { schema: PatchCheckoutBodySchema } } },
  },
  responses: {
    303: { description: 'Redirect to updated session' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid request' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
  },
});
ucp.openapi(routePatchCheckoutSession, async (c) => {
  const sessionId = c.req.param('id');
  const body = c.req.valid('json');
  const db = getDb(c.var.db);
  await assertLegacySession(db,sessionId);

  const [session] = await db.query<any>(
    `SELECT * FROM ucp_checkout_sessions WHERE id = ?`, [sessionId]
  );
  if (!session) throw ApiError.notFound('Checkout session not found');
  if (['completed', 'canceled', 'complete_in_progress'].includes(session.status)) {
    throw ApiError.invalidRequest(`Cannot update ${session.status} session`);
  }

  if(Date.parse(session.expires_at)<=Date.now())throw ApiError.invalidRequest('Checkout has expired');
  if(body.buyer===undefined&&body.line_items===undefined)throw ApiError.invalidRequest('No fields to update');
  const currentItems:UCPLineItem[]=JSON.parse(session.line_items||'[]');
  const patches=body.line_items||[];
  if(new Set(patches.map(p=>p.id)).size!==patches.length||patches.some(p=>!currentItems.some(i=>i.id===p.id)))throw ApiError.invalidRequest('Unknown or duplicate line item');
  const items=currentItems.map(item=>{const qty=patches.find(p=>p.id===item.id)?.quantity??item.quantity;return {...item,quantity:qty,total_price:{...item.unit_price,amount:item.unit_price.amount*qty}};});
  for(const item of items){
    const [available]=await db.query<{on_hand:number;reserved:number}>("SELECT i.on_hand,i.reserved FROM variants v JOIN products p ON p.id=v.product_id JOIN inventory i ON i.sku=v.sku WHERE v.sku=? AND v.status='active' AND p.status='active'",[item.item.id]);
    if(!available||available.on_hand-available.reserved<item.quantity)throw ApiError.invalidRequest('Requested product or quantity is unavailable');
  }
  const subtotal=items.reduce((sum,item)=>sum+item.total_price.amount,0);if(!Number.isSafeInteger(subtotal)||subtotal>1_000_000_000)throw ApiError.invalidRequest('Checkout amount exceeds supported limit');
  const {taxAmount,taxLabel}=await computeTax(db,subtotal);
  const oldTotals:UCPTotal[]=JSON.parse(session.totals||'[]'),shipping=oldTotals.find(t=>t.type==='shipping')?.amount||0;
  const totals:UCPTotal[]=[{type:'subtotal',amount:subtotal,currency:session.currency},...(taxAmount?[{type:'tax' as const,amount:taxAmount,currency:session.currency,label:taxLabel}]:[]),...(shipping?[{type:'shipping' as const,amount:shipping,currency:session.currency}]:[]),{type:'grand_total',amount:subtotal+taxAmount+shipping,currency:session.currency}];
  const buyer={...(JSON.parse(session.buyer||'null')||{}),...body.buyer};
  const changed=await db.run("UPDATE ucp_checkout_sessions SET status=?,buyer=?,line_items=?,totals=?,messages='[]',updated_at=? WHERE id=? AND status NOT IN ('completed','canceled','complete_in_progress') AND line_items=? AND buyer IS ?",[buyer.email&&items.length?'ready_for_complete':'incomplete',JSON.stringify(buyer),JSON.stringify(items),JSON.stringify(totals),now(),sessionId,session.line_items,session.buyer]);
  if(!changed.changes)throw ApiError.invalidRequest('Checkout changed while updating');
  return c.redirect(storeApiBase(c.req.url,c.env)+'/ucp/v1/checkout-sessions/'+sessionId,303);
});

// ============================================================
// UCP BROWSE CAPABILITY — catalog &amp; product browsing for AI agents
// ============================================================

const routeGetProducts = createRoute({
  method: 'get',
  path: '/ucp/v1/products',
  tags: ['UCP'],
  summary: 'Browse products',
  request: { query: ProductsQuerySchema },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ucp: UCPEnvelopeSchema,
            items: z.array(z.record(z.string(), z.unknown())),
            pagination: z.object({ limit: z.number(), offset: z.number(), count: z.number() }),
          }),
        },
      },
      description: 'Product list',
    },
  },
});
// @ts-expect-error handler returns DB-sourced data whose shape matches the schema at runtime
ucp.openapi(routeGetProducts, async (c) => {
  const db = getDb(c.var.db);
  const { limit = '20', offset = '0', category, q } = c.req.query();
  const lim = Math.min(parseInt(limit, 10) || 20, 100);
  const off = Math.max(parseInt(offset, 10) || 0, 0);

  let sql = `
    SELECT p.id, p.title, p.description,
           COALESCE(v.thumbnail_url, v.image_url, p.image_url) as thumbnail_url,
           COALESCE(v.image_url, p.image_url) as image_url,
           MIN(vp.price_cents) as min_price_cents,
           cur.code as currency_code
    FROM products p
    LEFT JOIN variants v ON v.product_id = p.id AND v.status = 'active'
    LEFT JOIN variant_prices vp ON vp.variant_id = v.id
    LEFT JOIN currencies cur ON cur.id = vp.currency_id
    WHERE p.status = 'active'
  `;
  const params: unknown[] = [];

  if (q) {
    sql += ` AND (p.title LIKE ? OR p.description LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`);
  }
  if (category) {
    sql += `
      AND EXISTS (
        SELECT 1 FROM product_categories pc
        JOIN categories cat ON cat.id = pc.category_id
        WHERE pc.product_id = p.id AND cat.handle = ?
      )`;
    params.push(category);
  }

  sql += ` GROUP BY p.id LIMIT ? OFFSET ?`;
  params.push(lim, off);

  const items = await db.query(sql, params);

  return c.json({
    ucp: ucpEnvelope([
      { name: 'dev.ucp.shopping.browse', version: UCP_VERSION },
      { name: 'dev.ucp.shopping.catalog', version: UCP_VERSION },
    ]),
    items,
    pagination: { limit: lim, offset: off, count: items.length },
  });
});

const routeGetProductById = createRoute({
  method: 'get',
  path: '/ucp/v1/products/{id}',
  tags: ['UCP'],
  summary: 'Get product',
  request: { params: ProductIdParamSchema },
  responses: {
    200: { content: { 'application/json': { schema: z.object({ ucp: UCPEnvelopeSchema, product: z.record(z.string(), z.unknown()) }) } }, description: 'Product detail' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
  },
});
// @ts-expect-error handler returns DB-sourced data whose shape matches the schema at runtime
ucp.openapi(routeGetProductById, async (c) => {
  const productId = c.req.param('id');
  const db = getDb(c.var.db);

  // Accept product id, product handle, variant id, or variant sku
  const [product] = await db.query<Record<string, unknown>>(
    `SELECT p.* FROM products p
     WHERE p.status = 'active'
       AND (p.id = ? OR p.handle = ?
            OR EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND (v.id = ? OR v.sku = ?)))
     LIMIT 1`,
    [productId, productId, productId, productId]
  );
  if (!product) throw ApiError.notFound('Product not found');

  const variants = await db.query(
    `SELECT v.id, v.sku, v.title, v.image_url, v.thumbnail_url,
            vp.price_cents, cur.code as currency
     FROM variants v
     LEFT JOIN variant_prices vp ON vp.variant_id = v.id
     LEFT JOIN currencies cur ON cur.id = vp.currency_id
     WHERE v.product_id = ? AND v.status = 'active'`,
    [product.id]
  );

  return c.json({
    ucp: ucpEnvelope([
      { name: 'dev.ucp.shopping.browse', version: UCP_VERSION },
    ]),
    product: { ...product, variants },
  });
});

const routeGetCategories = createRoute({
  method: 'get',
  path: '/ucp/v1/categories',
  tags: ['UCP'],
  summary: 'Browse categories',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ucp: UCPEnvelopeSchema,
            categories: z.array(z.record(z.string(), z.unknown())),
          }),
        },
      },
      description: 'Category list',
    },
  },
});
// @ts-expect-error handler returns DB-sourced data whose shape matches the schema at runtime
ucp.openapi(routeGetCategories, async (c) => {
  const db = getDb(c.var.db);
  const categories = await db.query(
    `SELECT id, handle, name, parent_id, image_url
     FROM categories WHERE status = 'active' ORDER BY position ASC, name ASC`,
    []
  );
  return c.json({
    ucp: ucpEnvelope([{ name: 'dev.ucp.shopping.catalog', version: UCP_VERSION }]),
    categories,
  });
});

// ============================================================
// UCP SHIPPING ESTIMATION
// ============================================================

const routePostEstimateShipping = createRoute({
  method: 'post',
  path: '/ucp/v1/checkout-sessions/{id}/estimate-shipping',
  tags: ['UCP'],
  summary: 'Estimate shipping options',
  description: 'Returns available shipping rates for the given country code.',
  request: {
    params: SessionIdParamSchema,
    body: { content: { 'application/json': { schema: EstimateShippingBodySchema } } },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            ucp: UCPEnvelopeSchema,
            shipping_options: z.array(UCPShippingOptionSchema),
          }),
        },
      },
      description: 'Available shipping options',
    },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid request' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
  },
});
// @ts-expect-error handler returns DB-sourced data whose shape matches the schema at runtime
ucp.openapi(routePostEstimateShipping, async (c) => {
  const sessionId = c.req.param('id');
  const body = c.req.valid('json');
  const countryCode: string = body.country_code;

  const db = getDb(c.var.db);
  await assertLegacySession(db,sessionId);

  const [session]=await db.query<{id:string;currency:string;status:string;expires_at:string;line_items:string}>("SELECT id,currency,status,expires_at,line_items FROM ucp_checkout_sessions WHERE id=?",[sessionId]);
  if(!session)throw ApiError.notFound('Checkout session not found');
  if(['completed','canceled','complete_in_progress'].includes(session.status)||Date.parse(session.expires_at)<=Date.now())throw ApiError.invalidRequest('Checkout cannot be quoted in this state');
  let weight=0,physical=false;
  for(const item of JSON.parse(session.line_items||'[]') as UCPLineItem[]){
    const [variant]=await db.query<{weight_g:number;requires_shipping:number;shipping_class_id:string|null}>("SELECT v.weight_g,v.requires_shipping,COALESCE(v.shipping_class_id,p.shipping_class_id) shipping_class_id FROM variants v JOIN products p ON p.id=v.product_id WHERE v.sku=? AND v.status='active' AND p.status='active'",[item.item.id]);
    if(!variant)throw ApiError.invalidRequest('Product is unavailable');
    if(variant.requires_shipping===0)continue;
    if(variant.shipping_class_id||!Number.isFinite(variant.weight_g)||variant.weight_g<=0)throw ApiError.invalidRequest('Shipping requires merchant checkout with product shipping context');
    physical=true;weight+=variant.weight_g*item.quantity;
  }
  const rates=physical?await db.query<{id:string;name:string;price_cents:number;estimated_days:number|null}>(
    "SELECT DISTINCT sr.id,sr.display_name name,sp.amount_cents price_cents,sr.max_delivery_days estimated_days FROM shipping_rates sr JOIN region_shipping_rates rs ON rs.shipping_rate_id=sr.id JOIN regions r ON r.id=rs.region_id JOIN region_countries rc ON rc.region_id=r.id JOIN countries c ON c.id=rc.country_id JOIN currencies cur ON cur.id=r.currency_id JOIN shipping_rate_prices sp ON sp.shipping_rate_id=sr.id AND sp.currency_id=cur.id WHERE c.code=? AND c.status='active' AND r.status='active' AND cur.status='active' AND cur.code=? AND sr.status='active' AND sr.shipping_class_id IS NULL AND (sr.max_weight_g IS NULL OR sr.max_weight_g>=?) AND sp.amount_cents>=0 ORDER BY sp.amount_cents,sr.id",
    [countryCode.toUpperCase(),session.currency,weight]):[];

  return c.json({
    ucp: ucpEnvelope([{ name: 'dev.ucp.shopping.checkout', version: UCP_VERSION }]),
    shipping_options: rates.map(rate => ({
      id: rate.id,
      name: rate.name ?? 'Standard Shipping',
      price_cents: rate.price_cents,
      currency: session.currency,
      estimated_days: rate.estimated_days ?? null,
    })),
  });
});

// ============================================================
// UCP ORDER CAPABILITY - Webhook handler for Stripe completion
// ============================================================

/**
 * Handles a `checkout.session.completed` Stripe webhook for UCP checkout sessions.
 *
 * Looks up the internal UCP checkout session via `ucp_checkout_session_id` from
 * the Stripe session metadata, marks it as `completed`, decrements inventory,
 * and creates an order record.
 *
 * Called by the main Stripe webhook route; not exposed directly as an HTTP endpoint.
 *
 * @param stub            - Store-scoped Durable Object stub.
 * @param stripeSessionId - The Stripe `checkout.session` ID.
 * @param stripeSession   - The full Stripe `Checkout.Session` object from the event.
 */
export async function handleUCPStripeWebhook(
  stub: import('../types').DOStub,
  stripeSessionId: string,
  stripeSession: Stripe.Checkout.Session,
): Promise<void> {
  const sessionId = stripeSession.metadata?.ucp_checkout_session_id;
  if (!sessionId || stripeSession.payment_status !== 'paid') return;
  await stub.ucpPaymentSettle({ sessionId, stripeId: stripeSessionId,
    paymentStatus: stripeSession.payment_status,
    amount: stripeSession.amount_total ?? -1, currency: stripeSession.currency || '',
    paymentIntent: typeof stripeSession.payment_intent === 'string'
      ? stripeSession.payment_intent : stripeSession.payment_intent?.id || null,
  });
}
