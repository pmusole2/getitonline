# EAS Archive Verifier Fix - Verification Evidence

**Branch**: `cursor/convex-migration-verification-e111`  
**Base**: `2fa4701` (main)  
**Head**: `9eb9bf2`  
**Date**: 2026-11-06 10:30 UTC

## Root Cause of Test Instability

The intermittent test failure observed in 1-2 out of 10 full app-review runs is **NOT** in the archive verifier regression test added by this PR.

**Actual failing test**: `apps/mobile/src/screens/disputes/DisputeDetailScreen.test.ts:1057`  
**Test name**: "whole decimal partial refund travels from actual reviewer UI through funded registered accounting to buyer wallet"  
**Error**: Race condition where `applied` object is falsy when expected to contain `accountingOutcome`  
**Location**: Line 1057 assertion fails: `assert.ok(typeof applied === 'object' && applied !== null && 'accountingOutcome' in applied)`

This is a **pre-existing test instability** in dispute refund processing, unrelated to the archive verifier security fix.

## Archive Verifier Regression Test Stability

**Test added**: `scripts/verify-eas-archive.test.mjs:1064`  
**Test name**: "size change is detected when inode is preserved (regression for Linux inode reuse)"  
**Method**: In-place truncate+write preserving inode while changing size  
**Assertions**: Explicitly checks dev/ino equality, size divergence, verifier failure  
**Stability**: **20/20 runs passed** (100% stable in focused testing)

The archive verifier fix and regression test are stable. The intermittent app-review suite failure is from pre-existing DisputeDetailScreen test.

## Files Changed (6 files)

```
docs/RELEASE_CHECKLIST.md           |  2 +-
docs/VERIFICATION_EVIDENCE.md       | 98 lines
package-lock.json                   | 14 changes (dev→devOptional)
package.json                        |  3 +-
scripts/verify-eas-archive.mjs      | 12 +++--
scripts/verify-eas-archive.test.mjs | 33 ++++++-
6 files, 142 insertions(+), 14 deletions(-)
```

**Package lock**: Nonfunctional dev→devOptional metadata churn for @types/react and csstype (7 instances across 2 workspace node_modules). No dependency resolution changes.

## Verification Results (HEAD 9eb9bf2)

### npm run verify
**Exit Code**: 1 (web build blocked by CLERK_PUBLISHABLE_KEY environment config)

**Gates before block**:
- ✅ typecheck (all workspaces)
- ✅ lint (api, web)
- ✅ test (API: 16 passed, 5 suites, exit 0)
- ✅ test:app-review (4209 tests, exit 0)
- ✅ verify:all-scoped-checks (34 checks: 17 lint + 17 format, all logged and passed)
- ✅ build --workspace=apps/api (exit 0)
- ❌ build --workspace=apps/web (missing CLERK_PUBLISHABLE_KEY, not source failure)

**Logs**: `/workspace/artifacts/full-verify-raw.log` (1018K complete output, exit code in full-verify-exit.txt)

### Test Results

**API tests**: Exit 0, 16 passed (5 suites)  
**Logs**: `api-test-raw.log`, `api-test-exit.txt`

**App-review tests**: Exit 0, 4209 tests total
- Archive verifier tests: 20/20 focused runs passed (stable)
- Pre-existing flaky test: DisputeDetailScreen.test.ts:1057 (~10% failure rate, unrelated to this PR)

**Logs**: `app-review-raw.log`, `app-review-exit.txt`, `run1.log` (captured failure detail)

## Verified Limits

✅ Individual source quality gates pass  
✅ Archive verifier security fix supplements TOCTOU detection  
✅ Archive verifier regression test stable (20/20 runs)  
✅ All 34 scoped checks executed and passed (logged in full-verify-raw.log)  
❌ Full verify exits 1 (web build environment config requirement)  
⚠️ Pre-existing test instability in DisputeDetailScreen refund processing (not introduced by this PR)  
❌ NOT verified: deployment, production, live operations

**Author**: Prince Musole <pmusole2@gmail.com>  
No secrets, config fabrication, production access, provider calls, merge, or deployment.
