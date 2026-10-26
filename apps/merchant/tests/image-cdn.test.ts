import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { allowedImageSource, cdnImageUrl, rewriteImageFields } from '../src/cdn/policy';
import { serveRemoteImage } from '../src/cdn/worker';
import { imageCdnMiddleware } from '../src/middleware/image-cdn';
import { createHash } from 'node:crypto';

const hosts = 'images.example.com,redirect.example.com';
const config = { IMAGE_CDN_URL: 'https://cdn.example.com', IMAGE_CDN_ALLOWED_HOSTS: hosts };
const image = 'https://images.example.com/a.png?version=2';
const request = (method = 'GET') => new Request(cdnImageUrl(image, config), { method });
function harness() {
  const entries = new Map<string, Response>();
  const work: Promise<unknown>[] = [];
  const cache = {
    async match(key: Request) { return entries.get(key.url)?.clone(); },
    async put(key: Request, response: Response) { entries.set(key.url, new Response(await response.arrayBuffer(), response)); },
  } as unknown as Cache;
  const ctx = { waitUntil(promise: Promise<unknown>) { work.push(promise); } };
  return { cache, ctx, work, entries };
}
const fetcher = (fn: (input: string, init?: RequestInit) => Promise<Response>) => fn as typeof fetch;

test('prepared thumbnails use a deterministic asset path, HEAD works, and missing variants fall back to original', async () => {
  for (const method of ['GET', 'HEAD']) {
    const h = harness();
    const url = new URL(request().url); url.searchParams.set('w', '640');
    const assets = { async fetch(asset: Request) {
      assert.equal(new URL(asset.url).pathname, `/products/${createHash('sha256').update(image).digest('hex')}/640.webp`);
      return new Response('webp', { headers: { 'Content-Type': 'image/webp' } });
    } } as Fetcher;
    const response = await serveRemoteImage(new Request(url, { method }), { ...config, ASSETS: assets }, h.ctx, h.cache, fetcher(async () => { throw new Error('Should use prepared image'); }));
    assert.equal(response.headers.get('X-Image-Cache'), 'THUMBNAIL');
    assert.equal(await response.text(), method === 'HEAD' ? '' : 'webp');
    await Promise.all(h.work);
  }
  const h = harness(); const url = new URL(request().url); url.searchParams.set('w', '320');
  const response = await serveRemoteImage(new Request(url), { ...config, ASSETS: { fetch: async () => new Response('missing', { status: 404 }) } as unknown as Fetcher }, h.ctx, h.cache,
    fetcher(async () => new Response('original', { headers: { 'Content-Type': 'image/png' } })));
  assert.equal(await response.text(), 'original'); await Promise.all(h.work);
  assert.equal(h.entries.size, 1);
});

test('invalid and repeated thumbnail parameters fail before accessing assets or origin', async () => {
  for (const query of ['w=999', 'w=640&w=320', 'w=', 'other=640']) {
    const h = harness();
    const response = await serveRemoteImage(new Request(`${request().url}&${query}`), config, h.ctx, h.cache,
      fetcher(async () => { throw new Error('Must not fetch'); }));
    assert.equal(response.status, 400);
  }
});

test('exact HTTPS host allowlist rejects credentials, ports, lookalikes and private origins', () => {
  for (const url of ['http://images.example.com/a', 'https://images.example.com.evil.test/a',
    'https://evil.images.example.com/a', 'https://user:pass@images.example.com/a',
    'https://images.example.com:8443/a', 'https://127.0.0.1/a', 'https://images.example.com/a#frag']) {
    assert.equal(allowedImageSource(url, hosts), null);
    assert.equal(cdnImageUrl(url, config), url);
  }
  assert.equal(allowedImageSource(image, hosts)?.href, image);
  assert.equal(cdnImageUrl(image, {}), image);
  const data = { items: [{ image_url: image, variants: [{ thumbnail_url: image }], description: image }] };
  const rewritten = rewriteImageFields(data, config) as typeof data;
  assert.equal(new URL(rewritten.items[0].image_url).searchParams.get('url'), image);
  assert.equal(rewritten.items[0].variants[0].thumbnail_url, cdnImageUrl(image, config));
  assert.equal(rewritten.items[0].description, image);
  assert.equal(data.items[0].image_url, image);
});

test('cache miss stores image; subsequent GET and HEAD use the same cached bytes without credentials', async () => {
  const h = harness(); let calls = 0;
  const fetchImage = fetcher(async (_url, init) => {
    calls++;
    assert.equal(init?.redirect, 'manual');
    assert.deepEqual(Object.keys(init?.headers || {}), ['Accept']);
    return new Response('image-bytes', { headers: { 'Content-Type': 'image/png', ETag: '"v1"', 'X-Secret': 'hidden' } });
  });
  const first = await serveRemoteImage(request(), config, h.ctx, h.cache, fetchImage);
  assert.equal(first.headers.get('X-Image-Cache'), 'MISS');
  assert.equal(first.headers.get('X-Secret'), null);
  assert.equal(await first.text(), 'image-bytes');
  await Promise.all(h.work);
  const second = await serveRemoteImage(request(), config, h.ctx, h.cache, fetchImage);
  assert.equal(second.headers.get('X-Image-Cache'), 'HIT');
  assert.equal(await second.text(), 'image-bytes');
  const head = await serveRemoteImage(request('HEAD'), config, h.ctx, h.cache, fetchImage);
  assert.equal(head.headers.get('X-Image-Cache'), 'HIT');
  assert.equal(await head.text(), '');
  assert.equal(calls, 1);
});

test('redirects cannot escape the allowlist; allowed redirect returns image', async () => {
  for (const target of ['https://127.0.0.1/private', 'https://images.example.com.evil.test/a']) {
    const h = harness(); let calls = 0;
    const response = await serveRemoteImage(request(), config, h.ctx, h.cache, fetcher(async () => {
      calls++; return new Response(null, { status: 302, headers: { Location: target } });
    }));
    assert.equal(response.status, 403); assert.equal(calls, 1); assert.equal(h.work.length, 0);
  }
  const h = harness(); let calls = 0;
  const response = await serveRemoteImage(request(), config, h.ctx, h.cache, fetcher(async () => {
    calls++;
    return calls === 1 ? new Response(null, { status: 302, headers: { Location: 'https://redirect.example.com/a' } })
      : new Response('png', { headers: { 'Content-Type': 'image/png' } });
  }));
  assert.equal(response.status, 200); await response.text(); await Promise.all(h.work); assert.equal(calls, 2);
});

test('HTML, private responses, failures and oversized images never enter cache', async () => {
  for (const upstream of [
    new Response('<html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('png', { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private' } }),
    new Response('png', { headers: { 'Content-Type': 'image/png', 'Set-Cookie': 'session=secret' } }),
    new Response('png', { headers: { 'Content-Type': 'image/png', 'Content-Length': '22000000' } }),
    new Response(null, { status: 404 }),
  ]) {
    const h = harness();
    const response = await serveRemoteImage(request(), config, h.ctx, h.cache, fetcher(async () => upstream));
    assert.ok(response.status >= 400); assert.equal(h.work.length, 0);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
});

test('middleware rewrites cached catalog responses without modifying cached origin data or other text', async () => {
  const app = new Hono();
  app.use('*', imageCdnMiddleware);
  app.get('/', c => c.json({ items: [{ image_url: image, description: image }] }));
  const result = await app.request('/', {}, config);
  const body = await result.json() as { items: { image_url: string; description: string }[] };
  assert.equal(body.items[0].image_url, cdnImageUrl(image, config));
  assert.equal(body.items[0].description, image);
});
