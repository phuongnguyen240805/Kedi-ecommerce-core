# Shopping and marketing administration delivery

Source: D:/monorepo-project-workspace/fufuni. Backend destination: phuongnguyen240805/Kedi-ecommerce-core. Frontend destination: phuongnguyen240805/kedimuse-fe.

## Shopping pilot

The store-scoped /v1/shopping/mcp endpoint uses stateless MCP Streamable HTTP and a dedicated SHOPPING_MCP_TOKEN (minimum 32 characters). It is intended for a trusted connector; it does not implement public-client OAuth or claim OpenAI marketplace approval. Origin headers are checked, requests are bounded, and each request receives a new server/transport instance. Tools: search_products, get_product, create_cart, get_cart, update_cart, prepare_checkout. No payment, refund, paid-status or production tool is registered.

Only approved canonical offers are searchable. The provisional cart supports one USD POD SKU, quantity and destination; signed capabilities bind purpose, expiry and store. It is a selection, without inventory reservation or a guaranteed quote. Checkout returns a one-use, 10-minute handoff to the merchant frontend. Its token stays in the URL fragment and is cleared on load. Redemption requires a buyer click; DO transaction consumption prevents replay. The buyer starts the real checkout, approves artwork and confirms the final live quote before Stripe payment. Existing custom-order drafts are preserved when another selection arrives.

Backend store settings: SHOPPING_ENABLED, SHOPPING_AI_ENABLED, SHOPPING_AI_MODEL. Secrets: SHOPPING_MCP_TOKEN, SHOPPING_OPENAI_API_KEY and existing ORDER_TOKEN_SECRET. AI model must be supplied explicitly and support Responses structured output. AI only extracts search keywords; it cannot set IDs/prices or execute purchases. Bounded response, timeout, no tools, store:false. Durable quota: 10 AI requests/client/hour and 200/store/day, shared with marketing draft protection.

Frontend settings: SHOPPING_FRONTEND_ENABLED, SHOPPING_AI_FRONTEND_ENABLED, POD_INTERNATIONAL_ENABLED; server-only FUFUNI_BACKEND_URL and FUFUNI_ADMIN_KEY must target the intended store. SHOPPING_RATE_SECRET may be set separately; otherwise a sufficiently long admin key supplies the HMAC key. TRUST_CLOUDFLARE_HEADERS is opt-in only behind the verified proxy. New routes: /ai-shopping and /shopping-handoff. Keep flags off until merchant configuration is verified.

## Marketing administration

/admin/marketing is guarded by the existing admin permission. The dashboard reads consent/queue counts, last-click revenue, 365-day RFM metrics and experiment reports. RFM includes active confirmed subscribers without suppression. Recency/frequency segments are descriptive (loyal, recent, active, at_risk, prospect); monetary value remains a separate net value per currency, not an invented cross-currency score. Pagination is by customer, keeping their currencies together.

Revenue excludes unpaid COD and orders without the existing Stripe paid-order binding or confirmed commerce payment. Successful refunds subtract only in the order currency. Attribution is last click within seven days, not incremental causal lift. Mailgun click tracking must be enabled and its signed clicked webhooks configured before attribution can be populated. No opening-rate conversion proxy is used as revenue.

An admin can publish one active A/B experiment per automation, with two reviewed subject/text variants. A subscriber is randomly assigned 50/50 once per experiment and retains their variant. Each new job freezes the experiment and copy in its payload. Pausing stops new assignment, preserving queued jobs and audit/report history. Confirmation messages never enter experiments. Existing consent, suppression, send caps and unknown-delivery rules remain enforced. This is subject/body A/B testing, without an automatic winner or statistical significance claim.

Optional MARKETING_AI_ENABLED + MARKETING_AI_MODEL and store secret MARKETING_OPENAI_API_KEY enable copy suggestions. Briefs contain merchant product context only. The model receives no customer/order list and returns schema-validated subject/text. The draft is not saved as an active experiment and does not send email. Human review and the explicit publish action are required. Existing MARKETING_SEND_ENABLED remains the global send gate.

Migration 037 adds experiment/assignment tables. DO initialization applies them idempotently for existing stores; rollback preserves consent/jobs/assignments/financial data.

## External activation and limits

- New repository CI quality passed for d2f3261. Deployment is blocked by repository credentials; successful Git push is not proof of production deployment.
- Configure Cloudflare deployment target and repository secrets in GitHub settings, never in chat. Existing core workflow requires CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and a CRYPTOKEN of at least 32 characters; runtime store configuration/secrets are also required.
- No trusted Techcombank transaction source has been provided. QR remains manually verified; no client event marks a bank payment paid. Domestic COD/QR and international POD remain separate order routes.
- Live Printify account/cost/tax/artwork/sample acceptance, Mailgun sender domain/webhook/click tracking, merchant feed registration/ownership, and live payment checks require the merchant accounts and configuration. No paid/provider/email operation was performed during tests.
- OpenAI embedded checkout/ACP entitlement is not established. The supported implementation here is external merchant checkout handoff; it does not advertise feed checkout eligibility. Do not implement raw-card/delegated-payment behavior or declare ACP conformance based only on these MCP tools.
- The existing UCP protocol declaration has not been upgraded to full conformance against the latest specification; the delivered payment correctness fixes and shared Stripe service are narrower in scope. Mixed carts, multiple POD print placements and automatic editor-to-print export remain outside this pilot.

Primary references checked 2026-11-19:
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://developers.openai.com/api/docs/guides/structured-outputs
- https://developers.openai.com/commerce/guides/build-a-plugin
- https://developers.openai.com/plugins/build/monetization
- https://ucp.dev/latest/specification/checkout/
