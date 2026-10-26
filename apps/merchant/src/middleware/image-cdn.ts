import type { MiddlewareHandler } from 'hono';
import type { HonoEnv } from '../types';
import { rewriteImageFields } from '../cdn/policy';

export const imageCdnMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  await next();
  if (c.req.method !== 'GET' || c.res.status !== 200 || !c.env.IMAGE_CDN_URL ||
      !c.res.headers.get('Content-Type')?.includes('application/json')) return;
  const data: unknown = await c.res.json();
  const headers = new Headers(c.res.headers);
  headers.delete('Content-Length');
  headers.delete('ETag');
  c.res = new Response(JSON.stringify(rewriteImageFields(data, c.env)), { status: 200, headers });
};
