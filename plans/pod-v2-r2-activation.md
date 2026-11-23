# KediMuse POD v2 — activation after R2 is available

This change adds a Stripe-first staged pipeline. It does not certify real printing or the full Techcombank target. Keep retail QR/COD/Pancake settings unchanged. Do not use Stripe test export permission to authorize Printify writes.

## Deployment inputs

Backend source: `apps/merchant`, branch `codex/pod-v2-staged`, baseline `7fa341a`. Frontend source: sibling `checkout-fulfillment-fe`, same branch, baseline `00c4c3a`. Publish both only after review and their checks pass.

The existing CI path accepts these new repository variables:

```dotenv
POD_R2_BUCKET_NAME=
POD_ENABLED=false
POD_NEW_PIPELINE_ENABLED=false
POD_SUBMIT_ENABLED=false
POD_ACCOUNT_AUTOMATION_VERIFIED=false
POD_PRINTIFY_MEDIA_WRITE_ENABLED=false
POD_PRINTIFY_PRODUCT_WRITE_ENABLED=false
POD_ORDER_CREATE_ENABLED=false
POD_PRODUCTION_RELEASE_ENABLED=false
POD_WEBHOOK_ENABLED=false
PRINTIFY_SHOP_ID=
STORE_PUBLIC_API_URL=
```

Repository secrets: `PRINTIFY_API_TOKEN`, `PRINTIFY_WEBHOOK_SECRET`, optional `PRINTIFY_WEBHOOK_PREVIOUS_SECRET`, existing `ORDER_TOKEN_SECRET` and Stripe credentials. Webhook/signing secrets must be independently generated, at least 32 characters. Never put them in browser variables or copy the test fixture secrets.

`POD_R2_BUCKET_NAME` is deployment metadata, not a Worker secret. Empty means **no R2 binding is provisioned**. Once the owner enables R2 and provisions the intended private bucket, set the name. The existing generator adds `IMAGES` only to Worker `merchant`; it rejects conflicts with an existing IMAGES bucket. It does not give MCP artwork access. For other Worker names, configure the explicit `IMAGES` binding in that Worker's source config after confirming its tenant/namespace. Do not rename a Worker or Durable Object to activate POD.

The bucket must remain private. No public `r2.dev` URL is necessary. Artwork downloads go through scoped, expiring, hash-checked Worker URLs. No new DO namespace or D1 migration is required: `podV2Init()` creates additive tables/triggers with `ensureSchemaObjects` in each owning DO. Existing POD/stock/order/payment rows are preserved.

Frontend server environment:

```dotenv
POD_INTERNATIONAL_ENABLED=false
POD_NEW_PIPELINE_ENABLED=false
FUFUNI_BACKEND_URL=https://<verified-worker-host>[/stores/<verified-store-id>]
POD_ADMIN_KEY=<existing server-side merchant key>
POD_ORDER_COOKIE_SECRET=<independent random secret of at least 32 characters>
```

Use the same merchant base path as retail. New POD BFF explicitly refuses an absent backend URL. Cookies bind order+cart+backend scope, expire after 90 days, and are HttpOnly/SameSite; rotate `POD_ORDER_COOKIE_SECRET` to revoke this browser access. Lost-browser access needs the shop's verified recovery process; no public email/ID lookup endpoint is introduced.

## Activation sequence

1. Keep all provider writes OFF. Deploy the reviewed code with the private `IMAGES` binding. `GET /v1/pod/v2/status` must report storage/provider/signing readiness. Missing R2 blocks seal/quote/checkout; it does not simulate successful storage.
2. Enable POD routes and the new pipeline for the selected store only. In Admin POD, check catalog, record manufacturer physical dimensions, safe inset, technique, cost, currency and tax evidence. Approve the versioned print spec, then activate its mapping. Legacy direct `PUT /mappings/:sku` accepts disabled drafts only.
3. First supported scope: RGBA 8-bit non-interlaced PNG, flattened canvas, DTG/DTF, front/back, up to 40 million pixels, 8 MB through FE (20 MB backend), one customized design per SKU per cart. Embroidery/AOP and multiple different designs of one SKU in one cart are not certified. Do not infer physical inches from catalog pixels. Effective DPI and aspect ratio must satisfy the approved spec. All nontransparent pixels must stay inside the chosen safe inset; use zero only under an explicit bleed policy.
4. Customer creates a draft, exports from the existing designer or uploads a print-ready file. Admin previews actual bytes and approves artwork. Customer seals immutable snapshots. Front/back bytes are copied write-once and checked with SHA-256. Later design edits cannot replace sealed assets. Manual review remains necessary for rights, fine text, source-image quality and color reproduction; browser output is not a server-rendered proof of source-layer fidelity.
5. Run Stripe test with provider writes OFF. Confirm amount/currency/order and access after return/reload. Test receipts **cannot** trigger real Printify writes. Live runner independently retrieves the live Stripe session and expanded charge; unpaid/refunded/disputed charges are denied. No additional customer payment ledger is created.
6. Before authorized real provider smoke, independently verify Printify shop **Manual Approval**, funding and sample budget. Record its evidence in Admin (one-hour validity). Code cannot change or read this dashboard setting reliably. Enable media/product/order flags only for the approved live-paid sample. Keep production release OFF. Each provider resource must have its saved ID and matching GET proof; product creation does not publish a sales-channel listing.
7. Verify image dimensions/filename/bytes and created product's exact image IDs, variant, cost and transforms. Verify order external reference, line items and recipient. Review exact snapshot/cost/payment, record per-order production approval (one-hour validity), then enable release for the authorized sample. `POD_SUBMIT_ENABLED` and `POD_ACCOUNT_AUTOMATION_VERIFIED` remain mandatory gates in addition to the new flags.
8. Register Printify webhook at `<store API base>/v1/pod/v2/webhooks/printify` with its own secret and approved topics. HMAC is verified on raw body before persistence; inbox deduplicates event IDs. Existing cron performs authoritative GET reconciliation. Existing cron is every 15 minutes: this implementation does **not** claim a five-minute webhook latency SLO. Partial shipment remains partial until provider confirms the complete order delivered.
9. Inspect the delivered physical sample and record print placement, size, color/clarity acceptance before canary release. R2 availability alone does not satisfy this step.

## Unknown outcomes and rollback

- Media/product/order/production each have a separate durable intent and fenced lease. Any uncertain POST result or expired lease stops reposting. Provider GET and audited resolution are required.
- In Admin, obtain the candidate resource ID from Printify, select the matching operation, provide evidence, and invoke resource reconciliation. The backend fetches and checks scoped identity/content before attaching it. An order timeout can also recover via paginated shop order lookup. There is deliberately no "force retry POST" button.
- A provider operation with an active lease cannot be manually resolved. A stale worker cannot confirm a result after its lease expires.
- Disable `POD_PRINTIFY_MEDIA_WRITE_ENABLED`, `POD_PRINTIFY_PRODUCT_WRITE_ENABLED`, `POD_ORDER_CREATE_ENABLED` and `POD_PRODUCTION_RELEASE_ENABLED` to stop new writes. Keep `POD_ENABLED=true`, webhook ingress and cron read reconciliation active for existing orders. Never delete new schema/provider references or send legacy unknown orders again.
- Legacy on-the-fly jobs remain readable/reconcilable. With new pipeline enabled, fresh unsnapshotted legacy jobs cannot be submitted automatically.
- Read `/v1/pod/v2/admin/health`, `/admin/operations`, retries and inbox age; alert on unknown operations, paid-but-stuck orders, missing webhooks and duplicated external resources. This patch provides structured logs/health data, not a configured external paging service.

## Remaining external acceptance

Actual R2 binding and permission, deployed store identity, real provider contract responses, live Stripe, Printify Manual Approval/funding/webhook registration, shipping/print sample, and treasury/tax signoff remain owner-controlled acceptance. Techcombank POD VND/FX is not activated: no authenticated bank interface or FX policy was supplied. Existing retail manual QR reconciliation remains unchanged. `bank_ready=false` is intentional; do not advertise the full bank target as complete.

Official references checked: [Printify API](https://developers.printify.com/), [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [DO SQLite transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
