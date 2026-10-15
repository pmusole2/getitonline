# Repository Safety and Internal Release Plan

> Execute with `superpowers:executing-plans`; use `superpowers:verification-before-completion` for the final gates.

**Goal:** Audit the accumulated update and Git history for secrets and private release information, push the verified source, and publish matching iOS and Android builds to TestFlight and Google Play internal testing.

**Assumptions:** The user's push and publication instructions authorize the current accumulated update. Preserve existing work. Use the current organization iOS app and the existing Android package and internal testing group. Store credentials remain managed outside Git.

**Approach:** Scan every local Git ref and the proposed source tree, exclude private artifacts, align native and EAS release targets, verify the application and existing backend configuration, obtain independent review, commit and push only `main`, deploy the matching API revision, and build and submit the exact committed revision.

**Files to touch:** Root ignore and secret-scanner configuration; mobile Expo/EAS configuration; native iOS identifiers, update runtime and display name; Android display name. Make implementation fixes only for reproduced release blockers. Include the pre-existing source update without unrelated refactors.

**Verification:** Redacted Gitleaks history and candidate scans; manual sensitive-file review; GitHub secret alerts; typechecks, app-review tests, API tests, lint, API/web builds, production mobile exports, release-target consistency and native bundle metadata. Verify the remote commit, exact EAS build revisions, store processing, and tester availability.

**Rollback:** Keep a private baseline of pre-existing changes. Revert only changes introduced by this plan if necessary. Do not rewrite shared history for false positives. If a release fails verification, leave the previous tester release active and do not submit the failing artifact. Roll back a published build through its store track rather than reusing a build number.

**October 7 backend change:** The user selected migration of the remaining Railway API calls to Convex before finishing the releases. The old Android build 13 and iOS build 2 submission were canceled and verified. Source push remains complete. The matching Railway deployment step is superseded by the proposed [Convex migration design](../specs/2026-10-07-convex-api-migration-design.md); implementation planning follows written-spec approval under the required Superpowers workflow. Fresh builds and store publication remain outstanding.

## Tasks

- [x] Audit local and remote history, proposed files, and private artifacts.
- [x] Add narrow scanner exceptions for proven public placeholders and dependency checksums; exclude local evidence and binaries.
- [x] Align the organization iOS target and Google Play internal submission configuration.
- [x] Run local verification and independent release review; resolve reproduced blocking findings.
- [x] Commit the verified source, push only `main`, and verify the remote revision (`1a1c9c6`).
- [ ] Complete the approved Convex migration and verify its deployed health, Pinkie identity, authentication, and payment webhook cutover. The Railway deployment was blocked by billing and is superseded.
- [ ] Build and submit the exact revision to TestFlight and Google Play internal testing.
- [ ] Verify processing and tester availability; remove task scratch and report any remaining artifacts.
