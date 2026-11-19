# POD pilot operations

The first connector targets Printify v1. Catalog/quote/submit/get/list are implemented against its official API. Gelato and Merchize remain separate future adapters; this pilot does not manufacture products through them.

## Store configuration

Keep flags disabled until merchant acceptance. Configure per store using the existing store settings/secrets mechanism:

- `POD_ENABLED=true`: enable admin/BFF POD APIs.
- `PRINTIFY_SHOP_ID`: the merchant's API shop, with USD production billing verified.
- `PRINTIFY_API_TOKEN`: secret, server only; never a public setting.
- `STORE_PUBLIC_API_URL`: public backend URL including `/stores/<id>` for non-default stores. Used for signed artwork delivery in the scheduled consumer.
- Existing `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ORDER_TOKEN_SECRET`, `STORE_URL`, scoped R2 `IMAGES`, and cron.
- `POD_SUBMIT_ENABLED=true` and `POD_ACCOUNT_AUTOMATION_VERIFIED=true`: only after approving the Printify shop's automatic-production settings, funding, sample print, costs and delivery. An API order may be manufactured automatically depending on the provider's account configuration.

Frontend: `POD_INTERNATIONAL_ENABLED=true`, existing Fufuni admin/public keys, and cart-cookie signing secret. The page is `/pod-checkout`; the regular cart entry appears only when both layers enable it. POD uses a separate signed cookie and does not replace the regular cart.

## Setup and acceptance

1. Create genuine USD Fufuni products/variants and prices. Admin PUT `/v1/pod/mappings/:sku` supplies Printify product/variant/blueprint/provider, placement, dimensions, countries, USD cost verification deadline, minimum unit margin, and reviewed tax policy/basis points. No global tax rate is invented by code.
2. The provider product is checked for blueprint/provider/variant and current manufacturing cost during quote and again before submission. A mismatch blocks manufacturing. Retail prices always come from Fufuni.
3. Customer uploads PNG to scoped R2. Bounded structural PNG/CRC validation, checksum and immutable artwork ID are persisted. This does not replace visual, rights or print-quality review.
4. An authorized merchant reviews the actual file and POSTs `/v1/pod/artworks/:id/approve` with traceable evidence. Production remains blocked before this approval.
5. Quote uses live Printify standard shipping and explicit merchant tax policy. It expires after ten minutes. One confirmed checkout is allowed per POD cart, with exact amount confirmation.
6. Stripe webhook must verify paid/amount/currency/session before atomic order/items/receipt/outbox and POD fulfillment creation. No stock reservation/deduction or Pancake mirror is used for this POD path.
7. Cron polls queued/accepted/shipped/unknown fulfillments. Claim is persisted before I/O. Timeout after create only reconciles by external ID/reference; it cannot blindly issue a second order-create POST. `needs_review` requires merchant action.
8. The customer can inspect payment/fulfillment and tracking from the same signed POD cart. Returning from Stripe is never evidence of payment.

## Limits that must remain visible

- Pilot UI supports one SKU/one front-or-back print file per custom order. It does not silently reinterpret local demo product IDs as real SKUs or product preview images as print-ready artwork. The editor's exported print file is uploaded explicitly. Multi-design/mixed fulfillment and additional providers are not claimed complete.
- Live catalog credentials, account entitlement, tax policy, sample manufacturing, international settlement eligibility, provider balance and real delivery have not been verified by mock tests.
- Provider cancel/refund/dispute exceptions require merchant handling. Never refund based solely on a provider timeout, automatically switch provider after acceptance, or reset `attempted_at` to force a new submission.
- Kill switch stops new submits. Keep polling/reconciliation available through operational tools; do not delete in-flight fulfillment records or migrations on rollback.

Migration `035-pod-core.sql` is additive; tables also initialize idempotently through DO methods. Tokenized artwork URLs last seven days and are restricted to the artwork/checksum/store. Operate an external review process until an authenticated review UI is delivered.
