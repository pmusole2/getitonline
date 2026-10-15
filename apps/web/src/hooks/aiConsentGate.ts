// The web's AI consent gate, as pure functions over a key-value store. Consent is scoped to one subject: a signed-in
// account or a guest. An acceptance for one subject never allows another, and an older disclosure version prompts again.
// A browser store that cannot be read or written (private mode, a full quota) never throws out of the gate: an unreadable
// record prompts again, and an acceptance that cannot be stored holds for the rest of this page session.
import {
  hasCurrentAiConsent,
  recordAiConsent,
  type AiSubject,
  type KeyValueStore,
} from "../../../../packages/shared/src/index";

export type AiConsentDecision = "allowed" | "prompt";

const sessionAcceptances = new WeakMap<KeyValueStore, Set<AiSubject>>();

export async function decideAiConsent(
  store: KeyValueStore,
  subject: AiSubject,
): Promise<AiConsentDecision> {
  if (sessionAcceptances.get(store)?.has(subject) === true) {
    return "allowed";
  }
  try {
    return (await hasCurrentAiConsent(store, subject)) ? "allowed" : "prompt";
  } catch {
    // The record cannot be read, so consent is not assumed. The disclosure is shown again.
    return "prompt";
  }
}

// The one consent answer the action hook and the gate share, so a request is admitted exactly when the gate would not prompt.
export async function isAiConsentAllowed(
  store: KeyValueStore,
  subject: AiSubject,
): Promise<boolean> {
  return (await decideAiConsent(store, subject)) === "allowed";
}

export async function acceptAiConsent(
  store: KeyValueStore,
  subject: AiSubject,
): Promise<void> {
  const accepted = sessionAcceptances.get(store) ?? new Set<AiSubject>();
  accepted.add(subject);
  sessionAcceptances.set(store, accepted);
  try {
    await recordAiConsent(store, subject);
  } catch {
    // Storage refused the write. The acceptance still holds for this page session, so the person is not asked twice.
  }
}

// The browser's localStorage. It is touched only from event handlers, never during render, so importing this file is safe on the server.
export const browserStore: KeyValueStore = {
  async getItem(key) {
    return window.localStorage.getItem(key);
  },
  async setItem(key, value) {
    window.localStorage.setItem(key, value);
  },
};
