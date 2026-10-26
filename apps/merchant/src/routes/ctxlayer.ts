import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { authMiddleware, adminOnly } from '../middleware/auth'
import { ApiError, type HonoEnv } from '../types'
import { integrationConfig, IntegrationError } from '../integrations/ctxlayer/config'
import {
  completeConnection,
  integrationStub,
  startConnection
} from '../integrations/ctxlayer/oauth'
import { randomSecret, digest } from '../integrations/ctxlayer/secrets'
import { setupHtml } from '../integrations/ctxlayer/setup-html'

export const ctxlayerRoute = new Hono<HonoEnv>()
ctxlayerRoute.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  try {
    await next()
  } finally {
    if (new URL(c.req.url).pathname.endsWith('/complete'))
      deleteCookie(c, `ctxlayer_oauth_${c.env.STORE_ID || 'default'}`, { path: '/' })
  }
})
ctxlayerRoute.use(
  '*',
  bodyLimit({
    maxSize: 8192,
    onError: (c) => c.json({ error: { code: 'request_too_large' } }, 413)
  })
)
// Static shell only. All data and operations below require an authenticated store admin.
ctxlayerRoute.get('/setup', (c) => {
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
  )
  return c.html(setupHtml)
})
ctxlayerRoute.get('/callback', async (c) => {
  if (c.req.query('error')) {
    const name = `ctxlayer_oauth_${c.env.STORE_ID || 'default'}`,
      binding = getCookie(c, name),
      state = c.req.query('state')
    if (binding && state) {
      const config = integrationConfig(c.env)
      await integrationStub(c.env).ctxlayerState({
        op: 'cancel',
        state: await digest(state),
        binding: await digest(binding),
        config: config.fingerprint
      })
    }
    deleteCookie(c, name, { path: '/' })
  }
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
  )
  return c.html(setupHtml)
})
ctxlayerRoute.use('*', authMiddleware, adminOnly)
ctxlayerRoute.use('*', async (c, next) => {
  if (c.req.method !== 'GET') {
    const origin = c.req.header('Origin')
    if (origin && origin !== new URL(c.req.url).origin) throw ApiError.forbidden('Origin mismatch')
  }
  try {
    await next()
  } catch (error) {
    if (error instanceof IntegrationError)
      return c.json(
        { error: { code: error.code, message: 'Không hoàn tất kết nối ctxlayer.' } },
        409
      )
    throw error
  }
})
ctxlayerRoute.get('/status', async (c) => {
  const { connection } = await integrationStub(c.env).ctxlayerState({ op: 'get' })
  let matching = false
  try {
    matching = connection.config === integrationConfig(c.env).fingerprint
  } catch {}
  return c.json({
    status: connection.status,
    configured: matching,
    generation: connection.generation,
    expires_at: connection.expires_at
  })
})
ctxlayerRoute.post('/connect', async (c) => {
  const actor = c.var.auth.sub
  if (!actor) throw ApiError.forbidden('Verified staff JWT required for provisioning')
  const binding = randomSecret()
  const name = `ctxlayer_oauth_${c.env.STORE_ID || 'default'}`
  const result = await startConnection(c.env, actor, binding)
  setCookie(c, name, binding, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: 600
  })
  return c.json(result)
})
ctxlayerRoute.post('/complete', async (c) => {
  const name = `ctxlayer_oauth_${c.env.STORE_ID || 'default'}`
  try {
    const actor = c.var.auth.sub
    if (!actor) throw ApiError.forbidden('Verified staff JWT required for provisioning')
    const parsed = z
      .strictObject({ code: z.string().min(1).max(4096), state: z.string().min(20).max(200) })
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw ApiError.badRequest('Invalid OAuth completion')
    const body = parsed.data
    const binding = getCookie(c, name)
    if (!binding) throw new IntegrationError('mcp_oauth_state_invalid')
    return c.json(await completeConnection(c.env, actor, binding, body.state, body.code))
  } finally {
    deleteCookie(c, name, { path: '/' })
  }
})
ctxlayerRoute.delete('/connection', async (c) => {
  await integrationStub(c.env).ctxlayerState({ op: 'disconnect' })
  deleteCookie(c, `ctxlayer_oauth_${c.env.STORE_ID || 'default'}`, { path: '/' })
  // Local invalidation is immediate. Do not falsely claim the issuer grant was revoked.
  return c.json({ disconnected: true, remote_revocation: 'not_supported' })
})
