import { ApiError } from '../types';
import type { Database } from '../db';
export async function hashKey(value: string) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export const CUSTOMER_SESSION_SCHEMA = `CREATE TABLE IF NOT EXISTS customer_sessions (
  token_hash TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
); CREATE INDEX IF NOT EXISTS idx_customer_sessions_expiry ON customer_sessions(expires_at);
CREATE TABLE IF NOT EXISTS customer_auth_attempts (
  id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, window_start INTEGER NOT NULL
);`;

const iterations = 100_000;
export async function passwordHash(
  password: string,
  salt: string = crypto.randomUUID(),
) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(salt), iterations, hash: 'SHA-256' },
    key,
    256,
  );
  const digest = Array.from(new Uint8Array(bits), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `pbkdf2-sha256:${iterations}:${salt}:${digest}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [algorithm, rounds, salt, digest] = stored.split(':');
  if (
    algorithm !== 'pbkdf2-sha256' ||
    Number(rounds) !== iterations ||
    !salt ||
    !digest
  )
    return false;
  const actual = (await passwordHash(password, salt)).split(':')[3];
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(digest),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const expected = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(digest),
  );
  return crypto.subtle.verify(
    'HMAC',
    key,
    expected,
    new TextEncoder().encode(actual),
  );
}

export async function issueSession(db: Database, customerId: string) {
  const token = `ns_${crypto.randomUUID()}${crypto.randomUUID()}`;
  await db.run(
    'INSERT INTO customer_sessions(token_hash,customer_id,expires_at) VALUES(?,?,?)',
    [
      await hashKey(token),
      customerId,
      new Date(Date.now() + 3600_000).toISOString(),
    ],
  );
  return token;
}

/** A persistent per-email/IP budget cannot be bypassed by inventing API keys. */
export async function checkLoginBudget(
  db: Database,
  email: string,
  ip: string,
) {
  const id = await hashKey(`${ip}:${email.toLowerCase()}`);
  const now = Date.now();
  const cutoff = now - 15 * 60_000;
  await db.run(
    `INSERT INTO customer_auth_attempts(id,attempts,window_start) VALUES(?,1,?)
    ON CONFLICT(id) DO UPDATE SET attempts=CASE WHEN window_start<? THEN 1 ELSE attempts+1 END,
    window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END`,
    [id, now, cutoff, cutoff],
  );
  const [row] = await db.query<{ attempts: number }>(
    'SELECT attempts FROM customer_auth_attempts WHERE id=?',
    [id],
  );
  if (row.attempts > 10)
    throw new ApiError(
      'rate_limit_exceeded',
      429,
      'Too many login attempts. Try again later.',
    );
  return id;
}

export async function sessionCustomer(db: Database, token: string) {
  const [customer] = await db.query<{
    id: string;
    email: string;
    name: string | null;
    metadata: string | null;
  }>(
    `SELECT c.id,c.email,c.name,c.metadata FROM customer_sessions s JOIN customers c ON c.id=s.customer_id
     WHERE s.token_hash=? AND s.expires_at>?`,
    [await hashKey(token), new Date().toISOString()],
  );
  if (!customer)
    throw ApiError.unauthorized('Invalid or expired customer session');
  return customer;
}
