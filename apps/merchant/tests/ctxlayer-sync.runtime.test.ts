import { it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { unstable_dev } from 'wrangler'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { hashKey } from '../src/middleware/auth'
import { initializeStore } from '../scripts/init-store.mjs'
import { digest } from '../src/integrations/ctxlayer/secrets'

it('persists a catalog through OAuth and MCP HTTP into real Worker SQLite; repeat is idempotent and Gateway OFF preserves storefront data', {
  timeout: 120000
}, async () => {
  let reads = 0,
    enabled = true,
    origin = '',
    challenge = '',
    refreshes = 0
  const warehouse = { id: 'w1', name: 'Main', allow_create_order: true }
  const rows = Array.from({ length: 31 }, (_, i) => ({
    id: `v${i}`,
    product_id: `p${i}`,
    display_id: `SKU-${i}`,
    retail_price: 99000 + i,
    images: ['https://example.com/fruit.png'],
    product: { name: `Fruit ${i}`, is_published: true },
    variations_warehouses: [{ warehouse_id: 'w1', remain_quantity: 10 + i }]
  }))
  const gateway = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin),
        chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks).toString()
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (url.pathname === '/.well-known/oauth-protected-resource')
        return json({ resource: origin, authorization_servers: [origin] })
      if (url.pathname === '/.well-known/oauth-authorization-server')
        return json({
          issuer: origin,
          authorization_endpoint: origin + '/authorize',
          token_endpoint: origin + '/token',
          registration_endpoint: origin + '/register',
          code_challenge_methods_supported: ['S256']
        })
      if (url.pathname === '/register') return json({ client_id: 'fixture-client' })
      if (url.pathname === '/authorize') {
        challenge = url.searchParams.get('code_challenge')!
        const callback = new URL(url.searchParams.get('redirect_uri')!)
        callback.searchParams.set('code', 'fixture-code')
        callback.searchParams.set('state', url.searchParams.get('state')!)
        res.writeHead(302, { Location: callback.href })
        res.end()
        return
      }
      if (url.pathname === '/token') {
        const params = new URLSearchParams(body)
        if (
          params.get('grant_type') === 'authorization_code' &&
          (await digest(params.get('code_verifier')!)) !== challenge
        )
          return json({ error: 'pkce' }, 400)
        if (params.get('grant_type') === 'refresh_token') {
          refreshes++
          assert.equal(params.get('refresh_token'), 'fixture-refresh')
        }
        return json({
          access_token: 'fixture-access',
          refresh_token: 'fixture-refresh',
          token_type: 'Bearer',
          expires_in: 60
        })
      }
      if (url.pathname !== '/mcp') return json({}, 404)
      if (req.headers.authorization !== 'Bearer fixture-access') return json({}, 401)
      const server = new McpServer({ name: 'fixture-gateway', version: '1' })
      server.registerResource(
        'identity',
        'ctxlayer://identity',
        { mimeType: 'application/json' },
        async () => ({
          contents: [
            { uri: 'ctxlayer://identity', text: JSON.stringify({ userId: 'fixture-sync-user' }) }
          ]
        })
      )
      server.registerTool(
        'up-pancake-pos__read_catalog_snapshot',
        {
          inputSchema: {
            action: z.literal('page'),
            warehouse_id: z.literal('w1'),
            page_number: z.number()
          }
        },
        async (args) => {
          if (!enabled) return { isError: true, content: [{ type: 'text', text: 'access_denied' }] }
          reads++
          const data = {
            schema_version: 1,
            shop_id: '1',
            success: true,
            warehouse,
            data: rows.slice((args.page_number - 1) * 30, args.page_number * 30),
            total_entries: 31,
            total_pages: 2,
            page_number: args.page_number
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(data) }],
            structuredContent: data
          }
        }
      )
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      })
      await server.connect(transport)
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers))
        if (v) headers.set(k, Array.isArray(v) ? v.join(',') : v)
      const response = await transport.handleRequest(
        new Request(url, { method: req.method, headers, ...(body ? { body } : {}) })
      )
      res.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body) Readable.fromWeb(response.body as never).pipe(res)
      else res.end()
    } catch {
      res.writeHead(500)
      res.end('fixture_failure')
    }
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  const address = gateway.address()
  if (!address || typeof address === 'string') throw Error('No fixture address')
  origin = `http://127.0.0.1:${address.port}`
  const root = fileURLToPath(new URL('../.wrangler/', import.meta.url))
  mkdirSync(root, { recursive: true })
  const folder = mkdtempSync(join(root, 'ctxlayer-runtime-')),
    config = join(folder, 'wrangler.json')
  writeFileSync(
    config,
    JSON.stringify({
      name: 'fufuni-mcp-test',
      main: fileURLToPath(new URL('./fixtures/ctxlayer-runtime-worker.ts', import.meta.url)),
      compatibility_date: '2025-12-01',
      durable_objects: { bindings: [{ name: 'MERCHANT', class_name: 'MerchantDO' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['MerchantDO'] }],
      kv_namespaces: [{ binding: 'KV_CACHE', id: '0'.repeat(32) }],
      vars: {
        SETUP_INIT_TOKEN: 'fixture-bootstrap',
        PANCAKE_CATALOG_SOURCE: 'ctxlayer_mcp',
        PANCAKE_SHOP_ID: '1',
        PANCAKE_WAREHOUSE_ID: 'w1',
        CTXLAYER_MCP_ENABLED: 'true',
        CTXLAYER_MCP_URL: origin + '/mcp',
        CTXLAYER_OAUTH_REDIRECT_URI: 'http://localhost:3002/api/integrations/ctxlayer/callback',
        CTXLAYER_PRINCIPAL_ID: 'fixture-sync-user',
        CTXLAYER_PANCAKE_UPSTREAM_SLUG: 'up-pancake-pos',
        CTXLAYER_TOKEN_KEY: btoa('x'.repeat(32))
      }
    })
  )
  let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined
  try {
    worker = await unstable_dev(
      fileURLToPath(new URL('./fixtures/ctxlayer-runtime-worker.ts', import.meta.url)),
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
          showInteractiveDevSession: false
        }
      }
    )
    console.info('MCP runtime: isolated local Worker ready')
    const call = (path: string, method = 'GET', token = 'sk_fixture', body?: unknown) =>
      worker!.fetch(path, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {})
      })
    const keys = await Promise.all(
      [
        { value: 'sk_fixture', role: 'admin' },
        { value: 'pk_fixture', role: 'public' }
      ].map(async (k) => ({
        id: crypto.randomUUID(),
        key_hash: await hashKey(k.value),
        key_prefix: k.value.slice(0, 8),
        role: k.role
      }))
    )
    const init = await call('/v1/setup/init', 'POST', 'fixture-bootstrap', { keys })
    assert.equal(init.status, 200, await init.text())
    await initializeStore({
      baseUrl: 'http://fixture.test',
      storeId: 'halifruit',
      bootstrapToken: 'fixture-bootstrap',
      publicKey: 'pk_fixture',
      adminKey: 'sk_fixture',
      request: (url: string, init: RequestInit) => worker!.fetch(new URL(url).pathname, init)
    })
    console.info('MCP runtime: local store initialized')
    const denied = await call('/v1/integrations/ctxlayer/connect', 'POST', 'pk_fixture', {})
    assert.equal(denied.status, 403)
    const noActor = await call('/v1/integrations/ctxlayer/connect', 'POST', 'sk_fixture', {})
    assert.equal(noActor.status, 403)
    const rejectedCompletion = await call(
      '/v1/integrations/ctxlayer/complete',
      'POST',
      'sk_fixture',
      {}
    )
    assert.equal(rejectedCompletion.status, 403)
    assert.ok(rejectedCompletion.headers.get('Set-Cookie')?.includes('ctxlayer_oauth_halifruit='))
    const connected = await call('/__test/connect', 'POST', 'fixture-bootstrap')
    assert.equal(connected.status, 200, await connected.text())
    console.info('MCP runtime: OAuth/PKCE and integration identity verified')
    const privateStatus = await call('/v1/integrations/ctxlayer/status')
    const privateText = await privateStatus.text()
    assert.ok(!privateText.includes('fixture-access') && !privateText.includes('fixture-refresh'))
    for (const [index, limit] of [1, undefined, undefined].entries()) {
      const response = await call(
        '/v1/integrations/pancake/sync',
        'POST',
        'sk_fixture',
        limit ? { limit_products: limit } : {}
      )
      assert.equal(response.status, 200, await response.clone().text())
      const report = (await response.json()) as {
        products: number
        created_products: number
        run_id: string
      }
      assert.equal(report.products, limit ? 1 : 31)
      console.info('MCP runtime: snapshot persisted', report.products)
      assert.equal(report.created_products, [1, 30, 0][index])
      const run = await call('/v1/integrations/pancake/runs/' + report.run_id)
      assert.equal(run.status, 200)
    }
    const products = await call('/v1/products?limit=100', 'GET', 'pk_fixture')
    assert.equal(products.status, 200)
    const catalog = (await products.json()) as { items: unknown[] }
    assert.equal(catalog.items.length, 31)
    assert.ok(refreshes > 0, 'background connection refreshed without a browser session')
    enabled = false
    const count = reads
    const blocked = await call('/v1/integrations/pancake/sync', 'POST', 'sk_fixture', {})
    assert.equal(blocked.status, 502)
    assert.equal(reads, count)
    const retained = await call('/v1/products?limit=100', 'GET', 'pk_fixture')
    assert.equal(retained.status, 200)
    assert.deepEqual(await retained.json(), catalog)
    assert.equal(reads, count, 'storefront reads persisted data without MCP calls')
    const status = await call('/v1/integrations/pancake/status')
    const info = (await status.json()) as { last_completed_at: string; last_error: string }
    assert.ok(info.last_completed_at)
    assert.ok(info.last_error)
    assert.equal((await call('/v1/integrations/ctxlayer/connection', 'DELETE')).status, 200)
    assert.equal(
      (await call('/v1/integrations/pancake/sync', 'POST', 'sk_fixture', {})).status,
      502
    )
  } finally {
    await worker?.stop()
    gateway.closeAllConnections()
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
  }
})
