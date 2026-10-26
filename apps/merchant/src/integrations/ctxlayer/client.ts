import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import { z } from 'zod'
import type { Env } from '../../types'
import { integrationConfig, IntegrationError } from './config'

export async function withGateway<T>(
  env: Env,
  bearer: string,
  run: (client: Client) => Promise<T>,
  fetcher: typeof fetch = fetch
): Promise<T> {
  const config = integrationConfig(env)
  const client = new Client(
    { name: 'fufuni-catalog-sync', version: '1.0.0' },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() }
  )
  const transport = new StreamableHTTPClientTransport(config.endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.href !== config.endpoint.href) throw new IntegrationError('mcp_untrusted_endpoint')
      const response = await fetcher(input, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.any([
          ...(init?.signal ? [init.signal] : []),
          AbortSignal.timeout(15000)
        ])
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        throw new IntegrationError('mcp_untrusted_redirect')
      }
      if (response.status === 401) throw new IntegrationError('mcp_reauth_required')
      if (response.status === 403) throw new IntegrationError('mcp_forbidden')
      if (response.status === 429) throw new IntegrationError('mcp_rate_limited')
      let size = 0
      const body = response.body?.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            size += chunk.length
            if (size > 2_000_000) throw new IntegrationError('mcp_response_too_large')
            controller.enqueue(chunk)
          }
        })
      )
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      })
    }
  })
  try {
    await client.connect(transport)
    const identity = await client.readResource({ uri: 'ctxlayer://identity' }, { timeout: 15000 })
    const entry = identity.contents.find((c) => 'text' in c)
    if (
      !entry ||
      !('text' in entry) ||
      z.object({ userId: z.string() }).parse(JSON.parse(entry.text)).userId !== config.principal
    )
      throw new IntegrationError('mcp_principal_mismatch')
    return await run(client)
  } catch (error) {
    if (error instanceof IntegrationError) throw error
    throw new IntegrationError('mcp_upstream_error')
  } finally {
    await client.close().catch(() => {})
  }
}
