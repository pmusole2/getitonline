// Account-scoped AI consent. Consent gates provider calls; it does not authenticate anyone. A record counts only for the
// subject that gave it and only at the current AI_CONSENT_VERSION, so a new disclosure prompts again.
// Mirrors apps/mobile/src/services/aiConsentPolicy.ts and convex/lib/aiConsent.ts. Bump all three together.
import type { KeyValueStore } from "./aiGuestSession";

export const AI_CONSENT_VERSION = 2;

export type AiSubject = "guest" | `account:${string}`;

export interface AiConsentRecord {
  version: typeof AI_CONSENT_VERSION;
  acceptedAt: string;
  subject: AiSubject;
}

export function aiSubjectFor(accountId: string | null): AiSubject {
  return accountId === null ? "guest" : `account:${accountId}`;
}

export function aiConsentStorageKey(subject: AiSubject): string {
  return `gettitonline.aiConsent.${subject}`;
}

export function createAiConsentRecord(
  subject: AiSubject,
  now: Date = new Date(),
): AiConsentRecord {
  return {
    version: AI_CONSENT_VERSION,
    acceptedAt: now.toISOString(),
    subject,
  };
}

export function isAiConsentRecordForSubject(
  value: unknown,
  subject: AiSubject,
): value is AiConsentRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    "version" in value &&
    value.version === AI_CONSENT_VERSION &&
    "acceptedAt" in value &&
    typeof value.acceptedAt === "string" &&
    !Number.isNaN(Date.parse(value.acceptedAt)) &&
    "subject" in value &&
    value.subject === subject
  );
}

export async function hasCurrentAiConsent(
  store: KeyValueStore,
  subject: AiSubject,
): Promise<boolean> {
  const raw = await store.getItem(aiConsentStorageKey(subject));
  if (raw === null) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isAiConsentRecordForSubject(parsed, subject);
  } catch {
    return false;
  }
}

export async function recordAiConsent(
  store: KeyValueStore,
  subject: AiSubject,
  now?: Date,
): Promise<void> {
  await store.setItem(
    aiConsentStorageKey(subject),
    JSON.stringify(createAiConsentRecord(subject, now)),
  );
}
