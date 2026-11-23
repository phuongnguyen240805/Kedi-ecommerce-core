# POD v2 implementation checkpoint

Scope: only missing KediMuse → Fufuni → Printify functionality. Existing retail checkout, COD, QR, POS and marketing behavior must be preserved. Report changes to existing logic before editing.

## Inputs

- Backend baseline: `7fa341a`, clean checkout `checkout-fulfillment-be`.
- Frontend baseline: `00c4c3a`, clean checkout `checkout-fulfillment-fe`.
- Implementation kit: `tmp/pod-v2-kit-2026-11-23/KediMuse_POD_Codex_Implementation_Kit`.
- Branch in both repositories: `codex/pod-v2-staged`.
- No applicable AGENTS.md found in repository trees or workspace ancestors.
- RTK executable is blocked by Windows Application Control even outside sandbox. Use bounded logs; do not claim RTK was used.

## P00 baseline

- `npm.cmd run test:pod:ready`: **28 passed**, 0 failed. Local Workers, SQLite and R2 with mocked Printify. Log: `../pod-v2-baseline-be-retry.log` relative to repository root.
- Initial sandbox run could not write Wrangler logs. Retried with approved local runtime execution.
- Frontend baseline initially could not write Jest cache; outside-sandbox execution was denied. No-cache sandbox retry pending.
- Existing receipt/order/outbox transaction is reused; no second POD payment ledger.
- Existing mapping draft helper is already safe, but legacy PUT mapping route still bypasses it.

## Necessary edits to existing code reported before editing

1. POD mapping activation route: require provider/spec approval, not arbitrary enabled=true.
2. POD runner dispatch: staged pipeline for new snapshot-bound orders, preserve legacy reconciliation.
3. POD BFF: explicit backend config and durable scoped order access beyond 30-minute cart cookie.
4. MerchantDO/types/store secret classification/cron: minimal wiring for new POD RPCs and flags, no unrelated refactor.

## External gates

Production deployment, Printify live media/product/order writes and production release require operator authorization. Actual shop Manual Approval, billing, live Stripe, trusted Techcombank settlement source/FX policy, print specifications and physical sample acceptance cannot be inferred from mocks or source. Complete independent offline work first. Do not claim P10 complete without evidence.

## Implementation and verified scope

Implemented: versioned approved DTG/DTF front/back specs, guarded mapping activation, transparent editor export, inspected/approved and write-once sealed R2 artifacts, canonical snapshot hashes, quote binding, existing Stripe receipt/order/outbox reuse, live Stripe charge/refund/dispute recheck before writes, separate media/product/order/production intents, fencing, unknown recovery with scoped GET proof, raw-HMAC inbox, polling/tracking, protected 90-day read-only order access, Admin controls, per-store flag/secret scoping, optional R2 CI binding and offline CI tests.

All new provider flags default OFF. Actual R2 absence is supported: status and admin configuration remain inspectable; new snapshot/quote/checkout/provider writes fail closed. Tests use local R2. No R2 service/bucket was created, no Printify resource/payment/production was sent, no live configuration was modified and no deployment occurred.

Required existing-code edits were reported before changes. Retail payment/stock/POS/marketing business functions were not rewritten. `ucp-payment.ts` and its ledger schema remain unchanged. Legacy Printify pagination now respects metadata and a 50-record page; the legacy mapping activation bypass is closed. Existing unknown legacy jobs are not resent.

## Verification results

| Check | Result | Evidence under sibling `kedimuse-implementation` directory |
| --- | --- | --- |
| Existing backend commerce phase5 | 219 passed | `pod-v2-retail-regression.log` |
| Existing POD readiness | 28 passed | `pod-v2-legacy-final.log` |
| New POD unit/contract/runtime/chaos | 16 passed | `pod-v2-backend-release-tests.log` |
| Frontend modular regression | 336 passed | `pod-v2-fe-cloudflare-full.log` (full prebuild), `pod-v2-fe-regression-final.log` |
| Admin regression and new approval control | 20 passed | `checkout-fulfillment-be/pod-v2-admin-final-tests.log` |
| Existing browser regression | 22 passed | `pod-v2-existing-browser.log` |
| New browser POD/export | 3 passed | `pod-v2-browser-acceptance.log` |
| Python config/activation tests | 9 + 4 passed | execution output; tests committed in `scripts/` |
| BE/FE/Admin TypeScript | Passed independently | `pod-v2-be-typecheck-release.log`, `pod-v2-fe-typecheck-final.log`, `checkout-fulfillment-be/pod-v2-admin-typecheck.log` |
| FE lint and module boundaries | Passed | `pod-v2-fe-cloudflare-full.log`, `pod-v2-fe-lint-final.log` |
| Next production + Cloudflare OpenNext packaging | Passed | `pod-v2-fe-cloudflare-full.log` |
| BE and FE Wrangler packaging | Dry-run passed, no upload | `pod-v2-be-dryrun.log`, `pod-v2-fe-dryrun.log` |

New runtime tests invoke the actual router/admin authentication and MerchantDO, not a substitute state model. They check missing R2/no operation, unauthorized Admin and unsigned webhook rejection, 100 concurrent DO RPC claims/one owner, sealed SHA served to mock Printify, exactly one upload/product/order/send, production held before approval, durable references, signed/deduplicated webhook, delivered tracking, and lost replies after every provider write with GET/manual recovery and no duplicate POST. Browser tests validate actual exported PNG dimensions and corner/center alpha pixels; this caught and fixed Fabric 7 origin handling in the new exporter.

The test case IDs in titles identify covered invariants, **not certification of every kit row**. The entire 112-row phase matrix and 50-row E2E matrix have not been adjudicated as complete. No load/SLO certification, physical color/print sample, production rollback drill, true customer recovery across lost devices, or live provider/bank certification is claimed.

## Phase disposition

| Phase | Disposition |
| --- | --- |
| P00 | Local baseline and safe environment complete; remote identity/config still requires activation verification |
| P01 | New fenced per-operation engine and recovery implemented/tested; legacy state rows preserved, no destructive backfill |
| P02 | Reviewed/versioned spec + activation implemented; real catalog/manufacturer evidence external |
| P03 | Flattened RGBA export, inspection, approval, seal and hash binding tested; source-layer fidelity and physical quality remain manual |
| P04 | Existing Stripe ledger reused and live recheck added; **Techcombank POD VND/FX not implemented/activated without trusted bank contract and treasury policy** |
| P05–P06 | Staged provider pipeline and gates passed local contract/runtime/chaos; real provider writes remain external |
| P07 | Signed inbox, poll fallback, partial tracking and ownership implemented; real webhook registration/delivery external |
| P08 | Customer/editor/Admin paths implemented and tested in scoped pilot; manufacturer/finance production acceptance external |
| P09 | Focused regression, E2E/chaos/security and CI implemented; full matrix/load/production rollback acceptance still open |
| P10 | EXTERNAL_GATE: no live deployment, real R2, payment, provider write or physical sample acceptance |

## Activation handoff

Read `plans/pod-v2-r2-activation.md` for exact configuration, activation order, supported pilot scope and rollback. R2 activation alone is not proof that real paid printing works. Stripe-first can be accepted separately; full bank target must remain open until a supported authenticated settlement channel, frozen VND/FX/tax policy and finance approval are supplied.

Environment issues resolved during verification: RTK blocked by Application Control; Jest cache moved into workspace; Wrangler tests used approved local execution; D drive ENOSPC resolved for builds by redirecting this checkout's generated `.next` through a junction to a task-specific temp root on C, with a dependency junction for Node ESM. No source configuration was changed to work around disk space. Interrupted runs and failed build attempts are not counted as passes. Browser tests were rerun after packaging finished.
