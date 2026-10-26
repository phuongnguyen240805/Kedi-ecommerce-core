# Halifruit Smart Shipping

The merchant now has a GHN quote adapter and a provider interface for adding
other carriers. It requests available service types, fees and estimated delivery,
marks estimated delivery against the shop/customer preferred time and recommends
the lowest carrier fee. `delivery_deadline_mode="strict"` excludes late results;
`"preferred"` keeps them selectable with `meets_delivery_deadline=false`.
The current production implementation has only GHN; it does not compare carriers
connected exclusively inside Pancake. No shipment is created by quoting.

## Configuration

Set the private backend environment (and Cloudflare secrets for deployment):
`GHN_TOKEN`, `GHN_SHOP_ID`, `GHN_FROM_DISTRICT_ID`, `GHN_FROM_WARD_CODE`,
`GHN_ENVIRONMENT` (`production` or `staging`), `SMART_SHIPPING_POLICY`, then
`SMART_SHIPPING_ENABLED=true`. A Pancake key or OTP cannot replace the GHN token.
The policy example in `.env.example` is an example, not measured warehouse data.

The policy defines `version`, `max_delivery_hours`, `delivery_deadline_mode`, `subsidy_vnd`, optional
`free_shipping_from_vnd`, optional `allowed_district_ids`, and a measured parcel
profile (`length_cm`, `width_cm`, `height_cm`, `max_weight_g`,
`packaging_weight_g`). The shipping weight equals POS variant weight × quantity,
plus profile packaging weight. If POS weights already include packaging, keep
profile packaging weight zero to avoid double counting. POS `weight` is synced
into `variants.weight_g`, rounded up to whole grams. Missing weight stays unknown
(zero) and blocks automatic quoting.

The initial adapter uses one parcel profile. Multi-parcel packing and automatic
selection between package sizes are not implemented. Keep the profile capacity
appropriate to its measured dimensions. Fees and estimated dates are estimates
from GHN; final carrier fees can change if actual parcel measurements differ.

## API

All endpoints require the existing Bearer API key; responses are `no-store`.

- `GET /v1/shipping/status`: readiness without exposing secrets.
- `GET /v1/shipping/ghn/locations?level=province|district|ward&parent_id=...`:
  selected GHN address fields. Fee APIs use GHN district/ward IDs; POS IDs are not
  interchangeable. This lookup explicitly uses GHN's district/ward address model.
- `POST /v1/shipping/quotes`: body `{cart_id,destination:{district_id,ward_code},
  payment_method:"prepaid"|"cod",deliver_by?}`. Returns eligible quotes, recommended
  option and structured warnings. Fees, prices, weight and parcel size cannot be
  submitted by the browser. In preferred mode, the shop/customer time is a target
  rather than a guarantee; late offers are selectable with a warning. Strict mode
  excludes late offers. The current shop policy uses a 48-hour preferred target.
- `PUT /v1/shipping/carts/:cartId/selection`: `{quote_id,option_id}`. Persists only
  an option in that cart's still-valid quote, updating authoritative cart fees.
- `GET /v1/shipping/carts/:cartId/selection`: active selection; stale fees clear.
- `DELETE /v1/shipping/carts/:cartId/selection`: clear quote selection.
- `GET /v1/shipping/carts/:cartId/pos-handoff`: admin-only handoff preview with
  service type, fees/subsidy/COD and destination. It is not a POS order-push API.

Quotes expire in five minutes. Cart contents, current catalog prices, stock,
weight, region, existing cart address or discount changes invalidate selection.
Policy/account/origin/environment changes invalidate the policy key. The backend
checks again when selecting, after carrier network I/O, and when reading cart
fees. A Durable Object transaction makes these comparisons and fee writes atomic.
GHN COD fee calculation includes customer shipping and is re-quoted to a stable
amount; it fails explicitly if convergence is not achieved.

The carrier fee, shop subsidy and customer fee are separate VND integer amounts.
Errors do not expose carrier bodies, tokens, addresses or raw requests. There is
a 10-second quote cooldown per cart plus existing endpoint rate limiting.
No mock carrier or static free-fee fallback runs in production.

## Frontend and order scope

The Halifruit cart has a Smart Shipping panel: GHN area selection, desired delivery
deadline, payment intent, quote results and automatic cheapest eligible selection.
Only server responses supply fees. The panel marks staging and expires quotes.
The frontend BFF retains all API credentials server-side.

This phase computes and stores shipping; it does not accept payment or create a
VN order. Existing Stripe checkout rejects carts carrying a dynamic selection,
so it cannot silently replace the chosen quote with static Stripe shipping rates.
The subsequent VN checkout/order phase must validate/freeze the selected quote
inside the order transaction, reconcile taxes/discounts, and push the exact GHN
service into Pancake. Pancake remains the shipment owner; the engine does not
also create a GHN label. POS auto-cheapest must not override a service already
promised by Fufuni without an explicit re-quote/reconfirmation flow.

## Validation and sources

Run `npm run test:shipping` and `npm run test:pancake`. Tests cover price/SLA
selection, subsidy boundaries, COD iteration, cart races, expiry, policy mismatch,
provider partial failure, request tampering, and redacted error handling, using
mock GHN responses and real in-memory SQLite. They do not prove real contract fees.
Local Workers runtime checks pass for API authentication, strict quote input,
cart reads and shipping RPCs, including a fresh database without shipping tables.
The Worker was deployed to `halifruit-backend`; real quotes remain unverified
because direct GHN credentials/origin/policy are incomplete and Cloudflare reports
an exhausted Durable Objects Free daily write quota. Remote checks return a
controlled `503 database_write_limit`, rather than exposing the storage error.

POS sync now skips unchanged catalog/inventory rows and detects removed entries
against complete snapshots without rewriting every link's scan token. The
deployment cron runs hourly. An identical snapshot test changes only completion
metadata; the lease adds its own metadata write. Existing stock reservations are
preserved. This reduces writes but cannot restore already exhausted daily quota
or guarantee a free-tier budget for every traffic/sync workload.

Cloudflare's Free SQLite allowance is 100,000 rows written/day and resets at
00:00 UTC (07:00 Vietnam). See
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

Official GHN documentation:
- [Available services](https://developer.ghn.vn/vi/docs/master-data/get-service)
- [Calculate fee](https://developer.ghn.vn/vi/docs/order/calculate-fee)
- [Lead time](https://developer.ghn.vn/vi/docs/order/leadtime)
- [Token](https://developer.ghn.vn/vi/docs/token/get-token)
- [Ward codes](https://developer.ghn.vn/vi/docs/master-data/get-ward)

GHN uses `service_type_id` for fee/leadtime, not legacy `service_id`. Current types
2 (under 20kg) and 5 (20kg or more) are filtered according to shipment weight.
