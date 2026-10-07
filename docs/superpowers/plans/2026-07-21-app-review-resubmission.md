# App Review Resubmission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Satisfy App Review findings 1, 2, and 4, then create and upload a verified Expo iOS production build to TestFlight.

**Architecture:** Keep Clerk as the identity authority, use native Sign in with Apple on iOS, and synchronize Clerk deletion events to Convex through a signed webhook. Keep AI consent local but bind it to the active account, enforce it before every mobile AI request, minimize backend prompt context, and publish matching disclosure text in the canonical privacy policy.

**Tech Stack:** Expo SDK 54, React Native 0.81, Clerk Expo, Convex, NestJS, OpenAI API, EAS Build/Submit.

## Global Constraints

- Preserve all pre-existing worktree changes.
- Do not implement finding 3; demo credentials and user testing remain a user handoff.
- Do not transmit AI input before explicit consent from the active account.
- Do not expose webhook signing secrets or Apple private keys.
- Build and submit only after local gates and reviewer flows pass.

---

### Task 1: Native Sign in with Apple

**Files:**
- Create: `apps/mobile/src/components/auth/AppleSignInButton.tsx`
- Modify: `apps/mobile/src/screens/auth/SignInScreen.tsx`
- Modify: `apps/mobile/src/screens/auth/SignUpScreen.tsx`
- Modify: `apps/mobile/app.config.ts`

- [ ] Replace the generic Apple glyph buttons with Expo's native Apple authentication button.
- [ ] Keep the existing Clerk `startAppleAuthenticationFlow()` handlers and cancellation behavior.
- [ ] Render the native button only on supported iOS devices and provide light/dark contrast.
- [ ] Enable mixed native localizations in Expo iOS configuration.
- [ ] Verify the production Clerk Apple provider and signed entitlement.

### Task 2: Complete Account Deletion

**Files:**
- Create: `convex/lib/clerkWebhook.ts`
- Create: `convex/lib/clerkWebhook.test.ts`
- Modify: `convex/http.ts`
- Modify: `convex/users.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] Write tests proving missing or invalid webhook signatures are rejected.
- [ ] Verify Clerk webhook requests with the production endpoint signing secret.
- [ ] Keep deletion idempotent and anonymize marketplace-side personal data after `user.deleted`.
- [ ] Deploy the matching Convex functions and configure the production Clerk endpoint for `user.created`, `user.updated`, and `user.deleted`.
- [ ] Send signed example events and confirm successful delivery.

### Task 3: AI Disclosure, Consent, and Minimization

**Files:**
- Create: `apps/mobile/src/services/aiConsentPolicy.ts`
- Create: `apps/mobile/src/services/aiConsentPolicy.test.ts`
- Modify: `apps/mobile/src/services/aiConsent.ts`
- Modify: `apps/mobile/src/context/AuthProvider.tsx`
- Modify: `apps/mobile/src/screens/profile/SettingsScreen.tsx`
- Modify: `apps/api/src/ai/services/chat.service.ts`
- Modify: `artifacts/app-store-submission-prep/resubmission-notes-2026-07-07.md`

- [ ] Write tests proving consent is valid only for the active account and current disclosure version.
- [ ] Bind consent to the current Clerk account or guest subject.
- [ ] Expand the prompt to identify OpenAI, LLC, the exact remaining data categories, purposes, international processing, retention, and revocation.
- [ ] Remove names, addresses, phone numbers, payment failure details, private conversation history, and unnecessary transaction details from assistant prompts.
- [ ] Publish the same disclosure in the canonical live privacy policy and align App Store metadata to that URL.

### Task 4: Verification and TestFlight

**Files:**
- Modify only if required by verification: `apps/mobile/eas.json`
- Update: `artifacts/app-store-submission-prep/resubmission-notes-2026-07-07.md`

- [ ] Run focused tests, mobile/API typechecks, lint, API tests/build, Convex dry run, and Expo Doctor.
- [ ] Run the native iOS app and capture reviewer-visible Apple login, AI consent, and deletion screens.
- [ ] Generate a production EAS build with auto-incremented build number.
- [ ] Submit that exact EAS build to App Store Connect/TestFlight.
- [ ] Confirm App Store processing and TestFlight availability, then leave finding 3 as the explicit user handoff.

## Rollback

Revert only files changed by this plan, remove the newly created Clerk webhook endpoint if signed delivery cannot be verified, restore the prior Convex deployment from its deployment history, and do not select the new build in App Store Connect if any reviewer flow fails.
