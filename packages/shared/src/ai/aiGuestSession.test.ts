import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";

import {
  GUEST_SESSION_STORAGE_KEY,
  getOrCreateGuestSessionId,
  isValidGuestSessionId,
  type KeyValueStore,
} from "./aiGuestSession";

function memoryStore(
  initial: Record<string, string> = {},
): KeyValueStore & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
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

test("a guest session id is printable ASCII of 1 to 128 characters", () => {
  assert.equal(
    isValidGuestSessionId("3f2c9a1e-8b7d-4c6a-9e0f-1a2b3c4d5e6f"),
    true,
  );
  assert.equal(isValidGuestSessionId("a"), true);
  assert.equal(isValidGuestSessionId("a".repeat(128)), true);
  assert.equal(isValidGuestSessionId(""), false, "empty is refused");
  assert.equal(
    isValidGuestSessionId("a".repeat(129)),
    false,
    "over 128 is refused",
  );
  assert.equal(
    isValidGuestSessionId("line\nbreak"),
    false,
    "control characters are refused",
  );
  assert.equal(isValidGuestSessionId("café"), false, "non-ASCII is refused");
  assert.equal(isValidGuestSessionId(42), false, "non-strings are refused");
});

test("the first call creates and persists an id, and later calls return the same id", async () => {
  const store = memoryStore();
  let created = 0;
  const createId = (): string => {
    created += 1;
    return `guest-${created}`;
  };

  const first = await getOrCreateGuestSessionId(store, createId);
  const second = await getOrCreateGuestSessionId(store, createId);

  assert.equal(first, "guest-1");
  assert.equal(second, "guest-1", "the stored id is reused");
  assert.equal(created, 1, "the generator runs once");
  assert.equal(store.values.get(GUEST_SESSION_STORAGE_KEY), "guest-1");
});

test("a stored value that is not a valid session id is replaced", async () => {
  const store = memoryStore({ [GUEST_SESSION_STORAGE_KEY]: "bad\u0000value" });

  const id = await getOrCreateGuestSessionId(store, () => "fresh-id");

  assert.equal(id, "fresh-id");
  assert.equal(store.values.get(GUEST_SESSION_STORAGE_KEY), "fresh-id");
});

test("a generated id that is not valid is refused rather than stored", async () => {
  const store = memoryStore();

  await assert.rejects(
    () => getOrCreateGuestSessionId(store, () => ""),
    /valid guest session/,
  );
  assert.equal(store.values.has(GUEST_SESSION_STORAGE_KEY), false);
});

// The backend's rule, read from convex/aiUsage.ts itself, so a change on either side fails this test.
const backendSource = readFileSync(
  fileURLToPath(new URL("../../../../convex/aiUsage.ts", import.meta.url)),
  "utf8",
);

function backendGuestSessionIdAccepts(value: string): boolean {
  const maxLength = /const GUEST_SESSION_ID_MAX_LENGTH = (\d+);/.exec(
    backendSource,
  );
  const pattern = /const GUEST_SESSION_ID_PATTERN = \/(.+)\/;/.exec(
    backendSource,
  );
  assert.ok(
    maxLength !== null && pattern !== null,
    "the backend guest session rule is in convex/aiUsage.ts",
  );
  return (
    value.length <= Number(maxLength[1]) && new RegExp(pattern[1]).test(value)
  );
}

test("the client guest session id rule matches the backend rule on every single ASCII character and on boundary lengths", () => {
  const inputs: string[] = [];
  for (let code = 0; code <= 127; code += 1) {
    inputs.push(String.fromCharCode(code));
  }
  for (const length of [1, 127, 128, 129]) {
    inputs.push("a".repeat(length));
  }
  inputs.push("guest token", "a b", "tab\tid", "café", "guest-1", "");

  const disagreements = inputs.filter(
    (value) =>
      isValidGuestSessionId(value) !== backendGuestSessionIdAccepts(value),
  );
  assert.deepEqual(
    disagreements,
    [],
    "no input is accepted by one side and refused by the other",
  );
  assert.equal(
    isValidGuestSessionId(" "),
    false,
    "a space is refused, as the backend refuses it",
  );
  assert.equal(
    isValidGuestSessionId("guest token"),
    false,
    "a stored id with a space is replaced",
  );
  assert.equal(
    isValidGuestSessionId("~"),
    true,
    "the last printable ASCII character is accepted",
  );
  assert.equal(
    isValidGuestSessionId("!"),
    true,
    "the first printable ASCII character is accepted",
  );
});

test("a stored id with a space is replaced by a fresh id, and the fresh id is persisted", async () => {
  const store = memoryStore({ [GUEST_SESSION_STORAGE_KEY]: "guest token" });

  const id = await getOrCreateGuestSessionId(store, () => "fresh-id");

  assert.equal(id, "fresh-id");
  assert.equal(store.values.get(GUEST_SESSION_STORAGE_KEY), "fresh-id");
});

test("five concurrent first calls share one id and persist it once", async () => {
  const values = new Map<string, string>();
  const writes: string[] = [];
  let created = 0;
  let openRead: () => void = () => undefined;
  const readsOpen = new Promise<void>((resolve) => {
    openRead = resolve;
  });
  const store: KeyValueStore = {
    async getItem(key) {
      await readsOpen;
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      writes.push(value);
      values.set(key, value);
    },
  };
  const createId = (): string => {
    created += 1;
    return `guest-${created}`;
  };

  const calls = [1, 2, 3, 4, 5].map(() =>
    getOrCreateGuestSessionId(store, createId),
  );
  openRead();
  const ids = await Promise.all(calls);

  assert.deepEqual(
    new Set(ids),
    new Set(["guest-1"]),
    "every concurrent call gets the same id",
  );
  assert.equal(created, 1, "the id is generated once");
  assert.deepEqual(writes, ["guest-1"], "the id is persisted once");
});

test("a failed write does not throw, and every later call gets the same in-memory id", async () => {
  const store: KeyValueStore = {
    async getItem() {
      return null;
    },
    async setItem() {
      throw new Error("quota exceeded");
    },
  };
  let created = 0;
  const createId = (): string => {
    created += 1;
    return `guest-${created}`;
  };

  const first = await getOrCreateGuestSessionId(store, createId);
  const second = await getOrCreateGuestSessionId(store, createId);

  assert.equal(first, "guest-1");
  assert.equal(second, "guest-1", "the in-memory id is kept for this process");
  assert.equal(created, 1);
});

test("a failed read does not throw, and the in-memory id is used without touching storage again", async () => {
  let reads = 0;
  let writes = 0;
  const store: KeyValueStore = {
    async getItem() {
      reads += 1;
      throw new Error("storage unavailable");
    },
    async setItem() {
      writes += 1;
    },
  };

  const first = await getOrCreateGuestSessionId(store, () => "guest-1");
  const second = await getOrCreateGuestSessionId(store, () => "guest-2");

  assert.equal(first, "guest-1");
  assert.equal(second, "guest-1");
  assert.equal(
    reads,
    1,
    "the failed read is not retried for the process lifetime",
  );
  assert.equal(writes, 0, "nothing is written when the read failed");
});
