# Commerce / Marketing follow-up — 20 November 2026

## Coordination and scope

Read the linked chat “Kiểm tra tiến độ KediMuse” (01a1f82a-efcf-7fa2-99dd-3ffba23d91ed). Its latest recorded work was Printify planning. While this release was running, new uncommitted Printify files appeared in the shared workspace. They were left untouched and were not staged by this release. MCP and R2/POD remain deferred. Do not interpret this report as Printify delivery or account acceptance.

## Changes shipped

- dfeff6c: shared checkout requires an explicit matching tax rule, including explicit zero-rate exemptions. Unsupported destinations still report unavailable; absent tax policy is never silently treated as zero.
- Marketing webhook ordering: late accepted/click/open events cannot erase delivery evidence, late delivered cannot reopen canceled jobs, terminal complaint/bounce suppression stays intact. Temporary failure can progress to delivered without suppressing a recipient.
- Frequency protection counts outstanding sends and unknown provider outcomes, not just completed sends. Unknown results are never automatically resent. Sending requires a webhook signing key and a store name before claiming jobs.
- Deployment accepts named marketing/feed/shopping settings through structured environment variables and a bounded allowlist. Single-line/boolean checks reject invalid configuration without partial writes. No values are interpolated as shell commands. Missing external-service config remains disabled.
- b174bc9: stock product search runs over the shared checkout catalog and dedicated checkout bridge without enabling MCP or POD. Optional OpenAI query interpretation uses existing per-client/store budget and must be configured and explicitly selected. It only returns keywords; prices/products remain database-authoritative.
- Frontend 9a8848e: /shop-assistant supports product search, current prices, explicit draft checkout selection and an unchecked AI opt-in when available. Same-origin BFF derives private rate keys; no raw credential, supplied price or caller-supplied rate identity reaches the browser. Review this product creates a draft only.

## Tests and deployments

Final backend CI: 178/178 merchant tests, typecheck, pinned ACP request and three actual response schema checks, 8 deployment tests, 2 commerce-settings tests and 7 Admin UI tests passed. Worker deployment run 44713333658 completed successfully for 467310e. Earlier stock-shopping deploy 44712767844 and Admin Pages run 44712768084 also succeeded. MCP run 44712767957 was skipped.

Frontend: 270/270 tests, typecheck/lint/boundaries, production OpenNext build and middleware manifest compatibility test passed. Eight Playwright browser scenarios passed, including physical search/draft creation and AI opt-in. Two timeouts occurred during a competing earlier test run; the unchanged full suite passed sequentially before release. Frontend commit 9a8848e deployed printerval version 8791ab6c-1e33-4ec6-84cf-b625e125a150. Frontend CI run 44713691489 completed successfully for 9a8848e.

Live smoke: /shop-assistant HTTP 200, typing/search responds through the real BFF/backend, no JavaScript errors observed. The empty result is accurate because the new merchant catalog still has zero configured stock offers. No paid order was created. /v1/checkouts/status reports Stripe configured and shopping_ai_available=false; marketing status disabled, policy null; POD disabled; shopping MCP and ACP return 404. No model or email provider was called by this production smoke.

## Configuration handoff

See plans/kedimuse-service-configuration.md for the exact Mailgun/Stripe/feed/payment setup steps. The user asked for Mailgun instructions and has not yet supplied sender domain, From address, approved consent policy/privacy URL, business contact address or test recipient. No such values were invented. Do not enable customer mail until those values, DNS verification and test delivery/suppression are accepted.

Remaining commercial acceptance: approved stock/catalog, delivery and tax data; full Stripe test payment with webhook; Mailgun account/domain and real delivery; OpenAI/Google merchant onboarding; legitimate bank transaction source and domestic POS/carrier mappings. Sample Pancake POD inventory remains isolated-test-only. Search UI deployment does not mean a configured catalog, live model, feed approval or production fulfillment.

## Final verification after CI completion

Rechecked the current production endpoints: frontend /shop-assistant HTTP 200; /api/checkout/status HTTP 200 with enabled=true, stripe_configured=true and backend_configured=true. Shopping AI remains unavailable until a supported model/key is configured. /api/marketing/status reports enabled=false and policy_version=null. POD production is disabled and shopping MCP returns 404. The frontend working tree is clean. This closes this release verification; service-account/merchant-data acceptance remains outstanding as described above. No payment, email or print submission was performed.
