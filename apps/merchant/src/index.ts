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

import { OpenAPIHono } from '@hono/zod-openapi';
import {commerce} from './routes/commerce';
import {processCommerceOrder as syncCommerceOrder} from './lib/commerce-shipment';
import {ShippingError} from './lib/smart-shipping';
import {smartShipping} from './routes/smart-shipping';
import { cors } from 'hono/cors';
import { swaggerUI } from '@hono/swagger-ui';
import { adminSetup } from './routes/setup';
import { adminCatalog } from './routes/catalog';
import { adminInventory } from './routes/inventory';
import { adminCheckout } from './routes/checkout';
import { adminOrders, publicOrders } from './routes/orders';
import { adminCustomers } from './routes/customers';
import { webhooks } from './routes/webhooks';
import { adminWebhooksRoutes } from './routes/webhooks-outbound';
import { publicImages } from './routes/images';
import { adminDiscounts } from './routes/discounts';
import { oauth } from './routes/oauth';
import { ucp } from './routes/ucp';
import { adminAuth0 } from './routes/auth0';
import { adminMe } from './routes/me';
import { adminUserPreferencesRouter } from './routes/user-preferences';
import { adminSavedCartsRouter } from './routes/saved-carts';
import { publicCategories, adminCategories } from './routes/categories';
import { adminAnalytics } from './routes/analytics';
import { reviews, adminReviews } from './routes/reviews';
import { adminRegions } from './routes/regions';
import { adminOrderEmailSettings } from './routes/order-email-settings';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { kvCacheMiddleware, kvInvalidateMiddleware } from './middleware/kv-cache';
import { adminAi } from './routes/ai';
import { adminTaxRates } from './routes/tax-rates';
import { ApiError, type Env, type DOStub } from './types';
import { MerchantDO } from './do';
import { adminMails } from './routes/mails';
import { sitemapRouter } from './routes/sitemap';
import { adminDigitalAssetVariantRouter, adminDigitalAssetsRouter } from './routes/digital-assets';
import { customerOrderDownloads, publicDownloads } from './routes/downloads';
import { customerAiTokensRouter, proxyAiTokensRouter, adminAiTokensRouter } from './routes/ai-tokens';
import { storefrontContent } from './routes/storefront-content';
import { customerSessions } from './routes/customer-sessions';
import { adminPancake } from './routes/pancake';
import { ctxlayerRoute } from './routes/ctxlayer';
import { resolveStore, storeRegistry, storeEnvironment, merchantObjectName } from './lib/stores';
import { syncPancake } from './lib/pancake-sync';
import { PancakeError } from './lib/pancake-source';
import { imageCdnMiddleware } from './middleware/image-cdn';

export { MerchantDO };

type Variables = {
  db: DOStub;
};

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
});

app.use('*', cors());

// Runs outside JSON caching so existing cached origin URLs are rewritten too.
app.use('/v1/products', imageCdnMiddleware);
app.use('/v1/products/*', imageCdnMiddleware);
app.use('/v1/categories', imageCdnMiddleware);
app.use('/v1/categories/*', imageCdnMiddleware);
app.use('/ucp/v1/products', imageCdnMiddleware);
app.use('/ucp/v1/products/*', imageCdnMiddleware);

app.use('*', async (c, next) => {
  const id = c.env.MERCHANT.idFromName(merchantObjectName(c.env));
  const stub = c.env.MERCHANT.get(id);
  c.set('db', stub as unknown as DOStub);
  await next();
});

// KV cache & invalidation: must be registered on the parent app with app.use()
// BEFORE app.route() so they execute first in Hono's middleware chain.
//
// kvCacheMiddleware caches:
//   • Unauthenticated GETs (public categories, reviews)
//   • GETs with a public key (Bearer pk_...) — same response for all storefront
//     visitors; products and product pages are the highest-traffic endpoints.
// Admin tokens (sk_ / JWT) always bypass the cache.
//
// kvInvalidateMiddleware purges by prefix on successful mutations, covering
// both the list and all paginated/filtered/detail variants of each namespace.
app.use('/v1/categories', kvCacheMiddleware);
app.use('/v1/categories/*', kvCacheMiddleware);
app.use('/v1/products', kvCacheMiddleware);
app.use('/v1/products/*', kvCacheMiddleware);
app.use('/openapi.json', kvCacheMiddleware);
app.use('/openapi/*', kvCacheMiddleware);
app.use('/.well-known/ucp', kvCacheMiddleware);
app.use('/ucp/v1/products', kvCacheMiddleware);
app.use('/ucp/v1/products/*', kvCacheMiddleware);
app.use('/ucp/v1/categories', kvCacheMiddleware);
app.use('/v1/categories', kvInvalidateMiddleware);
app.use('/v1/categories/*', kvInvalidateMiddleware);
app.use('/v1/products', kvInvalidateMiddleware);
app.use('/v1/products/*', kvInvalidateMiddleware);

// Mount public routes BEFORE authentication middleware
app.route('/', sitemapRouter);         // /sitemap.xml — no auth
app.route('/v1/orders', publicOrders);
app.route('/v1/categories', publicCategories);

app.use('/v1/*', rateLimitMiddleware());

app.onError((err, c) => {
  console.error(err);

  if(err instanceof ShippingError)return c.json({error:{code:err.code,message:err.message}},err.status as 400|404|409|422|429|502|503);

  if (err instanceof ApiError) {
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details && { details: err.details }),
        },
      },
      err.statusCode as any
    );
  }

  // Extract detailed error message for database and other errors
  const errorMessage = err instanceof Error ? err.message : String(err);
  if(errorMessage.includes('Exceeded allowed rows written in Durable Objects free tier')) {
    return c.json({error:{code:'database_write_limit',message:'Backend đã đạt hạn mức ghi database hôm nay. Vui lòng thử lại sau khi hạn mức được đặt lại.'}},503);
  }
  const message = 'Internal server error';

  return c.json({ error: { code: 'internal', message } }, 500);
});

app.get('/', (c) => c.json({ name: 'fufuni', version: '0.1.0', ok: true }));

app.route('/v1/storefront-content', storefrontContent);
app.route('/v1/customer-auth', customerSessions);
app.route('/v1/setup', adminSetup);
app.route('/v1/integrations/pancake', adminPancake);
app.route('/v1/integrations/ctxlayer',ctxlayerRoute);
app.route('/v1/ai', adminAi);
// Mount reviews BEFORE catalog — catalog has app.use('*', authMiddleware) which
// would otherwise intercept /v1/products/:productId/reviews/guest (a public route)
app.route('/v1/products/:productId/reviews', reviews);
app.route('/v1/products', adminCatalog);
app.route('/v1/inventory', adminInventory);
app.route('/v1/carts', adminCheckout);
app.route('/v1/shipping',smartShipping);
app.route('/v1/commerce',commerce);
app.route('/v1/orders', customerOrderDownloads);
app.route('/v1/orders', adminOrders);
app.route('/v1/categories', adminCategories);
app.route('/v1/analytics', adminAnalytics);
app.route('/v1/reviews', adminReviews);
app.route('/v1/customers', adminCustomers);
app.route('/v1/webhooks', webhooks);
app.route('/v1/webhooks', adminWebhooksRoutes);
app.route('/v1/images', publicImages);
app.route('/v1/discounts', adminDiscounts);
app.route('/v1/regions', adminRegions);
app.route('/v1/tax-rates', adminTaxRates);
app.route('/v1/mails', adminMails);
app.route('/v1/admin/order-email-settings', adminOrderEmailSettings);
app.route('/v1/me', adminMe);
app.route('/v1/me/ai-tokens', customerAiTokensRouter);
app.route('/v1', adminUserPreferencesRouter);
app.route('/v1', adminSavedCartsRouter);

app.route('/v1/downloads', publicDownloads);
app.route('/v1/products', adminDigitalAssetVariantRouter);
app.route('/v1/admin/digital-assets', adminDigitalAssetsRouter);
app.route('/v1/ai-tokens/proxy', proxyAiTokensRouter);
app.route('/v1/admin/ai-tokens', adminAiTokensRouter);
app.route('/oauth', oauth);
app.route('', oauth);
app.route('/', ucp);
app.route('/v1/__auth0', adminAuth0);

app.doc31('/openapi.json', (c) => ({
  openapi: '3.1.0',
  info: {
    title: 'Fufuni API',
    version: '1.0.0',
    description: 'The open-source commerce backend for Cloudflare + Stripe + Auth0',
  },
  servers: [{ url: c.env.STORE_API_PREFIX || '/' }],
}));

app.get('/docs', (c, next) => swaggerUI<{ Bindings: Env; Variables: Variables }>({ url: `${c.env.STORE_API_PREFIX || ''}/openapi.json` })(c, next));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      const selected = resolveStore(request, env);
      return await app.fetch(selected.request, selected.env, ctx);
    } catch (error) {
      const failure = error instanceof ApiError ? error : ApiError.serviceUnavailable('Store routing is unavailable');
      return Response.json({ error: { code: failure.code, message: failure.message } }, { status: failure.statusCode });
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    for (const store of storeRegistry(env).stores) {
      try {
        const selected = storeEnvironment(env, store);
        const stub = selected.MERCHANT.get(selected.MERCHANT.idFromName(merchantObjectName(selected)));
        if(selected.PANCAKE_ORDER_SYNC_ENABLED==='true'){
          await stub.commerceOverviewInit();
          const jobs=await stub.commercePending();
          for(const job of jobs){try{await syncCommerceOrder(selected,stub,job.order_id);}catch{console.warn(JSON.stringify({event:'commerce.pos.needs_attention',store_id:store.id,order_id:job.order_id}));}}
        }
        const cleaned = await stub.cleanupExpiredCarts();
        console.log(JSON.stringify({ event: 'store.carts.cleaned', store_id: store.id, count: cleaned }));
        if (selected.PANCAKE_SYNC_ENABLED === 'true' && (_event.cron !== '*/5 * * * *' || new Date(_event.scheduledTime).getUTCMinutes() === 0)) {
          const report = await syncPancake(selected,{trigger:'cron'});
          console.log(JSON.stringify({ event: 'pancake.catalog.synced', store_id: store.id, source:selected.PANCAKE_CATALOG_SOURCE||'direct',run_id:'run_id' in report?report.run_id:undefined, products: report.products, variants: report.variants, warnings: report.warnings }));
        }
      } catch (error) {
        console.error(JSON.stringify({ event: 'store.scheduled.failed', store_id: store.id, code: error instanceof PancakeError ? error.code : 'storage' }));
      }
    }
  },
};
