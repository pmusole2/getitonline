// Mirrors AI_CONSENT_VERSION in apps/mobile/src/services/aiConsentPolicy.ts. Bump both together when the disclosure changes,
// so consent given to an older disclosure stops counting. Consent gates provider calls; it does not authenticate anyone.
export const AI_CONSENT_VERSION = 2;

export function hasCurrentAiConsent(consentVersion: unknown): boolean {
  return consentVersion === AI_CONSENT_VERSION;
}
