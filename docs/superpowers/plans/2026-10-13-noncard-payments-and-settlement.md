# Non-card Payments and Settlement Implementation Plan

> For agentic workers: use Superpowers subagent-driven development, with Grok and Muse implementing bounded tasks and the controller reviewing production and test diffs independently.

**Goal:** Replace the remaining non-card payment and wallet HTTP flows with authenticated Convex initiation and one atomic settlement path.

**Assumptions:** The approved migration design applies with cards excluded by the October 13 user instruction. Existing money records remain unchanged. Payments remain disabled until live cutover gates pass. The user confirmed on October 13 that approved buyer refunds credit the marketplace wallet.

**Approach:** Verify the provider boundary first; then build authoritative quotes, durable intents, atomic accounting, webhook/status reconciliation, and client integration. Each task has focused behavioral evidence and independent review before dependent work starts.

**Files to touch:** New provider/operation/quote helpers and their tests under `convex/`; additive `schema.ts` fields/indexes; existing order, wallet, transaction, escrow, promotion and loyalty modules; affected mobile/web financial callers; package verification scripts; migration/release docs. Preserve all earlier M1/M2 changes.

**Verification:** Registered Convex handlers/actions with mocked provider transport, relevant negative and concurrency cases, test sensitivity probes for material accounting invariants, workspace/Convex typechecks, strict scoped lint/format checks, existing app/API suites and `git diff --check`. Live provider, deployment, device and store acceptance are separate gates.

**Rollback:** Revert only this plan's source delta against the controller's task-start snapshots. Do not reset, stash, stage, commit, push, deploy, repair records or remove pre-existing artifacts. Once financial operations are enabled, rollback disables initiation while preserving receipts and continuing reconciliation.

**Spec:** `docs/superpowers/specs/2026-10-07-convex-api-migration-design.md`.

**Source status — October 14:** The non-card implementation is accepted after the final independent SPEC and CODE/TEST QUALITY review. That review passed 947 focused tests and eight joined financial-lifecycle probes; the controller independently replayed all eight probes. Source/history scanner matches were checked and classified as dependency checksums or synthetic/public documentation fixtures. The tracked Android debug keystore matches the public React Native 0.81.5 development fixture. Actual EAS upload, production signing, provider/deployment, device and store acceptance remain open below; no activation or release is implied.

## Global constraints

- No card initiation, hosted page, card capability, widget credential or browser card-return work.
- Derive financial actors from verified identity; client account IDs, amounts and roles cannot grant authority.
- Integer cents for calculations; existing stored amounts stay in major units. Provider requests use checked numeric major units and responses use strictly parsed decimal strings.
- Persist intent and withdrawal reservation before external calls. Never automatically retry a financial POST. Timeouts and ambiguous responses retain pending/unknown reservations.
- One settlement mutation applies a validated, matching receipt exactly once, regardless of webhook/poll ordering.
- No historical repricing or automatic repair. Existing conflicting evidence remains a reconciliation concern.
- Internal accounting functions remain internal; the payment availability switch blocks initiation but not settlement.
- No secrets, personal data or raw provider payloads in logs, fixtures or review evidence.

## Reviewed provider contract

Current official Lenco v2 pages were inspected October 13, 2026. Context7 was queried first; older snippets conflicted with the current pages, so current primary pages take precedence. Sandbox acceptance remains unverified.

- Collections: `POST /collections/mobile-money`, numeric major-unit amount, unique constrained reference, phone/operator, explicit `country: zm`, merchant bearer. Current Zambia operator list includes airtel, mtn and zamtel. Phone authorization uses non-terminal `pay-offline`.
- Transfers: `/transfers/mobile-money` or `/transfers/bank-account`, configured debit account ID, major-unit amount/reference and documented destination fields. Bank selection uses directory `id` as `bankId`.
- Receipt envelope: boolean status plus data; decimal-string amount/fees, nullable collection fee/reference. Only successful/failed receipts are terminal. A settled notification must not create a second credit.
- Signature: raw-body HMAC-SHA512, with UTF-8 bytes of SHA256-hex of the bearer token as key. No early acknowledgement before settlement or durable ingestion.
- Financial POST transport/malformed-response/duplicate-reference errors are ambiguous; they cannot authorize a reversal. GET status lookup may retry one transient failure.

Sources: [collections](https://lenco-api.readme.io/v2.0/reference/initiate-collection-from-mobile-money), [mobile-money transfers](https://lenco-api.readme.io/v2.0/reference/initiate-transfer-to-mobile-money), [bank transfers](https://lenco-api.readme.io/v2.0/reference/initiate-transfer-to-bank-account), [collection status](https://lenco-api.readme.io/v2.0/reference/get-collection-by-reference), [transfer status](https://lenco-api.readme.io/v2.0/reference/get-transfer-by-reference), [webhooks](https://lenco-api.readme.io/v2.0/reference/webhooks).

## Review focus

Test unexpected provider envelopes and ambiguous acceptance, duplicate or conflicting operation keys, stale quotes and hidden listings, webhook-before-attachment and terminal-order late receipts, account/freeze changes during initiation, and historical evidence that already accounts for a payment. Tests must reach the changed behavior rather than assert mocks or unrelated green coverage.

### Task 1: Private non-card provider boundary — Muse, Grok review

- [x] Create `convex/lib/lencoAdapter.ts` and `convex/lib/lencoAdapter.test.ts` only. Export a typed client factory, strictly checked money conversions, normalized collection/transfer receipts and raw-signature verification. No public Convex route or database writes in this task.
- [x] Exercise actual request construction with mocked fetch: whitelist body fields, correct major-unit amounts, bankId path, no credential-bearing redirects, exact references, safe errors, nullable fees, non-terminal authorization, invalid/unsupported data and signature bytes.
- [x] Verify 20-second timeout, at most one transient GET retry and zero automatic POST retries. Prove material tests detect wrong units, retries and signature-key decoding.
- [x] Grok reviews actual production/test changes; delegate corrections, rerun relevant checks. Controller registers the files in strict scripts and runs the existing suites.

### Task 2: Authoritative quote and additive operation contracts

- [x] Define explicit intent identity, immutable provider reference, validated quote and consumed operation/reservation contracts with optional schema fields/indexes. No bulk record rewrite; provider financial accounting markers follow in Task4.
- [x] Compute prices from stored product/variant/add-on/delivery records in cents; bind promotions and loyalty to the checkout/intent once. Preserve fee and seller-payout rules; reject stale/tampered quotes before reserving.
- [x] Cover denied actors, malformed stored money, repeated/customized lines, company boundaries and unchanged state after rejection with local handler tests. Live concurrency/runtime proof remains a release gate.

### Task 3: Durable initiation and atomic wallet purchase

- [x] Task3A source slice: atomic verified-owner wallet purchase, 32 handler tests plus 88 quote tests; Grok correction review closed, root full local gates passed. Live/runtime acceptance remains a separate release gate.
- [x] Task3B1 source slice: top-up and withdrawal durable initiation/reservation + resolved destinations; independent review accepted, root 212 focused / 2618 app / 12 API tests and affected type/lint/format gates passed. Receipt attachment remains non-financial until Task4.
- [x] Task3B2 source slice: checkout collection order/inventory/discount reservation, cancellation/deletion guards and valid destination-registration args; Grok scoped review accepted, root 249 focused / 2655 app / 12 API and affected type/lint/format gates passed. No provider financial settlement yet.

Task3B2 includes narrow guards against cancelling unresolved collection orders and deleting their reserved loyalty records. These are prerequisites for retaining reservations during ambiguous provider outcomes; settlement and client cutover remain later tasks.

- [x] Public non-card actions authenticate and persist a stable intent before transport. The same account/request/input reuses it; conflicting reuse and overlapping pending order sets reject.
- [x] Wallet purchase performs debit, ledger, all paid-order transitions, escrow and notices in one mutation. Withdrawals reserve atomically and retain uncertainty after an attempted external transfer.
- [x] Cover source deduplication, claim ordering, account/freeze changes, and provider acceptance followed by local response/attachment failure. No public generic credit/debit primitives. Live OCC/provider acceptance remains separate.

### Task 4: Unified settlement and escrow accounting

Execute sequential source slices: Task4A top-up/withdrawal receipt settlement and strict funding proof; Task4B checkout reservation capture/release through that same mutation; Task4C shared escrow refund/release and completion wiring. Each has one source owner and independent non-Claude review before dependent work.

- [x] Task4A source: trusted top-up/withdrawal settlement, terminal receipt/provenance retention, exact reciprocal funding/effect proof and missing-beneficiary hold; GPT correction +Grok scoped re-review accepted. Root 357 focused /2763 app /12 unchanged API, workspace+Convex types/account lint+format/diffcheck pass. No live provider/OCC/rollback/signing/rollout claim.
- [x] Task4B source: checkout capture/release through the same writer, strict consumed funding/discount proof and privacy-preserving replay; Muse corrections +Grok r3 accepted. Root 662 focused /2833 app, workspace+Convex types/account lint+format/diffcheck and canonical inventory/coverage/lineage/privacy probes pass. Source-only; no provider/OCC/rollback/rollout claim.
- [x] Task4C source: shared escrow lifecycle, marketplace-wallet refunds, seller release and completion wiring.
  - [x] Task4C1 source: private accounting helper/internal wrappers accepted after GPT corrections and Grok scoped r2; root 895 focused /3012 app, types/account gates and refund/read-scope probes pass. Live index/OCC/provider gates remain separate.
  - [x] Task4C2 source: wire public order/dispute completion, approved refund and valid cancellation paths to that helper; preserve inventory policy and original funding proof.
    - [x] Task4C2a source: public order completion/cancellation accepted after Muse correction and Grok scoped r2; root1023focus/3051app/types/accountgates/22probes pass, positivefunding+immutablehistory+participantambiguity guards preserved. Live/client gates remain separate.
    - [x] Task4C2b source: verified dispute decisions/buyer releases and financial outcome summaries, after accepted order integration.
      - [x] Task4C2b1 source: verified dispute refunds and buyer/reviewer releases accepted after GPT implementation and independent Muse SPEC+QUALITY review; root1100focus/3128app/types/accountgates/22cash-hold-audit probes pass. First approval and original funding preserved; Task6 consumer/live gates remain separate.
      - [x] Task4C2b2 source: read-only proven outcome/fee summaries with nullable totals and caller compatibility accepted after GPT implementation and independent Muse SPEC+QUALITY review; root1286focus+screens/3218app/types/account+finance gates/22queryprobes pass. Late fee authority/status and live/client gates remain later.

- [x] Source: one internal mutation validates receipt identity/currency/amount/destination against its intent and atomically applies top-up, checkout or withdrawal effects once.
- [x] Source: keep terminal orders terminal on late success; record received funds and flag review. Reverse only a validated failed withdrawal, once.
- [x] Source: wire seller release and approved buyer refunds to ledger effects using the confirmed marketplace-wallet refund destination. Preserve approved amounts, permissions and lifecycle restrictions.
- [x] Source: recognize existing collection/withdrawal references and historical credit evidence without inferring uncredited money from missing markers. Conflicts stay unresolved for separately authorized reconciliation; no historical records were repaired.

### Task 5: Webhook and scheduled/status reconciliation

Execute sequential source slices, one editor and independent review each:

- [x] Task5A source: verified raw-body webhook ingestion and minimal durable inbox accepted after GPT implementation/Muse SPEC+QUALITY review; root1241focus/3278app/types/accountgates/17HTTP-HMAC-money-retry probes pass. Missing facts remain queued for Task5B/C; no live delivery/index/OCC claim.
- [x] Task5B source: trusted GET reconciliation, safe owner/by-request recovery and readonly validated late fees accepted after GPT implementation/Muse SPEC+QUALITY review; root1421focus/3459app/types/accountgates/11GET-money-proof-recovery probes pass. Final integration review considered both label/corrupt-DTO observations and found no material source defect; no live provider/JWT/OCC/index/rollback claim.
- [x] Task5C source: mutation-controlled durable bounded checkpoints and claim arming, including crash-safe polling/exhaustion holds; both5C1/5C2 independently accepted. Live scheduling/OCC/rollback/index/provider acceptance remains separate.
  - [x] Task5C1 source: durable financial checkpoints and atomic three-claim arming accepted after GPT implementation, one off-switch test correction and fresh scoped GPT review; root1504focus/3543app/types/accountgates/9queue-money-deadline probes pass. Fixed24h+60s safety retains reservations; live scheduling/OCC/rollback/provider gates remain separate.
  - [x] Task5C2 source: bounded associated-inbox acquisition accepted after GPT implementation and fresh independent GPT SPEC+QUALITY review; root1604focus/3644app/types/accountgates/9actualsigned-pipeline probes pass. Original ingest time,31GET bound and queue-only expiry preserved; live scheduling/OCC/rollback/provider gates remain separate.

- [x] Source: add signed `/lenco-webhook`: verify raw bytes before parsing; durable ingest/settle before acknowledgement; no swallowed persistence errors.
- [x] Source: authenticated status and scheduled GET reconciliation call the same settlement mutation. Poll alone must suffice; use the approved bounded schedule and retain unresolved reservations at exhaustion.
- [x] Local tests cover duplicate/out-of-order events, attachment races, signed unhandled events, invalid signatures, aggregate settlement and historical reference mismatches. Live transport/concurrency proof remains separate.

### Task 6: Non-card client cutover and release evidence

Sequential source slices:6A mobile wallet,6B mobile checkout/Pay Now,6C web wallet checkout,6D legacy HTTP/API_URL/API source retirement and final gates. One editor/independent review per slice.

- [x] Task6A source: mobile wallet top-up/withdrawal, resolved owned destinations and durable opaque recovery accepted after GPT correction and fresh scoped GPT r2 SPEC+QUALITY ACCEPT; F1–F4 closed. Root120focused/1604financial/3719app/12API/all19gates + originalrealReact race probes pass. Native process-death/storage/provider/JWT/OCC/live gates remain separate.
- [x] Task6B source: mobile authoritative checkout and existing pending-order Pay Now accepted after GPT correction and fresh independent GPT r2 SPEC+QUALITY review; R1–R4 closed. Root249focus/3839app/12API/all20gates pass; native/provider/JWT/OCC/storage/live gates remain separate.
- [x] Task6C source: web wallet-only canonical checkout/explicit approval/atomic purchase/owned recovery accepted after GPT correction and fresh scoped GPT r2 SPEC+QUALITY ACCEPT; T6C-R1-01 closed. Root104focus/3925app/12API/all23gates pass; native/provider/live gates remain separate.
- [x] Task6D1 source: remaining client outcome and local-input corrections accepted before retirement; live gates remain separate.
  - [x] Task6D1A source: web order/mobile dispute financial outcomes and owned async controls accepted after GPT correction and fresh scoped GPT R2 SPEC+QUALITY ACCEPT; both cancellation-feedback findings closed. Root209 focused/original2 probes and author4060 app/12 API/types/strict checks pass; live gates remain separate.
  - [x] Task6D1B source: wallet preclaim phone validation, exact-cent checkout eligibility and whole-decimal/lossless-major partial refund accepted after independent GPT R1 SPEC+QUALITY ACCEPT. Root326 focused/4103 app/types/strict affected checks and three-guard sensitivity pass; accounting policy and gross limit preserved; live gates remain separate.
- [x] Task6D2 source: all-consumer legacy HTTP/API_URL/API runtime retirement and final local source verification; actual upload and release evidence remain separate below.
  - [x] Task6D2A source: mobile generic HTTP/API_URL dependencies and obsolete Nest AI/payment/global Convex bridge modules retired; independent GPT R1 SPEC+QUALITY ACCEPT. Root4115 app/16 API/81 archive-fixture tests/types/strict checks and preservation/sensitivity pass; actual upload and live gates remain separate.
  - [x] Task6D2B source evidence: final independent integration SPEC+QUALITY ACCEPT, 947 focused tests and eight probes, controller replay of eight probes, accepted full local gates, redacted current/planned source and reachable-history audits, and complete inclusion inventory. Strict inspection of the full source list is recorded with classified policy failures; it is not an actual EAS upload pass.

- [x] Source: replace financial HTTP services with account-bound Convex hooks; preserve result contracts and availability/readiness recovery. Remove generic API URL requirements/fallbacks/logging after all consumers are gone.
- [x] Source: keep inactive cards hidden/disabled. Restore web wallet checkout through the atomic mutation and complete bankId directory wiring.
- [x] Complete final production/test review, accepted full local gates, source/history secret audit and full source-list inspection. Report source completion separately from actual upload, provider configuration, reconciliation, deployment, browser/device UAT and store publication.

## Remaining operational and release gates

- [ ] Establish a usable approved EAS CLI and verify monorepo ignore semantics against an actual provenance-bearing upload package/list. Preserve the strict verifier and negative fixtures; resolve upload exclusions for reference/test inputs and the public debug keystore without claiming a whole-source list is an EAS artifact.
- [ ] Verify actual release signing credentials and the built Android signer. Public development-fixture identity does not establish production signing.
- [ ] Validate configured Convex/Clerk/Lenco, deployed indexes, JWT/SDK transport, transactional rollback/OCC and both scheduler queues in the intended environment. Keep initiation disabled until acceptance; owed reconciliation must remain available.
- [ ] Verify provider webhook destination, delivery/status recovery and in-flight operations before retiring the deployed Railway service. Handle historical attribution/reconciliation only under separate authorization; do not repair records automatically.
- [ ] Exercise mobile/browser account, approval, recovery, access-loss and native storage/process-death flows with the actual SDKs and intended binaries.
- [ ] Complete authorized deployment, TestFlight and the existing Google Play internal-testing release. No staging, commit, push, deployment, payment activation or store publication was performed during the source implementation.

## Dependency scan

Task 1 defines provider receipts consumed by Tasks 3–5. Task 2 defines quote/intent identities consumed by Tasks 3–6. Tasks 3 and 4 share operation and ledger contracts and therefore execute sequentially. Task 5 consumes the same settlement interface as client status checks. Task 6 begins only after backend contracts are stable. The controller owns shared schema/scripts/docs edits; implementers receive bounded file ownership to prevent overlapping work.
