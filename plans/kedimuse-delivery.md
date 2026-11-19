# KediMuse implementation ledger

Target repositories: `Kedi-ecommerce-core` (backend, source folder `D:/monorepo-project-workspace/fufuni`), `kedimuse-fe` (frontend, explicitly confirmed).
Date: 2026-11-19. Changes are delivered in independently validated commits to main.

| Phase | Scope | Status |
|---|---|---|
| 1 | UCP/payment transaction correctness and regression gate | Implemented; local quality gate passed |
| 2 | One POD provider, international checkout, durable fulfillment | Pilot implemented; live merchant/sample acceptance pending |
| 3 | Subscriber/consent, email queue/automation and product feeds | Implemented; local gates passed; sender/feed account activation pending |
| 4 | Shopping MCP, AI shopping and safe checkout handoff | Pilot implemented; frontend local gates passed and pushed; external connector activation pending |
| 5 | Marketing admin/RFM/A-B/AI, reconciliation and enabled OpenAI integration | Marketing admin implemented and under validation; bank automation/manual fallback and external OpenAI access remain conditional |

## Phase 1

- Additive tables for payment attempts, receipts and durable paid-event outbox.
- Freeze the Stripe request before I/O, include quoted tax/shipping, reuse idempotency key, and stop blind retries beyond its safe retention window.
- Atomic UCP order/items/stock/payment receipt/outbox/session write in the owning store DO.
- Require paid status, exact amount/currency and payment binding; handle delayed successful Checkout payments.
- Preserve existing QR/COD business logic; UCP stock settlement does not release another cart's stock reservation.
- Correct existing merchant compile contracts for Stripe type aliases, response creation timestamp, DB/context types and refunds.
- Merchant quality workflow is required before the existing main-triggered deployment build.

Migration `034-ucp-payment-core.sql` is additive and also initialized idempotently by payment RPCs for existing stores. Existing UCP Stripe sessions can settle against their stored session binding; new sessions use immutable attempts. Never remove receipt/outbox data on rollback.

Paid-event consumers and POD routing arrive in phase 2. Phase 1 does not claim live provider production, bank transaction access or OpenAI checkout entitlement. A paid transaction rejected for inventory/schema/amount conflict must be reconciled by operations; do not retry a charge or silently manufacture a new order.

Rollback: disable entry to affected UCP checkout and roll forward a compatible fix; retain the additive tables and in-flight Stripe session mappings. Do not roll back to the known broken UCP order INSERT for already-collected payments.

Validation: 76 tests including 3 Worker/DO runtime cases; merchant TypeScript check passed. No live bank/provider transaction was performed.

Phase 2 local gates: 86 backend tests (including Worker/DO), merchant typecheck; frontend 255 tests in 56 suites, modular typecheck/boundaries/lint, production build, mocked Chrome checkout/mobile regression. Live flags remain unconfigured. CI phase 1 revealed an omitted package typecheck script; phase 2 adds it and installs only the merchant/root workspace for its gate.

Phase 3 local gates: 97 backend tests including marketing/feeds Worker/DO; frontend 260 tests, typecheck/boundaries/lint, production build, two mocked browser scenarios. Backend phase 2 GitHub quality gate succeeded; deploy is blocked by missing CLOUDFLARE_API_TOKEN/ACCOUNT_ID and empty CRYPTOKEN in repository secrets. Deployment preflight now fails before producing secret artifacts. User has been asked to configure secrets via GitHub, not chat.

## Backend source correction

User selected D:/monorepo-project-workspace/fufuni as the authoritative backend folder and will create a separate GitHub repository. Further pushes to Kedi-ecommerce are stopped. Existing local Commerce/Shipping/Admin edits were snapshotted and merged with delivered payment/POD/marketing/feed changes and the in-progress shopping implementation. The new repository URL is pending; do not infer or replace origin before it is supplied.

Merged-source validation: phase 1–3 regression passed 138 tests; shopping MCP/AI tests passed 5 tests, including real Worker/DO transport and atomic handoff/rate budget. Phase 4 frontend/browser and full delivery checks remain in progress.

2026-11-19: User supplied https://github.com/phuongnguyen240805/Kedi-ecommerce-core.git as the new backend destination. Its remote has no refs yet. First consolidated source push includes existing Commerce/Shipping/Admin work plus phase 1–3 and the tested shopping MCP backend pilot. Backend typecheck and 143 backend + 4 admin tests pass. MCP/AI frontend delivery is still in progress; production activation and external service access remain pending.

Phase 4 FE delivered as 014437f: 263 tests, typecheck/boundaries/lint, production build and 3 mocked Chrome scenarios. New backend d2f3261 GitHub quality job succeeded; deployment preflight failed due missing credentials. Phase 5 adds read-only financial/RFM reports, explicit A/B publication and review-only AI drafts. See kedimuse-shopping-marketing-admin.md for exact limits and activation prerequisites.

Phase 5 local gates: 147 backend tests, 6 Admin UI tests, merchant/client TypeScript checks and production Admin build passed. CI gate now includes client workspace typecheck/tests. Marketing changes do not activate email sending, AI calls or any provider account.
