import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_CONSENT_VERSION,
  aiConsentStorageKey,
  createAiConsentRecord,
  type AiSubject,
  type KeyValueStore,
} from "../../../../packages/shared/src/index";
import { acceptAiConsent, decideAiConsent } from "./aiConsentGate";

function memoryStore(): KeyValueStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
  };
}

test("account A's acceptance lets A through and does not let account B through", async () => {
  const store = memoryStore();
  await acceptAiConsent(store, "account:clerk_a" as AiSubject);

  assert.equal(await decideAiConsent(store, "account:clerk_a"), "allowed");
  assert.equal(await decideAiConsent(store, "account:clerk_b"), "prompt");
  assert.equal(
    await decideAiConsent(store, "guest"),
    "prompt",
    "a guest is prompted separately",
  );
});

test("a guest's acceptance does not carry over to a signed-in account", async () => {
  const store = memoryStore();
  await acceptAiConsent(store, "guest");

  assert.equal(await decideAiConsent(store, "guest"), "allowed");
  assert.equal(await decideAiConsent(store, "account:clerk_a"), "prompt");
});

test("an acceptance for an older disclosure version prompts again", async () => {
  const store = memoryStore();
  const older = {
    ...createAiConsentRecord("account:clerk_a"),
    version: AI_CONSENT_VERSION - 1,
  };
  store.values.set(
    aiConsentStorageKey("account:clerk_a"),
    JSON.stringify(older),
  );

  assert.equal(await decideAiConsent(store, "account:clerk_a"), "prompt");
});

test("each subject keeps its own stored key", () => {
  assert.notEqual(
    aiConsentStorageKey("account:clerk_a"),
    aiConsentStorageKey("account:clerk_b"),
  );
  assert.notEqual(
    aiConsentStorageKey("account:clerk_a"),
    aiConsentStorageKey("guest"),
  );
});
