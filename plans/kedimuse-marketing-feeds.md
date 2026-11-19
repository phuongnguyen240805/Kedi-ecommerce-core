# Marketing and discovery feeds

## Activation

Everything is opt-in per store. Leave sending disabled until sender/domain, consent text, privacy policy and recipient test are reviewed.

- `MARKETING_ENABLED=true` enables subscriber collection and automation planning.
- `MARKETING_POLICY_VERSION` is required; the browser submits the version it displayed. Changed versions require a fresh consent submission.
- `MARKETING_SEND_ENABLED=true` enables the separate marketing queue consumer.
- Reuse the existing scoped `MAILGUN_API_KEY` and transactional Mailgun helper. Optional `MARKETING_MAILGUN_DOMAIN` / `MARKETING_MAILGUN_BASE_URL` override only marketing delivery; existing transactional domain configuration is preserved.
- `MARKETING_FROM_EMAIL`, `MARKETING_CONTACT_ADDRESS`, `STORE_URL` (HTTPS), `STORE_PUBLIC_API_URL`, existing store-scoped `ORDER_TOKEN_SECRET` are required for delivery.
- `MAILGUN_WEBHOOK_SIGNING_KEY` is a separate secret from the Mailgun API key. Configure Mailgun events at `<store backend>/v1/marketing/mailgun`.
- Optional `MARKETING_WELCOME_DISCOUNT_CODE` references an existing active discount. Code eligibility/limits remain owned by checkout; no demo or invented coupon is created.
- Frontend `MARKETING_FRONTEND_ENABLED=true`, an actual `NEXT_PUBLIC_PRINTERVAL_PRIVACY_URL`, and existing Fufuni keys enable the reusable newsletter/popup. `MARKETING_RATE_SECRET` can override the server-side rate-key HMAC secret. Trust Cloudflare client-IP headers only behind Cloudflare and with `TRUST_CLOUDFLARE_HEADERS=true`.

## Subscriber and email state

Email normalization and a unique subscriber key prevent duplicates. Requested and confirmed consent records include purpose, source, policy version and timestamps. Double opt-in precedes marketing activation. Browser responses do not reveal whether an email already exists.

The durable queue stores a template version, dedupe key, lease, attempts, provider ID, delivery state and accepted time. It checks consent/suppression again immediately before sending. Known rate-limit rejection retries with backoff; permanent rejection becomes dead; network/unknown provider outcomes are not blindly resent. Mailgun events can resolve accepted/delivered outcomes and suppress permanent bounces/complaints. Event IDs and signature tokens deduplicate retries. A 24-hour signature window accommodates delayed delivery retries; no API key is used as a webhook signing key.

One-click POST unsubscribe is supported. Visiting a preference link alone does not withdraw consent. Tokens bind purpose/subscriber/store; browser-facing links keep tokens in the fragment and clear it after reading. A user explicitly confirms, withdraws or opens a saved cart.

## Automation

- Welcome queues once after confirmation, with the existing offer code only when configured and active.
- Abandoned cart uses server cart/checkout data, confirmed subscribers and a one-hour inactivity threshold. Expired carts are excluded. POD drafts last 24 hours; legacy carts retain their current expiry policy. A paid checkout or placed COD order cancels recovery, and send eligibility rechecks that state.
- Post-purchase follows delivery (including provider-independent POD delivery), not a browser success redirect.
- Win-back is deduplicated by subscriber and last paid order after 90 days without another paid purchase.
- Marketing is capped at three accepted/delivered campaign emails per recipient per rolling day, separate from solicited confirmation and existing transactional mail. The planner advances a durable subscriber cursor instead of starving subscribers beyond the first page.

Cart recovery validates email ownership via the signed link and cart/store identity before issuing a scoped cart cookie. POD recovery restores approved artwork and product/delivery draft; current quote/payment state still governs checkout. It never creates a second charge automatically.

Admin overview: `GET /v1/marketing/admin/overview` exposes subscriber/job counts and net attributed order revenue grouped by currency. The current model is last click within seven days. This is attributed revenue, not incremental lift; refunds are subtracted and canceled/refunded orders excluded. Advanced RFM/A-B/content drafting belongs to the next admin phase.

## Product feeds

Enable `FEEDS_ENABLED=true` only after reviewing public landing pages and offers. Admin `PUT /v1/feeds/admin/offers/:sku` supplies approved, factual brand/seller/variant/market/URL metadata. Canonical price, currency exponent and stock are read from Fufuni; POD availability requires a verified active mapping and a fresh availability declaration. Unknown or stale availability is never represented as confirmed stock. GTIN checksum and apparel/variant requirements are validated. No GTIN is invented.

- OpenAI hosted discovery URL: `<store backend>/v1/feeds/openai.jsonl`.
- Google Merchant Center hosted feed URL: `<store backend>/v1/feeds/google.xml`.
- Diagnostics: `GET /v1/feeds/admin/diagnostics`.

Both formats come from one transactional snapshot and preserve stable variant IDs and exact integer-money formatting (including VND exponent zero). Public output is streamed and bounded to 2,000 configured offers; exceeding this requires a paginated publisher rather than silent truncation. Invalid/unapproved offers are omitted and listed in admin diagnostics.

Feed endpoints do not prove external ingestion, approval, ads eligibility or OpenAI checkout access. Configure the hosted URLs in verified merchant accounts and inspect ingestion diagnostics there. OpenAI checkout eligibility stays false until a separately supported checkout integration is enabled and verified.

Migration `036-marketing-and-feeds.sql` is additive and is also initialized idempotently by the corresponding DO methods. Rollback disables collection/sending/feed flags while preserving consent, suppressions, jobs and payment data.
