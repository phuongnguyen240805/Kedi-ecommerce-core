import {
  acquirePosLease,
  applyPosSnapshot,
  finishPosError,
  type SyncSql
} from '../../lib/pancake-store'
import type { PancakeSnapshot } from '../../lib/pancake-source'
import { connection } from '../ctxlayer/store'
export interface RunContext {
  id: string
  shop: string
  config: string
  generation: number
  trigger: 'manual' | 'cron'
  actor?: string
}
export function beginMcpRun(sql: SyncSql, run: RunContext) {
  const current = connection(sql)
  if (
    current.status !== 'connected' ||
    current.generation !== run.generation ||
    current.config !== run.config
  )
    throw Error('mcp_connection_changed')
  if (!acquirePosLease(sql, run.shop, run.id)) return false
  sql.exec(
    "UPDATE pancake_sync_runs SET state='abandoned',finished_at=?,error_code='lease_expired' WHERE shop_id=? AND state='running'",
    Date.now(),
    run.shop
  )
  sql.exec(
    "INSERT INTO pancake_sync_runs(id,shop_id,source,config,generation,state,started_at,report_json) VALUES(?,?,'ctxlayer_mcp',?,?,'running',?,?)",
    run.id,
    run.shop,
    run.config,
    run.generation,
    Date.now(),
    JSON.stringify({ trigger: run.trigger,actor:run.actor||null })
  )
  return true
}
export function commitMcpRun(sql: SyncSql, snapshot: PancakeSnapshot, run: RunContext) {
  const current = connection(sql)
  const record = sql
    .exec(
      "SELECT id FROM pancake_sync_runs WHERE id=? AND shop_id=? AND state='running' AND config=? AND generation=?",
      run.id,
      run.shop,
      run.config,
      run.generation
    )
    .toArray()[0]
  if (
    !record ||
    snapshot.token !== run.id ||
    snapshot.shopId !== run.shop ||
    current.status !== 'connected' ||
    current.generation !== run.generation ||
    current.config !== run.config
  )
    throw Error('mcp_connection_changed')
  const report = { ...applyPosSnapshot(sql, snapshot), run_id: run.id, source: 'ctxlayer_mcp',trigger:run.trigger,actor:run.actor||null }
  sql.exec(
    "UPDATE pancake_sync_runs SET state='succeeded',finished_at=?,report_json=? WHERE id=?",
    Date.now(),
    JSON.stringify(report),
    run.id
  )
  return report
}
export function failMcpRun(sql: SyncSql, run: RunContext, code: string) {
  sql.exec(
    "UPDATE pancake_sync_runs SET state=?,finished_at=?,error_code=? WHERE id=? AND state='running'",
    /denied|forbidden|connected|reauth|disabled|scope/.test(code) ? 'blocked' : 'failed',
    Date.now(),
    code,
    run.id
  )
  finishPosError(sql, run.shop, run.id, code)
}
