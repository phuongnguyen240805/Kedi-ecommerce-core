# KediMuse marketing lifecycle — 22/11/2026

## Scope and coordination

Backend: `Kedi-ecommerce-core` (Fufuni checkout). Frontend: `liora-monorepo/tmp/kedimuse-implementation/kedimuse-fe`.
The older `D:/workspace/kedimuse/kedimuse` is not the source used for this implementation.
Existing shipping notes, FE tsconfig/next-env changes and concurrent payment/inventory work are outside this release. No feature flags, service credentials, customer records or provider accounts were changed by this task.

## Delivered phases

1. Subscriber: checkout is a distinct consent source; newsletter consent remains explicit, versioned and double opt-in. Contact email is not marketing consent. FE preserves meaningful backend status codes, ownership rejection and expired-link guidance.
2. Delivery engine: durable queue, confirmation priority, configurable bounded batch (1–50), per-recipient daily cap (1–3), optional cooldown and a bounded runner time window. Lease expiry cannot authorize a send. HTML/text templates have lifecycle-specific CTAs and escaped content. Ambiguous outcomes remain unknown, never automatically resent.
3. Welcome: confirmation creates one welcome per confirmed subscription nonce. Existing active coupon is optional; checkout owns eligibility. Mailgun acceptance and the confirmation link are exercised through the actual sender helper with a mocked transport.
4. Abandoned: save contact before entering delivery details; checkout draft only, no subscription or charge. Explicit cart-to-checkout linking transfers reminder ownership. Same-origin BFF validates ownership for contact changes. Current price/stock/tax/shipping are checked on recovery. Legacy recovery additionally checks active consent, suppression, expiry and paid/linked-cart status.
5. Post-purchase: delivered observation schedules follow-up after 3 days by default. Paid eligibility is checked, unpaid COD excluded, successful refunds excluded, and order status is rechecked before sending. This is marketing follow-up; existing transactional receipts and shipment notifications remain separate.
6. Win-back: default 90-day threshold, latest qualifying order, dedupe per subscriber/order, fresh-purchase invalidation before I/O. Changed delays postpone valid pending jobs rather than permanently consuming their dedupe key.
7. Operations: Admin automation policy, individual campaign switches, queue filtering/pagination, overdue and needs-attention counts, cancel/retry decisions with evidence and durable audit. Unknown/sending/accepted/delivered email cannot be manually retried. Only explicitly rejected `dead` jobs can be requeued and must pass eligibility again.

## Policy

Admin UI: `/admin/marketing`, section **Vận hành automation**.

`GET /v1/marketing/admin/settings`

`POST /v1/marketing/admin/settings` (Admin only; submit full policy when preserving existing settings):

```json
{
  "welcome": true,
  "abandoned": true,
  "post_purchase": true,
  "win_back": true,
  "abandoned_after_hours": 1,
  "post_purchase_after_days": 3,
  "win_back_after_days": 90,
  "daily_cap": 3,
  "cooldown_hours": 0,
  "batch_size": 10
}
```

Policies live inside each store DO, so account settings do not leak across tenants. Migration `038-marketing-lifecycle.sql` is additive and initialized idempotently by `marketingInit`. No existing customer/order table is reset.

Queue: `GET /v1/marketing/admin/jobs?state=unknown&cursor=...`; up to 51 rows, display 50 and use the last displayed ID as the next cursor.

Decision: `POST /v1/marketing/admin/jobs/:id/decision` with `{"action":"cancel","evidence":"Reason of at least ten characters"}` or `retry_rejected` for a dead job after fixing a known provider rejection. Unknown jobs require provider/webhook investigation; cancellation does not undo delivery.

## Verification

- Targeted lifecycle/checkout/admin business logic: **59/59 passed**, including 90-day boundary, new purchase after claim, refunds, delivery delay, changed policy delays, leased-send suppression, sender 200/400/429/500, timeout, stale nonce/lease, unknown retry rejection and cursor pagination.
- Final full merchant regression: **220/220 passed**, including the scheduling refinement and all Worker runtime scenarios.
- Worker/DO HTTP test passed with Admin/BFF isolation, settings persistence and jobs endpoints.
- FE full regression: **327/327**, 70 suites. Includes the additional API test for explicit checkout subscription and owned contact updates.
- Admin regression: **20/20**, 8 suites; no auto-publication on load, unknown-job retry unavailable.
- Merchant, Admin and FE modular TypeScript passed; FE boundaries and affected-file ESLint passed.
- Production-mode Next build passed in `.next-marketing-acceptance`, separate from the existing dev outputs. A `.test` privacy URL was used only in this test build; it is not a deployed policy URL.
- Browser: **19/19 passed**, including explicit checkout consent, email confirmation, early contact capture without subscription/payment, recovery, Stripe/QR and POD regression. Mobile screenshot: `liora-monorepo/tmp/kedimuse-implementation/kedimuse-fe/marketing-checkout-mobile.png`.

Tests use fixture data and mocked Mailgun. They do not prove DNS, real Mailgun acceptance/delivery, mailbox rendering or customer revenue.

## Activation prerequisites and procedure

Required owner-supplied information: owned sending domain, verified From identity, real business contact address, public privacy URL, approved consent policy version and designated test mailbox.

Backend secrets: `MAILGUN_API_KEY`, `MAILGUN_WEBHOOK_SIGNING_KEY`, store-scoped `ORDER_TOKEN_SECRET` and `MARKETING_BFF_TOKEN`. FE server secret `FUFUNI_MARKETING_BFF_TOKEN` must match the backend bridge; never expose it as `NEXT_PUBLIC_*`.

Backend settings: `MARKETING_MAILGUN_DOMAIN`, optional region-specific `MARKETING_MAILGUN_BASE_URL`, `MARKETING_FROM_EMAIL`, `MARKETING_CONTACT_ADDRESS`, `MARKETING_POLICY_VERSION`, `STORE_NAME`, HTTPS `STORE_URL`, correct tenant `STORE_PUBLIC_API_URL`.

FE: `MARKETING_FRONTEND_ENABLED=true` and real `NEXT_PUBLIC_PRINTERVAL_PRIVACY_URL` at build time. Existing checkout ownership cookie secret remains required for early contact and recovery.

1. Verify domain/DNS using values provided by Mailgun. Configure signed events at the correct tenant `/v1/marketing/mailgun`.
2. Deploy backend/Admin/frontend from reviewed marketing commits together, preserving current production bindings and concurrent payment fixes.
3. Keep sending disabled until the designated mailbox and sender details are available. Test confirmation delivery and welcome only, using an isolated test store/canary to prevent contacting existing subscribers.
4. Verify actual accepted/delivered webhooks, confirmation action, welcome, plain text/HTML and one-click unsubscribe. Verify permanent bounce/complaint suppression using provider-supported test facilities.
5. Enable abandoned, post-purchase and win-back one at a time after the respective fixture/real test flow is accepted. Check queue backlog and unknown/dead jobs.
6. Keep financial/POS/Printify actions out of mail testing; no email action creates a payment automatically.

## Limits and rollback

- Mailgun real delivery and production activation remain pending owner configuration; no customer email was sent.
- A single reminder per cart/checkout journey; a single post-delivery follow-up per order; a single win-back per last qualifying order. Multi-message drip campaigns are outside this first release.
- Delivery delay begins at the first planner observation for an active subscriber; historical delivery timestamps are not fabricated.
- A successful refund suppresses this release's order-driven campaigns, including partial refunds, conservatively.
- Scheduled planning visits 200 subscribers/run and the queue sends a bounded batch every configured cron interval. Monitor backlog before increasing volume; no unlimited publisher was added.
- Rollback: disable `MARKETING_SEND_ENABLED` first, then individual campaign switches/collection as needed. Preserve consent, suppression, audit, queued outcomes and order/payment data. Already-sent email cannot be recalled; webhook processing/unsubscribe should stay available.
