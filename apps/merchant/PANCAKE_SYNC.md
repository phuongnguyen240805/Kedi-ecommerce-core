# Pancake catalog sync

Pancake POS is the source for products, physical variants, VND retail prices,
external image URLs, availability flags and sellable stock at the configured warehouse.
The integration reads POS only. It does not create POS orders, reserve POS stock,
dispatch carriers or process payments. Original POS image URLs remain in storage;
catalog responses can serve them through the optional image CDN. R2 is not required.
See `IMAGE_CDN.md` for deployment and allowed source configuration.

## Runtime configuration

Private local values belong in `.dev.vars`; production credentials are Worker Secrets.
The Halifruit deploy script reads the ignored `.wrangler/halifruit.deploy-secrets.json`.
Keep the same credentials there for future deployments.

- `PANCAKE_BASE_URL`: `https://pos.pages.fm/api/v1` (only this upstream is accepted).
- `PANCAKE_SHOP_ID`: `715159313`.
- `PANCAKE_API_KEY`: server-only secret.
- `PANCAKE_WAREHOUSE_ID`: `9273036b-74c0-468c-9538-f3476f04b128` (Hali Fruit, verified through API).
- `PANCAKE_SYNC_ENABLED`: `true` enables the existing 15-minute cron.

## Administration

Both routes require a Fufuni admin bearer token. No credentials are returned.

- `GET /v1/integrations/pancake/status`: configured/cron state, last attempt,
  last successful report, warning counts and error code.
- `POST /v1/integrations/pancake/sync` with JSON `{}`: full snapshot.
- The same POST with `{"limit_products":1}`: one-product trial; it does not retire missing products.

The cron runs the same full snapshot function after cart cleanup. POS data is fetched
before committing anything: every page must validate, counts must agree and variation
IDs must be unique. The first version supports at most 20 pages of 30 variants (600).
Larger catalogs fail explicitly without applying a partial snapshot.

A five-minute lease prevents concurrent manual/cron runs. Durable Object
`transactionSync` commits products, mappings, VND prices, warehouse inventory and
the success report together. A failed commit rolls back. Stable IDs prevent duplicates;
each repeat updates records. Local reserved quantities remain untouched.
POS `remain_quantity` supplies the selected warehouse's sellable quantity;
missing warehouse stock is zero, not global POS stock. Fractional stock stays draft
until a unit conversion policy exists. Weight is not copied because its unit is unverified.

Zero-price, locked, hidden, removed or explicitly unpublished variants remain draft.
Products with any draft variant stay draft. Complete snapshots retire absent managed
products/variants to draft and set stock to zero; they do not physically delete records.
Changing the selected warehouse after a completed sync requires an explicit stock
reconciliation and is rejected to avoid counting two warehouses accidentally.
Missing or duplicate source SKU labels receive stable `POS-shop-variationID` fallbacks.
Catalog KV entries are invalidated after the commit; cache failures are reported
separately and do not undo persisted data.

This is polling, not atomic POS stock reservation. Concurrent storefront/POS sales
still require the later order/reservation and reconciliation workflow.

## Validation on 2026-10-12

- `npm run test:pancake`: SQLite persistence, idempotency, reservation preservation,
  full vs trial retirement, rollback, pagination failures, VND values and credential-safe errors.
- Worker deployment/dry run succeeds. Whole-repository TypeScript still reports
  pre-existing errors in checkout, orders, categories and AI-token routes; the new
  integration files produced no TypeScript diagnostics.
- Live admin endpoints return 200; anonymous/public-key integration requests return 401/403.
- One-product trial followed by its repeat creates no duplicates.
- Full sync and repeat produce 60 products / 60 variants; repeat creates zero records.
- POS currently returns zero prices, no image URLs, no selected-warehouse stock
  and no usable unique variant SKU labels for all 60 variants. All imported products
  are draft, so the FE active catalog remains empty.
- The supplied Excel contains 105 variants, but POS currently exposes only 60.
  Correct Excel column mapping/variant import and stock receipts in POS before publishing.

## Provider references

- https://docs.pancake.biz/pos/api/
- https://docs.pancake.biz/pos/api/openapi.json?lang=vi
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
