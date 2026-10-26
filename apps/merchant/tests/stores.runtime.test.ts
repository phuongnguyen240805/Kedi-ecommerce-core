import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeStore } from '../scripts/init-store.mjs';
import { unstable_dev } from 'wrangler';
import { hashKey } from '../src/middleware/auth';

it(
  'routes real Worker/SQLite requests and refuses cross-store product, content and session access',
  { timeout: 90_000 },
  async () => {
    const tempRoot = resolve(
      fileURLToPath(new URL('../.wrangler/', import.meta.url)),
    );
    const { mkdirSync } = await import('node:fs');
    mkdirSync(tempRoot, { recursive: true });
    const fixture = mkdtempSync(join(tempRoot, 'stores-runtime-'));
    const config = join(fixture, 'wrangler.json');
    writeFileSync(
      config,
      JSON.stringify({
        name: 'fufuni-store-runtime-test',
        main: fileURLToPath(new URL('../src/index.ts', import.meta.url)),
        compatibility_date: '2025-12-01',
        durable_objects: {
          bindings: [{ name: 'MERCHANT', class_name: 'MerchantDO' }],
        },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['MerchantDO'] }],
        kv_namespaces: [{ binding: 'KV_CACHE', id: '0'.repeat(32) }],
        vars: {
          SETUP_INIT_TOKEN: 'test-hali-bootstrap',
          STORES_JSON: {
            default_store: 'halifruit',
            stores: [
              { id: 'halifruit', name: 'Halifruit' },
              {
                id: 'printerval',
                name: 'Printerval',
                settings: { CUSTOMER_PASSWORD_AUTH_ENABLED: 'true' },
              },
            ],
          },
          STORE_SECRETS_JSON: JSON.stringify({
            printerval: {
              SETUP_INIT_TOKEN: 'test-print-bootstrap',
              ORDER_TOKEN_SECRET:
                'test-print-signing-secret-at-least-32-characters',
            },
          }),
        },
      }),
    );
    let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined;
    try {
      worker = await unstable_dev(
        fileURLToPath(new URL('../src/index.ts', import.meta.url)),
        {
          config,
          local: true,
          persist: false,
          port: 0,
          inspectorPort: 0,
          logLevel: 'error',
          experimental: {
            testMode: true,
            disableDevRegistry: true,
            watch: false,
            showInteractiveDevSession: false,
          },
        },
      );
      async function request(
        path: string,
        method = 'GET',
        body?: unknown,
        token?: string,
      ) {
        return worker!.fetch(path, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      }
      async function bootstrap(
        prefix: string,
        bootstrapToken: string,
        publicKey: string,
        adminKey: string,
      ) {
        const keys = await Promise.all(
          [
            { value: publicKey, role: 'public' },
            { value: adminKey, role: 'admin' },
          ].map(async (key) => ({
            id: crypto.randomUUID(),
            key_hash: await hashKey(key.value),
            key_prefix: key.value.slice(0, 8),
            role: key.role,
          })),
        );
        const response = await request(
          prefix + '/v1/setup/init',
          'POST',
          { keys },
          bootstrapToken,
        );
        assert.equal(response.status, 200, await response.text());
      }
      await bootstrap('', 'test-hali-bootstrap', 'pk_hali', 'sk_hali');
      const denied = await request(
        '/stores/printerval/v1/setup/init',
        'POST',
        { keys: [] },
        'test-hali-bootstrap',
      );
      assert.equal(denied.status, 401);
      const discovery = await request('/stores/printerval/openapi.json');
      assert.equal(discovery.status, 200);
      assert.deepEqual(
        ((await discovery.json()) as { servers: Array<{ url: string }> })
          .servers,
        [{ url: '/stores/printerval' }],
      );
      await bootstrap(
        '/stores/printerval',
        'test-print-bootstrap',
        'pk_print',
        'sk_print',
      );
      const provision = {
        baseUrl: 'https://fixture.test',
        storeId: 'printerval',
        bootstrapToken: 'test-print-bootstrap',
        publicKey: 'pk_print',
        adminKey: 'sk_print',
        request: (url: string, init: RequestInit) =>
          worker!.fetch(new URL(url).pathname, init),
      };
      assert.equal((await initializeStore(provision)).ready, true);
      assert.equal((await initializeStore(provision)).ready, true);
      const a = await request(
        '/v1/products',
        'POST',
        { title: 'Halifruit only' },
        'sk_hali',
      );
      assert.equal(a.status, 201);
      const { id: halifruitId } = (await a.json()) as { id: string };
      const b = await request(
        '/stores/printerval/v1/products',
        'POST',
        { title: 'Printerval only' },
        'sk_print',
      );
      assert.equal(b.status, 201);
      const { id: printId } = (await b.json()) as { id: string };
      const listA = await request('/v1/products', 'GET', undefined, 'pk_hali');
      assert.equal(listA.status, 200);
      const productsA = (await listA.json()) as {
        items: Array<{ id: string }>;
      };
      assert.deepEqual(
        productsA.items.map((p) => p.id),
        [halifruitId],
      );
      const listB = await request(
        '/stores/printerval/v1/products',
        'GET',
        undefined,
        'pk_print',
      );
      assert.equal(listB.status, 200);
      assert.deepEqual(
        ((await listB.json()) as { items: Array<{ id: string }> }).items.map(
          (p) => p.id,
        ),
        [printId],
      );
      assert.equal(
        (
          await request(
            '/stores/printerval/v1/products/' + halifruitId,
            'GET',
            undefined,
            'pk_print',
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(
            '/stores/printerval/v1/products',
            'GET',
            undefined,
            'pk_hali',
          )
        ).status,
        401,
      );
      assert.equal(
        (await request('/v1/products', 'GET', undefined, 'pk_print')).status,
        401,
      );
      const content = await request(
        '/stores/printerval/v1/storefront-content/campaigns/c1',
        'PUT',
        { name: 'Printerval campaign' },
        'sk_print',
      );
      assert.equal(content.status, 200);
      assert.equal(
        (
          await request(
            '/v1/storefront-content/campaigns/c1',
            'GET',
            undefined,
            'sk_hali',
          )
        ).status,
        404,
      );
      const registration = await request(
        '/stores/printerval/v1/customer-auth/register',
        'POST',
        {
          email: 'test@example.test',
          password: 'test-password',
          first_name: 'Test',
          last_name: 'User',
        },
      );
      assert.equal(registration.status, 201, await registration.text());
      const login = await request(
        '/stores/printerval/v1/customer-auth/login',
        'POST',
        { email: 'test@example.test', password: 'test-password' },
      );
      assert.equal(
        login.status,
        200,
        login.status !== 200 ? await login.text() : '',
      );
      const { token } = (await login.json()) as { token: string };
      assert.equal(
        (
          await request(
            '/stores/printerval/v1/customer-auth/me',
            'GET',
            undefined,
            token,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await request(
            '/stores/printerval/v1/orders/' +
              crypto.randomUUID() +
              '/downloads',
            'GET',
            undefined,
            token,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(
            '/stores/printerval/v1/me/profile',
            'GET',
            undefined,
            token,
          )
        ).status,
        200,
      );
      assert.equal(
        (await request('/v1/me/profile', 'GET', undefined, token)).status,
        401,
      );
      assert.equal(
        (
          await request(
            '/stores/missing/v1/products',
            'GET',
            undefined,
            'pk_hali',
          )
        ).status,
        404,
      );
    } finally {
      await worker?.stop();
      if (!resolve(fixture).startsWith(tempRoot + requireSeparator()))
        throw new Error('Unsafe fixture cleanup path');
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);
function requireSeparator() {
  return process.platform === 'win32' ? '\\' : '/';
}
