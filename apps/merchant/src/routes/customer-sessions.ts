import { readJson } from '../lib/read-json';
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db';
import { ApiError, type HonoEnv } from '../types';
import {
  checkLoginBudget,
  hashKey,
  issueSession,
  passwordHash,
  sessionCustomer,
  verifyPassword,
} from '../lib/customer-sessions';

const loginInput = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});
const registrationInput = loginInput.extend({
  password: z.string().min(6).max(256),
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  sex: z.string().max(30).optional(),
  avatar: z.string().url().max(2048).optional(),
});
function customerView(customer: {
  id: string;
  email: string;
  name: string | null;
  metadata: string | null;
}) {
  const metadata = JSON.parse(customer.metadata || '{}') as Record<
    string,
    unknown
  >;
  return {
    ...customer,
    first_name: metadata.first_name || customer.name || '',
    last_name: metadata.last_name || '',
    metadata,
    active_cart_id: metadata.active_cart_id,
  };
}

export const customerSessions = new Hono<HonoEnv>();
customerSessions.use('*', async (c, next) => {
  if (c.env.CUSTOMER_PASSWORD_AUTH_ENABLED !== 'true')
    throw ApiError.serviceUnavailable(
      'Password authentication is not configured',
    );
  c.header('Cache-Control', 'private, no-store');
  await next();
});
customerSessions.post('/register', async (c) => {
  const parsed = registrationInput.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw ApiError.badRequest('Invalid registration data');
  const input = parsed.data;
  const db = getDb(c.var.db);
  const email = input.email.toLowerCase();
  const [exists] = await db.query('SELECT id FROM customers WHERE email=?', [
    email,
  ]);
  if (exists) throw ApiError.conflict('An account already exists');
  const id = crypto.randomUUID();
  const metadata = JSON.stringify({
    first_name: input.first_name,
    last_name: input.last_name,
    sex: input.sex,
    avatar: input.avatar,
  });
  const hash = await passwordHash(input.password);
  // Conditional insertion prevents overwriting an existing POS/customer record during a concurrent registration.
  const result = await db.run(
    `INSERT OR IGNORE INTO customers(id,email,name,password_hash,auth_provider,auth_provider_id,metadata)
    VALUES(?,?,?,?,'native',?,?)`,
    [id, email, `${input.first_name} ${input.last_name}`, hash, id, metadata],
  );
  if (!result.changes) throw ApiError.conflict('An account already exists');
  return c.json(
    {
      customer: customerView({
        id,
        email,
        name: `${input.first_name} ${input.last_name}`,
        metadata,
      }),
    },
    201,
  );
});
customerSessions.post('/login', async (c) => {
  const parsed = loginInput.safeParse(await readJson(c.req.raw));
  if (!parsed.success) throw ApiError.badRequest('Invalid login data');
  const db = getDb(c.var.db);
  const budgetId = await checkLoginBudget(
    db,
    parsed.data.email,
    c.req.header('CF-Connecting-IP') || 'unknown',
  );
  const [customer] = await db.query<{
    id: string;
    password_hash: string | null;
  }>(
    "SELECT id,password_hash FROM customers WHERE email=? AND auth_provider='native'",
    [parsed.data.email.toLowerCase()],
  );
  const stored =
    customer?.password_hash || `pbkdf2-sha256:100000:missing:${'0'.repeat(64)}`;
  const valid = await verifyPassword(parsed.data.password, stored);
  if (!customer || !valid)
    throw ApiError.unauthorized('Invalid email or password');
  await db.run('DELETE FROM customer_auth_attempts WHERE id=?', [budgetId]);
  return c.json({
    token: await issueSession(db, customer.id),
    expires_in: 3600,
  });
});
customerSessions.get('/me', async (c) => {
  const token = c.req.header('Authorization')?.replace(/^Bearer /, '') || '';
  if (!token.startsWith('ns_'))
    throw ApiError.unauthorized('Customer session required');
  return c.json(customerView(await sessionCustomer(getDb(c.var.db), token)));
});
customerSessions.post('/logout', async (c) => {
  const token = c.req.header('Authorization')?.replace(/^Bearer /, '') || '';
  const db = getDb(c.var.db);
  await sessionCustomer(db, token);
  await db.run('DELETE FROM customer_sessions WHERE token_hash=?', [
    await hashKey(token),
  ]);
  return c.json({ success: true });
});
