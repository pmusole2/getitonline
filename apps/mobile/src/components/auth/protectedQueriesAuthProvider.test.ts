import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import {
  createControls,
  createHarness,
  withFallback,
  type HarnessControls,
  type Props,
  type RenderedChild,
} from '../../../../../tests/support/componentHarness';

// Renders the real AuthProvider with controlled Clerk and Convex auth. Protected queries must wait for settled Convex
// authentication, and every piece of account state (profile, sync error, completion) belongs to one Clerk subject.
// A delayed result for one subject must never be shown to, or change the state of, another subject or a signed-out session.

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const repoFile = (relativePath: string) => resolve(repoRoot, relativePath);

const PROFILE_QUERY = 'users.getUserByClerkId';
const UPSERT = 'users.upsertUser';

interface Subject {
  readonly id: string;
  readonly primaryEmailAddress: { readonly emailAddress: string };
  readonly firstName: string;
  readonly lastName: string;
  readonly imageUrl: string;
}

interface ClerkSnapshot {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly user: Subject | null;
}

interface AuthView {
  readonly isLoading: boolean;
  readonly isSignedIn: boolean;
  readonly user: Props | null;
  readonly authSyncError: string | null;
  readonly signOut: () => Promise<void>;
  readonly retryUserSync: () => void;
}

interface PendingUpsert {
  readonly email: string;
  readonly resolve: (userId: string) => void;
  readonly reject: (error: Error) => void;
}

const subjectA: Subject = {
  id: 'clerk_a',
  primaryEmailAddress: { emailAddress: 'a@example.invalid' },
  firstName: 'Ada',
  lastName: 'Lovelace',
  imageUrl: 'https://img.example.invalid/a.png',
};

const subjectB: Subject = {
  id: 'clerk_b',
  primaryEmailAddress: { emailAddress: 'b@example.invalid' },
  firstName: 'Grace',
  lastName: 'Hopper',
  imageUrl: 'https://img.example.invalid/b.png',
};

const signedInAs = (user: Subject): ClerkSnapshot => ({ isLoaded: true, isSignedIn: true, user });
const signedOut: ClerkSnapshot = { isLoaded: true, isSignedIn: false, user: null };

function profileFor(subject: Subject, userId: string): Props {
  return {
    _id: userId,
    _creationTime: 1767225600000,
    clerkId: subject.id,
    email: subject.primaryEmailAddress.emailAddress,
    firstName: subject.firstName,
    lastName: subject.lastName,
    role: 'user',
    isBanned: false,
    isVerified: true,
    totalSales: 0,
    totalPurchases: 0,
    createdAt: 1767225600000,
    updatedAt: 1767225600000,
  };
}

function isRecord(value: unknown): value is Props {
  return typeof value === 'object' && value !== null;
}

function isAuthView(value: unknown): value is AuthView {
  return (
    isRecord(value) &&
    typeof value.isLoading === 'boolean' &&
    typeof value.isSignedIn === 'boolean' &&
    (value.user === null || isRecord(value.user)) &&
    typeof value.signOut === 'function' &&
    typeof value.retryUserSync === 'function'
  );
}

function findProviderValue(nodes: readonly RenderedChild[]): unknown {
  for (const node of nodes) {
    if (typeof node === 'string') {
      continue;
    }
    if (node.name === 'Provider' && 'value' in node.props) {
      return node.props.value;
    }
    const nested = findProviderValue(node.children);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

function emailOf(args: unknown): string {
  if (isRecord(args) && typeof args.email === 'string') {
    return args.email;
  }
  throw new Error('upsertUser was called without an email');
}

interface Env {
  readonly controls: HarnessControls;
  readonly clerk: { current: ClerkSnapshot };
  readonly upserts: PendingUpsert[];
  view(): AuthView;
  render(): AuthView;
  settle(): Promise<void>;
  // Resolves the next pending upsert for an email, as the network reply for that subject would arrive.
  resolveUpsert(email: string, userId: string): void;
  rejectUpsert(email: string, message: string): void;
  profileQueryArgs(): unknown[];
}

function setup(initial: ClerkSnapshot): Env {
  const controls = createControls();
  const clerk: { current: ClerkSnapshot } = { current: initial };
  const upserts: PendingUpsert[] = [];
  controls.mutations[UPSERT] = (args: unknown) =>
    new Promise<unknown>((resolveRequest, rejectRequest) => {
      upserts.push({
        email: emailOf(args),
        resolve: resolveRequest,
        reject: rejectRequest,
      });
    });

  const harness = createHarness({
    controls,
    effects: true,
    files: {
      [repoFile('apps/mobile/src/services/aiConsent.ts')]: withFallback({
        setAIConsentSubject: () => undefined,
      }),
    },
    packages: {
      '@clerk/clerk-expo': withFallback({
        useAuth: () => ({
          isLoaded: clerk.current.isLoaded,
          isSignedIn: clerk.current.isSignedIn,
          signOut: async () => {
            clerk.current = signedOut;
          },
        }),
        useUser: () => ({ user: clerk.current.user }),
      }),
    },
  });
  const AuthProvider = harness.load(repoFile('apps/mobile/src/context/AuthProvider.tsx')).AuthProvider;

  const renderOnce = (): AuthView => {
    const result = harness.render(AuthProvider, { children: null });
    const value = findProviderValue(result.tree);
    if (!isAuthView(value)) {
      throw new Error('AuthProvider did not render its context value');
    }
    return value;
  };

  const pendingFor = (email: string): PendingUpsert => {
    const request = upserts.find((entry) => entry.email === email);
    if (request === undefined) {
      throw new Error(`no pending upsert for ${email}`);
    }
    return request;
  };

  return {
    controls,
    clerk,
    upserts,
    view: () => renderOnce(),
    render: () => renderOnce(),
    settle: () => harness.settle(),
    resolveUpsert(email, userId) {
      pendingFor(email).resolve(userId);
    },
    rejectUpsert(email, message) {
      pendingFor(email).reject(new Error(message));
    },
    profileQueryArgs() {
      return controls.queryCalls.filter((call) => call.name === PROFILE_QUERY).map((call) => call.args);
    },
  };
}

// Lets effects start and the replies they await settle, then renders the state those replies produced.
async function renderSettled(env: Env): Promise<AuthView> {
  env.render();
  await env.settle();
  return env.render();
}

function upsertRequestedFor(env: Env, email: string): boolean {
  return env.upserts.some((entry) => entry.email === email);
}

describe('protected queries wait for settled Convex authentication', () => {
  it('Clerk loaded but Convex still authenticating: no profile query, no sync, and loading', async () => {
    const env = setup(signedInAs(subjectA));
    env.controls.convexAuth = { isLoading: true, isAuthenticated: false };
    env.controls.queries[PROFILE_QUERY] = profileFor(subjectA, 'users|a');

    const view = await renderSettled(env);

    assert.ok(env.profileQueryArgs().length > 0, 'the profile query is always mounted');
    assert.ok(
      env.profileQueryArgs().every((args) => args === 'skip'),
      `no profile request may run before Convex is authenticated, got ${JSON.stringify(env.profileQueryArgs())}`,
    );
    assert.equal(upsertRequestedFor(env, subjectA.primaryEmailAddress.emailAddress), false, 'no sync may start');
    assert.equal(view.isLoading, true, 'the account is still loading');
    assert.equal(view.user, null, 'no profile may be exposed');
  });

  it('Convex authenticated: the profile query and sync run for the signed-in subject', async () => {
    const env = setup(signedInAs(subjectA));
    env.controls.convexAuth = { isLoading: false, isAuthenticated: true };
    env.controls.queries[PROFILE_QUERY] = profileFor(subjectA, 'users|a');

    const pending = renderSettled(env);
    env.resolveUpsert(subjectA.primaryEmailAddress.emailAddress, 'users|a');
    const view = await pending;

    assert.deepEqual(env.profileQueryArgs(), [{ clerkId: 'clerk_a' }]);
    assert.equal(view.isLoading, false);
    assert.equal(view.user?._id, 'users|a');
  });

  it('Convex settled unauthenticated: no profile query and the recovery notice', async () => {
    const env = setup(signedInAs(subjectA));
    env.controls.convexAuth = { isLoading: false, isAuthenticated: false };

    const view = await renderSettled(env);

    assert.ok(
      env.profileQueryArgs().every((args) => args === 'skip'),
      'no profile request may run without an authenticated Convex session',
    );
    assert.equal(upsertRequestedFor(env, subjectA.primaryEmailAddress.emailAddress), false, 'no sync may start');
    assert.equal(view.isLoading, false);
    assert.equal(view.user, null);
    assert.ok(view.authSyncError !== null, 'the account must show the sync error');
  });
});

describe('account state is bound to the current Clerk subject', () => {
  it('a finished sync for A is never shown to B while B is still syncing', async () => {
    const env = setup(signedInAs(subjectA));
    env.controls.convexAuth = { isLoading: false, isAuthenticated: true };
    env.controls.queries[PROFILE_QUERY] = profileFor(subjectA, 'users|a');

    const aSync = renderSettled(env);
    env.resolveUpsert(subjectA.primaryEmailAddress.emailAddress, 'users|a');
    assert.equal((await aSync).user?._id, 'users|a', 'A is ready once the server returns its profile');

    env.clerk.current = signedInAs(subjectB);
    const switched = env.render();

    assert.equal(switched.user, null, "A's cached profile must not be shown to B");
    assert.equal(switched.isLoading, true, 'B is loading until its own sync finishes');
  });

  it('a delayed A result that lands after the switch is discarded', async () => {
    const env = setup(signedInAs(subjectA));
    env.controls.convexAuth = { isLoading: false, isAuthenticated: true };
    env.render();

    env.clerk.current = signedInAs(subjectB);
    env.render();
    await env.settle();

    env.resolveUpsert(subjectA.primaryEmailAddress.emailAddress, 'users|a');
    await env.settle();
    const afterA = env.render();

    assert.equal(afterA.user, null, "A's late reply must not make B ready");
    assert.equal(afterA.isLoading, true, 'B is still loading');

    env.resolveUpsert(subjectB.primaryEmailAddress.emailAddress, 'users|b');
    env.controls.queries[PROFILE_QUERY] = profileFor(subjectB, 'users|b');
    const readyB = await renderSettled(env);
    assert.equal(readyB.user?._id, 'users|b', 'B sees only its own profile');
  });

  it('a delayed A error after the switch does not set a recovery error on B', async () => {
    const env = setup(signedInAs(subjectA));
    env.controls.convexAuth = { isLoading: false, isAuthenticated: true };
    env.render();

    env.clerk.current = signedInAs(subjectB);
    env.render();
    await env.settle();

    env.rejectUpsert(subjectA.primaryEmailAddress.emailAddress, 'network down');
    await env.settle();
    const view = env.render();

    assert.equal(view.authSyncError, null, "A's failure must not put B into recovery");
    assert.equal(view.isLoading, true, 'B is still loading');
  });

  it('signing out clears the profile, and a delayed sync cannot restore it', async () => {
    const env = setup(signedInAs(subjectA));
    env.controls.convexAuth = { isLoading: false, isAuthenticated: true };
    env.controls.queries[PROFILE_QUERY] = profileFor(subjectA, 'users|a');
    const pendingA = renderSettled(env);
    env.resolveUpsert(subjectA.primaryEmailAddress.emailAddress, 'users|a');
    assert.equal((await pendingA).user?._id, 'users|a');

    const signedInView = env.render();
    await signedInView.signOut();
    const afterSignOut = env.render();

    assert.equal(afterSignOut.user, null, 'the profile is cleared on sign-out');
    assert.equal(afterSignOut.isSignedIn, false);
    assert.equal(afterSignOut.isLoading, false);
    assert.equal(afterSignOut.authSyncError, null);

    env.resolveUpsert(subjectA.primaryEmailAddress.emailAddress, 'users|a');
    await env.settle();
    assert.equal(env.render().user, null, 'a reply that arrives after sign-out must not restore A');
  });

  it('a cached profile that belongs to another subject is ignored', async () => {
    const env = setup(signedInAs(subjectB));
    env.controls.convexAuth = { isLoading: false, isAuthenticated: true };
    env.controls.queries[PROFILE_QUERY] = profileFor(subjectA, 'users|a');

    const view = env.render();

    assert.equal(view.user, null, "A's profile must not be exposed as B's");
    assert.equal(view.isLoading, true, 'B has no profile of its own yet');
  });

  it('loading, ready, and recovery transitions follow the current subject', async () => {
    const env = setup(signedInAs(subjectA));
    env.controls.convexAuth = { isLoading: true, isAuthenticated: false };
    assert.equal((await renderSettled(env)).isLoading, true, 'loading while Convex authenticates');

    env.controls.convexAuth = { isLoading: false, isAuthenticated: true };
    env.controls.mutations[UPSERT] = (args: unknown) => Promise.reject(new Error(`failed for ${emailOf(args)}`));
    const failed = await renderSettled(env);
    assert.equal(failed.isLoading, false, 'recovery is settled, not loading');
    assert.equal(failed.user, null);
    assert.ok(failed.authSyncError !== null, 'recovery shows the sync error');

    env.controls.mutations[UPSERT] = (args: unknown) =>
      Promise.resolve(emailOf(args) === subjectA.primaryEmailAddress.emailAddress ? 'users|a' : 'users|other');
    env.controls.queries[PROFILE_QUERY] = profileFor(subjectA, 'users|a');
    failed.retryUserSync();
    const retried = await renderSettled(env);
    assert.equal(retried.authSyncError, null, 'a retry clears the recovery error');
    assert.equal(retried.user?._id, 'users|a', 'a successful retry makes the account ready');
  });
});
