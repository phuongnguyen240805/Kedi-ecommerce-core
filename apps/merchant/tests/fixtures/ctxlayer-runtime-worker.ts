// Test-only entry: never referenced by deployment configuration.
import worker, { MerchantDO } from '../../src/index'
import type { Env } from '../../src/types'
import { resolveStore } from '../../src/lib/stores'
import {
  completeConnection,
  startConnection,
  integrationStub
} from '../../src/integrations/ctxlayer/oauth'
import { randomSecret } from '../../src/integrations/ctxlayer/secrets'
export { MerchantDO }
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (
      new URL(request.url).pathname === '/__test/connect' &&
      request.headers.get('Authorization') === 'Bearer fixture-bootstrap'
    ) {
      const selected = resolveStore(request, env).env
      const binding = randomSecret(),
        actor = 'fixture-verified-admin'
      const started = await startConnection(selected, actor, binding)
      const authorization = new URL(started.authorization_url)
      const response = await fetch(authorization, { redirect: 'manual' })
      const callback = new URL(response.headers.get('Location')!)
      const result = await completeConnection(
        selected,
        actor,
        binding,
        callback.searchParams.get('state')!,
        callback.searchParams.get('code')!
      )
      return Response.json({
        ...result,
        status: (await integrationStub(selected).ctxlayerState({ op: 'get' })).connection.status
      })
    }
    return worker.fetch(request, env, ctx)
  }
}
