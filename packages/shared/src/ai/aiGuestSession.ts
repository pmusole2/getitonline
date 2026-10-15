// A guest's session id groups that guest's AI calls for rate limiting. It is random, stored on this device, and never an
// account identifier: signed-in requests send no session id, and the backend decides the account from the verified identity.

export const GUEST_SESSION_STORAGE_KEY = "gettitonline.aiGuestSession.v1";

// Mirrors GUEST_SESSION_ID_MAX_LENGTH and GUEST_SESSION_ID_PATTERN in convex/aiUsage.ts. The backend rejects anything else
// with session_required, so a client must never store or send a value this rule refuses. A test compares both rules.
const GUEST_SESSION_ID_PATTERN = /^[\x21-\x7E]{1,128}$/;

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export function isValidGuestSessionId(value: unknown): value is string {
  return typeof value === "string" && GUEST_SESSION_ID_PATTERN.test(value);
}

// One creation in flight per store, so concurrent first calls share one id and persist it once.
const pendingIds = new WeakMap<KeyValueStore, Promise<string>>();
// The id this process uses after storage failed. It is kept for the process lifetime, so the id never changes mid-session.
const fallbackIds = new WeakMap<KeyValueStore, string>();

// Returns the stored guest session id, or creates, validates, and stores one. A stored value that is no longer valid is
// replaced. Storage failures never throw: the in-memory id takes over for the rest of the process.
export function getOrCreateGuestSessionId(
  store: KeyValueStore,
  createId: () => string,
): Promise<string> {
  const inFlight = pendingIds.get(store);
  if (inFlight !== undefined) {
    return inFlight;
  }

  const resolved = resolveGuestSessionId(store, createId).finally(() => {
    pendingIds.delete(store);
  });
  pendingIds.set(store, resolved);
  return resolved;
}

async function resolveGuestSessionId(
  store: KeyValueStore,
  createId: () => string,
): Promise<string> {
  const fallback = fallbackIds.get(store);
  if (fallback !== undefined) {
    return fallback;
  }

  let stored: unknown;
  try {
    stored = await store.getItem(GUEST_SESSION_STORAGE_KEY);
  } catch {
    // The stored id cannot be read, so it is not replaced. This process uses its own id instead.
    return rememberFallback(store, createId());
  }
  if (isValidGuestSessionId(stored)) {
    return stored;
  }

  const created = createId();
  if (!isValidGuestSessionId(created)) {
    throw new Error("createId must return a valid guest session id");
  }
  try {
    await store.setItem(GUEST_SESSION_STORAGE_KEY, created);
  } catch {
    return rememberFallback(store, created);
  }
  return created;
}

function rememberFallback(store: KeyValueStore, id: string): string {
  if (!isValidGuestSessionId(id)) {
    throw new Error("createId must return a valid guest session id");
  }
  fallbackIds.set(store, id);
  return id;
}
