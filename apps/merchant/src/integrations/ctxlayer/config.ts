import { z } from 'zod'
import type { Env } from '../../types'
export class IntegrationError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
export function trustedUrl(value: string) {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
  )
    throw new IntegrationError('mcp_configuration')
  return url
}
export function integrationConfig(env: Env) {
  if (env.CTXLAYER_MCP_ENABLED !== 'true') throw new IntegrationError('mcp_disabled')
  const endpoint = trustedUrl(env.CTXLAYER_MCP_URL || '')
  const redirect = trustedUrl(env.CTXLAYER_OAUTH_REDIRECT_URI || '')
  const principal = z.string().min(1).parse(env.CTXLAYER_PRINCIPAL_ID)
  const slug = z
    .string()
    .regex(/^up-[a-z0-9-]{1,21}$/)
    .parse(env.CTXLAYER_PANCAKE_UPSTREAM_SLUG)
  const store = env.STORE_ID || 'default'
  const fingerprint = JSON.stringify([
    store,
    endpoint.href,
    redirect.href,
    principal,
    slug,
    env.PANCAKE_SHOP_ID,
    env.PANCAKE_WAREHOUSE_ID
  ])
  return { endpoint, redirect, principal, slug, store, fingerprint }
}
export async function readBoundedJson(response: Response, max = 262144): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new IntegrationError('mcp_invalid_response')
  let length = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > max) {
        await reader.cancel()
        throw new IntegrationError('mcp_response_too_large')
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch (error) {
    if (error instanceof IntegrationError) throw error
    throw new IntegrationError('mcp_invalid_response')
  } finally {
    reader.releaseLock()
  }
}
