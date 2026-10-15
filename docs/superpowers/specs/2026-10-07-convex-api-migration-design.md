# Convex API Migration Design

Status: revision 5, proposed for user review; implementation has not started. Revision 5 separates funding, attribution, and authorization in the reconciliation, checks multi-order allocations, and corrects the withdrawal references. Revision 4 locked down role, ban, and admin-bootstrap controls during containment. It also replaces the credit audit with a full three-way financial reconciliation that includes ownership checks, adds privileged-account verification, and corrects the old-build behavior at cutover.

## Goal and agreed intent

Convex becomes the only application backend. Pinkie, payment initiation, payment reconciliation, wallet operations, and payment webhooks move from the Railway API to the existing Convex project. OpenAI and Lenco remain the external providers; Clerk remains the identity provider. The aim is to reduce the number of systems operated in production: there will be no production period in which some API functions run on Railway and others on Convex.

All migrated functionality therefore reaches production in **one cutover**, followed by fresh builds to the existing organization TestFlight Internal group and Google Play internal testing group, and the matching web deployment. Work proceeds in internal milestones (below), but milestones are verified on the Convex development deployment and are never released to production separately.

The repository audit and push were completed at `1a1c9c6b3c54abe684e99f2ef83509e30ad682b7`. The Railway-dependent Android build 13 and iOS build 2 submission were canceled and their cancellation was verified. The previous tester releases remain active. The finished iOS build 2 is retained as an unused artifact.

## Immediate financial containment (before the migration)

Convex has no authentication configured today (`convex/auth.config.ts` does not exist), and many money-moving mutations are public with no caller check, or trust a caller-supplied user/admin ID. The Railway API is still serving traffic (its readiness endpoint responded on 2026-10-07). Its withdrawal endpoints accept `userId` from the request body. Together these allow minting a wallet balance and withdrawing it as real money through Lenco.

Containment removes exposure without adding a backend. It is a production change and is executed only after explicit user confirmation, in this order:

1. **Inventory operations (read-only).** Export the references, provider IDs, amounts, statuses, and accounts of every transaction, top-up, and withdrawal record, in all statuses, to private release evidence. Pending and processing records are the ones whose outcomes must be recovered; the full set is the starting point for the financial reconciliation below, which also finds collections that never got a record.
2. **Stop Railway serving traffic.** Stop the Railway service from the Railway dashboard (stop or remove the active deployment; do not delete the project). This stops all Railway payment initiation, which internalizing Convex functions alone cannot guarantee. For example, wallet top-up calls Lenco *before* saving its Convex transaction, so a locked-down save could leave a started collection unrecorded. Verify that the health and payment endpoints no longer respond. Re-run step 1 to capture anything initiated between the first export and the stop.
3. **Lock down Convex accounting.** Convert these mutations to internal functions and update internal callers to `internal` references:
   - `wallet`: `creditWallet`, `debitWallet`, `updateWithdrawalStatus`, `updateTransactionExternalReference`, `updateWalletTransactionByLencoId`, `freezeWallet`, `unfreezeWallet`
   - `transactions`: `createTransaction`, `updateTransactionLencoIds`, `updateTransactionStatus`, `updateTransactionByLencoId`, `createTopUpTransaction`
   - `escrow`: `createEscrowHold`, `releaseFunds`, `refundFull`, `refundPartial`, `markAsDisputed`
   - `orders.markPaidByWallet` (marks an order paid and creates escrow with no wallet debit)
   - `loyalty.awardPoints`
   - `users.updateUserRole` and `users.toggleUserBan` (both trust a caller-supplied admin ID)
   - `seed.createInitialAdmin` (public, and when an admin already exists it returns that admin's ID, which is exactly what the caller-supplied admin checks trust). Bootstrap is then run only through `npx convex run` as an internal function.

   External callers are only the Railway API (now stopped), web checkout (`debitWallet`, `markPaidByWallet`), the unused mobile `debitWallet` reference in `apps/mobile/src/hooks/useWallet.ts`, the mobile admin freeze/unfreeze screen, and the mobile and web admin user screens (role and ban changes). Freeze, unfreeze, role, and ban changes trust a caller-supplied admin ID, so they become internal too. During the pause an emergency freeze or ban is run as an internal function from the Convex dashboard, and the authenticated admin controls return in milestone 1.
4. **Pause web payments.** Remove the mobile debit reference. Replace web wallet checkout, and the admin freeze, role, and ban controls on both clients, with a "temporarily unavailable" message. Deploy the web change together with the Convex change. Verify that every listed function rejects public calls in production.

**Consequences, accepted for the single-backend goal:** from step 2 until the cutover, testers have no payments, top-ups, withdrawals, or Pinkie, because Pinkie also runs on Railway. The rest of the marketplace keeps working on Convex.

**Settlement of existing operations.** Railway's webhook handler swallows Convex mutation failures and still acknowledges the event, and acknowledged events are not retried by Lenco. That is why step 2 stops Railway rather than leaving it running against locked-down functions. With the service stopped, Lenco's deliveries fail and remain eligible for retry instead of being acknowledged and lost. Lenco's retry window may still end before the cutover, so webhooks are not relied upon for these operations. Every pending operation in the step 1 inventory is settled after the cutover through the authenticated status reconciliation path (provider status lookup by reference or provider ID). Collected-but-unrecorded and collected-but-uncredited money is found by the financial reconciliation, not by the inventory. Payment availability stays off until both are done.

**Residual exposure during the pause.** `orders.completeOrder`, `orders.cancelOrder`, `disputes.resolveDispute`, `disputes.buyerResolveDispute`, and `loyalty.redeemPoints` are normal user actions that still trust caller-supplied IDs, so they cannot be internalized without breaking the apps. During the pause they can corrupt order, escrow, dispute, and points state, but they cannot move money out: initiation and withdrawals are stopped and wallet spending is internal. Milestone 1 binds them to the authenticated user. The pre-activation reconciliation below re-checks every change they made during the pause.

### Financial reconciliation (read-only)

Database records alone cannot prove legitimate funds, because provider IDs, statuses, and transaction links were caller-writable. Starting from existing credits also cannot reveal *missing* ones. Two known failure paths leave money collected but not accounted: wallet top-up calls Lenco before saving its record, and the collection webhook marks a top-up successful before a separate wallet credit that can fail. Lenco retries webhooks for at most 24 hours, so future deliveries cannot prove recovery is complete.

The reconciliation therefore compares three independent sets for the whole period the Railway API handled payments:

1. **Provider history:** every collection and transfer on the merchant account, from Lenco's list/history API or a dashboard export. Which source is used is confirmed during Lenco contract verification.
2. **Recorded operations:** every transaction, top-up, and withdrawal record in Convex, in every status (not only pending).
3. **Accounting effects:** wallet ledger entries, orders marked paid, and escrow holds, releases, and refunds.

Each discrepancy is classified:

- provider success with no recorded operation (collected but unrecorded)
- recorded success with no accounting effect (collected but not credited)
- accounting effect with no provider success (unfunded credit)
- amount or currency mismatch between provider and records
- more than one accounting claim against the same provider receipt
- provider outcome that differs from the recorded terminal state

**Ownership.** The reconciliation keeps three findings separate, because historical records can prove the first but not always the others:

- **Verified provider funding:** Lenco confirms the collection or transfer happened, with this reference, amount, and currency.
- **Historical beneficiary attribution:** the account the record names. Our system generated genuine references (`TXN-`/`TOP-` for collections, `WDR-MM-`/`WDR-BK-` for withdrawals; `WLT-` identifies the internal wallet ledger entry, not a provider reference). But `createTransaction` and related mutations accepted a caller-chosen `userId` without authentication, so a genuine reference recorded against an account shows only who the record *names*, not who paid.
- **Verified user authorization:** independent evidence that the named user initiated the operation, such as a matching payer phone number or account from the provider record, or an authenticated client session. This evidence often does not exist for legacy operations.

An item counts as verified only when funding and authorization are both verified. Where funding is verified but ownership rests on historical attribution alone, the item is classified *attributed, unverified*. It is reported as blocking unless the user explicitly accepts the historical attribution assumption, either for that item or for a stated class of items. Items with no attributable reference are *unattributed*.

**Allocation.** The unit of comparison is one **validated payment operation** together with its expected linked accounting effects, not one effect per receipt. A single aggregate checkout collection legitimately marks several orders paid and creates several escrow holds (`checkoutOrderIds`/legacy `orderIds`), and a top-up produces one wallet credit. For each operation the reconciliation checks:

- that the linked effects are exactly the ones its records call for: the listed orders and their escrow holds, or the wallet credit
- that the allocations conserve the collected amount: the linked orders' totals or the credited amount equal the gross amount the provider collected, within rounding (provider fees are deducted afterwards and recorded separately; they do not reduce the allocation)
- that no effect is linked to more than one operation, and no operation has effects beyond its expected set

Over-allocation, under-allocation, duplicated effects, and effects claimed by two operations are reported together as conflicts.

Withdrawals are checked the same way: a provider transfer, matched by its `WDR-` reference or provider ID (not the internal `WLT-` wallet entry), whose status and amount match exactly one wallet debit, with the same funding, attribution, and authorization distinction.

Any order, escrow, dispute, or points change made through the residual-exposure functions during the pause is also listed.

The results are written to private release evidence. Every discrepancy is either **blocking** or **explicitly accepted by the user**; nothing is repaired automatically, and repairs need a separately approved scope. The reconciliation runs once after containment, to measure what may already have happened, and again as a cutover gate before payment availability is turned on. Provider access is read-only (GET and export); no collections or transfers are created.

### Privileged-account verification (read-only)

Roles may already have been changed through the unauthenticated role and ban controls. Authentication added later would still trust those stored roles. Before payment activation, every `admin` and `moderator` account is compared against a staff list that the user confirms independently. Unconfirmed privileged accounts are reported and block activation. Demoting them is a role change and happens only with user approval.

## Assumptions and scope

- Preserve the existing marketplace features, mobile response shapes, payment references, order records, balances, and Pinkie identity and ghostwriting rules.
- Include the web's remaining AI calls and direct wallet checkout writes, because otherwise the shared backend cannot safely retire the old public accounting functions.
- Add the authentication and financial boundary checks required for the migrated flows. Do not turn this into an unrelated redesign or a complete audit of every marketplace feature.
- Do not repair historical balances, replay historical payments, or execute real payment or withdrawal tests. Those actions require separately defined record and transaction scope.
- Existing native tester versions cannot provide Convex authentication; they lose payments and Pinkie at containment. A minimum-version gate (below) tells them to update. Retaining unauthenticated accounting writes for old-client compatibility is unacceptable.
- Use existing managed credentials privately. Card payment is inactive and excluded from this migration by the October 13 scope decision. Do not add card initiation, card sessions, a hosted card page, or a public widget key requirement.
- Stop the Railway service at containment, but keep the project (not deleted) until the payment callback destination and pending-operation drain are verified. This design neither purchases a Railway plan nor deletes the project or cancels its subscription.

## Delivery shape: internal milestones, one production cutover

| Milestone | Content | Verified on |
|---|---|---|
| 0 | Immediate financial containment: stop Railway, lock down accounting, pause web payments | Production (with user confirmation) |
| 1 | Clerk-to-Convex authentication, actor guards, minimum-version gate, payment availability switch | Convex development deployment |
| 2 | Pinkie and all AI features on Convex | Convex development deployment |
| 3 | Authoritative pricing, payments, wallets, settlement, signed webhook, reconciliation | Convex development deployment |
| Cutover | Production Convex deploy, configuration, Lenco dashboard change, web deploy, fresh iOS and Android builds | Production |

Milestones may land on `main` only if they are inert in production (for example behind the payment availability switch). Otherwise they stay on a migration branch until the cutover. Mobile builds are produced once, from the cutover revision.

Card payments remain disabled throughout this migration. Hosted card checkout and its browser-return flow are outside the approved scope; they require a separate future decision.

## Approach choice

**Selected: native Convex actions and queries.** The clients use generated, typed function references through their authenticated Convex client. Actions call OpenAI or Lenco; internal queries and mutations enforce access and apply database changes. This removes the extra hosting dependency and retains the database's transaction guarantees.

A Convex HTTP facade resembling NestJS would reduce some client edits but retain a second transport/authentication contract. It also cannot inherit the existing Railway-owned hostname, so it would not avoid updating old native clients. A temporary Railway compatibility bridge would require deploying to the billing-blocked service and would preserve the dependency this migration removes. Neither is selected.

## Authentication and client integration

Configure the existing production Clerk issuer and `convex` JWT audience in `convex/auth.config.ts`. Verify that the production Clerk JWT template exists and that tokens validate. Replace mobile's plain Convex provider with `ConvexProviderWithClerk`; web already uses that provider. Wait for Convex authentication readiness before account synchronization and authenticated queries.

The server maps the verified Clerk subject to the user record. It rejects missing identity, deleted or banned users, mismatched account IDs, and unauthorized staff requests. Supplied `userId`, `adminId`, `reviewerId`, and `viewerRole` values do not grant authority. Use the existing `admin` and `moderator` review-role policy.

Protect role changes, ban changes, and wallet freeze/unfreeze with the actual authenticated admin, and restore the freeze, role, and ban controls on both clients. Bind `completeOrder`, `cancelOrder`, `resolveDispute`, `buyerResolveDispute`, and `redeemPoints` to the authenticated buyer, seller, or staff member. Initial-admin bootstrap stays internal (done during containment). Split subject-bound public profile synchronization from verified Clerk webhook upsert. Bind shared catalog/reviewer/admin actor guards to the authenticated subject so callers cannot change prices or promotions by submitting somebody else's privileged ID. These checks are prerequisites for trusting stored roles and prices; they are not optional adjacent cleanup.

Replace the mobile HTTP service implementations with typed service hooks bound to the current Convex client. Preserve their public result shapes where practical. Remove generic HTTP get/post access and the required `EXPO_PUBLIC_API_URL` configuration, localhost fallbacks, and API URL logging. Account switching must clear account-specific state and discard results issued for a previous account. Migrate the web's visual-search and listing-moderation callers as well.

### Minimum-version gate

Add a public Convex query returning the minimum supported native build per platform, stored as configuration. The new builds check it at launch and on resume, and show a blocking "please update" screen with a store link when below the minimum. The cutover sets the minimum to the new build numbers. Old builds cannot read this gate, so the payment paths they call already fail closed after containment; the release notes and tester message tell testers to update.

### Payment availability switch

Add a configuration-backed payment availability flag read by mobile and web. When off, checkout, top-up, and withdrawal entry points show "payments temporarily unavailable" instead of failing with transport errors, and the Convex payment actions refuse new initiation while settlement and reconciliation keep running. It defaults to off until the cutover verification passes, and it is the first rollback lever afterwards.

## Pinkie and AI behavior

Port chat, personalized recommendations, similar products, visual search, message rephrasing, response suggestions, dispute analysis, listing moderation, resolution drafts, and truthful configuration health.

- Share the existing identity helper between clients, Convex, and any retained legacy source. Deterministic identity questions return Pinkie's introduction without a provider call. Preserve quoted speech and the existing ghostwriting exclusion.
- Preserve guest catalog chat, similar products, and image search after version-2 consent. Guest requests cannot select another account or obtain private order/dispute context.
- Require authenticated accounts for recommendations and participant/staff authorization for disputes and drafts. Fetch moderation input from the stored listing and recheck its revision and reviewer permissions before saving.
- Preserve the minimized chat context: public product/catalog facts and authorized aggregate activity. Do not revive the unused comprehensive order-context builder containing contact, address, payment, or message details.
- Keep image input bounded to the current 500,000-character data URL limit, validate supported image encodings, cap history/context, and validate all model outputs from `unknown` before use. Navigation actions must use the existing allowed types and targets.
- Keep existing non-AI fallbacks where appropriate. An unavailable model must not produce a false configured-health result or a fabricated analysis/moderation success.
- Retain mobile consent checks and add the same disclosure and account-scoped consent gate to the two web callers. Pass the current consent version with AI requests; consent is a prerequisite for provider calls, not authentication.
- Reserve model usage atomically before provider calls. Configurable defaults are 1,000 calls/day and 100/minute globally, 100/day and 10/minute per authenticated account, 200/day and 20/minute across all guests, and 20/day and 5/minute per guest session. Guest calls also count against the global limits, so the all-guest caps bound how much of the global allowance guests can take: guest traffic can use at most 200 of the 1,000 daily calls and 20 of the 100 calls per minute, which leaves signed-in users at least 800/day and 80/minute. Accepted trade-off: anonymous session IDs alone cannot prevent abuse, so one abusive guest can exhaust the guest allowance and make guest Pinkie unavailable for the rest of that period. The limits are configuration and can be raised without a deploy. Missing provider credentials fail closed except deterministic/fallback behavior.
- Preserve `gpt-4o-mini` as the default model, with `OPENAI_MODEL` override. Set a 30-second provider timeout and at most one transient retry. Log only safe error codes; never raw prompts, images, provider responses, or private context.

## Payment initiation and authoritative amounts

Public payment actions authenticate the payer and load the relevant order or wallet themselves. Validate finite positive money values, supported operators, bank identifiers, duplicate order IDs, order ownership and status, wallet state, and provider response shapes. Use integer minor units for validated money arithmetic, while preserving existing stored major-unit representations. Lenco v2 accepts major-unit JSON numbers, so the adapter converts validated cents to numeric major units at the wire boundary; it must never send the cents integer as the provider amount. Parse provider decimal-string amounts and nullable fees strictly back into safe integer cents.

Validate checkout prices and totals server-side using current product/variant/add-on prices, configured delivery pricing, and valid promotion and loyalty rules. `createOrder` currently accepts client-supplied `subtotal`, `discountAmount`, and `shippingCost`; the server must compute them instead. Authenticate loyalty ownership and restrict points issuance to authorized/internal paths. Reserve/redeem a discount against its checkout/order exactly once, rather than accepting an arbitrary client discount or a separately replayable points debit. Reject stale or tampered client quotes before payment; do not merely trust the stored `order.totalAmount`. Preserve the existing choices and show a refresh/review error when the quote changes. Previously initiated provider operations retain their recorded intent amounts; this is not a repricing or repair of historical transactions.

Create a durable intent before any external collection or transfer. Each operation has an account-scoped request ID, a persisted immutable provider reference, validated input identity, and a state. A retry reuses the operation. Reuse with different inputs is rejected. A pending operation for the same order cannot create a second collection by changing request IDs.

### Lenco contract verification

Provider contracts were checked against the current official Lenco v2 pages on October 13. The non-card adapter sends only documented fields: mobile-money collection uses `/collections/mobile-money` with numeric major-unit `amount`, `reference`, `phone`, `operator`, explicit `country: "zm"`, and merchant fee bearer. Transfers use `/transfers/mobile-money` or `/transfers/bank-account`; bank payouts and bank-account resolution use `bankId` from the provider directory. A debit `accountId` is required for transfers, not collections. Do not send the legacy extra collection fields or transfer `currency`/`accountName` fields.

The current collection and transfer pages list Zambia operators `airtel`, `mtn`, and `zamtel`. `pay-offline` means the customer authorizes on their phone; it remains non-terminal. Older Context7 snippets omit `zamtel` and show an OTP challenge, so current official pages take precedence. Accept a documented challenge status as non-terminal on historical/status ingestion; do not infer payment success or map it to a card flow.

Provider responses use a boolean-status envelope, decimal-string amounts, and nullable collection fees/references. Only a validated, matching successful or failed receipt can decide a financial operation. An HTTP rejection, duplicate-reference error, timeout or malformed response must not by itself release a withdrawal reservation: status reconciliation determines whether the operation was accepted. Unknown outbound-field behavior is not a blocker because the new adapter omits those fields. Synthetic fixtures must contain no real credentials or personal data.

The confirmed signature is HMAC-SHA512 over the exact raw request bytes, keyed with the UTF-8 bytes of the SHA256 hexadecimal digest of the API token. Verify the signature before parsing or writing. Provider contract evidence and remaining live-verification limits are recorded in the non-card implementation plan.

Validate the provider's success envelope, IDs, currency, decimal-string amounts, and nullable fees. Use a 20-second timeout and no automatic financial POST retry. A read-only status GET may retry one transient failure using the same reference.

## Wallet accounting and settlement

Perform wallet purchase debit, wallet ledger insertion, all included order transitions, escrow holds, and notifications in one Convex mutation. Authenticate ownership and derive the total from validated orders. Concurrent purchases cannot overdraw the wallet or debit an order twice.

Reserve a withdrawal atomically before calling Lenco. Timeout, lost response, or provider-ID attachment failure leaves a pending/unknown reservation for reconciliation. Reverse the reservation only on authoritative failure, exactly once. A provider acceptance followed by a local error must never release money for a second spend.

Approved buyer refunds credit the buyer's marketplace wallet, as confirmed by the user on October 13. Full and partial refund decisions must write the wallet credit/ledger and escrow/order/transaction outcome atomically and exactly once. Seller releases credit the seller's wallet under the existing payout rules. No new provider refund transfer is introduced; an uncertain collection on a terminal order remains a reconciliation concern rather than an automatic refund. Historical funding and existing credit evidence must be checked before creating another accounting effect.

One internal settlement path handles signed webhook events and authenticated status reconciliation for collections, top-ups, aggregate checkouts, and withdrawals. It compares the provider result to the persisted intent and performs accounting atomically. Duplicate delivery, webhook/poll races, and out-of-order attachment cannot create another credit, debit, escrow, reversal, or notification. A late response cannot regress a terminal state. Because scheduled reconciliation alone can settle every operation, a delayed webhook delays settlement but does not threaten correctness.

Keep cancelled/refunded orders terminal when money arrives late; record the received payment and flag reconciliation instead of resurrecting the order or automatically issuing an unapproved refund. Reconcile pending/unknown operations after 30 seconds, 1 minute, 2 minutes, 5 minutes, 15 minutes, and 30 minutes, then hourly up to 24 hours. Exhaustion sets review-needed and retains unresolved withdrawal reservations instead of refunding them or silently retrying forever.

Generic transaction/accounting, wallet credit/debit/settlement, escrow, and `markPaidByWallet` functions are already internal after containment and stay internal. Keep authenticated owner wallet queries/creation and authenticated admin freeze controls. Replace web checkout's paused debit/mark-paid flow with the atomic purchase function. Escrow release and refund are reachable only through authenticated order, dispute, and staff actions.

## Historical compatibility and schema

Use additive, optional fields and indexes for request IDs, immutable provider references/IDs, accounting markers, linked wallet-ledger records, and the version-gate and payment-availability configuration. Add minimal durable webhook/reconciliation records as needed; card sessions are excluded. Do not require a destructive data migration or rewrite existing records in bulk.

Historical collection matching supports provider ID, `TXN-`/`TOP-` references, `metadata.topUp`, `checkoutOrderIds`, and legacy `orderIds`. Withdrawal matching supports provider ID and legacy `externalReference` values as well as the new immutable reference. A `WDR-` provider reference is not the existing `WLT-` wallet reference.

Absence of a new accounting marker on an old successful top-up never proves that it is uncredited. Search existing completed wallet credits matching the provider collection ID, account, source, and amount. Existing matching evidence prevents another credit. Conflicting or multiple evidence is flagged for separate reconciliation, not repaired automatically.

## Card exclusion

Card payments are inactive and outside this migration. Keep card controls disabled or hidden, remove their client transport when retiring the generic API service, and expose no new Convex card initiation action. Historical records are not rewritten or discarded merely because their type is outside new initiation scope.

## Managed configuration and webhook cutover

Move the OpenAI key/model and the existing Lenco private bearer, account ID, base URL, and verified webhook hash key into Convex environment management without printing or writing their values to Git or release evidence. Configure and verify the production Clerk issuer/audience, AI usage limits, minimum build numbers, and payment availability. The non-card provider adapter uses the existing Lenco bearer token and debit account ID; it derives the signature key from the bearer token and has no separate card credential requirement.

Add a signed Convex `/lenco-webhook` HTTP action. Verify the signature over the exact raw body using the confirmed HMAC-SHA512 scheme keyed with the UTF-8 SHA256 hexadecimal digest of the API token. Reject absent/invalid signatures before parsing or writing. Normalize the confirmed successful/failed collection and transfer events. Acknowledge only after settlement or durable ingestion; persistence failures return an error so provider retries remain possible. Retain only necessary normalized event data and redact logs.

### Cutover sequence

The maintenance window runs from containment step 2 (Railway stopped) until step 9 below. Payments stay off throughout.

1. Deploy the migration to production Convex with payment availability **off**, and the minimum supported builds still at the current tester builds.
2. Configure the production environment (above) and verify configuration health without printing values.
3. Verify the signed `/lenco-webhook` endpoint in production with invalid-signature rejection and a signed unhandled event.
4. Change the Lenco dashboard webhook destination to Convex, verify the change, and record the previous destination privately. Lenco dashboard access is a prerequisite: if it is unavailable, the cutover stops here with payments off. The migration is not claimed as live.
5. Deploy the matching web revision (payments still show as unavailable).
6. Build iOS and Android from the cutover revision and publish them to TestFlight Internal and Google Play internal testing. Wait until Apple processing completes and both builds are available to testers.
7. Set the minimum supported builds to the new build numbers. New builds below the minimum show the update screen. Already-installed older builds predate the gate, so they cannot show it; their payment and Pinkie calls keep failing closed, and testers are told directly to update.
8. Settle every pending operation from the containment inventory through status reconciliation. Run the financial reconciliation and the privileged-account verification as gates. Every discrepancy, unattributed receipt, and unconfirmed privileged account is either explicitly accepted by the user or left blocking.
9. Run the production smoke checks, then turn payment availability **on**. This ends the maintenance window.

Railway stays stopped (not deleted) after the cutover until the drain is proven: no pending operation still depends on it and no webhook still targets it. Shutting down the provider account is a separate decision; source migration alone is insufficient evidence.

## Components and files

- `convex/wallet.ts`, `convex/transactions.ts`, `convex/escrow.ts`, `convex/orders.ts` (`markPaidByWallet`), `convex/loyalty.ts` (`awardPoints`), `apps/mobile/src/hooks/useWallet.ts`, `convex/users.ts` (`updateUserRole`, `toggleUserBan`), `convex/seed.ts` (`createInitialAdmin`), the mobile and web admin freeze and user screens, and web checkout: containment (internal functions; payments and freeze controls paused).
- `convex/auth.config.ts` and a small `convex/lib/auth.ts`: Clerk verification and subject/role checks.
- `convex/appConfig.ts` (or the existing platform configuration module): minimum supported builds and payment availability.
- `convex/ai.ts`, `convex/aiData.ts`, and focused provider/prompt/result helpers: AI actions and internal authorized reads/writes; shared identity/contracts under `packages/shared/src`.
- `convex/payments.ts`, payment operation/settlement helpers, and a typed Lenco adapter: external orchestration, reservation, and reconciliation.
- `convex/http.ts` and a focused checkout-page helper: signed Lenco webhook; retain the verified Clerk webhook.
- `convex/schema.ts`, `orders.ts`, `loyalty.ts`, `promotions.ts`, shared actor guards, user-role/self-sync/bootstrap functions, and AI result persistence: additive state, authoritative quotes, atomic accounting, and trust prerequisites.
- Mobile Convex/auth providers, version gate and payment-availability UI, API/payment/wallet services and hooks, AI callers, checkout/wallet browser flows, runtime/build configuration, and public env examples.
- Web AI callers, consent utility, account-sync hook, payment-availability UI, and checkout; the matching web deployment is part of the cutover.
- Root scripts and scoped lint/format/editor configuration: explicitly typecheck Convex, verify new/touched code, and exclude generated sources and private artifacts. Preserve established compatible formatting and avoid unrelated repository-wide formatting.
- Release/runbook documentation: configuration, legacy-client impact, webhook change, verification, rollback, and exact store targets.

## Verification and release acceptance

Containment: tests prove that each listed mutation is no longer callable through the public API and that internal callers still work. Production checks confirm that the Railway endpoints no longer respond, that public calls to every listed function are rejected, and that web checkout and the freeze, role, and ban controls show the paused message. The operation inventory is captured and the first financial reconciliation result is reported, both privately.

Migration: use TDD and mocked provider boundaries. Convex integration tests must exercise real registered actions and mutations with authenticated/anonymous identities and mocked fetch, not only pure helpers. Cover:

- **Identity and access:** forged actors/roles, banned/deleted users, guest/private separation, consent.
- **AI outputs:** malformed model/provider output, stale moderation results.
- **Payments:** tampered prices, duplicate request IDs/orders, concurrent debits, duplicate/out-of-order webhooks, webhook-before-attachment, timeout after acceptance, reversal once, historical credit evidence, legacy withdrawal matching, aggregate poll settlement, terminal-order late success.
- **Gates:** version gate thresholds, payment-availability off/on behavior.

Run all existing typechecks, app-review and API tests, lint and build gates, plus Convex typecheck and migration tests. Run formatting checks on touched code. Verify the resulting EAS upload archive has no secrets/private evidence and no Railway runtime dependency. Independently review the migration before the cutover.

Production smoke checks may verify configuration, rejected unauthorized requests, invalid webhook rejection, signed unhandled-event handling, and deterministic Pinkie identity without executing a real charge or withdrawal. Verify a real authenticated test session for identity, account access, and guest behavior. Use mocked/sandbox payment checks with explicitly controlled test data; actual provider payment success remains a separate acceptance boundary if a sandbox or authorized transaction is unavailable. Follow the cutover sequence above. Builds use greater unused build numbers. Verify organization iOS bundle/team/runtime and Android package/upload signer from the actual artifacts. Publish to the existing TestFlight Internal group and Android internal group, preserving testers. Confirm Apple processing, beta availability, and Play's active version code before raising the minimum builds. Turn payment availability on only after inventory settlement, the financial reconciliation and privileged-account gates, and these checks pass. Public store release and App Review submission are outside this task.

## Rollback

Preserve the audited source revision and private provider configuration evidence. Keep schema changes additive.

Containment is not rolled back. Re-exposing public accounting writes or restarting the Railway service against them is not an acceptable recovery. Before the cutover, rollback is source/config rollback with payments paused and the old tester releases still installed.

After financial operations start, the first lever is turning payment availability off: new initiation stops while settlement and reconciliation continue. Preserve new operation, reservation, and accounting markers and continue signed event processing; never redeploy old duplicate-credit or blind-reversal behavior as a rollback. Publish a forward fix rather than reverting the app transport, because reverting it alone does not restore a safe backend. Do not change the callback destination until its replacement can process both old and new operation references. Keep the Railway project, stopped, until callback drain is proved; billing remains a separate account matter.

## Primary technical references

- [Convex actions and transaction boundaries](https://docs.convex.dev/functions/actions)
- [Convex Clerk integration](https://docs.convex.dev/auth/clerk)
- [Convex internal functions](https://docs.convex.dev/functions/internal-functions)
- [Convex HTTP actions](https://docs.convex.dev/functions/http-actions)
- [Convex testing](https://docs.convex.dev/testing/convex-test)
- [Lenco webhooks and signing](https://lenco-api.readme.io/v2.0/reference/webhooks)
- [Lenco bank transfers](https://lenco-api.readme.io/v2.0/reference/initiate-transfer-to-bank-account)

Non-card contract sources: [mobile-money collections](https://lenco-api.readme.io/v2.0/reference/initiate-collection-from-mobile-money), [mobile-money transfers](https://lenco-api.readme.io/v2.0/reference/initiate-transfer-to-mobile-money), [collection status](https://lenco-api.readme.io/v2.0/reference/get-collection-by-reference), and [transfer status](https://lenco-api.readme.io/v2.0/reference/get-transfer-by-reference). Retrieved October 13, 2026; sandbox behavior and live provider acceptance remain unverified.
