import { z } from 'zod'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Env } from '../../types'
import { variationSchema, warehouseSchema, PancakeError } from '../../lib/pancake-source'
import { integrationConfig, IntegrationError } from '../ctxlayer/config'
import { accessToken, integrationStub } from '../ctxlayer/oauth'
import { withGateway } from '../ctxlayer/client'

const page = z.object({
  schema_version: z.literal(1),
  shop_id: z.string(),
  success: z.literal(true),
  warehouse: warehouseSchema,
  data: z.array(variationSchema).max(30),
  total_entries: z.number().int().min(0).max(600),
  total_pages: z.number().int().min(0).max(20),
  page_number: z.number().int().min(1).max(20)
})
export async function collectCatalog(client: Client, env: Env) {
  const config = integrationConfig(env),
    tool = `${config.slug}__read_catalog_snapshot`
  let cursor: string | undefined,
    found = false
  for (let i = 0; i < 20; i++) {
    const catalog = await client.listTools(cursor ? { cursor } : {}, { timeout: 15000 })
    found ||= catalog.tools.some((t) => t.name === tool)
    cursor = catalog.nextCursor
    if (!cursor) break
  }
  if (!found || cursor) throw new IntegrationError('mcp_tool_unavailable')
  const read = async (number: number) => {
    const result = await client.callTool(
      {
        name: tool,
        arguments: { action: 'page', warehouse_id: env.PANCAKE_WAREHOUSE_ID, page_number: number }
      },
      undefined,
      { timeout: 15000 }
    )
    if (result.isError) throw new IntegrationError('mcp_catalog_denied')
    const content = result.content
    const text = Array.isArray(content) ? content.find((c) => c.type === 'text') : undefined
    const value = page.parse(
      result.structuredContent ?? JSON.parse(text && 'text' in text ? String(text.text) : 'null')
    )
    if (
      value.shop_id !== env.PANCAKE_SHOP_ID ||
      value.warehouse.id !== env.PANCAKE_WAREHOUSE_ID ||
      value.page_number !== number ||
      value.warehouse.allow_create_order === false
    )
      throw new IntegrationError('mcp_scope_mismatch')
    if (
      value.total_pages !== Math.ceil(value.total_entries / 30) ||
      value.data.length !== Math.min(30, Math.max(0, value.total_entries - (number - 1) * 30))
    )
      throw new IntegrationError('mcp_pagination')
    return value
  }
  const first = await read(1),
    rows = [...first.data]
  for (let number = 2; number <= first.total_pages; number++) {
    const current = await read(number)
    if (
      current.total_pages !== first.total_pages ||
      current.total_entries !== first.total_entries ||
      JSON.stringify(current.warehouse) !== JSON.stringify(first.warehouse)
    )
      throw new IntegrationError('mcp_pagination')
    rows.push(...current.data)
  }
  if (rows.length !== first.total_entries || new Set(rows.map((v) => v.id)).size !== rows.length)
    throw new IntegrationError('mcp_pagination')
  // Re-authorize against the live Gateway and detect a changing first page before commit.
  if (JSON.stringify(await read(1)) !== JSON.stringify(first))
    throw new IntegrationError('mcp_snapshot_changed')
  return { shopId: first.shop_id, warehouse: first.warehouse, variations: rows }
}
export async function readMcpCatalog(env: Env) {
  let auth: Awaited<ReturnType<typeof accessToken>> | undefined
  try {
    auth = await accessToken(env)
    const source = await withGateway(env, auth.bearer, (client) => collectCatalog(client, env))
    return { source, generation: auth.generation, config: integrationConfig(env).fingerprint }
  } catch (error) {
    if (auth && error instanceof IntegrationError && error.code === 'mcp_reauth_required')
      await integrationStub(env).ctxlayerState({
        op: 'invalidate',
        generation: auth.generation,
        secret: auth.secret
      })
    throw new PancakeError(
      error instanceof IntegrationError ? error.code : 'mcp_contract',
      'Catalog MCP source failed; previous snapshot retained'
    )
  }
}
