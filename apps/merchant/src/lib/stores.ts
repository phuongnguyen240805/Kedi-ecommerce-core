import { z } from 'zod';
import { ApiError, type Env } from '../types';

const idSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const settingsSchema = z.record(z.string(), z.string());
const storeSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  origins: z.array(z.string().url()).default([]),
  settings: settingsSchema.default({}),
});
const registrySchema = z.object({
  default_store: idSchema,
  stores: z.array(storeSchema).min(1),
});
export type StoreConfig = z.infer<typeof storeSchema>;

// These values belong to a store, never to every customer of the Worker.
const storeSettings = new Set([
  'CHECKOUT_CARRIER_ENABLED','CHECKOUT_ENABLED','ACP_ENABLED','ACP_ACCESS_VERIFIED',
  'MARKETING_AI_ENABLED','MARKETING_AI_MODEL',
  'SHOPPING_ENABLED',
  'SHOPPING_AI_ENABLED','SHOPPING_AI_MODEL',
  'MARKETING_ENABLED','MARKETING_SEND_ENABLED','MARKETING_POLICY_VERSION','MARKETING_FROM_EMAIL','MARKETING_CONTACT_ADDRESS','MARKETING_WELCOME_DISCOUNT_CODE','MARKETING_MAILGUN_DOMAIN','MARKETING_MAILGUN_BASE_URL','FEEDS_ENABLED',
  'POD_ENABLED', 'POD_SUBMIT_ENABLED', 'POD_ACCOUNT_AUTOMATION_VERIFIED', 'PRINTIFY_SHOP_ID', 'STORE_PUBLIC_API_URL',
  'PANCAKE_CATALOG_SOURCE',
  'CTXLAYER_MCP_ENABLED',
  'CTXLAYER_MCP_URL',
  'CTXLAYER_OAUTH_REDIRECT_URI',
  'CTXLAYER_PRINCIPAL_ID',
  'CTXLAYER_PANCAKE_UPSTREAM_SLUG',
  'COMMERCE_CHECKOUT_ENABLED',
  'COMMERCE_SERVICE_ENABLED',
  'COMMERCE_EXPIRE_UNPAID_ENABLED',
  'COMMERCE_SERVICE_FINANCE_SUBJECTS',
  'COMMERCE_ENVIRONMENT',
  'TECHCOMBANK_ACCOUNT_NUMBER',
  'TECHCOMBANK_ACCOUNT_NAME',
  'PANCAKE_ORDER_SYNC_ENABLED',
  'PANCAKE_GHN_DISPATCH_ENABLED',
  'PANCAKE_GHN_ACCOUNT_ID',
  'PANCAKE_PAYMENT_MAPPING_VERIFIED',
  'STORE_URL',
  'PANCAKE_STOCK_ONLY',
  'PANCAKE_SHOP_ID',
  'PANCAKE_WAREHOUSE_ID',
  'PANCAKE_SYNC_ENABLED',
  'PANCAKE_VARIANT_TYPE',
  'AUTH0_DOMAIN',
  'AUTH0_AUDIENCE',
  'ADMIN_STORE_PERMISSION',
  'CARRIER_REGISTRY_JSON',
  'SHIPPING_AUTOMATION_ENABLED',
  'PANCAKE_TRACKING_MIRROR_VERIFIED',
  'SMART_SHIPPING_ENABLED',
  'SMART_SHIPPING_POLICY',
  'GHN_SHOP_ID',
  'GHN_FROM_DISTRICT_ID',
  'GHN_FROM_WARD_CODE',
  'GHN_ENVIRONMENT',
  'IMAGE_CDN_URL',
  'IMAGE_CDN_ALLOWED_HOSTS',
  'IMAGES_URL',
  'STRIPE_PUBLISHABLE_KEY',
  'CUSTOMER_PASSWORD_AUTH_ENABLED',
]);
const storeSecrets = new Set([
  'MARKETING_BFF_TOKEN','ACP_API_TOKEN','CHECKOUT_BFF_TOKEN',
  'MARKETING_OPENAI_API_KEY',
  'SHOPPING_MCP_TOKEN',
  'SHOPPING_OPENAI_API_KEY',
  'MAILGUN_WEBHOOK_SIGNING_KEY',
  'PRINTIFY_API_TOKEN',
  'CTXLAYER_TOKEN_KEY',
  'PANCAKE_API_KEY',
  'SETUP_INIT_TOKEN',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'ORDER_TOKEN_SECRET',
  'GHN_TOKEN',
  'CARRIER_SECRETS_JSON',
  'PANCAKE_ORDER_WEBHOOK_SECRET',
  'AI_BALANCE_SHARED_SECRET',
  'MAILGUN_API_KEY',
]);

export function storeRegistry(env: Env) {
  if (!env.STORES_JSON)
    return {
      default_store: 'halifruit',
      stores: [
        {
          id: 'halifruit',
          name: env.STORE_NAME || 'Halifruit',
          origins: [],
          settings: {},
        },
      ],
    } satisfies z.infer<typeof registrySchema>;
  let registry: z.infer<typeof registrySchema>;
  try {
    registry = registrySchema.parse(
      typeof env.STORES_JSON === 'string'
        ? JSON.parse(env.STORES_JSON)
        : env.STORES_JSON,
    );
  } catch {
    throw ApiError.serviceUnavailable('Invalid store registry');
  }
  const ids = new Set(registry.stores.map((s) => s.id));
  if (ids.size !== registry.stores.length || !ids.has(registry.default_store))
    throw ApiError.serviceUnavailable('Invalid store identities');
  for (const store of registry.stores) {
    if (Object.keys(store.settings).some((key) => !storeSettings.has(key)))
      throw ApiError.serviceUnavailable('Unsupported store setting');
    if (
      store.settings.PANCAKE_VARIANT_TYPE &&
      !['physical', 'digital', 'ai_tokens'].includes(
        store.settings.PANCAKE_VARIANT_TYPE,
      )
    )
      throw ApiError.serviceUnavailable('Invalid POS variant type');
    for (const key of [
      'PANCAKE_STOCK_ONLY',
      'PANCAKE_SYNC_ENABLED',
      'CUSTOMER_PASSWORD_AUTH_ENABLED',
      'SMART_SHIPPING_ENABLED',
    ])
      if (
        store.settings[key] &&
        !['true', 'false'].includes(store.settings[key])
      )
        throw ApiError.serviceUnavailable('Invalid store feature setting');
  }
  return registry;
}

export function merchantObjectName(env: Env): string {
  return env.STORE_OBJECT_NAME || 'default';
}

/** Namespace all KV operations, including caches, rate limits and AI config. */
export function scopedKV(kv: KVNamespace, storeId: string): KVNamespace {
  const prefix = `store:${storeId}:`;
  return new Proxy(kv, {
    get(target, property) {
      if (property === 'get' || property === 'getWithMetadata')
        return (key: string, ...args: unknown[]) => {
          if (typeof key !== 'string')
            throw new TypeError(
              'Bulk KV reads are not supported in store scope',
            );
          return Reflect.apply(Reflect.get(target, property), target, [
            prefix + key,
            ...args,
          ]);
        };
      if (property === 'put' || property === 'delete')
        return (key: string, ...args: unknown[]) =>
          Reflect.apply(Reflect.get(target, property), target, [
            prefix + key,
            ...args,
          ]);
      if (property === 'list')
        return async (options: KVNamespaceListOptions = {}) => {
          const result = await target.list({
            ...options,
            prefix: prefix + (options.prefix || ''),
          });
          return {
            ...result,
            keys: result.keys.map((key) => ({
              ...key,
              name: key.name.slice(prefix.length),
            })),
          };
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function scopedBucket(bucket: R2Bucket, storeId: string): R2Bucket {
  const prefix = `stores/${storeId}/`;
  return new Proxy(bucket, {
    get(target, property) {
      if (
        [
          'get',
          'head',
          'put',
          'createMultipartUpload',
          'resumeMultipartUpload',
        ].includes(String(property))
      )
        return (key: string, ...args: unknown[]) =>
          Reflect.apply(Reflect.get(target, property), target, [
            prefix + key,
            ...args,
          ]);
      if (property === 'delete')
        return (keys: string | string[]) =>
          target.delete(
            Array.isArray(keys)
              ? keys.map((key) => prefix + key)
              : prefix + keys,
          );
      if (property === 'list')
        return async (options: R2ListOptions = {}) => {
          const result = await target.list({
            ...options,
            prefix: prefix + (options.prefix || ''),
          });
          return {
            ...result,
            objects: result.objects.map((object) => ({
              ...object,
              key: object.key.slice(prefix.length),
            })),
          };
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function storeEnvironment(env: Env, store: StoreConfig): Env {
  const registry = storeRegistry(env);
  const isDefault = store.id === registry.default_store;
  const scoped = { ...env } as Env & Record<string, unknown>;
  if (!isDefault) {
    for (const key of [...storeSettings, ...storeSecrets]) delete scoped[key];
  }
  let secrets: Record<string, Record<string, string>> = {};
  if (env.STORE_SECRETS_JSON) {
    try {
      secrets = z
        .record(idSchema, settingsSchema)
        .parse(JSON.parse(env.STORE_SECRETS_JSON));
    } catch {
      throw ApiError.serviceUnavailable('Invalid store secrets');
    }
  }
  const selectedSecrets = secrets[store.id] || {};
  if (Object.keys(selectedSecrets).some((key) => !storeSecrets.has(key)))
    throw ApiError.serviceUnavailable('Unsupported store secret');
  Object.assign(scoped, store.settings, selectedSecrets, {
    STORE_ID: store.id,
    STORE_NAME: store.name,
    STORE_OBJECT_NAME: isDefault ? 'default' : `store:${store.id}`,
    STORE_API_PREFIX: isDefault ? '' : `/stores/${store.id}`,
    KV_CACHE: isDefault ? env.KV_CACHE : scopedKV(env.KV_CACHE, store.id),
  });
  if (!isDefault) {
    if (env.IMAGES) scoped.IMAGES = scopedBucket(env.IMAGES, store.id);
    if (env.DIGITAL_ASSETS_BUCKET)
      scoped.DIGITAL_ASSETS_BUCKET = scopedBucket(
        env.DIGITAL_ASSETS_BUCKET,
        store.id,
      );
    if (scoped.ORDER_TOKEN_SECRET)
      scoped.ORDER_TOKEN_SECRET += `:store:${store.id}`;
  }
  return scoped;
}

/** Explicit paths select a store; omitted paths preserve the existing Halifruit API. */
export function resolveStore(request: Request, env: Env) {
  const url = new URL(request.url);
  const registry = storeRegistry(env);
  const match = /^\/stores\/([^/]+)(\/.*)?$/.exec(url.pathname);
  const id = match ? match[1] : registry.default_store;
  const store = registry.stores.find((s) => s.id === id);
  if (!store) throw ApiError.notFound('Store not found');
  const headerStore = request.headers.get('X-Store-Id');
  if (headerStore && headerStore !== id)
    throw ApiError.badRequest('Store identity does not match URL');
  const origin = request.headers.get('Origin');
  if (origin && store.origins.length && !store.origins.includes(origin))
    throw ApiError.forbidden('Origin is not allowed for this store');
  if (match) url.pathname = match[2] || '/';
  return {
    request: match ? new Request(url, request) : request,
    env: storeEnvironment(env, store),
  };
}

export function storeApiBase(url: string, env: Env) {
  return new URL(url).origin + (env.STORE_API_PREFIX || '');
}

export function assertStoreClaims(payload: Record<string, unknown>, env: Env) {
  // Legacy Halifruit tokens remain valid. New stores need an explicit membership claim.
  if (!env.STORE_ID || merchantObjectName(env) === 'default') return;
  const stores = payload.store_ids;
  if (
    payload.store_id !== env.STORE_ID &&
    !(Array.isArray(stores) && stores.includes(env.STORE_ID))
  )
    throw ApiError.forbidden('Token does not have access to this store');
}
