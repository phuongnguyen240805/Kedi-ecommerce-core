import { z } from 'zod'
import type { Env } from '../../types'
import { merchantObjectName } from '../../lib/stores'
import { integrationConfig, IntegrationError, readBoundedJson } from './config'
import { randomSecret, digest, seal, unseal } from './secrets'
import { withGateway } from './client'

const tokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string().refine((v) => v.toLowerCase() === 'bearer'),
  expires_in: z.number().positive().max(31536000).default(3600)
})
const saved = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  client_id: z.string()
})
export function integrationStub(env: Env) {
  return env.MERCHANT.get(env.MERCHANT.idFromName(merchantObjectName(env)))
}
async function requestJson(url: URL, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(15000)
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new IntegrationError('mcp_oauth_failed')
  }
  return readBoundedJson(response, 65536)
}
async function metadata(env: Env) {
  const { endpoint } = integrationConfig(env)
  const resource = z
    .object({ resource: z.string(), authorization_servers: z.array(z.string()).min(1) })
    .parse(await requestJson(new URL('/.well-known/oauth-protected-resource', endpoint)))
  if (
    ![endpoint.href.replace(/\/$/, ''), endpoint.origin].includes(
      resource.resource.replace(/\/$/, '')
    )
  )
    throw new IntegrationError('mcp_resource_mismatch')
  const issuer = new URL(resource.authorization_servers[0]!)
  if (issuer.origin !== endpoint.origin) throw new IntegrationError('mcp_issuer_mismatch')
  const data = z
    .object({
      issuer: z.string(),
      authorization_endpoint: z.string(),
      token_endpoint: z.string(),
      registration_endpoint: z.string(),
      code_challenge_methods_supported: z.array(z.string())
    })
    .parse(await requestJson(new URL('/.well-known/oauth-authorization-server', issuer)))
  if (
    data.issuer.replace(/\/$/, '') !== issuer.href.replace(/\/$/, '') ||
    !data.code_challenge_methods_supported.includes('S256')
  )
    throw new IntegrationError('mcp_issuer_mismatch')
  for (const value of [
    data.authorization_endpoint,
    data.token_endpoint,
    data.registration_endpoint
  ])
    if (new URL(value).origin !== endpoint.origin) throw new IntegrationError('mcp_issuer_mismatch')
  return { ...data, resource: resource.resource }
}
export async function startConnection(env: Env, actor: string, binding: string) {
  const config = integrationConfig(env),
    stub = integrationStub(env),
    meta = await metadata(env)
  const cached = await stub.ctxlayerRegistration(config.fingerprint)
  let clientId = cached
  if (!clientId) {
    const result = z.object({ client_id: z.string() }).parse(
      await requestJson(new URL(meta.registration_endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Fufuni catalog sync',
          redirect_uris: [config.redirect.href],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none'
        })
      })
    )
    clientId = await stub.ctxlayerRegistration(config.fingerprint, result.client_id)
  }
  const state = randomSecret(),
    verifier = randomSecret()
  const current = await stub.ctxlayerState({ op: 'get' })
  await stub.ctxlayerState({
    op: 'transaction',
    value: {
      state: await digest(state),
      actor,
      binding: await digest(binding),
      config: config.fingerprint,
      expires_at: Date.now() + 600000,
      secret: await seal(env.CTXLAYER_TOKEN_KEY, config.fingerprint, {
        verifier,
        clientId,
        generation: current.connection.generation
      })
    }
  })
  const url = new URL(meta.authorization_endpoint)
  Object.entries({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: config.redirect.href,
    scope: 'mcp',
    resource: meta.resource,
    state,
    code_challenge: await digest(verifier),
    code_challenge_method: 'S256'
  }).forEach(([k, v]) => url.searchParams.set(k, v))
  return { authorization_url: url.href }
}
export async function completeConnection(
  env: Env,
  actor: string,
  binding: string,
  state: string,
  code: string
) {
  const config = integrationConfig(env),
    stub = integrationStub(env)
  const transaction = await stub.ctxlayerState({
    op: 'consume',
    state: await digest(state),
    actor,
    binding: await digest(binding),
    config: config.fingerprint
  })
  if (!transaction.ok || !transaction.transaction)
    throw new IntegrationError('mcp_oauth_state_invalid')
  const pending = z
    .object({ verifier: z.string(), clientId: z.string(), generation: z.number() })
    .parse(await unseal(env.CTXLAYER_TOKEN_KEY, config.fingerprint, transaction.transaction.secret))
  const meta = await metadata(env)
  const result = tokens.parse(
    await requestJson(new URL(meta.token_endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: pending.verifier,
        client_id: pending.clientId,
        redirect_uri: config.redirect.href,
        resource: meta.resource
      })
    })
  )
  await withGateway(env, result.access_token, async () => {})
  if (!result.refresh_token) throw new IntegrationError('mcp_refresh_token_missing')
  const value = await stub.ctxlayerState({
    op: 'connect',
    generation: pending.generation,
    config: config.fingerprint,
    expiry: Date.now() + result.expires_in * 1000,
    secret: await seal(env.CTXLAYER_TOKEN_KEY, config.fingerprint, {
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      client_id: pending.clientId
    })
  })
  if (!value.ok) throw new IntegrationError('mcp_connection_changed')
  return { connected: true }
}
export async function accessToken(env: Env) {
  const config = integrationConfig(env),
    stub = integrationStub(env)
  const { connection } = await stub.ctxlayerState({ op: 'get' })
  if (
    connection.status !== 'connected' ||
    connection.config !== config.fingerprint ||
    !connection.secret
  )
    throw new IntegrationError('mcp_not_connected')
  const bundle = saved.parse(
    await unseal(env.CTXLAYER_TOKEN_KEY, config.fingerprint, connection.secret)
  )
  if (connection.expires_at > Date.now() + 60000)
    return {
      bearer: bundle.access_token,
      generation: connection.generation,
      secret: connection.secret
    }
  const claim = randomSecret()
  if (
    !(
      await stub.ctxlayerState({
        op: 'claim',
        generation: connection.generation,
        token: claim,
        secret: connection.secret
      })
    ).ok
  )
    throw new IntegrationError('mcp_refresh_busy')
  try {
    if (!bundle.refresh_token) throw new IntegrationError('mcp_reauth_required')
    const meta = await metadata(env)
    const result = tokens.parse(
      await requestJson(new URL(meta.token_endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: bundle.refresh_token,
          client_id: bundle.client_id,
          resource: meta.resource
        })
      })
    )
    const next = {
      ...bundle,
      access_token: result.access_token,
      refresh_token: result.refresh_token || bundle.refresh_token
    }
    const savedResult = await stub.ctxlayerState({
      op: 'refresh',
      generation: connection.generation,
      token: claim,
      secret: await seal(env.CTXLAYER_TOKEN_KEY, config.fingerprint, next),
      expiry: Date.now() + result.expires_in * 1000
    })
    if (!savedResult.ok) throw new IntegrationError('mcp_connection_changed')
    return {
      bearer: next.access_token,
      generation: connection.generation,
      secret: savedResult.connection.secret!
    }
  } catch {
    await stub.ctxlayerState({ op: 'reauth', generation: connection.generation, token: claim })
    throw new IntegrationError('mcp_reauth_required')
  }
}
