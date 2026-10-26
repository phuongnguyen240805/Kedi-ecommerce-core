# One backend, multiple POS stores

The `halifruit-backend` Worker serves all stores. Each store has its own MerchantDO database, API keys, products, carts, orders, customers, POS sync state and cache. Non-default stores also use separate prefixes in shared R2 buckets. New stores are added through configuration, without editing application routes.

## Routing and compatibility

- Existing Halifruit requests keep their URL, keys and `default` Durable Object.
- `/stores/halifruit/v1/...` is an explicit alias for the existing store.
- `/stores/printerval/v1/...` uses the `store:printerval` Durable Object.
- `/stores/<new-id>/v1/...` uses `store:<new-id>`.
- Unknown stores return 404. `X-Store-Id`, when provided, must agree with the URL.
- Store IDs are stable identities. Do not rename them or change `default_store` after provisioning: this would select a different database.

Store selection is routing, not authorization. Public/admin keys and native customer sessions are checked against the selected database, including before returning cached catalog responses. Auth0 JWTs for a non-default store must carry `store_id` or a `store_ids` array containing that store ID. Auth0 issuers must grant this claim; frontend-supplied claims are not trusted.

## Configuration

`STORES_JSON` is a non-secret Worker JSON variable; structured objects and serialized JSON strings are both accepted. `wrangler.halifruit.jsonc` declares Halifruit and Printerval; Printerval sync starts disabled until its own POS configuration is supplied.

```json
{
  "default_store": "halifruit",
  "stores": [
    { "id": "halifruit", "name": "Halifruit" },
    {
      "id": "printerval",
      "name": "Printerval",
      "origins": ["https://your-printerval-domain.example"],
      "settings": {
        "STORE_URL": "https://your-printerval-domain.example",
        "PANCAKE_SHOP_ID": "YOUR_NUMERIC_POS_SHOP_ID",
        "PANCAKE_WAREHOUSE_ID": "YOUR_POS_WAREHOUSE_ID",
        "PANCAKE_VARIANT_TYPE": "digital",
        "PANCAKE_SYNC_ENABLED": "true",
        "CUSTOMER_PASSWORD_AUTH_ENABLED": "true"
      }
    }
  ]
}
```

`STORE_SECRETS_JSON` is a Wrangler secret containing a JSON object keyed by store ID. Never commit its real value. Supported entries include `PANCAKE_API_KEY`, `SETUP_INIT_TOKEN`, `ORDER_TOKEN_SECRET`, Stripe keys and GHN tokens. Each non-default store must supply its own credentials; it does not inherit Halifruit credentials. Example structure only:

```json
{
  "printerval": {
    "PANCAKE_API_KEY": "REPLACE_WITH_SECRET",
    "SETUP_INIT_TOKEN": "REPLACE_WITH_STRONG_BOOTSTRAP_SECRET",
    "ORDER_TOKEN_SECRET": "REPLACE_WITH_STRONG_SIGNING_SECRET"
  }
}
```

The allowed settings/secrets are centralized in `src/lib/stores.ts`. Invalid JSON, unsupported settings or duplicate IDs fail closed. Origin restrictions are optional for server requests; when configured, browser Origin headers are checked. Origins do not replace API-key authorization.

## Provision a store

Use server environment variables `FUFUNI_BACKEND_URL` (backend origin), `STORE_ID`, `SETUP_INIT_TOKEN`, `MERCHANT_PK` and `MERCHANT_SK`. Keys must be generated securely and different for each store. The script hashes them before bootstrap and never logs credentials:

```powershell
rtk proxy node apps/merchant/scripts/init-store.mjs
```

The script initializes keys, an active VND currency with zero decimal places and a VND region. Re-running with the same credentials reuses those records. It does not rotate existing keys. Test it against local/staging first; production invocation writes store data.

After setting the shop ID, warehouse and POS secret, call the selected store's `POST /v1/integrations/pancake/sync`, authenticated with that store's admin key. Inspect `GET /v1/integrations/pancake/status`. The cron iterates configured stores; a store failure is reported independently.

## Digital products

New POS variants use `PANCAKE_VARIANT_TYPE` (`physical`, `digital` or `ai_tokens`). Digital/token variants have `requires_shipping=false`. Later syncs update POS-managed prices, images and inventory while preserving manual variant types and fulfillment metadata. Existing imported physical variants are not silently reclassified when changing this setting; migrate those variants explicitly through the admin API.

Downloaded files use the existing digital-asset API. AI token packages additionally need `ai_token_units` and the existing token integration configured. Setting the type alone does not provision external accounts, license keys or subscriptions. Those fulfillment integrations are outside this migration.

## Frontend display metadata

`/v1/storefront-content/:kind` is an admin-only API for store-owned display records. Supported kinds are `campaigns`, `promotions`, `videos`, `price-lists`, `product-metadata` and `variant-metadata`. GET lists records; GET/PUT/DELETE `/:kind/:id` reads, upserts or deletes one record. PUT accepts a JSON object up to 64 KB.

- Product/variant metadata IDs must match the Fufuni product/variant IDs, not old Medusa IDs.
- Product metadata can contain the existing AI view fields: `category`, `type`, `features`, `tags`, `badge`, `source_catalog_card` and `parent_content`.
- Variant metadata can contain `price_period`, `selected_options` and `offer_attributes`.
- Price-list display records contain `product_ids`; the catalog's actual variant prices remain authoritative.
- Campaign/promotion records preserve the existing UI's display shape. This API does not apply discounts to orders; use Fufuni's discount APIs for checkout discounts.
- These records are independent of POS sync and are not overwritten by it.

Printerval's server adapter joins this metadata to the public product catalog. Its admin key remains server-only. Old Medusa content is not automatically imported: migrate its display records and map IDs before expecting the same populated catalog.

## Customer accounts

Optional `/v1/customer-auth/register`, `/login`, `/me` and `/logout` support the existing Printerval email/password UI. Passwords use salted PBKDF2-SHA256; one-hour opaque sessions are stored hashed in the selected database. Customer authentication middleware also recognizes these sessions for customer routes. Expired session rows are cleaned by cron.

Old Medusa tokens and password hashes are not migrated or trusted. Existing customers need an explicit account migration/reset strategy before a production cutover. Halifruit authentication behavior remains unchanged unless password authentication is enabled explicitly.

## Checks

From the workspace root:

```powershell
rtk test node --import tsx --test apps/merchant/tests/stores.test.ts apps/merchant/tests/pancake-sync.test.ts
rtk test node --import tsx --test apps/merchant/tests/stores.runtime.test.ts
rtk test npx tsc --noEmit -p apps/merchant/tsconfig.stores.json
```

The runtime test launches a local Worker with isolated temporary SQLite/KV data and fixture credentials. It stops the Worker and removes only its own temporary directory. It never connects to a live POS shop or writes production data.
