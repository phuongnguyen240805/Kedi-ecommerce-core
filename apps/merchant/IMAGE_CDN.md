# Halifruit image CDN without R2

`halifruit-cdn` serves public frontend images with Workers Static Assets. `/remote?url=...`
fetches public raster images from explicitly allowed HTTPS hosts and uses the Workers
Cache API. No R2 bucket or image upload storage is required.

## Deploy

From `apps/merchant`:

```powershell
npm run cdn:prepare -- D:/workspace/halifruit-fe-v1/public
npm run cdn:typegen
npm run test:cdn
npx tsc -p tsconfig.cdn.json
npm run deploy:cdn
```

Repeat asset preparation/deployment when frontend public images change. Only image
files are copied, with their original public paths. `_headers` gives browser cache
a one-hour TTL; assets are distributed through Cloudflare's static asset system.

### Product thumbnails

After `cdn:prepare` and before `deploy:cdn`, generate 320/640px WebP variants from
the active backend catalog. Run from the frontend checkout (requires its Next.js/Sharp
dependencies). Keep the server credentials JSON outside public files:

```powershell
node scripts/prepare-product-cdn.mjs D:/monorepo-project-workspace/fufuni/apps/merchant/.wrangler/cdn-assets <server-secrets.json>
```

The JSON supplies `FUFUNI_BACKEND_URL` and `FUFUNI_PUBLIC_KEY`; environment variables
can be used instead by omitting that argument. Download sources must match
`IMAGE_CDN_ALLOWED_HOSTS` (defaults match the CDN config). The script deduplicates
catalog image URLs and writes only generated WebP files and a report outside public
assets. It does not modify product records or original uploads.

Listing cards request `/remote?url=...&w=640`; supported widths are 320 and 640.
Prepared variants return `X-Image-Cache: THUMBNAIL`. Missing variants automatically
fall back to the original cached image, so new products remain visible before the
next preparation/deployment. Product detail keeps its full-size original.
Regenerate after catalog images change. Always run thumbnail preparation **after**
`cdn:prepare`, because that command replaces the generated public asset snapshot.
No Cloudflare Images subscription or R2 is used.

## Custom domain

Add the chosen domain's DNS zone to the same Cloudflare account, then add this to
`wrangler.cdn.jsonc` and deploy:

```json
"routes": [{ "pattern": "cdn.your-domain.vn", "custom_domain": true }]
```

Replace `IMAGE_CDN_URL` in `wrangler.halifruit.jsonc` and build-time
`NEXT_PUBLIC_IMAGE_CDN_URL` in the frontend with that HTTPS origin. Re-deploy both.
The existing account currently has only the `kedi.media` zone; no Halifruit hostname
has been selected or registered by this change.

## Image sources and cache

`IMAGE_CDN_ALLOWED_HOSTS` must match in both configs. Use exact hostnames; verify
the actual POS image host when Pancake starts returning images. Hosts outside this
list continue to use their original URLs. Do not add private or authenticated hosts.

Backend GET catalog responses rewrite `image_url` and `thumbnail_url`, including
responses from existing KV cache. Original URLs remain in the database. The FE
`publicImageUrl` helper routes local image paths through the CDN when configured;
it is used for homepage image assets and storefront product cards.

Remote images cache at the serving Cloudflare location for up to 24 hours and in
browsers for one hour. Responses expose `X-Image-Cache: HIT|MISS`. Cache is temporary;
the original image source must remain available. Update the original image URL when
changing image content; otherwise allow the TTL to expire. No global purge endpoint
is provided. The existing `/v1/images` upload API still requires R2 and is separate.

Only successful public JPEG, PNG, WebP, AVIF and GIF responses are accepted remotely.
Redirects are validated at every hop, and request cookies/auth are never forwarded.
Errors, HTML, private responses, cookies and images larger than 20 MiB are rejected.
Streaming avoids buffering entire image files in Worker memory.

References:
- https://developers.cloudflare.com/workers/runtime-apis/cache/
- https://developers.cloudflare.com/workers/static-assets/
- https://developers.cloudflare.com/workers/configuration/routing/custom-domains/

## Live validation on 2026-10-13

CDN health and static WebP return 200. A real Pancake product image was verified
with MISS followed by HIT. Frontend homepage returns 200 with CDN image URLs.
Frontend deployment d638f36c-a884-4103-96fe-0acfcd6e88bb includes the native
backend service binding and manual redirect mode; temporary diagnostics are removed.
Catalog API verification is currently blocked by the backend error
`Exceeded allowed rows written in Durable Objects free tier.` This is a separate
account storage quota; CDN image delivery does not depend on Durable Objects.
The custom CDN hostname is still awaiting the user-selected domain.
