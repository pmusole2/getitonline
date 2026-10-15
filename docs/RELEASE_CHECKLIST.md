# Release Checklist

Architecture: Convex-only. The Railway-hosted NestJS API (`apps/api`) is being retired by the [Convex API migration](superpowers/specs/2026-10-07-convex-api-migration-design.md). Until the cutover, the plan is to stop the Railway service (containment step 2) and keep payments off. Whether that has happened is a prerequisite to confirm (section 0), not a fact recorded here. Nothing in this checklist has been run against production. Result fields are blank until the check is actually performed for the release revision.

## 0. Prerequisites to confirm

Each item is a condition to check before the release, not a statement that it holds. Leave the evidence column blank until someone performs the check for the release revision. Record names and outcomes only, never values.

| Prerequisite                                                                                              | How to confirm                                                                     | Evidence |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------- |
| Railway service state: stopped, not deleted (containment step 2)                                          | Railway dashboard, then confirm its health and payment endpoints no longer respond |          |
| Production Clerk instance has a JWT template named `convex` whose issuer equals `CLERK_JWT_ISSUER_DOMAIN` | Clerk dashboard, JWT templates, compare the issuer                                 |          |
| Clerk webhook destination                                                                                 | Clerk dashboard, webhook endpoints; record the previous destination privately      |          |
| Convex deployment environment names are set (section 1.1)                                                 | Convex dashboard, names only                                                       |          |
| EAS production environment names are set (section 1.1)                                                    | EAS dashboard, names only                                                          |          |

Milestone labels refer to the migration spec: M1 authentication, minimum-version gate and payment switch; M2 Pinkie and AI on Convex; M3 payments, wallets, settlement and the signed Lenco webhook. Cards are inactive and excluded from this migration by the October 13 scope decision.

## 1. Convex configuration

### 1.1 Environment variables (names only)

Values never go in Git, docs, logs or release evidence. Set them in the Convex dashboard for the target deployment, so values stay out of shell history.

| Name                                                           | Where it is set                                                     | Read by                                                                                                                         | Needed for              | Milestone     |
| -------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------- |
| `CLERK_JWT_ISSUER_DOMAIN`                                      | Convex deployment environment, from the Clerk `convex` JWT template | `convex/auth.config.ts` (the deploy fails when it is missing)                                                                   | Every deployment        | M1            |
| `CLERK_WEBHOOK_SIGNING_SECRET`                                 | Convex deployment environment, from the Clerk webhook endpoint      | `convex/lib/clerkWebhook.ts`, used by the `/clerk-webhook` route in `convex/http.ts`                                            | Clerk user sync         | M1 (retained) |
| `OPENAI_API_KEY`                                               | Convex deployment environment                                       | `convex/lib/aiProvider.ts`; when missing, provider calls fail closed                                                            | Pinkie and AI features  | M2            |
| `OPENAI_MODEL`                                                 | Convex deployment environment (optional)                            | `convex/lib/aiProvider.ts`; default `gpt-4o-mini`                                                                               | Optional model override | M2            |
| `LENCO_API_KEY`, `LENCO_ACCOUNT_ID`, optional `LENCO_BASE_URL` | Convex deployment environment                                       | Provider operations, checkout collection and payment reconciliation; the webhook derives its signature key from `LENCO_API_KEY` | Payments                | M3            |

Mobile build-time variables (set per EAS environment; `eas.json` profiles use `"environment": "production"` for store builds):

| Name                                            | Where it is set                | Read by                                                                                    | Status                              |
| ----------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------- |
| `EXPO_PUBLIC_APP_ENV`                           | Set by each `eas.json` profile | `app.config.ts`, `src/config/runtime.ts`                                                   | Required for production builds      |
| `EXPO_PUBLIC_CONVEX_URL`                        | EAS production environment     | `app.config.ts`, `src/config/runtime.ts`                                                   | Required for production builds      |
| `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`             | EAS production environment     | `app.config.ts`, `src/config/runtime.ts`                                                   | Required for production builds      |
| `EXPO_PUBLIC_API_URL`                           | Retired configuration          | Not read or required by the mobile build/runtime; the legacy HTTP service has been removed | Do not add it to new release builds |
| `EAS_PROJECT_ID` / `EXPO_PUBLIC_EAS_PROJECT_ID` | Optional                       | `app.config.ts` (has a default)                                                            | Not required                        |

Configuration rows (Convex table `appConfig`, singleton) are not environment variables. See section 2.

### 1.2 Clerk

- Prerequisite (section 0): the production Clerk instance has a JWT template named `convex`, and its issuer domain equals `CLERK_JWT_ISSUER_DOMAIN`. `convex/auth.config.ts` uses `applicationID: "convex"`.
- Tokens from a real session must validate on the Convex deployment (development-session check, section 8).
- Clerk webhook endpoint: if Clerk currently sends user events to Railway, repoint it to the production Convex HTTP route `/clerk-webhook` (on the deployment's `.convex.site` host; confirm the host in the Convex dashboard). Record the previous destination in private release evidence. Verify with a real signed event and a tampered body (section 8).

### 1.3 Minimum-version gate and payment availability

Both live in the `appConfig` singleton row, managed by `convex/appConfig.ts`:

- `getClientGate(platform, build)` (public query) returns `updateRequired` when `build` is below `minimumBuilds[platform]`, plus the store URL and `paymentsEnabled`.
- `getPaymentAvailability` (public query) returns `paymentsEnabled`. It is `false` when no row exists.
- `paymentsEnabled` defaults to `false` when absent.
- The first write must include `minimumBuilds` for both platforms. Each build number must be a positive integer.
- Store URLs must be `https` with no embedded credentials. A platform left out of an update keeps its stored URL.
- `applyAppConfig` is an internal mutation, so no client can call it. It is run from a shell.

Operator commands. Verify the argument names against `convex/appConfig.ts` before running them. Add the production deployment selector your CLI version expects (check `npx convex run --help`). Replace each `<...>` placeholder with a real value.

```sh
# First-time setup: minimum builds set to the current tester builds; payments stay off
npx convex run appConfig:applyAppConfig '{"minimumBuilds":{"ios":<current-ios-build>,"android":<current-android-build>},"storeUrls":{"ios":"<confirm-app-store-url>","android":"<confirm-play-store-url>"},"paymentsEnabled":false}'

# Raise the minimum only after the new builds are processed and available to testers
npx convex run appConfig:applyAppConfig '{"minimumBuilds":{"ios":<new-ios-build>,"android":<new-android-build>}}'

# Enable payments only after the cutover gates in section 3 pass
npx convex run appConfig:applyAppConfig '{"paymentsEnabled":true}'

# EMERGENCY: stop new payment initiation (settlement and reconciliation keep running)
npx convex run appConfig:applyAppConfig '{"paymentsEnabled":false}'
```

The AI usage limits are configured through the optional `aiLimits` field of the `appConfig` row (`convex/schema.ts`). Defaults are in `convex/lib/aiLimits.ts`:

- global: 1,000 per day, 100 per minute
- account: 100 per day, 10 per minute
- allGuests: 200 per day, 20 per minute
- guest: 20 per day, 5 per minute

Each override must be a positive safe integer. Anything else keeps its default. **`applyAppConfig` does not accept `aiLimits` today**, so overrides can only be set by editing the row in the Convex dashboard until an operator argument is added.

## 2. Store targets (from the repository configuration)

These values are read from `apps/mobile/app.config.ts` and `apps/mobile/eas.json`. Confirm them in App Store Connect and Google Play Console before the cutover.

| Target                             | Value                                                                                                | Source                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| iOS bundle identifier              | `com.getitonline.app`                                                                                | `app.config.ts`                             |
| Apple team                         | `5THHD5US74`                                                                                         | `app.config.ts`, `eas.json`                 |
| App Store Connect app ID           | `6816962475`                                                                                         | `eas.json` `submit.production.ios.ascAppId` |
| iOS EAS build profile for store    | `organization-ios` (extends `production`; channel `getitonline-organization`; scheme `Gettitonline`) | `eas.json`                                  |
| iOS TestFlight group               | The existing organization TestFlight Internal group (group name not recorded in the repo)            | Spec                                        |
| iOS URL scheme                     | `getitonline`                                                                                        | `app.config.ts`                             |
| Android package                    | `com.gettitonline.app`                                                                               | `app.config.ts`                             |
| Android EAS profile for Play       | `production` (no `buildType`, so an app bundle); submit track `internal`, `releaseStatus: completed` | `eas.json`                                  |
| Android internal test APK          | `internal-test` profile (`buildType: apk`). This is a sideload build, not the Play upload            | `eas.json`                                  |
| Google Play internal testing group | The existing internal testing group (name not recorded in the repo)                                  | Spec                                        |
| Android URL scheme                 | `gettitonline`                                                                                       | `app.config.ts`                             |

Note: the iOS bundle identifier and the Android package differ by one letter (`getitonline` and `gettitonline`). Both are existing values. Do not change them as part of a release.

The checked-in Android Gradle release block uses the committed debug keystore (`android/app/build.gradle`, `signingConfig signingConfigs.debug`). Who signs an EAS artifact is a separate question, and it must be verified before any change (section 9).

## 3. Cutover sequence and containment

Containment (production, executed only after user confirmation, spec section "Immediate financial containment"):

1. Export the operation inventory (read-only) to private release evidence.
2. Stop the Railway service (keep the project). Verify that its health and payment endpoints no longer respond. Re-run step 1.
3. Convert the listed accounting mutations to internal functions and update their callers.
4. Pause web payments and the freeze, role and ban controls with a "temporarily unavailable" message. Deploy the web change with the Convex change.

The maintenance window runs from containment step 2 until cutover step 9. Payments stay off throughout.

Cutover (spec, "Cutover sequence"):

1. Deploy the migration to production Convex with payment availability **off** and the minimum builds still at the current tester builds.
2. Configure the production environment (section 1). Verify configuration health without printing values.
3. Verify the signed `/lenco-webhook` endpoint in production with invalid-signature rejection and a signed unhandled event. The route is registered in `convex/http.ts`; source presence does not prove deployment or provider callback configuration.
4. Change the Lenco dashboard webhook destination to Convex. Verify the change. Record the previous destination privately. If Lenco dashboard access is unavailable, stop here with payments off. The migration is not live.
5. Deploy the matching web revision (payments still show as unavailable).
6. Build iOS and Android from the cutover revision and publish them to TestFlight Internal and Google Play internal testing. Wait until Apple processing completes and both builds are available to testers.
7. Set the minimum supported builds to the new build numbers (section 1.3).
8. Settle every pending operation from the containment inventory through status reconciliation. Run the financial reconciliation and the privileged-account verification as gates. Every discrepancy, unattributed receipt and unconfirmed privileged account must be explicitly accepted by the user or left blocking.
9. Run the production smoke checks, then turn payment availability on (`paymentsEnabled: true`). This ends the maintenance window.

Railway stays stopped, not deleted, until the callback drain is proven. Cancelling the provider account is a separate decision.

## 4. Rollback levers

- **Before the cutover:** source and configuration rollback, with payments paused and the old tester releases still installed. Containment is not rolled back. Re-exposing public accounting writes or restarting Railway against them is not an acceptable recovery.
- **After financial operations start:** the first lever is `paymentsEnabled: false` (section 1.3). New initiation stops; settlement and reconciliation continue. Keep new operation and accounting records, and keep processing signed events. Do not redeploy old duplicate-credit or blind-reversal behaviour. Publish a forward fix instead.
- Do not change the webhook callback destination until its replacement can process both old and new operation references.
- Keep the Railway project stopped until the callback drain is proven.

## 5. Legacy-client impact (testers)

Builds installed before the minimum-version gate cannot read it. After containment they cannot make payments, top-ups, withdrawals or Pinkie calls, and those calls fail closed. The rest of the app keeps working on Convex.

Tester message draft (review wording before sending, and do not add links that are not verified):

> The payment and Pinkie features have moved to a new backend. Please update Getitonline from the store to the newest build. Until you update, payments, top-ups, withdrawals and Pinkie are unavailable. The rest of the marketplace should keep working. Confirm this on a test build before sending.

## 6. Automated checks

Existing root scripts (`package.json`):

- `npm run typecheck` (shared, api, web, mobile, then `typecheck:convex`)
- `npm run lint` (api, web)
- `npm run test` (api workspace)
- `npm run test:app-review` (AI, auth, account, payment-availability and Convex tests; it also runs `scripts/verify-eas-archive.test.mjs`)
- `npm run build --workspace=apps/api` and `npm run build --workspace=apps/web` (api build is legacy until `apps/api` is retired)
- Scoped lint and format checks: `lint:account-safety`, `lint:mobile-access`, `lint:staff-access`, `lint:behavior-events`, `lint:ai-identity`, `lint:test-support`, and their `format:*:check` counterparts

Convex and archive-check scripts (present in `package.json`):

- `npm run typecheck:convex`: strict Convex typecheck using `convex/tsconfig.json`
- `npm run verify:eas-archive -- <target>` and `npm run verify:eas-archive:strict -- <target>`: archive checks (section 8)
- `npm run lint:scripts` and `npm run format:scripts:check`: lint and format checks for `scripts/verify-eas-archive*.mjs`

## 7. Manual flows

Account and sign-in:

- Sign up on mobile and sign in on mobile
- Confirm the user is created or updated in Convex
- Confirm banned and deleted accounts are refused (section 8)

Listings and discovery:

- Create a listing on mobile with multiple uploaded images
- Create a listing on web with browser-based image uploads
- Confirm the saved product has real public Convex URLs
- Browse categories, search products, open product detail

Checkout and wallet (payments off until section 3 step 9):

- Add a product to the cart, select shipping, place an order
- With payments off, confirm "payments temporarily unavailable" is shown, not a transport error
- Top up and withdraw only after payments are on, and only with authorised test data

Payments through Convex (replaces the removed Railway flow, M3):

- Initiate a payment through the Convex actions, not an API URL
- Confirm the signed Lenco webhook is accepted and an invalid signature is refused
- Confirm a successful event updates transaction state exactly once

Order lifecycle: paid, processing, shipped, delivered, completed.

Conversation and dispute: start a conversation, send a message, create a dispute, review dispute details and chat flow.

## 8. Verification evidence to record

Record each result with the date, the revision, the command and the output summary. Do not record secrets, tokens or private identifiers. None of the rows below has been performed for this revision.

| Check                                    | How                                                                                                   | Evidence to record                                         | Result |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------ |
| Convex typecheck                         | `npm run typecheck:convex`                                                                            | Exit code and error count                                  |        |
| Scoped lint and format                   | The `lint:*` and `format:*:check` scripts for touched areas                                           | Exit codes                                                 |        |
| App-review tests                         | `npm run test:app-review`                                                                             | Test counts and failures                                   |        |
| Clerk webhook, signed and tampered       | `convex/lib/clerkWebhook.test.ts` (unit); dev deployment with a real signed event and a modified body | Accepted and refused outcomes                              |        |
| Lenco webhook, signed and tampered (M3)  | Not yet in the repo                                                                                   | Not applicable until M3                                    |        |
| Archive verification                     | `npm run verify:eas-archive:strict -- <archive or EAS inspect output>`                                | Summary only (counts and rule names), with no matched text |        |
| Real authenticated session (development) | Sign in on a development build; confirm identity maps to the account                                  | Account ID and outcome, no token                           |        |
| Guest session (development)              | Use guest catalog chat and image search after consent                                                 | Consent and limit outcome                                  |        |
| Banned account (development)             | Ban a test account; attempt an authenticated call                                                     | Refusal outcome                                            |        |
| Deleted account (development)            | Delete a test account; attempt an authenticated call                                                  | Refusal outcome                                            |        |
| Mismatched subject (development)         | Send an account ID that does not match the token subject                                              | Refusal outcome                                            |        |
| Staff restrictions (development)         | Non-staff and moderator attempts at admin-only actions                                                | Refusal outcome per role                                   |        |
| Installed-build gate (real build)        | Install a build below the minimum; then one at or above it                                            | Update screen and store link, then normal launch           |        |

Production smoke checks (spec, "Verification and release acceptance"): configuration health; rejected unauthorised requests; invalid webhook rejected; signed unhandled event handled; deterministic Pinkie identity. No real charge or withdrawal is made. Actual provider payment success stays a separate acceptance boundary.

Archive check notes:

- `scripts/verify-eas-archive.mjs` reads a directory or an archive (`.tar`, `.tar.gz`, `.tgz`). It fails on environment files (except `.env.example`), private keys and keystores (including the committed `debug.keystore`, on purpose), provisioning profiles, service-account and store-credential files, private evidence locations (`.superpowers/`, `/artifacts/`), app binaries, `.git`, a root `node_modules` or a nested dependency tree (a folder holding `.bin` or an installed package), and secret-looking content. Railway and localhost API references are warnings unless `--strict-no-railway` is passed.
- Archive contents are scanned while the extracted files exist, so an archive gets the same findings as the equivalent directory.
- Anything the check cannot fully inspect is a FAIL with rule `incomplete-inspection`, never a pass: a text file over `--max-file-bytes` (default 32 MiB), an unreadable file, a file discovered in a directory, `--list` or archive that disappears before it is read (in every mode, including a `--list` entry that does not exist), a file that changes during inspection (`changed-during-inspection`), a platform without `O_NOFOLLOW` (`no-nofollow`, which fails closed), a `--list` entry that names a directory (for example `missing.ts/` or `src`), a non-regular entry (FIFO, socket, device or directory) in the upload set, more files than `--max-files` (default 20000), a total over `--max-total-bytes` (default 1 GiB), an archive link or special entry (links are not extracted), or an upload set with zero files (an empty directory or a `--list` with no entries). Non-regular entries are reported without being opened. Binary files (NUL bytes in the first 8 KiB) are recorded as `skipped-binary` info.
- A symbolic link is followed to its real path. If the target is a regular file inside the target root, it is scanned and findings are reported under the link's path. A link whose target is outside the root, or is not a regular file, is a FAIL (`path-escape` or `incomplete-inspection`), never a warning. Absolute paths, `..` entries and paths that resolve outside the target are `path-escape` FAILs and are not read.
- Each text file is opened with `O_NOFOLLOW` and `O_NONBLOCK`, so a symbolic link or FIFO that replaces a file after its check is never followed or blocked on. Before any byte is read, the opened descriptor must be a regular file with the same device and inode that the earlier `lstat` saw, and the path must still resolve to the same real path. Any mismatch is a `changed-during-inspection` FAIL, and the content is not scanned. Platforms without `O_NOFOLLOW` fail closed with `no-nofollow`.
- Honest limit: a hostile local process that can write to the upload set can still change a file's bytes between reads of that same file. The verifier cannot prevent this, and it reports only what it read. Archive extraction happens in a private temporary directory that is removed afterwards, and the archive is not extracted into the working tree.
- Output shows paths and rule names only. Secret-shaped text in file or member names is masked, and so are long high-entropy path tokens, so some hash-like names appear as `[redacted]`.
- A directory argument checks everything on disk, including ignored local files such as `.env` and `node_modules`, so a developer checkout will report them. Use an archive, the output of `eas build:inspect -s archive`, or a `--list` of the files EAS would send for the release gate. Confirm with `eas build:inspect --help` which root EAS uploads for this monorepo (the project directory or the repository root).
- Ignore rules alone are not evidence. The gate checks the files themselves.

## 9. Known blockers at this revision

- **Android signing (two separate questions):**
  - _Checked-in Gradle config._ `apps/mobile/android/app/build.gradle` (line 115) has `release { signingConfig signingConfigs.debug }`, and `signingConfigs.debug` points at the committed `android/app/debug.keystore`. Git tracks that file. `.gitignore` covers `*.jks`, `*.p12`, `*.p8` and `*.key` but not `*.keystore`. This is a standalone-build hazard: a local Gradle release build would be signed with the debug key. It says nothing about what an EAS cloud build signs with.
  - _EAS-injected release credentials._ EAS cloud builds are expected to override the Gradle signing config with the release credentials EAS stores. That expectation is unverified here.
  - _Verification before any change._ Do not change `build.gradle`, remove the keystore from the upload set, or add a signing config until the actual signer of an EAS artifact is verified against the established Play upload certificate. Verification steps (not run by this document; record outcomes in release evidence, never the keystore or its passwords):
    1. Get the upload certificate fingerprint (SHA-1 and SHA-256) registered in the Google Play Console for the app.
    2. Show the upload key EAS uses for the production Android profile with `eas credentials` (interactive, Android, production profile). Compare its SHA-256 fingerprint with step 1.
    3. For the built `.aab`: `keytool -printcert -jarfile <file.aab>`. For an `.apk`: `apksigner verify --print-certs <file.apk>`. Compare the signer's SHA-256 digest with step 1. A certificate named `CN=Android Debug` is a failure.
  - The verifier flags the tracked debug keystore on purpose (`private-key-file` on `android/app/debug.keystore`). Do not suppress that finding to get a pass.
  - Resolve this before Play submission by using an upload key managed by EAS credentials, then remove the committed file from the upload set. Do not add an `apps/mobile/.easignore` before this decision: EAS treats `.easignore` as a replacement for `.gitignore`, so a partial file would expose `.env` and `node_modules`.
- **Runtime dependency gate:** `EXPO_PUBLIC_API_URL` is retired. Verify the actual EAS upload archive with `--strict-no-railway` before each release; passing source checks alone does not establish the uploaded contents.
- **Localhost API fallback:** `app.config.ts` and `src/services/api.ts` use `http://localhost:3001` as a fallback.
- **Lenco names:** no Lenco environment variable name is defined in the repo yet (M3).
- **`aiLimits`:** cannot be set through `applyAppConfig` (section 1.3).
- **Root `README.md`:** still documents Railway as the API host. It is outside this slice and must be updated before the cutover.
