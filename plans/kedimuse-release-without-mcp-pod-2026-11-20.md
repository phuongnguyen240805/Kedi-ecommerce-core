# KediMuse / Fufuni release — 20 November 2026

## Authorized scope

Continue commerce, payment, feeds and marketing with a test gate before each phase and push/deploy main. MCP and R2/POD are deferred. The owner confirmed the Pancake shirts are POD/sample data for checkout testing only: no production order, inventory deduction in POS, shipment or print submission is authorized by this test dataset.

## Delivered phases

1. Shared checkout readiness and Stripe reconciliation (600822d): authenticated paginated diagnostics explain missing prices, weight, stock and delivery; integration status exposes presence booleans, never secrets. The buyer can request reconciliation of a bound Stripe session using an owned browser cookie and same-origin POST. The server fetches Stripe status; unpaid never settles, foreign metadata is rejected, and only confirmed expiration releases holds. Calls are throttled per checkout. Unknown unbound creation outcomes remain manual reconciliation; no second payment is created by this endpoint.
2. Marketing shared-checkout recovery (2956dd8): confirmed, unsuppressed subscribers only; unknown/in-progress payment is excluded from abandoned-cart reminders. A recovery creates/replays a fresh web checkout using current prices and invalidates the old payable draft. Original and recovered paid states suppress queued mail. A dedicated subscribe-only bridge cannot read Marketing Admin. The frontend routes recovery to the isolated checkout cookie scope and excludes checkout/handoff pages from newsletter popups.
3. Stripe configuration verification (e3be49c): read-only GitHub Actions probe authenticates to Stripe, establishes test/live mode and verifies the configured endpoint has all three required events. Run 44705194735 succeeded in test mode. This does not prove the stored webhook signing secret matches a real delivery, nor does it constitute a completed payment.
4. Feed correctness (a3c8456): verified MPN and supplied return policy export, duplicate variant option/parent identity validation, and POD exclusion while POD is disabled. OpenAI checkout eligibility remains false. Publication/account/domain approval is separate from serialization tests.
5. Admin readiness (e193a6f plus pipeline fixes): read-only page /admin/launch-readiness shows SKU blockers and service gates. Existing Admin authentication is retained. Pages builds use locked workspace installs, the reusable commerce quality gate and a client-only build, rather than pulling MCP/inspector into deployment. Pages workflow run 44706872722 attempt 2 succeeded after enabling workflow hosting.
6. Catalog and sample VND regression (94a8c67, c6a652a): public checkout catalog excludes unavailable stock and POD mappings. The sample SKU P2779230218-BLA-S-MEN-UAt35gnn was tested entirely in isolated SQLite: reference price 453000 VND, reference weight 210g, synthetic delivery 30000 VND and zero test tax, resulting total 483000 VND. Shipping/tax values are test fixtures, not approved commercial policy. No external Stripe/Pancake/print-provider write occurred.

## Verification

Latest local backend gate: 173/173 tests; merchant TypeScript passed in the implementation phases. Frontend: 269 tests, 6 browser scenarios, modular types/lint/boundaries and OpenNext production build passed. Admin: 7 UI tests, TypeScript and production build passed. Deployment configuration: 8 tests; Stripe verifier: 4 tests; manifest compatibility: 1 test. Real ACP fixture schema validation runs in backend CI. RTK is used for compact logs, preserving actual process exit codes for release decisions.

Backend run 44707281236 deployed c6a652a successfully. Frontend commit 3a0d5f1 passed CI run 44705779776 and deployed printerval version 0417cf1f-337c-4ce8-938b-23b8f6db62bf. Admin quality/build/deploy run 44706872722 attempt 2 succeeded. Live browser smoke: Admin root HTTP 200 with no page JavaScript errors; storefront checkout visible, empty-catalog form disabled and no mobile overflow. Authenticated Admin operations have not been accepted with a real staff login.

## URLs

- Storefront: https://printerval.gofiber-phuongnguyen.workers.dev/commerce-checkout
- Backend: https://merchant.gofiber-phuongnguyen.workers.dev
- Admin hosting: https://phuongnguyen240805.github.io/Kedi-ecommerce-core/
- Admin readiness route requires the existing staff sign-in and admin:store permission.

## Observed production state and remaining work

- Stripe key/webhook variables present; mode test; API authentication and endpoint/events verified. A signature-forgery probe is rejected with HTTP 400. No completed test payment or real webhook delivery has been claimed.
- New merchant backend contains three legacy demo variants; zero meet shared-checkout readiness. Missing reasons: shipping weight, available stock and explicit currency prices. No sample data was inserted into production to bypass this gate.
- Existing storefront backend contains the shirt from the supplied screenshot: Black/S sample SKU above, 453000 VND, 210g, recorded available 70. This is not physical stock verification. Direct Pancake shop 715160501 API reads returned 404 using the locally configured key for 715159313. Do not switch shops or sync through deferred MCP. Require the correct direct API access or a reviewed export for an actual import.
- Marketing enabled/send flags remain false. Mailgun API/signing keys, consent policy version, sender and business contact address are absent. The owner must provide real settings/approved policy and verify delivery/bounce/unsubscribe before sending. No customer email was sent during this release.
- Feeds remain disabled pending real approved offers, landing pages/images, stock/price validity and merchant account/domain onboarding. A feed flag cannot grant OpenAI/Google access or ACP entitlement.
- Techcombank auto-reconciliation still requires a legitimate transaction source. Keep manual verification without it. Pancake/GHN/COD production actions require correct shop/warehouse/account mapping and settlement acceptance. International POD is never routed into domestic POS by this release.
- ACP handoff subset remains gated; delegated/direct complete unsupported. MCP, R2, POD artwork uploads and production submission stay deferred.

## Primary references checked

- https://developers.openai.com/commerce/specs/file-upload/products
- https://support.google.com/merchants/answer/7052112
- https://pos.pages.fm/developers/api/en/product
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
