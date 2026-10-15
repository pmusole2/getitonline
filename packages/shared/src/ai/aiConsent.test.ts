import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import {
  AI_CONSENT_VERSION,
  aiConsentStorageKey,
  aiSubjectFor,
  createAiConsentRecord,
  hasCurrentAiConsent,
  isAiConsentRecordForSubject,
  recordAiConsent,
} from "./aiConsent";
import type { KeyValueStore } from "./aiGuestSession";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

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

test("the consent version matches the mobile policy and the Convex gate", () => {
  const mobile = readFileSync(
    resolve(repoRoot, "apps/mobile/src/services/aiConsentPolicy.ts"),
    "utf8",
  );
  const convex = readFileSync(
    resolve(repoRoot, "convex/lib/aiConsent.ts"),
    "utf8",
  );

  assert.equal(AI_CONSENT_VERSION, 2);
  assert.match(mobile, /export const AI_CONSENT_VERSION = 2;/);
  assert.match(convex, /export const AI_CONSENT_VERSION = 2;/);
});

test("a signed-in account and a guest are separate consent subjects", () => {
  assert.equal(aiSubjectFor(null), "guest");
  assert.equal(aiSubjectFor("users_123"), "account:users_123");
  assert.notEqual(
    aiConsentStorageKey("account:a"),
    aiConsentStorageKey("account:b"),
  );
  assert.notEqual(
    aiConsentStorageKey("account:a"),
    aiConsentStorageKey("guest"),
  );
});

test("account A's acceptance does not apply to account B or to a guest", async () => {
  const store = memoryStore();
  await recordAiConsent(store, "account:a");

  assert.equal(await hasCurrentAiConsent(store, "account:a"), true);
  assert.equal(await hasCurrentAiConsent(store, "account:b"), false);
  assert.equal(await hasCurrentAiConsent(store, "guest"), false);
});

test("a record copied under another subject key is refused", async () => {
  const store = memoryStore();
  const recordForA = createAiConsentRecord(
    "account:a",
    new Date("2026-10-01T00:00:00.000Z"),
  );
  store.values.set(
    aiConsentStorageKey("account:b"),
    JSON.stringify(recordForA),
  );

  assert.equal(await hasCurrentAiConsent(store, "account:b"), false);
});

test("an older consent version prompts again", async () => {
  const store = memoryStore();
  const staleRecord = { ...createAiConsentRecord("account:a"), version: 1 };
  store.values.set(
    aiConsentStorageKey("account:a"),
    JSON.stringify(staleRecord),
  );

  assert.equal(isAiConsentRecordForSubject(staleRecord, "account:a"), false);
  assert.equal(await hasCurrentAiConsent(store, "account:a"), false);
});

test("unreadable stored consent counts as no consent", async () => {
  const store = memoryStore();
  store.values.set(aiConsentStorageKey("guest"), "{not json");

  assert.equal(await hasCurrentAiConsent(store, "guest"), false);
});

test("a new record is stamped with the current version and its subject", async () => {
  const store = memoryStore();
  await recordAiConsent(store, "guest", new Date("2026-10-10T08:00:00.000Z"));

  const stored: unknown = JSON.parse(
    store.values.get(aiConsentStorageKey("guest")) ?? "null",
  );
  assert.equal(isAiConsentRecordForSubject(stored, "guest"), true);
  assert.deepEqual(stored, {
    version: 2,
    acceptedAt: "2026-10-10T08:00:00.000Z",
    subject: "guest",
  });
});
