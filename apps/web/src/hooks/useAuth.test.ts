import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, URL } from "node:url";

import { resolveAccountAccess } from "../../../../packages/shared/src/utils/accountAccess";
import {
  createControls,
  createHarness,
  withFallback,
  type HarnessControls,
  type Props,
} from "../../../../tests/support/componentHarness";

// Runs the real useAuth hook with its effects. Clerk and Convex are controlled, and each sync request is held
// until the test settles it, so a late completion can be replayed after sign-out or an account switch.

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const useAuthFile = resolve(repoRoot, "apps/web/src/hooks/useAuth.ts");

type SyncMode = "held" | "accepted" | "refused";

interface ClerkAccount {
  readonly id: string;
  readonly primaryEmailAddress: { readonly emailAddress: string };
  readonly firstName: string;
  readonly lastName: string;
  readonly imageUrl: string;
}

interface ClerkState {
  isLoaded: boolean;
  isSignedIn: boolean;
  user: ClerkAccount | null;
}

interface HeldSync {
  readonly email: string;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

function isRecord(value: unknown): value is Props {
  return typeof value === "object" && value !== null;
}

function account(id: string): ClerkAccount {
  return {
    id,
    primaryEmailAddress: { emailAddress: `${id}@example.invalid` },
    firstName: "Fixture",
    lastName: id,
    imageUrl: "",
  };
}

function profileOf(clerkAccount: ClerkAccount): Props {
  return {
    _id: `row_${clerkAccount.id}`,
    clerkId: clerkAccount.id,
    role: "user",
    isBanned: false,
  };
}

function held(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
} {
  let settle: () => void = () => undefined;
  let fail: (reason: unknown) => void = () => undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    settle = () => resolvePromise();
    fail = rejectPromise;
  });
  return { promise, resolve: settle, reject: fail };
}

function accountOf(value: unknown): { readonly isBanned: boolean } | null {
  return isRecord(value) ? { isBanned: value.isBanned === true } : null;
}

function accessOf(auth: Props) {
  return resolveAccountAccess({
    isLoading: auth.isLoading === true,
    isSignedIn: auth.isSignedIn === true,
    syncFailed: auth.syncFailed === true,
    user: accountOf(auth.user),
  });
}

function callAction(action: unknown): void {
  if (typeof action !== "function") {
    throw new Error("useAuth must expose this action");
  }
  Reflect.apply(action, undefined, []);
}

async function runAction(action: unknown): Promise<void> {
  if (typeof action !== "function") {
    throw new Error("useAuth must expose this action");
  }
  await Reflect.apply(action, undefined, []);
}

function authSession(initialMode: SyncMode = "held") {
  const controls: HarnessControls = createControls();
  const clerk: ClerkState = { isLoaded: true, isSignedIn: false, user: null };
  const syncs: HeldSync[] = [];
  let mode: SyncMode = initialMode;

  controls.mutations["users.upsertUser"] = (args) => {
    const email =
      isRecord(args) && typeof args.email === "string" ? args.email : "";
    if (mode === "accepted") {
      return Promise.resolve(undefined);
    }
    if (mode === "refused") {
      return Promise.reject(new Error("Convex sync unavailable"));
    }
    const pending = held();
    syncs.push({ email, resolve: pending.resolve, reject: pending.reject });
    return pending.promise;
  };

  const harness = createHarness({
    controls,
    effects: true,
    packages: {
      "@clerk/nextjs": withFallback({
        useAuth: () => ({
          isLoaded: clerk.isLoaded,
          isSignedIn: clerk.isSignedIn,
          signOut: async () => {
            clerk.isSignedIn = false;
            clerk.user = null;
          },
        }),
        useUser: () => ({ user: clerk.user }),
      }),
    },
  });

  const useAuthHook = harness.load(useAuthFile).useAuth;
  if (typeof useAuthHook !== "function") {
    throw new Error("useAuth must be exported as a function");
  }

  let latest: Props = {};
  const AuthProbe = (): null => {
    const result: unknown = Reflect.apply(useAuthHook, undefined, []);
    if (!isRecord(result)) {
      throw new Error("useAuth must return an object");
    }
    latest = result;
    return null;
  };

  return {
    view(): Props {
      harness.render(AuthProbe, {});
      return latest;
    },
    settle: () => harness.settle(),
    signIn(next: ClerkAccount) {
      clerk.isSignedIn = true;
      clerk.user = next;
    },
    async signOut() {
      await runAction(latest.signOut);
    },
    retry() {
      callAction(latest.retrySync);
    },
    setMode(next: SyncMode) {
      mode = next;
    },
    setProfile(value: Props | null | undefined) {
      controls.queries["users.getUserByClerkId"] = value;
    },
    heldSync(index: number): HeldSync {
      const sync = syncs[index];
      if (sync === undefined) {
        throw new Error(`no held sync at position ${index}`);
      }
      return sync;
    },
    syncCount(): number {
      return controls.calls.filter(
        (call) => call.name === "mutation:users.upsertUser",
      ).length;
    },
  };
}

describe("useAuth sync", () => {
  it("a sync failure that lands after sign-out does not reopen recovery", async () => {
    const session = authSession();
    session.signIn(account("user_a"));
    session.view();
    await session.signOut();
    session.view();
    session.heldSync(0).reject(new Error("network down"));
    await session.settle();
    const auth = session.view();

    assert.equal(auth.isSignedIn, false);
    assert.equal(
      auth.syncFailed,
      false,
      "an obsolete failure must not overwrite sign-out",
    );
    assert.equal(accessOf(auth), "signed-out");
  });

  it("a late failure from a previous account does not fail the current account", async () => {
    const session = authSession();
    session.signIn(account("user_a"));
    session.view();
    session.signIn(account("user_b"));
    session.view();
    session.heldSync(0).reject(new Error("network down"));
    await session.settle();
    const auth = session.view();

    assert.equal(
      auth.syncFailed,
      false,
      "a previous account's failure must not fail the current account",
    );
    assert.equal(
      accessOf(auth),
      "loading",
      "the current account is still syncing",
    );
  });

  it("a late success from a previous account cannot clear the current account's failure", async () => {
    const session = authSession();
    session.signIn(account("user_a"));
    session.view();
    session.signIn(account("user_b"));
    session.view();
    session.heldSync(1).reject(new Error("network down"));
    await session.settle();
    assert.equal(accessOf(session.view()), "recovery");

    session.heldSync(0).resolve();
    await session.settle();
    assert.equal(
      accessOf(session.view()),
      "recovery",
      "an obsolete success must not clear the current failure",
    );
  });

  it("a failed sync with an unresolved profile is recovery, not loading, and retry recovers", async () => {
    const session = authSession("refused");
    session.signIn(account("user_a"));
    session.view();
    await session.settle();
    const failed = session.view();

    assert.equal(failed.syncFailed, true);
    assert.equal(
      failed.isLoading,
      false,
      "a terminal sync failure must not wait on the profile",
    );
    assert.equal(accessOf(failed), "recovery");

    session.setMode("accepted");
    session.retry();
    session.view();
    await session.settle();
    const retried = session.view();
    assert.equal(retried.syncFailed, false);
    assert.equal(
      accessOf(retried),
      "loading",
      "a successful retry waits for the profile",
    );

    session.setProfile(profileOf(account("user_a")));
    assert.equal(accessOf(session.view()), "ready");
  });

  it("a successful sync is loading until the profile arrives, then ready", async () => {
    const session = authSession("accepted");
    session.signIn(account("user_a"));
    session.view();
    await session.settle();
    assert.equal(accessOf(session.view()), "loading");

    session.setProfile(profileOf(account("user_a")));
    assert.equal(accessOf(session.view()), "ready");
  });

  it("a signed-out visitor never starts a sync", () => {
    const session = authSession("accepted");
    session.view(); // the first render starts the effects
    const auth = session.view(); // the next render shows the state they settled

    assert.equal(accessOf(auth), "signed-out");
    assert.equal(session.syncCount(), 0);
  });
});
