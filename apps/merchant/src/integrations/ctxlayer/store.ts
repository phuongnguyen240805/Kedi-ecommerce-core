import type { SyncSql } from '../../lib/pancake-store'
import { z } from 'zod'
export const INTEGRATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS ctxlayer_connection (
 id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL DEFAULT 0,
 config TEXT NOT NULL DEFAULT '', secret TEXT, expires_at INTEGER NOT NULL DEFAULT 0,
 refresh_until INTEGER NOT NULL DEFAULT 0, refresh_token TEXT, status TEXT NOT NULL DEFAULT 'disconnected'
 CHECK(status IN ('connected','disconnected','reauth_required')));
CREATE TABLE IF NOT EXISTS ctxlayer_transactions (
 state TEXT PRIMARY KEY, actor TEXT NOT NULL, binding TEXT NOT NULL, config TEXT NOT NULL,
 secret TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pancake_sync_runs (
 id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, source TEXT NOT NULL, config TEXT NOT NULL,
 generation INTEGER, state TEXT NOT NULL CHECK(state IN ('running','succeeded','succeeded_with_warning','failed','blocked','abandoned')),
 started_at INTEGER NOT NULL, finished_at INTEGER, error_code TEXT, report_json TEXT);
`
export interface Connection {
  generation: number
  config: string
  secret: string | null
  expires_at: number
  refresh_until: number
  refresh_token: string | null
  status: 'connected' | 'disconnected' | 'reauth_required'
}
export interface OAuthTransaction {
  state: string
  actor: string
  binding: string
  config: string
  secret: string
  expires_at: number
}
export type StateCommand =
  | { op: 'get' }
  | { op: 'transaction'; value: OAuthTransaction }
  | { op: 'consume'; state: string; actor: string; binding: string; config: string }
  | { op: 'connect'; config: string; secret: string; expiry: number; generation: number }
  | { op: 'disconnect' }
  | { op: 'cancel'; state: string; binding: string; config: string }
  | { op: 'invalidate'; generation: number; secret: string }
  | { op: 'claim'; generation: number; token: string; secret: string }
  | { op: 'refresh'; generation: number; token: string; secret: string; expiry: number }
  | { op: 'reauth'; generation: number; token: string }
export type StateResult = { connection: Connection; transaction?: OAuthTransaction; ok: boolean }
const connectionSchema = z.object({
  generation: z.number(),
  config: z.string(),
  secret: z.string().nullable(),
  expires_at: z.number(),
  refresh_until: z.number(),
  refresh_token: z.string().nullable(),
  status: z.enum(['connected', 'disconnected', 'reauth_required'])
})
const transactionSchema = z.object({
  state: z.string(),
  actor: z.string(),
  binding: z.string(),
  config: z.string(),
  secret: z.string(),
  expires_at: z.number()
})
export function connection(sql: SyncSql): Connection {
  const row = sql.exec('SELECT * FROM ctxlayer_connection WHERE id=1').toArray()[0]
  return row
    ? connectionSchema.parse(row)
    : {
        generation: 0,
        config: '',
        secret: null,
        expires_at: 0,
        refresh_until: 0,
        refresh_token: null,
        status: 'disconnected'
      }
}
/** Called inside transactionSync: consume, CAS and refresh claim cannot interleave. */
export function integrationState(sql: SyncSql, input: StateCommand): StateResult {
  const now = Date.now()
  let ok = true
  let transaction: OAuthTransaction | undefined
  const current = connection(sql)
  if (input.op !== 'get' && current.generation === 0)
    sql.exec('INSERT OR IGNORE INTO ctxlayer_connection(id) VALUES(1)')
  if (input.op === 'transaction') {
    sql.exec('DELETE FROM ctxlayer_transactions WHERE expires_at<=?', now)
    const t = input.value
    sql.exec(
      'INSERT INTO ctxlayer_transactions VALUES(?,?,?,?,?,?)',
      t.state,
      t.actor,
      t.binding,
      t.config,
      t.secret,
      t.expires_at
    )
  } else if (input.op === 'consume') {
    const consumed = sql
      .exec(
        'DELETE FROM ctxlayer_transactions WHERE state=? AND actor=? AND binding=? AND config=? AND expires_at>? RETURNING *',
        input.state,
        input.actor,
        input.binding,
        input.config,
        now
      )
      .toArray()[0]
    transaction = consumed ? transactionSchema.parse(consumed) : undefined
    ok = Boolean(transaction)
  } else if (input.op === 'cancel') {
    sql.exec(
      'DELETE FROM ctxlayer_transactions WHERE state=? AND binding=? AND config=?',
      input.state,
      input.binding,
      input.config
    )
  } else if (input.op === 'invalidate') {
    ok = current.generation === input.generation && current.secret === input.secret
    if (ok)
      sql.exec(
        "UPDATE ctxlayer_connection SET generation=generation+1,status='reauth_required',secret=NULL,refresh_token=NULL,refresh_until=0 WHERE id=1"
      )
  } else if (input.op === 'connect') {
    ok = current.generation === input.generation
    if (ok)
      sql.exec(
        "UPDATE ctxlayer_connection SET generation=generation+1,config=?,secret=?,expires_at=?,refresh_until=0,refresh_token=NULL,status='connected' WHERE id=1",
        input.config,
        input.secret,
        input.expiry
      )
  } else if (input.op === 'disconnect') {
    sql.exec(
      "UPDATE ctxlayer_connection SET generation=generation+1,secret=NULL,expires_at=0,refresh_until=0,refresh_token=NULL,status='disconnected' WHERE id=1"
    )
    sql.exec('DELETE FROM ctxlayer_transactions')
  } else if (input.op === 'claim') {
    ok =
      current.generation === input.generation &&
      current.secret === input.secret &&
      current.status === 'connected' &&
      current.refresh_until <= now
    if (ok)
      sql.exec(
        'UPDATE ctxlayer_connection SET refresh_token=?,refresh_until=? WHERE id=1',
        input.token,
        now + 30000
      )
  } else if (input.op === 'refresh' || input.op === 'reauth') {
    ok =
      current.generation === input.generation &&
      current.refresh_token === input.token &&
      current.refresh_until > now
    if (ok && input.op === 'refresh')
      sql.exec(
        'UPDATE ctxlayer_connection SET secret=?,expires_at=?,refresh_token=NULL,refresh_until=0 WHERE id=1',
        input.secret,
        input.expiry
      )
    if (ok && input.op === 'reauth')
      sql.exec(
        "UPDATE ctxlayer_connection SET generation=generation+1,status='reauth_required',secret=NULL,refresh_token=NULL,refresh_until=0 WHERE id=1"
      )
  }
  return { connection: connection(sql), transaction, ok }
}
