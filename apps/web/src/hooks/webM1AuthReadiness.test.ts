import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, URL } from "node:url";

import { resolveAccountAccess } from "../../../../packages/shared/src/utils/accountAccess";
import {
  createControls,
  createHarness,
  fixture,
  textOf,
  withFallback,
  type HarnessControls,
  type Props,
  type RenderResult,
} from "../../../../tests/support/componentHarness";

// Runs the real useAuth hook and the real account-access chain. Clerk is controlled, Convex auth state is set per
// test, and each sync request is held until the test settles it. Protected queries are read from the render result.

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const useAuthFile = resolve(repoRoot, "apps/web/src/hooks/useAuth.ts");
const usersPage = resolve(
  repoRoot,
  "apps/web/src/app/(admin)/admin/users/page.tsx",
);
const PROFILE_QUERY = "users.getUserByClerkId";

type SyncMode = "held" | "accepted" | "refused";
type ConvexAuthState = { isLoading: boolean; isAuthenticated: boolean };

interface ClerkAccount {
  readonly id: string;
  readonly primaryEmailAddress: { readonly emailAddress: string };
  readonly firstName: string;
  readonly lastName: string;
  readonly imageUrl: string;
}

interface HeldSync {
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

const SIGNED_IN: ConvexAuthState = { isLoading: false, isAuthenticated: true };

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

function profileOf(clerkAccount: ClerkAccount, extra: Props = {}): Props {
  return {
    _id: `row_${clerkAccount.id}`,
    clerkId: clerkAccount.id,
    role: "user",
    isBanned: false,
    deletedAt: undefined,
    ...extra,
  };
}

function deferred(): {
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

function accessOf(auth: Props) {
  return resolveAccountAccess({
    isLoading: auth.isLoading === true,
    isSignedIn: auth.isSignedIn === true,
    syncFailed: auth.syncFailed === true,
    user: isRecord(auth.user)
      ? { isBanned: auth.user.isBanned === true }
      : null,
  });
}

function protectedCalls(result: RenderResult): string[] {
  return result.queryCalls
    .filter((call) => call.args !== "skip")
    .map((call) => call.name);
}

function adminDataCalls(result: RenderResult): string[] {
  return protectedCalls(result).filter((name) => name !== PROFILE_QUERY);
}

interface AuthSession {
  readonly controls: HarnessControls;
  render(): { auth: Props; result: RenderResult };
  settle(): Promise<void>;
  signIn(next: ClerkAccount): void;
  setMode(next: SyncMode): void;
  setProfile(value: Props | null | undefined): void;
  heldSync(index: number): HeldSync;
}

// The real useAuth, with Clerk and Convex controlled. A sync request is held, accepted or refused by `mode`.
function authSession(convexAuth: ConvexAuthState = SIGNED_IN): AuthSession {
  const controls = createControls();
  controls.convexAuth = convexAuth;
  const clerk: {
    isLoaded: boolean;
    isSignedIn: boolean;
    user: ClerkAccount | null;
  } = { isLoaded: true, isSignedIn: false, user: null };
  const syncs: HeldSync[] = [];
  let mode: SyncMode = "held";

  controls.mutations["users.upsertUser"] = () => {
    if (mode === "accepted") {
      return Promise.resolve(undefined);
    }
    if (mode === "refused") {
      return Promise.reject(new Error("Convex sync unavailable"));
    }
    const pending = deferred();
    syncs.push({ resolve: pending.resolve, reject: pending.reject });
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
          signOut: async () => undefined,
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
    controls,
    render() {
      const result = harness.render(AuthProbe, {});
      return { auth: latest, result };
    },
    settle: () => harness.settle(),
    signIn(next: ClerkAccount) {
      clerk.isSignedIn = true;
      clerk.user = next;
    },
    setMode(next: SyncMode) {
      mode = next;
    },
    setProfile(value: Props | null | undefined) {
      controls.queries[PROFILE_QUERY] = value;
    },
    heldSync(index: number): HeldSync {
      const sync = syncs[index];
      if (sync === undefined) {
        throw new Error(`no held sync at position ${index}`);
      }
      return sync;
    },
  };
}

describe("profile query waits for settled Convex auth", () => {
  it("Clerk is loaded but Convex auth is still loading: no profile query is issued", () => {
    const session = authSession({ isLoading: true, isAuthenticated: false });
    session.signIn(account("user_a"));
    session.render();
    const { result } = session.render();

    assert.deepEqual(
      result.queryCalls
        .filter((call) => call.name === PROFILE_QUERY)
        .map((call) => call.args),
      ["skip"],
      "the profile query must not run until Convex auth settles",
    );
  });

  it("Convex reports the user as unauthenticated: no profile query is issued", () => {
    const session = authSession({ isLoading: false, isAuthenticated: false });
    session.signIn(account("user_a"));
    session.render();
    const { result } = session.render();

    assert.deepEqual(
      result.queryCalls
        .filter((call) => call.name === PROFILE_QUERY)
        .map((call) => call.args),
      ["skip"],
      "an unauthenticated Convex session must not query the profile",
    );
  });

  it("settled Convex auth queries the profile for the Clerk subject", () => {
    const session = authSession(SIGNED_IN);
    session.signIn(account("user_a"));
    session.render();
    const { result } = session.render();

    assert.deepEqual(
      result.queryCalls
        .filter((call) => call.name === PROFILE_QUERY)
        .map((call) => call.args),
      [{ clerkId: "user_a" }],
    );
  });
});

describe("account switch isolation", () => {
  it("a sync failure for account A does not put account B into recovery", async () => {
    const session = authSession(SIGNED_IN);
    session.setMode("refused");
    session.signIn(account("user_a"));
    session.render();
    await session.settle();
    assert.equal(accessOf(session.render().auth), "recovery");

    session.setMode("held");
    session.signIn(account("user_b"));
    session.render();
    await session.settle();
    const { auth } = session.render();

    assert.equal(
      auth.syncFailed,
      false,
      "a failure recorded for account A must not describe account B",
    );
    assert.equal(accessOf(auth), "loading", "B is still syncing");
  });

  it("a profile row cached for account A is never returned as account B", async () => {
    const session = authSession(SIGNED_IN);
    session.setMode("accepted");
    session.signIn(account("user_a"));
    session.setProfile(profileOf(account("user_a")));
    session.render();
    await session.settle();
    assert.equal(accessOf(session.render().auth), "ready");

    session.signIn(account("user_b"));
    session.render();
    const { auth } = session.render();

    assert.equal(
      auth.user,
      null,
      "account A's profile must not be exposed to account B",
    );
    assert.notEqual(accessOf(auth), "ready");
  });

  it("a late sync completion from account A does not settle account B", async () => {
    const session = authSession(SIGNED_IN);
    session.signIn(account("user_a"));
    session.render();
    session.signIn(account("user_b"));
    session.render();
    session.heldSync(0).resolve();
    await session.settle();
    const { auth } = session.render();

    assert.equal(auth.syncFailed, false);
    assert.equal(
      accessOf(auth),
      "loading",
      "A's completion must not make B ready before B's own profile arrives",
    );
  });
});

// Loads the real admin users page. Its account chain (useAccountAccess and useAuth) is the real one.
function loadPage(options: {
  readonly convexAuth: ConvexAuthState;
  readonly profile: Props | undefined;
  readonly sync: "accepted" | "refused";
}) {
  const controls = createControls();
  controls.convexAuth = options.convexAuth;
  controls.queries[PROFILE_QUERY] = options.profile;
  controls.queries["users.getAllUsers"] = { items: [] };
  controls.queries["platform.getPlatformSettingsForAdmin"] = fixture({
    companyDisplayName: "Fixture Store",
    companySeller: null,
    companySellerUserId: null,
  });
  controls.mutations["users.upsertUser"] = () =>
    options.sync === "refused"
      ? Promise.reject(new Error("Convex sync unavailable"))
      : Promise.resolve(undefined);
  const harness = createHarness({
    controls,
    aliases: { "@/": resolve(repoRoot, "apps/web/src") },
    effects: true,
    packages: {
      "@clerk/nextjs": withFallback({
        useAuth: () => ({
          isLoaded: true,
          isSignedIn: true,
          signOut: async () => undefined,
        }),
        useUser: () => ({ user: account("user_a") }),
      }),
      "@gettitonline/shared": withFallback({ resolveAccountAccess }),
    },
  });
  const component = harness.load(usersPage).default;
  return {
    // The first render starts the sync effect; the settled render shows the account state it produced.
    async settledRender(): Promise<RenderResult> {
      harness.render(component, {});
      await harness.settle();
      return harness.render(component, {});
    },
  };
}

describe("protected admin page readiness with the real account chain", () => {
  it("Clerk loaded, Convex loading: the admin page issues no protected query", async () => {
    const page = loadPage({
      convexAuth: { isLoading: true, isAuthenticated: false },
      profile: undefined,
      sync: "accepted",
    });
    const result = await page.settledRender();

    assert.deepEqual(protectedCalls(result), []);
    assert.ok(!textOf(result.tree).includes("User Management"));
  });

  // Once Convex auth settles, the own-profile read is what decides the account state, so it is allowed here. The
  // admin data queries must still not run for an account that is not ready.
  it("banned account: the page shows the account notice and issues no admin data query", async () => {
    const page = loadPage({
      convexAuth: SIGNED_IN,
      profile: profileOf(account("user_a"), {
        role: "admin",
        isBanned: true,
      }),
      sync: "accepted",
    });
    const result = await page.settledRender();

    assert.deepEqual(adminDataCalls(result), []);
    assert.ok(textOf(result.tree).includes("Account unavailable"));
  });

  it("sync failure: the page shows the recovery notice and issues no admin data query", async () => {
    const page = loadPage({
      convexAuth: SIGNED_IN,
      profile: undefined,
      sync: "refused",
    });
    const result = await page.settledRender();

    assert.deepEqual(adminDataCalls(result), []);
    assert.ok(textOf(result.tree).includes("Account setup did not finish"));
  });
});
