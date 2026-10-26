import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { INTEGRATION_SCHEMA, integrationState } from '../src/integrations/ctxlayer/store'
import { PANCAKE_SCHEMA, type SyncSql } from '../src/lib/pancake-store'
import { normalizePos } from '../src/lib/pancake-source'
import { beginMcpRun, commitMcpRun, failMcpRun } from '../src/integrations/pancake/sync-runs'
import { seal, unseal, digest } from '../src/integrations/ctxlayer/secrets'
import { integrationConfig, readBoundedJson } from '../src/integrations/ctxlayer/config'
import { collectCatalog } from '../src/integrations/pancake/mcp-source'
import type { Env } from '../src/types'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

const warehouse = { id: 'w1', name: 'Main', allow_create_order: true }
const variant = {
  id: 'v1',
  product_id: 'p1',
  retail_price: 129000,
  display_id: 'SKU-1',
  weight: 500,
  variations_warehouses: [{ warehouse_id: 'w1', remain_quantity: 10 }],
  product: { name: 'Fruit' }
}
const env = {
  STORE_ID: 'halifruit',
  CTXLAYER_MCP_ENABLED: 'true',
  CTXLAYER_MCP_URL: 'https://gateway.example/mcp',
  CTXLAYER_OAUTH_REDIRECT_URI: 'https://fufuni.example/v1/integrations/ctxlayer/callback',
  CTXLAYER_PRINCIPAL_ID: 'sync-user',
  CTXLAYER_PANCAKE_UPSTREAM_SLUG: 'up-pancake-pos',
  PANCAKE_SHOP_ID: '1',
  PANCAKE_WAREHOUSE_ID: 'w1'
} as Env
const fingerprint = integrationConfig(env).fingerprint
function database() {
  const db = new DatabaseSync(':memory:')
  const schema = readFileSync(new URL('../src/do.ts', import.meta.url), 'utf8').match(
    /const SCHEMA = `([\s\S]*?)`;/
  )?.[1]
  if (!schema) throw Error('Missing merchant schema')
  db.exec(schema)
  db.exec("ALTER TABLE variants ADD COLUMN variant_type TEXT NOT NULL DEFAULT 'physical'")
  db.exec(PANCAKE_SCHEMA)
  db.exec(INTEGRATION_SCHEMA)
  db.exec("INSERT INTO currencies(id,code,display_name,decimal_places) VALUES('vnd','VND','VND',0)")
  const sql: SyncSql = {
    exec: (query, ...args) => {
      const rows = db.prepare(query).all(...args) as Record<string, unknown>[]
      return { toArray: () => rows }
    }
  }
  const transaction = <T>(fn: () => T) => {
    db.exec('BEGIN')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  integrationState(sql, {
    op: 'connect',
    generation: 0,
    config: fingerprint,
    secret: 'encrypted-fixture',
    expiry: Date.now() + 3600000
  })
  return { db, sql, transaction }
}
function run(id: string) {
  return { id, shop: '1', config: fingerprint, generation: 1, trigger: 'manual' as const }
}
describe('durable integration connection', () => {
  it('does not let a delayed refresh or 401 invalidate a newer token', () => {
    const { db, sql } = database()
    try {
      assert.equal(
        integrationState(sql, {
          op: 'claim',
          generation: 1,
          token: 'first',
          secret: 'encrypted-fixture'
        }).ok,
        true
      )
      assert.equal(
        integrationState(sql, {
          op: 'refresh',
          generation: 1,
          token: 'first',
          secret: 'new-encrypted-token',
          expiry: Date.now() + 3600000
        }).ok,
        true
      )
      assert.equal(
        integrationState(sql, {
          op: 'claim',
          generation: 1,
          token: 'late',
          secret: 'encrypted-fixture'
        }).ok,
        false
      )
      assert.equal(
        integrationState(sql, { op: 'invalidate', generation: 1, secret: 'encrypted-fixture' }).ok,
        false
      )
      assert.equal(integrationState(sql, { op: 'get' }).connection.status, 'connected')
    } finally {
      db.close()
    }
  })
  it('cancels denied consent only for the original browser and rejects expired states', () => {
    const { db, sql } = database()
    try {
      const t = {
        state: 'cancel-state',
        actor: 'admin',
        binding: 'browser',
        config: fingerprint,
        secret: 'sealed',
        expires_at: Date.now() + 60000
      }
      integrationState(sql, { op: 'transaction', value: t })
      integrationState(sql, { op: 'cancel', state: t.state, binding: 'other', config: fingerprint })
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ctxlayer_transactions').get()?.n, 1)
      integrationState(sql, {
        op: 'cancel',
        state: t.state,
        binding: 'browser',
        config: fingerprint
      })
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ctxlayer_transactions').get()?.n, 0)
      integrationState(sql, { op: 'transaction', value: { ...t, expires_at: Date.now() - 1 } })
      assert.equal(
        integrationState(sql, {
          op: 'consume',
          state: t.state,
          actor: t.actor,
          binding: t.binding,
          config: fingerprint
        }).ok,
        false
      )
    } finally {
      db.close()
    }
  })
  it('consumes OAuth state once and refuses wrong actor/store/browser', () => {
    const { db, sql } = database()
    try {
      integrationState(sql, {
        op: 'transaction',
        value: {
          state: 'hashed-state',
          actor: 'admin',
          binding: 'browser',
          config: fingerprint,
          secret: 'sealed',
          expires_at: Date.now() + 60000
        }
      })
      assert.equal(
        integrationState(sql, {
          op: 'consume',
          state: 'hashed-state',
          actor: 'other',
          binding: 'browser',
          config: fingerprint
        }).ok,
        false
      )
      assert.equal(
        integrationState(sql, {
          op: 'consume',
          state: 'hashed-state',
          actor: 'admin',
          binding: 'other',
          config: fingerprint
        }).ok,
        false
      )
      assert.equal(
        integrationState(sql, {
          op: 'consume',
          state: 'hashed-state',
          actor: 'admin',
          binding: 'browser',
          config: 'other-store'
        }).ok,
        false
      )
      const input = {
        op: 'consume' as const,
        state: 'hashed-state',
        actor: 'admin',
        binding: 'browser',
        config: fingerprint
      }
      assert.equal(integrationState(sql, input).ok, true)
      assert.equal(integrationState(sql, input).ok, false)
    } finally {
      db.close()
    }
  })
  it('fences refresh and late OAuth callbacks after disconnect', () => {
    const { db, sql } = database()
    try {
      assert.equal(
        integrationState(sql, {
          op: 'claim',
          generation: 1,
          token: 'a',
          secret: 'encrypted-fixture'
        }).ok,
        true
      )
      assert.equal(
        integrationState(sql, {
          op: 'claim',
          generation: 1,
          token: 'b',
          secret: 'encrypted-fixture'
        }).ok,
        false
      )
      integrationState(sql, { op: 'disconnect' })
      assert.equal(
        integrationState(sql, {
          op: 'refresh',
          generation: 1,
          token: 'a',
          secret: 'old',
          expiry: Date.now()
        }).ok,
        false
      )
      assert.equal(
        integrationState(sql, {
          op: 'connect',
          generation: 1,
          config: fingerprint,
          secret: 'late',
          expiry: Date.now()
        }).ok,
        false
      )
    } finally {
      db.close()
    }
  })
  it('encrypts with store-bound AAD and rejects another store or key', async () => {
    const key = btoa('x'.repeat(32)),
      sealed = await seal(key, 'store-a', { refresh_token: 'secret' })
    assert.ok(!sealed.includes('secret'))
    assert.deepEqual(await unseal(key, 'store-a', sealed), { refresh_token: 'secret' })
    await assert.rejects(unseal(key, 'store-b', sealed))
    await assert.rejects(unseal(btoa('y'.repeat(32)), 'store-a', sealed))
    assert.equal((await digest('verifier')).length, 43)
  })
})
describe('catalog job persistence', () => {
  it('replays without duplicates and preserves reservations and VND prices', async () => {
    const { db, sql, transaction } = database()
    try {
      for (const id of ['first', 'second']) {
        const r = run(id)
        assert.equal(
          transaction(() => beginMcpRun(sql, r)),
          true
        )
        const snapshot = await normalizePos('1', warehouse, [variant], id)
        const report = transaction(() => commitMcpRun(sql, snapshot, r))
        assert.equal(report.created_products, id === 'first' ? 1 : 0)
        if (id === 'first') {
          db.exec('UPDATE inventory SET reserved=3')
          db.exec('UPDATE warehouse_inventory SET reserved=3')
        }
      }
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products').get()?.n, 1)
      assert.equal(db.prepare('SELECT price_cents FROM variant_prices').get()?.price_cents, 129000)
      assert.equal(db.prepare('SELECT reserved FROM inventory').get()?.reserved, 3)
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM pancake_sync_runs WHERE state='succeeded'").get()?.n,
        2
      )
    } finally {
      db.close()
    }
  })
  it('blocks concurrent claims and a commit after disconnect; keeps previous catalog', async () => {
    const { db, sql, transaction } = database()
    try {
      const r = run('first')
      assert.equal(
        transaction(() => beginMcpRun(sql, r)),
        true
      )
      assert.equal(
        transaction(() => beginMcpRun(sql, run('concurrent'))),
        false
      )
      const snapshot = await normalizePos('1', warehouse, [variant], r.id)
      integrationState(sql, { op: 'disconnect' })
      assert.throws(() => transaction(() => commitMcpRun(sql, snapshot, r)), /connection_changed/)
      failMcpRun(sql, r, 'mcp_not_connected')
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products').get()?.n, 0)
      assert.equal(db.prepare('SELECT state FROM pancake_sync_runs').get()?.state, 'blocked')
    } finally {
      db.close()
    }
  })
  it('rolls back both catalog and run success if persistence fails', async () => {
    const { db, sql, transaction } = database()
    try {
      const r = run('a')
      transaction(() => beginMcpRun(sql, r))
      const snapshot = await normalizePos(
        '1',
        warehouse,
        [variant, { ...variant, id: 'v2', product_id: 'p2', display_id: 'SKU-2' }],
        r.id
      )
      snapshot.variants[1].sku = snapshot.variants[0].sku
      assert.throws(() => transaction(() => commitMcpRun(sql, snapshot, r)))
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products').get()?.n, 0)
      assert.equal(db.prepare('SELECT state FROM pancake_sync_runs').get()?.state, 'running')
    } finally {
      db.close()
    }
  })
})
describe('MCP snapshot boundary', () => {
  it('bounds metadata before parsing and refuses non-local HTTP configuration', async () => {
    await assert.rejects(readBoundedJson(new Response('x'.repeat(100)), 20), /too_large/)
    assert.throws(
      () => integrationConfig({ ...env, CTXLAYER_MCP_URL: 'http://external.example/mcp' }),
      /configuration/
    )
  })
  function client(change?: (number: number, call: number) => unknown) {
    let calls = 0
    return {
      listTools: async () => ({ tools: [{ name: 'up-pancake-pos__read_catalog_snapshot' }] }),
      callTool: async (input: { arguments: { page_number: number } }) => {
        calls++
        const number = input.arguments.page_number
        return {
          structuredContent: change?.(number, calls) ?? {
            schema_version: 1,
            shop_id: '1',
            success: true,
            warehouse,
            data: [variant],
            total_entries: 1,
            total_pages: 1,
            page_number: number
          },
          content: []
        }
      }
    } as unknown as Client
  }
  it('reads a versioned snapshot and rechecks the live first page', async () => {
    const source = await collectCatalog(client(), env)
    assert.equal(source.variations.length, 1)
  })
  it('rejects wrong shop, missing fields and incomplete counts', async () => {
    for (const override of [
      { shop_id: 'other' },
      { total_entries: 31, total_pages: 2 },
      { data: [{ id: 'incomplete' }] }
    ])
      await assert.rejects(
        collectCatalog(
          client(() => ({
            schema_version: 1,
            shop_id: '1',
            success: true,
            warehouse,
            data: [variant],
            total_entries: 1,
            total_pages: 1,
            page_number: 1,
            ...override
          })),
          env
        )
      )
  })
  it('rejects source change before commit', async () => {
    await assert.rejects(
      collectCatalog(
        client((_n, c) => ({
          schema_version: 1,
          shop_id: '1',
          success: true,
          warehouse,
          data: [{ ...variant, retail_price: c === 1 ? 100 : 200 }],
          total_entries: 1,
          total_pages: 1,
          page_number: 1
        })),
        env
      ),
      /snapshot_changed/
    )
  })
})
