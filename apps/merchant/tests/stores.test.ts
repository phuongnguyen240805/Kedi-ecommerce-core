import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { DatabaseSync } from 'node:sqlite';
import {
  resolveStore,
  storeEnvironment,
  storeRegistry,
  merchantObjectName,
  scopedKV,
  scopedBucket,
  assertStoreClaims,
  storeApiBase,
} from '../src/lib/stores';
import { ApiError, type Env, type HonoEnv } from '../src/types';
import { customerSessions } from '../src/routes/customer-sessions';
import {
  CUSTOMER_SESSION_SCHEMA,
  passwordHash,
  verifyPassword,
} from '../src/lib/customer-sessions';
import { kvCacheMiddleware } from '../src/middleware/kv-cache';
import { hashKey } from '../src/middleware/auth';

function memoryKV() {
  const entries = new Map<string, string>();
  const kv = {
    get: async (key: string, type?: string) =>
      entries.has(key)
        ? type === 'json'
          ? JSON.parse(entries.get(key)!)
          : entries.get(key)!
        : null,
    put: async (key: string, value: string) => {
      entries.set(key, value);
    },
    delete: async (key: string) => {
      entries.delete(key);
    },
    list: async ({ prefix = '' } = {}) => ({
      keys: [...entries.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
    }),
  } as unknown as KVNamespace;
  return { kv, entries };
}
const registry = {
  default_store: 'halifruit',
  stores: [
    { id: 'halifruit', name: 'Halifruit' },
    {
      id: 'printerval',
      name: 'Printerval',
      origins: ['https://printerval.test'],
      settings: {
        PANCAKE_VARIANT_TYPE: 'digital',
        CUSTOMER_PASSWORD_AUTH_ENABLED: 'true',
      },
    },
    { id: 'third-app', name: 'Third App' },
  ],
};
function environment() {
  return {
    STORES_JSON: JSON.stringify(registry),
    KV_CACHE: memoryKV().kv,
    STORE_NAME: 'Halifruit',
    PANCAKE_API_KEY: 'hali-secret',
    PANCAKE_SHOP_ID: '1',
    AUTH0_AUDIENCE: 'hali-audience',
    ORDER_TOKEN_SECRET: 'hali-signing-secret',
    STORE_SECRETS_JSON: JSON.stringify({
      printerval: {
        PANCAKE_API_KEY: 'print-secret',
        SETUP_INIT_TOKEN: 'print-bootstrap',
        ORDER_TOKEN_SECRET: 'print-signing-secret',
      },
    }),
  } as Env;
}
describe('store routing and isolation', () => {
  it('preserves the existing default DO and allows additional stores without code changes', () => {
    const env = environment();
    const legacy = resolveStore(
      new Request('https://api.test/v1/products'),
      env,
    );
    const print = resolveStore(
      new Request('https://api.test/stores/printerval/v1/products?limit=10'),
      env,
    );
    const third = resolveStore(
      new Request('https://api.test/stores/third-app/v1/products'),
      env,
    );
    assert.equal(merchantObjectName(legacy.env), 'default');
    assert.equal(merchantObjectName(print.env), 'store:printerval');
    assert.equal(merchantObjectName(third.env), 'store:third-app');
    assert.equal(print.request.url, 'https://api.test/v1/products?limit=10');
    assert.equal(
      storeApiBase(print.request.url, print.env),
      'https://api.test/stores/printerval',
    );
  });
  it('does not inherit another stores POS, Auth0 or signing credentials', () => {
    const env = environment();
    const print = storeEnvironment(env, storeRegistry(env).stores[1]);
    assert.equal(print.PANCAKE_API_KEY, 'print-secret');
    assert.equal(print.PANCAKE_SHOP_ID, undefined);
    assert.equal(print.AUTH0_AUDIENCE, undefined);
    assert.equal(print.PANCAKE_VARIANT_TYPE, 'digital');
    assert.notEqual(print.ORDER_TOKEN_SECRET, 'print-signing-secret');
    assert.equal(env.PANCAKE_API_KEY, 'hali-secret');
  });
  it('rejects unknown stores, conflicting headers and disallowed origins without fallback', () => {
    const env = environment();
    assert.throws(
      () =>
        resolveStore(
          new Request('https://api.test/stores/unknown/v1/products'),
          env,
        ),
      /Store not found/,
    );
    assert.throws(
      () =>
        resolveStore(
          new Request('https://api.test/stores/printerval/v1/products', {
            headers: { 'X-Store-Id': 'halifruit' },
          }),
          env,
        ),
      /does not match/,
    );
    assert.throws(
      () =>
        resolveStore(
          new Request('https://api.test/stores/printerval/v1/products', {
            headers: { Origin: 'https://wrong.test' },
          }),
          env,
        ),
      /Origin/,
    );
  });
  it('fails closed on invalid settings, duplicate IDs and broken JSON', () => {
    for (const config of [
      'broken',
      JSON.stringify({
        ...registry,
        stores: [registry.stores[0], registry.stores[0]],
      }),
      JSON.stringify({
        ...registry,
        stores: [
          { ...registry.stores[0], settings: { PANCAKE_API_KEY: 'unsafe' } },
        ],
      }),
    ])
      assert.throws(() =>
        storeRegistry({ ...environment(), STORES_JSON: config }),
      );
  });
  it('requires membership on JWTs for a non-default store', () => {
    const env = resolveStore(
      new Request('https://api.test/stores/printerval'),
      environment(),
    ).env;
    assert.throws(
      () => assertStoreClaims({ store_id: 'halifruit' }, env),
      /access/,
    );
    assertStoreClaims({ store_ids: ['printerval'] }, env);
  });
  it('isolates cache reads, listings and deletion for identical paths', async () => {
    const { kv, entries } = memoryKV();
    const a = scopedKV(kv, 'a');
    const b = scopedKV(kv, 'b');
    await a.put('cache:https://api.test/v1/products', 'A');
    await b.put('cache:https://api.test/v1/products', 'B');
    assert.equal(await a.get('cache:https://api.test/v1/products'), 'A');
    assert.equal(await b.get('cache:https://api.test/v1/products'), 'B');
    const list = await a.list({ prefix: 'cache:' });
    assert.equal(list.keys.length, 1);
    await a.delete(list.keys[0].name);
    assert.equal(entries.size, 1);
    assert.equal(await b.get('cache:https://api.test/v1/products'), 'B');
  });
  it('namespaces file delivery and upload even when stores use the same R2 key', async () => {
    const calls: string[] = [];
    const bucket = {
      get: async (key: string) => {
        calls.push(key);
      },
      put: async (key: string) => {
        calls.push(key);
      },
    } as unknown as R2Bucket;
    await scopedBucket(bucket, 'a').get('license.pdf');
    await scopedBucket(bucket, 'b').put('license.pdf', 'data');
    assert.deepEqual(calls, ['stores/a/license.pdf', 'stores/b/license.pdf']);
  });
});

function customerStore() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(
    `CREATE TABLE customers(id TEXT PRIMARY KEY,email TEXT UNIQUE,name TEXT,password_hash TEXT,auth_provider TEXT,auth_provider_id TEXT,metadata TEXT);${CUSTOMER_SESSION_SCHEMA}`,
  );
  const db = {
    query: async (query: string, params: unknown[] = []) =>
      sql.prepare(query).all(...(params as any[])),
    run: async (query: string, params: unknown[] = []) => ({
      changes: Number(sql.prepare(query).run(...(params as any[])).changes),
    }),
  };
  const app = new Hono<HonoEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db as never);
    await next();
  });
  app.onError((error, c) =>
    c.json(
      { error: error.message },
      error instanceof ApiError ? (error.statusCode as 400) : 500,
    ),
  );
  app.route('/auth', customerSessions);
  const env = { CUSTOMER_PASSWORD_AUTH_ENABLED: 'true' } as Env;
  const request = (path: string, body?: unknown, token?: string) =>
    app.request(
      'https://api.test/auth/' + path,
      {
        method: body ? 'POST' : 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      env,
    );
  return { sql, request };
}
describe('native customer accounts', () => {
  it('hashes passwords and verifies both valid and invalid passwords', async () => {
    const hash = await passwordHash('secret-password');
    assert.ok(!hash.includes('secret-password'));
    assert.equal(await verifyPassword('secret-password', hash), true);
    assert.equal(await verifyPassword('wrong', hash), false);
  });
  it('registers, logs in, returns the existing UI profile, and rejects sessions in another store', async () => {
    const a = customerStore();
    const b = customerStore();
    try {
      const registration = await a.request('register', {
        email: 'USER@example.test',
        password: 'secret-password',
        first_name: 'Test',
        last_name: 'User',
      });
      assert.equal(registration.status, 201);
      assert.equal(
        (
          await a.request('register', {
            email: 'user@example.test',
            password: 'secret-password',
            first_name: 'Test',
            last_name: 'User',
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await a.request('login', {
            email: 'user@example.test',
            password: 'wrong',
          })
        ).status,
        401,
      );
      const login = await a.request('login', {
        email: 'user@example.test',
        password: 'secret-password',
      });
      assert.equal(login.status, 200);
      const { token } = (await login.json()) as { token: string };
      const profile = await a.request('me', undefined, token);
      assert.equal(profile.status, 200);
      assert.equal(
        ((await profile.json()) as { email: string }).email,
        'user@example.test',
      );
      assert.equal((await b.request('me', undefined, token)).status, 401);
      const stored = a.sql
        .prepare('SELECT token_hash FROM customer_sessions')
        .get();
      assert.notEqual(stored?.token_hash, token);
      assert.equal((await a.request('logout', {}, token)).status, 200);
      assert.equal((await a.request('me', undefined, token)).status, 401);
    } finally {
      a.sql.close();
      b.sql.close();
    }
  });
});
it('does not serve a cached catalog to an invalid public key', async () => {
  const { kv } = memoryKV();
  await kv.put(
    'cache:https://api.test/v1/products',
    JSON.stringify({ secret: 'cached' }),
  );
  const valid = await hashKey('pk_valid');
  const app = new Hono<HonoEnv>();
  app.use('*', async (c, next) => {
    c.set('db', {
      query: async (_sql: string, params: string[]) =>
        params[0] === valid ? [{ role: 'public' }] : [],
    } as never);
    await next();
  });
  app.onError((error, c) =>
    c.json(
      { error: error.message },
      error instanceof ApiError ? (error.statusCode as 401) : 500,
    ),
  );
  app.use('*', kvCacheMiddleware);
  app.get('/v1/products', (c) => c.json({ fresh: true }));
  const response = await app.request(
    'https://api.test/v1/products',
    { headers: { Authorization: 'Bearer pk_wrong' } },
    { KV_CACHE: kv } as Env,
  );
  assert.equal(response.status, 401);
  assert.ok(!(await response.text()).includes('cached'));
  assert.equal(
    (
      await app.request('https://api.test/v1/products', {}, {
        KV_CACHE: kv,
      } as Env)
    ).status,
    401,
  );
});

it('limits repeated password attempts within the store database', async () => {
  const store = customerStore();
  try {
    for (let i = 0; i < 10; i++)
      assert.equal(
        (
          await store.request('login', {
            email: 'missing@example.test',
            password: 'wrong',
          })
        ).status,
        401,
      );
    assert.equal(
      (
        await store.request('login', {
          email: 'missing@example.test',
          password: 'wrong',
        })
      ).status,
      429,
    );
  } finally {
    store.sql.close();
  }
});

it('rejects oversized native authentication bodies before parsing credentials', async () => {
  const store = customerStore();
  try {
    const response = await store.request('register', {
      email: 'user@example.test',
      password: 'x'.repeat(9000),
      first_name: 'Test',
      last_name: 'User',
    });
    assert.equal(response.status, 400);
    assert.ok((await response.text()).includes('size limit'));
  } finally {
    store.sql.close();
  }
});

it('accepts structured Wrangler JSON bindings as well as serialized registry strings', () => {
  const env = { ...environment(), STORES_JSON: registry };
  assert.equal(
    resolveStore(
      new Request('https://api.test/stores/printerval/v1/products'),
      env,
    ).env.STORE_ID,
    'printerval',
  );
});
