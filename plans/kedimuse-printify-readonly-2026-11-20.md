# Printify read-only integration — 20 November 2026

## Scope and ownership

The owner selected option 1 in the progress chat: implement Printify connection, catalog, mapping checks and tests; defer R2, artwork uploads and real production submission. The other chat, “Đánh giá kế hoạch KediMuse”, owns checkout, marketing, payment, feeds and shared CI/deployment. This change does not edit those files or change deployment settings. Backend source remains this Fufuni checkout; verify the deployed commit and intended store before activation.

The existing POD client and fulfillment runner are retained. A separate GET-only client prepares the provider connection without invoking them. No migrations, customer data writes, provider writes, uploads, publishing, payment or production orders occur in the new endpoints.

## Delivered API

All routes inherit existing `authMiddleware` and `adminOnly` and return `Cache-Control: private, no-store`. They are deliberately registered before the POD activation middleware; configuring the read-only connection does not require `POD_ENABLED=true`.

Prefix: `/v1/pod/admin/printify`. For a named store, use the existing `/stores/<store-id>` prefix and credentials scoped to that store.

| Method and path | Result |
| --- | --- |
| GET `/connection` | Checks the configured shop against `/v1/shops.json`; returns only that shop, never other shops or the token. |
| GET `/products?page=1&limit=20` | Reads existing products in the configured Printify shop. Limit 1–50, page 1–10000. Returns numeric `next_page`; never follows provider-supplied pagination URLs. |
| GET `/products/:id` | Reads one product with blueprint, print provider, variant costs/enabled status and print positions. Artwork image payloads and arbitrary provider fields are stripped. |
| POST `/mapping-check` | Validates an existing `podMapping` JSON candidate against the live product: identity, variant, enabled state, cost, placement and cost-verification deadline. Returns reasons; does not persist or enable the mapping. |

Example mapping-check payload (replace with reviewed real values, including the deadline):

```json
{
  "product_id": "REPLACE_PRODUCT_ID",
  "variant_id": 101,
  "blueprint_id": 12,
  "print_provider_id": 2,
  "placement": "front",
  "min_width": 1000,
  "min_height": 1000,
  "countries": ["US"],
  "production_cost_minor": 1000,
  "cost_verified_until": 1,
  "minimum_margin_minor": 500,
  "tax_bps": 0,
  "tax_policy_ref": "REPLACE_WITH_REVIEWED_POLICY",
  "currency": "USD",
  "enabled": false
}
```

The deliberately expired example is not production-ready. `valid=true` establishes provider mapping consistency only. It does not certify currency/account billing, destination eligibility, artwork quality, retail price, tax, shipping, margin or live production readiness. `currency_verification_required=true`, `saved=false` and `production_enabled=false` describe this operation, not a global status probe. No catalog synchronization into Fufuni or automatic product activation is performed. Existing mapping persistence remains behind the POD activation gate for the later rollout.

## Configure when ready

1. Create a Printify API store and a server-side personal access token with the required shop/product read permissions. Obtain the real Shop ID from the account/shop list. Never put the token in storefront/public variables, source control or chat.
2. Set `PRINTIFY_API_TOKEN` through the existing per-store secret mechanism and `PRINTIFY_SHOP_ID` through per-store settings. Confirm the exact store and backend first; do not alter Halifruit credentials. This change does not install credentials or change GitHub secrets forwarding.
3. Keep `POD_ENABLED`, `POD_SUBMIT_ENABLED`, `POD_ACCOUNT_AUTOMATION_VERIFIED`, frontend POD activation and MCP activation off for this scope. R2 is unnecessary for these read-only operations.
4. With an existing authorized admin client, call connection, paginate products, inspect the selected product and submit a mapping candidate to mapping-check. Do not expose the backend admin key to a browser storefront.
5. Record selected product/variant/provider, measured cost and the verified billing currency. Future POD activation still requires artwork/R2, pricing/tax/destination review, paid-gate acceptance and a separately approved sample order.

## Verification commands

Run from `apps/merchant` using the locked installed dependencies:

```powershell
node --import tsx --test tests/printify-readonly.test.ts tests/pod-core.test.ts
$env:WRANGLER_LOG_PATH = Join-Path (Get-Location) '.wrangler\printify-logs'
$env:WRANGLER_SEND_METRICS = 'false'
node --import tsx --test tests/printify-readonly.runtime.test.ts tests/pod.runtime.test.ts
npm.cmd run typecheck
```

The new test files are not added to the shared CI workflow or package scripts because those are being changed by the other chat. Before shared release, include both Printify test files in its quality gate, review the combined diff, rerun that gate and verify the deployed commit. Do not assume deploying the other chat's commit automatically includes these uncommitted files.

Coverage: selected-shop access; pagination and fixed origin; credential redaction; redirect/error/oversized/malformed-response rejection; mapping drift; bounded invalid input; admin authentication and authorization; reads with POD disabled; checkout/catalog still blocked with POD disabled; existing paid-gate/idempotency and no stock/POS side-effect regressions.

Observed results: 20/20 Node/Hono and POD-core tests passed; 2/2 real local Workers runtime tests passed, including the existing SQLite/DO paid-fulfillment regression. Merchant TypeScript passed. Initial sandbox-only runtime attempts could not complete; the successful rerun used local runtime process permissions and workspace-local Wrangler logs. No live provider/account read or deployment was performed.

## Rollback and next handoff

Remove the `printifyAdmin` import and route registration in `routes/pod.ts` to withdraw the new routes; no data migration needs reversal. Retain existing order/artwork/fulfillment records and existing POD flags.

Next independent task: an authenticated Admin UI for connection/catalog/mapping candidates can consume these routes. Actual credentials and a read-only live connection acceptance remain external prerequisites. Resume artwork storage and production orchestration only when the owner re-enables that scope. Gelato/Merchize and MCP are outside this delivery.

Official contracts checked: https://developers.printify.com/ and https://developers.cloudflare.com/workers/runtime-apis/fetch/ .

## Production deployment — 20 November 2026

At the owner's explicit request, the local implementation over backend HEAD e5147b4 was deployed directly to the existing `merchant` Worker, preserving remote KV/DO bindings, plain variables and unrelated secrets. Only the two Printify settings were uploaded from the owner's ignored root `.env`. The temporary upload secrets file was removed afterward. POD activation/submission/account-verification flags remain false; MCP and R2 were not enabled.

Cloudflare deployment API confirms version `fb12e1d0-b955-450c-8a8f-789e734bacbf` active at 100%, deployment `94a1e573-939f-42f6-ab57-4dd184121191`. The 22 Printify/POD tests and merchant TypeScript passed before deployment.

Direct read-only Printify acceptance confirms shop 29834299, title Kedimuse, sales channel custom_integration. Production UCP discovery/catalog return 200 and POD status remains disabled/production_enabled=false. The local `.env` and `.dev.vars` contain the same merchant admin key, rejected by this production database with 401 Invalid API key. Consequently authenticated production connection/catalog acceptance remains pending a valid existing staff login or admin key; no keys or access rules were changed to bypass this condition.

Source changes remain local/uncommitted. Before any later CI deployment, include the Printify source files and tests in the repository release, otherwise an older repository checkout can remove these routes. Runtime secrets were verified present by name only.

## Admin credential recovery

The owner subsequently authorized a new Admin key. A 256-bit random key was generated locally and its SHA-256 hash added to the existing merchant/default `api_keys` table with role admin using the owner's authenticated Cloudflare account. Existing keys were retained. The fixed-operation recovery Worker required an unpredictable bearer capability, expired after 15 minutes, accepted no client-supplied SQL, and was deleted immediately after the operation. One key was added; no commerce records were modified.

The new key was verified against production GET `/v1/products?limit=1` (HTTP 200) and saved as `MERCHANT_SK` in the ignored root `.env`. The former root `.env` was preserved in the ignored `.wrangler/merchant-env-before-admin-recovery.backup`; older `.dev.vars`, storefront credentials, GitHub secrets and production secrets were not replaced. The raw key was never printed or committed.

Production Printify admin endpoints now pass Fufuni authentication but return HTTP 502 `printify_unavailable` / `Printify connection failed; retry the read later.` Provider transport/runtime diagnosis remains open. This is separate from the resolved 401 Admin-key issue; do not claim end-to-end Printify acceptance until the backend provider read succeeds.

## Printify transport fix and live acceptance

The 502 was resolved by invoking the injected/native fetch as a standalone function, instead of `this.transport(...)`, which supplies the client instance as the receiver. Native Workers fetch rejects that receiver. Previous arrow-function mocks masked the failure.

The runtime regression now uses the production compatibility date 2025-12-01 and a Proxy around actual Workers native fetch that redirects only the URL to a local HTTP provider fixture while retaining receiver semantics. It failed before the fix and passed afterward. The full 22-test Printify/POD gate and merchant TypeScript passed.

Deployed merchant version `d7e5025c-d8ac-4831-9f9f-987570101b0a` with the existing bindings/vars/secrets preserved. Live authenticated GET `/v1/pod/admin/printify/connection` returned 200, connected=true, shop 29834299/Kedimuse, sales_channel custom_integration, mode read_only. GET products returned 200 with zero products and next_page=null: connection acceptance is complete, product mapping acceptance still needs a real shop product. UCP discovery/catalog returned 200. POD status remained enabled=false and production_enabled=false. No provider write, artwork upload, payment or production order was performed.

## Admin UI continuation

Added `/admin/printify` behind the existing admin-store permission guard and a Printify navigation item. Uses the secured API client (no new token storage or public admin key). The page shows selected-shop connection, paginated catalog, enabled variants and a mapping-candidate check form. It requires explicit account USD confirmation, reviewed tax basis/reference, future cost deadline and a supported variant/placement; it does not save the candidate or submit orders. The displayed SKU is merchant context only; the current provider check does not prove Fufuni SKU existence. Print-file size defaults in the candidate are pilot values, not verified artwork quality.

The page gives an empty-catalog next step: add a product inside Printify My products and refresh. Live read-only recheck confirmed connection HTTP 200 and zero products. No provider product was created by this task.

Validation: six new UI scenarios passed (read-only load, empty catalog, sanitized failure, pagination, reviewed inputs/no-save, mapping drift). The entire existing Admin UI suite passed 14/14, client TypeScript passed, and the GitHub Pages production build passed. New UI test added to the shared UI test config while preserving the other chat's BankPayments entries. Route additions preserve its in-progress bank-payments route.

Admin UI is local and not deployed: the other chat is actively changing shared checkout/payment/marketing and release files. Do not publish that unfinished combined working tree from this chat. Include this page/navigation/route/test in the next coordinated Admin release after its gates pass. No new backend deployment is needed for these UI endpoints.

## Pre-R2 completion and activation runbook

The other chat completed and committed its checkout/payment release before this phase. This phase adds the remaining preparatory POD operations without enabling a production bucket, POD checkout, paid manufacturing or MCP.

Delivered:
- Disabled mapping drafts can be saved through Admin after a live provider mapping check and explicit USD billing confirmation. The Fufuni SKU must be active and have a positive explicit USD price. Saving cannot replace an active mapping. Mapping changes are transactional and audited. Admin now accepts reviewed print-file dimensions instead of fixed pilot dimensions.
- `/admin/pod-operations` shows storage/provider/signing/Stripe/activation readiness, authenticated actual artwork previews, reviewed approval/rejection with evidence, and fulfillment exceptions. Artwork cannot be reviewed after its cart enters checkout. Review does not certify merchant tax/account eligibility.
- Rejected artwork loses approval; invalid/expired carts cannot upload; a failed metadata insert removes the just-uploaded object to avoid an orphan. No automatic deletion of paid artwork or fulfillment history is performed. Retention beyond failed-upload cleanup remains an operational policy decision.
- Printify manufacturing transport now uses the corrected native fetch invocation too. Fulfillment distinguishes pending, production, partial shipment, delivered, issues and canceled states. Known provider orders can continue read-only reconciliation under the submit kill switch; ambiguous submits never trigger a blind second create. Unknown/unhandled provider states require review. There is no automatic provider cancellation, refund or provider switching.
- Frontend POD requires separate server-only `POD_BACKEND_URL` and `POD_ADMIN_KEY`; it no longer silently uses the older Fufuni storefront backend/store. Keep existing `FUFUNI_BACKEND_URL`/keys for the regular storefront. POD form preserves its delivery draft across payment return, locks the frozen details after checkout creation and prevents starting an empty-catalog order.
- CI runs `npm run test:pod:ready --workspace merchant`, using local Worker/DO/SQLite/R2 and injected Stripe/Printify fixtures only. No test/debug routes or fixtures are mounted in production.

Acceptance evidence before release:
- Backend regression 191/191; POD readiness suite 28/28 (overlapping coverage, not additive unique counts).
- Frontend modular suite 274/274, types/lint/module boundaries and production Next build passed. Browser suite 17/17, including approval gate, payment return with restored address, completed tracking, empty catalog and domestic checkout regressions.
- Admin suite 18/18; client TypeScript and production Pages build passed.
- Full HTTP E2E uploads a real PNG to local R2, previews it with Admin auth, rejects/approves it, verifies quote totals, rejects changed total/unpaid/wrong amount, settles repeated paid callbacks exactly once, creates one mock provider order, polls production/delivery, retrieves the identical bytes from the signed URL, rejects bad tokens and foreign cart order access. Stripe is simulated at the provider boundary; no real Stripe Sandbox payment is claimed.

### Prepare product data now

Create/select a real product in the Printify API shop, then a matching real Fufuni USD SKU. Do not use Pancake POD sample stock as physical inventory. Select blueprint/provider/variant/placement in Admin, supply reviewed tax reference, allowed destination, cost deadline, file dimensions and margin, and save a disabled mapping draft. The current live Printify shop is empty, so acceptance of a real product remains pending merchant data. Do not create placeholder commercial data to claim readiness.

### Activation after the owner enables R2

1. Bind a private R2 bucket as `IMAGES` to the merchant Worker (use existing per-store R2 namespacing for named stores). Match Worker/account/store and preserve all existing KV/DO/bindings. Never enable R2 remote bindings for the local test suite.
2. Confirm `ORDER_TOKEN_SECRET` is at least 32 characters, `STORE_PUBLIC_API_URL` resolves to the same merchant/store and frontend `POD_BACKEND_URL` points there. Set frontend `POD_ADMIN_KEY` to a valid admin key for that store, server only. Keep `POD_INTERNATIONAL_ENABLED=false` until readiness acceptance.
3. Review account production automation, billing currency/funding, provider access scopes, actual costs, tax/destination policy, sample order approval and print-file quality. Add write/order permissions only when manufacturing is authorized; the current read-only provider token is not assumed sufficient for quote/order creation.
4. In staging only, enable `POD_ENABLED=true`, bind storage, activate the reviewed mapping, and enable frontend `POD_INTERNATIONAL_ENABLED=true`. Leave `POD_SUBMIT_ENABLED=false` and `POD_ACCOUNT_AUTOMATION_VERIFIED=false`. Upload and review a genuine print-ready PNG; test expired/foreign URLs and preview. Confirm Printify can download the signed artwork URL from its side.
5. Run a real Stripe Sandbox checkout and real signed webhook acceptance with the correct shop/amount/currency. Local mocks are not evidence of that account-level acceptance.
6. Approve one paid manufacturing sample before enabling both `POD_SUBMIT_ENABLED=true` and `POD_ACCOUNT_AUTOMATION_VERIFIED=true`. Verify physical print quality and delivery/tracking. Expand SKU/country coverage only after successful acceptance.

### Stop and recovery

Set `POD_SUBMIT_ENABLED=false` to stop fresh submissions while keeping `POD_ENABLED=true` for polling already-attempted known orders. `submission_unknown` with no external ID needs reference reconciliation/operator review; do not clear `attempted_at`, create another provider order, switch providers or refund solely because of a timeout. Canceled/issues/partial fulfillment require human assessment and payment handling. Roll back UI/code while retaining all orders, artwork records, payment receipts, audits and fulfillments.

The target is code/test readiness before R2; final commercial acceptance still requires real products, storage, real Stripe events and an approved physical sample.

### Release status at handoff

All above code remains local in the backend and frontend checkouts. The attempted main-branch commit/push was stopped before execution by the automatic approval reviewer because it could trigger production deployment and required explicit release authorization. Neither repository was committed/pushed by this phase. Owner confirmation for pushing both repositories and deploying CI was requested; MCP, R2 and manufacturing will remain disabled even if release is authorized.

A final status inspection also observed new in-progress edits to product-feeds.ts and routes/acp.ts, checkouts.ts and feeds.ts from concurrent work. These are outside this POD change and must not be staged or overwritten by its release. Recheck combined CI gates on the exact revision being published.
