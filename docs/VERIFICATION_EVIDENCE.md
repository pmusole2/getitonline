# PR #2 verification evidence

2026-11-06. This PR adds verification infrastructure, archive metadata checks and refund-test synchronization. The Convex migration is already on main; these checks do not establish deployment or migration completeness.

- Base: `2fa47010782c6f076afb0bc79cc752f8c5f81c95`.
- Starting remote PR head: `291ad0f38ef7c0609293be4ae9333ede3f211f12` (the reported `9eb9bf2` was stale).
- Tested working-tree snapshot: `6d510ff47b08b4e142e5c8b47e2752253bb1189a`, before this evidence-document replacement. Tracked-file hashes showed no drift during checks. Final committed verification and pushed head are recorded in raw-log metadata and the PR description.
- Runtime: Node `v24.22.1`, npm `11.19.1`, macOS `27.2`, arm64. `npm ci --ignore-scripts --no-audit --no-fund` exited 0.
- Isolated worktree: `/Users/macbookair/.t3/worktrees/Auto Marketplace/codex-getitonline-pr2-cleanup-20261106`; branch `cursor/convex-migration-verification-e111`.

## Refund synchronization and baseline

Submit's actual UI callback returns `void`. Registered Convex accounting continues through funding-proof validation and asynchronous `crypto.subtle.digest`. React `act` around the press does not establish that this detached handler has finished. The test now captures and awaits its exact registered-handler promise inside `act` before asserting accounting and UI outcomes.

Production UI, registered handlers and financial assertions are unchanged: wallet `895 -> 920.01`, refund `25.01`, proof `2501` cents, one buyer refund ledger entry, resolved alert and cleared draft. Calls remain through `api.disputes.resolveDispute`; no client provider request or NestJS route was added.

The original unmodified failure was **not reproduced naturally** locally. Attribution of the historical occurrence remains an inference. The missing completion dependency is demonstrated by a controlled probe: compute the real SHA-256 digest, hold its completion, then inspect the original assertion. It fails with `applied` undefined and wallet `895`; releasing that digest and awaiting the handler passes every original assertion. Diagnostic source/logs remain outside the repo; no digest override, delay, retry or diagnostic logging remains in the test.

Pinned main and starting PR were extracted separately and independently installed using the same runtime and commands. Their original refund UI/test source is identical.

| Same command / probe | Pinned main | Starting PR |
| --- | --- | --- |
| Full dispute test file | 104 pass, 0 fail/skip; exit 0 | 104 pass, 0 fail/skip; exit 0 |
| `npm run test:app-review` | 4208 pass, 0 fail/skip; exit 0 | 4209 pass, 0 fail/skip; exit 0 |
| Controlled original funded-refund probe | Original assertion fails; exit 1 | Original assertion fails; exit 1 |
| Controlled repaired probe | 1 pass, 0 fail/skip; exit 0 | 1 pass, 0 fail/skip; exit 0 |

Full file command: `node --import tsx --test apps/mobile/src/screens/disputes/DisputeDetailScreen.test.ts`. Focused/probe command adds `--test-name-pattern='whole decimal partial refund travels'` before the path. Each snapshot's original test was restored afterward. Raw prefixes: `baseline-{main,pr-initial}-file-independent`, `baseline-{main,pr-initial}-app-review-independent`, and `baseline-{main,pr-initial}-diagnostic[-fixed]-independent`.

## Archive detection

Before reading bytes, the opened descriptor must match lstat's regular-file status, device, inode, size and mtime. This bounded metadata comparison is **not complete TOCTOU protection**. Writes after descriptor validation and rewrites preserving the compared metadata remain outside its protection; actual Linux inode reuse was not exercised.

The size regression truncates/rewrites the same file, proving equal device/inode/fixed mtime, divergent size and rejection with `changed-during-inspection`. The mtime regression rewrites equal-length content, proving equal device/inode/size, a distinct fixed mtime and rejection. Neither relies on clock timing or sleeps.

Removing only size detection fails its regression (exit 1); removing only mtime fails its regression (exit 1); restoring both passes (exit 0). The script was restored after each mutation. Raw prefixes: `archive-root-no-size`, `archive-root-no-mtime`, `archive-root-size-mtime-pass`.

## Checks and complete raw logs

Artifacts: `/Users/macbookair/.codex/artifacts/gettitonline-pr2-20261106/`. `evidence-index.json` indexes raw results, runtime, tested tree and all 34 scoped command definitions. Every prefix below has complete `.log` stdout/stderr and `.exit` with the real child exit code. Capture uses direct redirection/subprocesses, without status-masking pipelines.

| Check | Pass / fail / skip | Exit | Raw prefix |
| --- | --- | --- | --- |
| Repaired dispute file | 104 / 0 / 0 | 0 | `refund-fixed-file` |
| Repaired focused refund, five invocations | 1 / 0 / 0 each | 0 each | `refund-fixed-focused-1` through `-5` |
| Final size/mtime regressions, twenty invocations | 2 / 0 / 0 each | 0 each | `archive-final-regression-01` through `-20` |
| `node --test scripts/verify-eas-archive.test.mjs` | 85 / 0 / 0 | 0 | `archive-root-final-full` |
| `npm run test:app-review` | 4210 / 0 / 0 | 0 | `app-review-final` |
| API tests within `npm run verify` | 16 / 0 / 0, 5 suites | 0 | `full-verify-configured` |
| All scoped checks within `npm run verify` | 34 commands: 17 lint + 17 format checks | 0 each | `full-verify-configured` |
| `npm run build --workspace=apps/web`, existing config | Build succeeds | 0 | `web-configured-build` |
| `npm run verify`, existing config | Typechecks, original lint/API tests, app-review 4210/0/0, all 34 scoped checks, API/web builds | 0 | `full-verify-configured` |

Every original verify gate, including web build, is retained; app-review and all 34 existing read-only scoped checks are added. No scoped command uses fix/write. Lockfile bytes equal pinned main; unrelated dev/devOptional churn was removed.

Exploratory failures remain visible: first cross-snapshot app-review runs shared dependency symlinks and produced two AI error-class identity failures per snapshot; independent installs passed. Those initial runs are not baseline acceptance evidence. `refund-pr-initial-app-review` captured one archive-mtime failure while temporary archive mutation experiments ran. Its exact transient script content was not pinned; it is excluded from final acceptance evidence and not attributed to the refund.

## Configuration and acceptance limits

The web README references an absent `.env.local.example`. Actual source needs `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `NEXT_PUBLIC_CONVEX_URL`. Existing authorized primary-checkout `apps/web/.env` supplied the Clerk **test** publishable key and Convex URL directly to child-process environments. No env file/private credential was copied, printed or committed; no key was invented. The installed Convex React client creates its network client lazily; this server build performs no application query.

The local missing-key build blocker is resolved for configured runs. Separate environments still need authorized configuration; the web gate remains mandatory. These are bounded local results, not a historical failure rate or a general suite-reliability claim.

Manual boundaries: authenticated device/browser flows, actual EAS archive/upload and signer verification, production/provider operations and deployment were not exercised. Merging remains the user's decision.

## Actual PR file list (6)

```text
apps/mobile/src/screens/disputes/DisputeDetailScreen.test.ts
docs/RELEASE_CHECKLIST.md
docs/VERIFICATION_EVIDENCE.md
package.json
scripts/verify-eas-archive.mjs
scripts/verify-eas-archive.test.mjs
```
