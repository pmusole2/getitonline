# Convex API Migration Design

Status: proposed for user review; implementation has not started.

## Goal and agreed intent

The user selected migration of all remaining Railway API calls to Convex before completing the mobile releases. Pinkie, payment initiation, payment reconciliation, wallet operations, and payment webhooks will execute on the existing Convex project. OpenAI and Lenco remain their respective external providers. Fresh builds will go to the existing organization TestFlight Internal group and Google Play internal testing group.

The repository audit and push are complete at `1a1c9c6b3c54abe684e99f2ef83509e30ad682b7`. The Railway-dependent Android build 13 and iOS build 2 submission were canceled and their cancellation was verified. The previous tester releases remain active. The finished iOS build 2 is retained as an unused artifact.

## Assumptions and scope

- Preserve the existing marketplace features, mobile response shapes, payment references, order records, balances, and Pinkie identity and ghostwriting rules.
- Include the web's remaining AI calls and direct wallet checkout writes because otherwise the shared backend cannot safely retire the old public accounting functions.
- Add the authentication and financial boundary checks required for the migrated flows. Do not turn this into an unrelated redesign or a complete audit of every marketplace feature.
- Do not repair historical balances, replay historical payments, or execute real payment or withdrawal tests. Those actions require separately defined record and transaction scope.
- Existing native tester versions will need updating when the authenticated payment cutover occurs. They currently cannot provide Convex authentication. Retaining unauthenticated accounting writes for old-client compatibility is unacceptable.
- Use existing managed credentials privately. Verify the distinct Lenco public widget key before enabling card payment. Never substitute the private bearer token for a public key.
- Keep the Railway project available until the payment callback destination and pending-operation drain are verified. This design neither purchases a Railway plan nor deletes the project or cancels its subscription.

## Approach choice

**Recommended: native Convex actions and queries.** The clients use generated, typed function references through their authenticated Convex client. Actions call OpenAI or Lenco; internal queries and mutations enforce access and apply database changes. This removes the extra hosting dependency and retains the database's transaction guarantees.

A Convex HTTP facade resembling NestJS would reduce some client edits but retain a second transport/authentication contract. It also cannot inherit the existing Railway-owned hostname, so it would not avoid updating old native clients. A temporary Railway compatibility bridge would require deploying to the billing-blocked service and would preserve the dependency the user asked to remove. Neither is the selected design.

## Authentication and client integration

Configure the existing production Clerk issuer and `convex` JWT audience in `convex/auth.config.ts`. Verify that the production Clerk JWT template exists and that tokens validate. Replace mobile's plain Convex provider with `ConvexProviderWithClerk`; web already uses that provider. Wait for Convex authentication readiness before account synchronization and authenticated queries.

The server maps the verified Clerk subject to the user record. It rejects missing identity, deleted or banned users, mismatched account IDs, and unauthorized staff requests. Supplied `userId`, `adminId`, `reviewerId`, and `viewerRole` values do not grant authority. Use the existing `admin` and `moderator` review-role policy.

Protect role changes and ban changes with the actual authenticated admin. Make initial-admin bootstrap internal. Split subject-bound public profile synchronization from verified Clerk webhook upsert. Bind shared catalog/reviewer/admin actor guards to the authenticated subject so callers cannot change prices or promotions by submitting somebody else's privileged ID. These checks are prerequisites for trusting stored roles and prices; they are not optional adjacent cleanup.

Replace the mobile HTTP service implementations with typed service hooks bound to the current Convex client. Preserve their public result shapes where practical. Remove generic HTTP get/post access and the required `EXPO_PUBLIC_API_URL` configuration, localhost fallbacks, and API URL logging. Account switching must clear account-specific state and discard results issued for a previous account. Migrate the web's visual-search and listing-moderation callers as well.

## Pinkie and AI behavior

Port chat, personalized recommendations, similar products, visual search, message rephrasing, response suggestions, dispute analysis, listing moderation, resolution drafts, and truthful configuration health.

- Share the existing identity helper between clients, Convex, and any retained legacy source. Deterministic identity questions return Pinkie's introduction without a provider call. Preserve quoted speech and the existing ghostwriting exclusion.
- Preserve guest catalog chat, similar products, and image search after version-2 consent. Guest requests cannot select another account or obtain private order/dispute context.
- Require authenticated accounts for recommendations and participant/staff authorization for disputes and drafts. Fetch moderation input from the stored listing and recheck its revision and reviewer permissions before saving.
- Preserve the minimized chat context: public product/catalog facts and authorized aggregate activity. Do not revive the unused comprehensive order-context builder containing contact, address, payment, or message details.
- Keep image input bounded to the current 500,000-character data URL limit, validate supported image encodings, cap history/context, and validate all model outputs from `unknown` before use. Navigation actions must use the existing allowed types and targets.
- Keep existing non-AI fallbacks where appropriate. An unavailable model must not produce a false configured-health result or a fabricated analysis/moderation success.
- Retain mobile consent checks and add the same disclosure and account-scoped consent gate to the two web callers. Pass the current consent version with AI requests; consent is a prerequisite for provider calls, not authentication.
- Reserve model usage atomically before provider calls. Configurable defaults are 1,000 calls/day and 100/minute globally, 100/day and 10/minute per authenticated account, 200/day across all guests, and 20/day and 5/minute per guest session. Anonymous session IDs alone cannot prevent abuse; the global guest cap bounds that spending. Missing provider credentials fail closed except deterministic/fallback behavior.
- Preserve `gpt-4o-mini` as the default model, with `OPENAI_MODEL` override. Set a 30-second provider timeout and at most one transient retry. Log only safe error codes; never raw prompts, images, provider responses, or private context.

## Payment initiation and authoritative amounts

Public payment actions authenticate the payer and load the relevant order or wallet themselves. Validate finite positive money values, supported operators, bank identifiers, duplicate order IDs, order ownership and status, wallet state, and provider response shapes. Convert money to integer minor units at the provider boundary and preserve existing stored major-unit representations.

Validate checkout prices and totals server-side using current product/variant/add-on prices, configured delivery pricing, and valid promotion and loyalty rules. Authenticate loyalty ownership and restrict points issuance to authorized/internal paths. Reserve/redeem a discount against its checkout/order exactly once, rather than accepting an arbitrary client discount or a separately replayable points debit. Reject stale or tampered client quotes before payment; do not merely trust the stored `order.totalAmount`, because current order creation accepts client totals. Preserve the existing choices and show a refresh/review error when the quote changes. Previously initiated provider operations retain their recorded intent amounts; this is not a repricing or repair of historical transactions.

Create a durable intent before any external collection or transfer. Each operation has an account-scoped request ID, a persisted immutable provider reference, validated input identity, and a state. A retry reuses the operation. Reuse with different inputs is rejected. A pending operation for the same order cannot create a second collection by changing request IDs.

Use Lenco's documented mobile-money collection and transfer endpoints. Correct bank payout to `/transfers/bank-account` with `bankId`, using the provider's bank directory rather than passing an unrelated bank code. Validate the provider's success envelope, IDs, currency, decimal-string amounts and nullable fees. Use a 20-second timeout and no automatic financial POST retry. A read-only status GET may retry one transient failure using the same reference.

## Wallet accounting and settlement

Perform wallet purchase debit, wallet ledger insertion, all included order transitions, escrow holds, and notifications in one Convex mutation. Authenticate ownership and derive the total from validated orders. Concurrent purchases cannot overdraw the wallet or debit an order twice.

Reserve a withdrawal atomically before calling Lenco. Timeout, lost response, or provider-ID attachment failure leaves a pending/unknown reservation for reconciliation. Reverse the reservation only on authoritative failure, exactly once. A provider acceptance followed by a local error must never release money for a second spend.

One internal settlement path handles signed webhook events and authenticated status reconciliation for collections, top-ups, aggregate checkouts, and withdrawals. It compares the provider result to the persisted intent and performs accounting atomically. Duplicate delivery, webhook/poll races, and out-of-order attachment cannot create another credit, debit, escrow, reversal, or notification. A late response cannot regress a terminal state.

Keep cancelled/refunded orders terminal when money arrives late; record the received payment and flag reconciliation instead of resurrecting the order or automatically issuing an unapproved refund. Reconcile pending/unknown operations after 30 seconds, 1 minute, 2 minutes, 5 minutes, 15 minutes, and 30 minutes, then hourly up to 24 hours. Exhaustion sets review-needed and retains unresolved withdrawal reservations instead of refunding them or silently retrying forever.

Internalize generic transaction/accounting mutations and generic wallet credit/debit/settlement functions. Keep authenticated owner wallet queries/creation and authenticated admin freeze controls. Replace web checkout's separate debit/mark-paid calls with the atomic purchase function. Remove mobile's unused direct debit hook. Protect escrow creation as internal and authenticate its release/refund actors so it cannot bypass the new accounting boundary.

## Historical compatibility and schema

Use additive, optional fields and indexes for request IDs, immutable provider references/IDs, accounting markers, and linked wallet-ledger records. Add short-lived card sessions and minimal durable webhook/reconciliation records as needed. Do not require a destructive data migration or rewrite existing records in bulk.

Historical collection matching supports provider ID, `TXN-`/`TOP-` references, `metadata.topUp`, `checkoutOrderIds`, and legacy `orderIds`. Withdrawal matching supports provider ID and legacy `externalReference` values as well as the new immutable reference. A `WDR-` provider reference is not the existing `WLT-` wallet reference.

Absence of a new accounting marker on an old successful top-up never proves that it is uncredited. Search existing completed wallet credits matching the provider collection ID, account, source, and amount. Existing matching evidence prevents another credit. Conflicting or multiple evidence is flagged for separate reconciliation, not repaired automatically.

## Card payment and browser return

Do not introduce PAN/CVV handling. The existing email/callback-only card request does not match Lenco's documented encrypted card API.

Use the documented Lenco Inline widget on a Convex-hosted HTML checkout page. An authenticated preparation action creates the intent and a high-entropy session capability with a 15-minute page-access expiry and returns the existing payment URL result. Store the capability hash, not its raw value. The page uses only the merchant public key and server-stored reference, amount, and email, with card-only channels. Session expiry does not prove that an already-open provider checkout failed and cannot by itself reverse or cancel accounting.

Render a deliberate Pay button. Escape all dynamic HTML/script data, set a restrictive content-security policy and no-referrer/no-store headers, check expiration, and allow only the existing registered app schemes or configured first-party web return destination. Browser callbacks only trigger a status recheck; they never settle a payment.

Use the actual native schemes: `getitonline` on iOS and `gettitonline` on Android. Unify checkout and wallet top-up browser handling, open the top-up URL rather than only displaying an alert, and recheck on return, dismissal, or resume. A canceled browser does not prove payment failure.

## Managed configuration and webhook cutover

Move the OpenAI key/model and the existing Lenco private bearer, account ID, base URL, and verified webhook hash key into Convex environment management without printing or writing their values to Git or release evidence. Configure and verify the distinct `LENCO_PUBLIC_KEY`, production Clerk issuer/audience, AI usage limits, and fixed return destinations.

Add a signed Convex `/lenco-webhook` HTTP action. Verify HMAC-SHA512 over the exact raw body using the documented SHA256(API token) hash key. Reject absent/invalid signatures before parsing or writing. Normalize the documented successful/failed collection and transfer events. Acknowledge only after settlement or durable ingestion; persistence failures return an error so provider retries remain possible. Retain only necessary normalized event data and redact logs.

Deploy and verify the new Convex webhook endpoint before changing Lenco's dashboard destination. Verify the dashboard change itself and preserve the existing callback destination in private rollback evidence. Ensure the new handler can settle historical pending operations before locking legacy public writes. If the dashboard cannot be accessed, stop the cutover at that concrete blocker; do not claim the migration is live.

The old Railway API cannot call internal Convex accounting functions. Closing those public writes intentionally disables old payment initiation. Coordinate that upgrade boundary with the fresh internal builds and matching web deployment. Confirm no callbacks depend on Railway before considering provider shutdown; source migration alone is insufficient evidence.

## Components and files

- `convex/auth.config.ts` and a small `convex/lib/auth.ts`: Clerk verification and subject/role checks.
- `convex/ai.ts`, `convex/aiData.ts`, and focused provider/prompt/result helpers: AI actions and internal authorized reads/writes; shared identity/contracts under `packages/shared/src`.
- `convex/payments.ts`, payment operation/settlement helpers, and a typed Lenco adapter: external orchestration, reservation and reconciliation.
- `convex/http.ts` and a focused checkout-page helper: signed Lenco webhook and hosted card page; retain the verified Clerk webhook.
- `convex/schema.ts`, `transactions.ts`, `wallet.ts`, `orders.ts`, relevant `escrow.ts`, `loyalty.ts`, `promotions.ts`, shared actor guards, user-role/self-sync/bootstrap functions, and AI result persistence: additive state, authoritative quotes, atomic accounting, and trust prerequisites.
- Mobile Convex/auth providers, API/payment/wallet services and hooks, AI callers, checkout/wallet browser flows, runtime/build configuration, and public env examples.
- Web AI callers, consent utility, account-sync hook, and checkout; matching web deployment is part of the shared-backend cutover.
- Root scripts and scoped lint/format/editor configuration: explicitly typecheck Convex, verify new/touched code, and exclude generated sources and private artifacts. Preserve established compatible formatting and avoid unrelated repository-wide formatting.
- Release/runbook documentation: configuration, legacy-client impact, webhook change, verification, rollback, and exact store targets.

## Verification and release acceptance

Use TDD and mocked provider boundaries. Convex integration tests must exercise real registered actions and mutations with authenticated/anonymous identities and mocked fetch, not only pure helpers. Cover forged actors/roles, banned/deleted users, guest/private separation, consent, malformed model/provider output, stale moderation results, tampered prices, duplicate request IDs/orders, concurrent debits, duplicate/out-of-order webhooks, webhook-before-attachment, timeout after acceptance, reversal once, historical credit evidence, legacy withdrawal matching, aggregate poll settlement, terminal-order late success, card session expiry/escaping, and allowed return URLs.

Run all existing typechecks, app-review and API tests, lint and build gates, plus Convex typecheck and migration tests. Run formatting checks on touched code. Verify the resulting EAS upload archive has no secrets/private evidence and no active Railway runtime dependency. Independently review the migration before deployment and push.

Production smoke checks may verify configuration, rejected unauthorized requests, invalid webhook rejection, signed unhandled-event handling, and deterministic Pinkie identity without executing a real charge or withdrawal. Verify a real authenticated test session for identity, account access, and guest behavior. Use mocked/sandbox payment checks with explicitly controlled test data; actual provider payment success remains a separate acceptance boundary if a sandbox or authorized transaction is unavailable.

Only after backend/auth/webhook cutover verification, push the verified migration and build fresh artifacts with greater unused build numbers. Verify organization iOS bundle/team/runtime and Android package/upload signer from the actual artifacts. Publish to the existing TestFlight Internal group and Android internal group, preserving testers. Confirm Apple processing and beta availability and Play's active version code. Public store release and App Review submission are outside this task.

## Rollback

Preserve the audited source revision and private provider configuration evidence. Keep schema changes additive. Before cutover, rollback is source/config rollback with the old releases still active. After financial operations start, preserve new operation, reservation, and accounting markers and continue signed event processing; never redeploy old duplicate-credit or blind-reversal behavior as a rollback.

Disable new initiation if necessary, retain settlement/reconciliation, and publish a forward mobile fix. Do not change callback destination until its replacement can process both old and new operation references. Reverting the app transport alone does not restore a safe backend. Retain Railway until callback drain is proved; billing remains a separate account matter.

## Primary technical references

- [Convex actions and transaction boundaries](https://docs.convex.dev/functions/actions)
- [Convex Clerk integration](https://docs.convex.dev/auth/clerk)
- [Convex internal functions](https://docs.convex.dev/functions/internal-functions)
- [Convex HTTP actions](https://docs.convex.dev/functions/http-actions)
- [Convex testing](https://docs.convex.dev/testing/convex-test)
- [Lenco webhooks and signing](https://lenco-api.readme.io/v2.0/reference/webhooks)
- [Lenco Inline payment widget](https://lenco-api.readme.io/v2.0/reference/accept-payments)
- [Lenco bank transfers](https://lenco-api.readme.io/v2.0/reference/initiate-transfer-to-bank-account)
- [Lenco encrypted card API](https://lenco-api.readme.io/v2.0/reference/initiate-collection-from-card)
