import { allowedImageSource } from './policy';

type CdnEnv = Pick<CdnBindings, 'ASSETS' | 'IMAGE_CDN_ALLOWED_HOSTS'>;

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);
function failure(status: number, message: string) {
  return new Response(message, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function serveRemoteImage(
  request: Request, env: Pick<CdnEnv, 'IMAGE_CDN_ALLOWED_HOSTS'> & Partial<Pick<CdnEnv, 'ASSETS'>>,
  ctx: Pick<ExecutionContext, 'waitUntil'>, cache: Cache,
  fetchImage: typeof fetch = fetch,
): Promise<Response> {
  const incoming = new URL(request.url);
  const width = incoming.searchParams.get('w');
  if (incoming.searchParams.getAll('url').length !== 1 || incoming.searchParams.getAll('w').length > 1 ||
      (width !== null && !['320', '640'].includes(width)) ||
      [...incoming.searchParams.keys()].some(key => !['url', 'w'].includes(key))) return failure(400, 'Invalid image URL');
  const source = allowedImageSource(incoming.searchParams.get('url') || '', env.IMAGE_CDN_ALLOWED_HOSTS);
  if (!source) return failure(403, 'Image source is not allowed');
  if (width && env.ASSETS) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source.href));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const asset = await env.ASSETS.fetch(new Request(new URL(`/products/${hash}/${width}.webp`, incoming.origin)));
    if (asset.status === 200 && asset.headers.get('Content-Type')?.split(';')[0] === 'image/webp') {
      const headers = new Headers(asset.headers);
      headers.set('Cache-Control', 'public, max-age=3600');
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('X-Content-Type-Options', 'nosniff');
      return clientResponse(new Response(asset.body, { headers }), request.method, 'THUMBNAIL', ctx);
    }
    await asset.body?.cancel();
    // New catalog images remain available until the next thumbnail preparation.
  }
  const canonical = new URL('/remote', incoming.origin);
  canonical.searchParams.set('url', source.href);
  const cacheKey = new Request(canonical.href);
  const cached = await cache.match(cacheKey);
  if (cached) return clientResponse(cached, request.method, 'HIT', ctx);

  let upstream: Response;
  try {
    let current = source;
    for (let redirects = 0; ; redirects++) {
      // Never forward visitor credentials, cookies, Range, or arbitrary headers.
      upstream = await fetchImage(current.href, {
        redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' },
      });
      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
      const location = upstream.headers.get('Location');
      await upstream.body?.cancel();
      if (!location || redirects >= 3) return failure(502, 'Invalid image redirect');
      const next = allowedImageSource(new URL(location, current).href, env.IMAGE_CDN_ALLOWED_HOSTS);
      if (!next) return failure(403, 'Image redirect is not allowed');
      current = next;
    }
  } catch { return failure(502, 'Image source is unavailable'); }
  const type = upstream.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  const privateResponse = /(?:private|no-store|no-cache)/i.test(upstream.headers.get('Cache-Control') || '') ||
    upstream.headers.has('Set-Cookie');
  if (upstream.status !== 200 || !type || !IMAGE_TYPES.has(type) || privateResponse) {
    await upstream.body?.cancel();
    return failure(upstream.status === 404 ? 404 : 502, 'Source did not return a public image');
  }
  const length = Number(upstream.headers.get('Content-Length') || 0);
  if (length > MAX_IMAGE_BYTES || !upstream.body) {
    await upstream.body?.cancel();
    return failure(413, 'Image exceeds size limit');
  }
  let bytes = 0;
  const body = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MAX_IMAGE_BYTES) throw new Error('Image exceeds size limit');
      controller.enqueue(chunk);
    },
  }));
  const headers = new Headers({
    'Content-Type': type,
    'Cache-Control': 'public, max-age=3600, s-maxage=86400',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  });
  for (const name of ['ETag', 'Last-Modified']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  const response = new Response(body, { headers });
  ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {
    console.error(JSON.stringify({ event: 'cdn.cache_write_failed' }));
  }));
  return clientResponse(response, request.method, 'MISS', ctx);
}

function clientResponse(response: Response, method: string, status: string, ctx: Pick<ExecutionContext, 'waitUntil'>) {
  const headers = new Headers(response.headers);
  headers.set('X-Image-Cache', status);
  if (method === 'HEAD') {
    if (response.body) ctx.waitUntil(response.body.cancel().catch(() => {}));
    return new Response(null, { status: response.status, headers });
  }
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    if (!['GET', 'HEAD'].includes(request.method)) return failure(405, 'Method not allowed');
    const path = new URL(request.url).pathname;
    if (path === '/health') return Response.json({ ok: true, storage: 'workers-static-assets', r2: false });
    if (path === '/remote') {
      return serveRemoteImage(request, env, ctx, (caches as CacheStorage & { default: Cache }).default);
    }
    // The binding contains public image files only, prepared from the FE public directory.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<CdnEnv>;
