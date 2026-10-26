import { readJson } from '../lib/read-json';
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db';
import { ApiError, type HonoEnv } from '../types';
import { authMiddleware, adminOnly } from '../middleware/auth';

const kindSchema = z.enum([
  'campaigns',
  'promotions',
  'videos',
  'price-lists',
  'product-metadata',
  'variant-metadata',
]);
const dataSchema = z.record(z.string(), z.unknown());
export const storefrontContent = new Hono<HonoEnv>();
storefrontContent.use('*', authMiddleware, adminOnly);
storefrontContent.get('/:kind', async (c) => {
  const kind = kindSchema.parse(c.req.param('kind'));
  const rows = await getDb(c.var.db).query<{ id: string; data: string }>(
    'SELECT id,data FROM storefront_content WHERE kind=? ORDER BY id',
    [kind],
  );
  return c.json({
    items: rows.map((row) => ({ ...JSON.parse(row.data), id: row.id })),
  });
});
storefrontContent.get('/:kind/:id', async (c) => {
  const kind = kindSchema.parse(c.req.param('kind'));
  const [row] = await getDb(c.var.db).query<{ id: string; data: string }>(
    'SELECT id,data FROM storefront_content WHERE kind=? AND id=?',
    [kind, c.req.param('id')],
  );
  if (!row) throw ApiError.notFound('Storefront content not found');
  return c.json({ ...JSON.parse(row.data), id: row.id });
});
storefrontContent.put('/:kind/:id', async (c) => {
  const kind = kindSchema.parse(c.req.param('kind'));
  const id = z.string().min(1).max(200).parse(c.req.param('id'));
  const parsed = dataSchema.safeParse(await readJson(c.req.raw, 64_000));
  if (!parsed.success)
    throw ApiError.badRequest('Content must be a JSON object');
  const data = parsed.data;
  await getDb(c.var.db).run(
    `INSERT INTO storefront_content(kind,id,data) VALUES(?,?,?)
    ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data`,
    [kind, id, JSON.stringify(data)],
  );
  return c.json({ ...data, id });
});
storefrontContent.delete('/:kind/:id', async (c) => {
  const kind = kindSchema.parse(c.req.param('kind'));
  await getDb(c.var.db).run(
    'DELETE FROM storefront_content WHERE kind=? AND id=?',
    [kind, c.req.param('id')],
  );
  return c.json({ success: true });
});
