import assert from 'node:assert/strict';
import { beforeEach, before, describe, it } from 'node:test';
import { act, createElement, type ReactNode } from 'react';
import { getFunctionName } from 'convex/server';

import { resolveAccountAccess } from '../../../../packages/shared/src/utils/accountAccess';
import { api } from '../../../../convex/_generated/api';
import { ConvexClientDouble } from '../../../../tests/support/convexSubjectClientDouble';
import {
  clerk,
  mountWithClient,
  resetDoubles,
  server,
  settleTasks,
  subject,
} from '../../../../tests/support/convexSubjectHarness';

// Runs the real AuthProvider under the real ConvexProviderWithClerk, with one client double. The client can stay
// authenticated while Clerk reports another subject, which is the state a switch leaves behind when a client is reused.
// Account access is read through the shared resolver the app uses.
import type * as AuthModule from './AuthProvider';

let AuthProvider: typeof AuthModule.AuthProvider;
let useAppAuth: typeof AuthModule.useAppAuth;
before(async () => {
  ({ AuthProvider, useAppAuth } = await import('./AuthProvider'));
});

const profileQuery = getFunctionName(api.users.getUserByClerkId);
const upsertMutation = getFunctionName(api.users.upsertUser);

interface Profile {
  readonly _id: string;
  readonly clerkId: string;
  readonly role: string;
  readonly isBanned: boolean;
  readonly deletedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
}

function profileFor(clerkId: string, overrides: Partial<Profile> = {}): Profile {
  return {
    _id: `users_${clerkId}`,
    clerkId,
    role: 'user',
    isBanned: false,
    createdAt: 1,
    updatedAt: 1,
    email: `${clerkId}@example.invalid`,
    firstName: clerkId,
    lastName: 'Test',
    ...overrides,
  };
}

interface Seen {
  readonly isLoading: boolean;
  readonly isSignedIn: boolean;
  readonly user: {
    readonly _id: string;
    readonly clerkId: string;
    readonly isBanned?: boolean;
    readonly deletedAt?: number;
  } | null;
  readonly authSyncError: string | null;
  readonly access: string;
}

let latest: Seen | null = null;
// Every render the probe made, in order. An intermediate render is visible here even when the final one is correct.
const history: Seen[] = [];

function Probe(): ReactNode {
  const auth = useAppAuth();
  latest = {
    isLoading: auth.isLoading,
    isSignedIn: auth.isSignedIn,
    user: auth.user,
    authSyncError: auth.authSyncError,
    access: resolveAccountAccess({
      isLoading: auth.isLoading,
      isSignedIn: auth.isSignedIn,
      syncFailed: auth.authSyncError !== null,
      user: auth.user,
    }),
  };
  history.push(latest);
  return null;
}

function seen(): Seen {
  assert.ok(latest, 'the probe rendered');
  return latest;
}

function renderApp(client: ConvexClientDouble) {
  const root = mountWithClient(client);
  return {
    render: () => root.render(createElement(AuthProvider, { children: createElement(Probe) })),
    unmount: () => root.unmount(),
  };
}

describe('AuthProvider exposes only a profile owned by the current Clerk subject', () => {
  beforeEach(() => {
    resetDoubles();
    latest = null;
    history.length = 0;
  });

  it('a session still authenticated as A while Clerk says B exposes no user, even when the sync reply is A id', async () => {
    clerk.user = subject('clerk_B');
    server.mutations.set(upsertMutation, async () => 'users_A');
    // The stale session has no profile for B yet, so the query is pending.
    server.queries.set(profileQuery, () => undefined);
    const client = new ConvexClientDouble('https://auth-test.example.invalid');
    const app = renderApp(client);
    await app.render();
    await settleTasks();
    await app.render();

    assert.equal(seen().user, null, 'an ID-only sync reply is not ownership');
    assert.equal(seen().isLoading, true, 'the account stays loading until the server confirms its profile');
    await app.unmount();
  });

  it('a profile that the server returns for another subject is not exposed as B', async () => {
    clerk.user = subject('clerk_B');
    server.mutations.set(upsertMutation, async () => 'users_A');
    server.queries.set(profileQuery, () => profileFor('clerk_A'));
    const client = new ConvexClientDouble('https://auth-test.example.invalid');
    const app = renderApp(client);
    await app.render();
    await settleTasks();
    await app.render();

    assert.equal(seen().user, null, 'a row whose clerkId is not the current subject is never exposed');
    await app.unmount();
  });

  it('after an authoritative null profile for a synced account, access is recovery, not ready', async () => {
    clerk.user = subject('clerk_A');
    server.mutations.set(upsertMutation, async () => 'users_clerk_A');
    server.queries.set(profileQuery, () => profileFor('clerk_A'));
    const client = new ConvexClientDouble('https://auth-test.example.invalid');
    const app = renderApp(client);
    await app.render();
    await settleTasks();
    await app.render();
    assert.equal(seen().access, 'ready', 'precondition: the synced account is ready');

    // The backend reports no current account for this subject, as after deletion.
    const rendersBeforeNull = history.length;
    server.queries.set(profileQuery, () => null);
    await act(async () => {
      server.changed(profileQuery);
    });

    const rendersAfterNull = history.slice(rendersBeforeNull);
    assert.ok(rendersAfterNull.length > 0, 'the authoritative null re-rendered the account');
    assert.deepEqual(
      rendersAfterNull.filter((view) => view.user !== null),
      [],
      'no render after the authoritative null exposes the cached profile, not only the final one',
    );
    assert.equal(seen().user, null, 'a deleted account is not kept as a synthetic ready profile');
    assert.notEqual(seen().authSyncError, null, 'the account surfaces the recovery path');
    assert.equal(seen().access, 'recovery');
    await app.unmount();
  });

  it('a null profile before the subject sync settles is not treated as deleted', async () => {
    clerk.user = subject('clerk_A');
    let finishSync: (userId: string) => void = () => undefined;
    server.mutations.set(
      upsertMutation,
      () =>
        new Promise<string>((resolve) => {
          finishSync = resolve;
        }),
    );
    server.queries.set(profileQuery, () => null);
    const client = new ConvexClientDouble('https://auth-test.example.invalid');
    const app = renderApp(client);
    await app.render();
    await settleTasks();
    await app.render();

    assert.equal(seen().user, null);
    assert.equal(seen().authSyncError, null, 'the upsert has not finished, so there is no sync error yet');
    assert.equal(seen().access, 'loading');
    finishSync('users_clerk_A');
    await app.unmount();
  });

  it('a pending profile keeps the verified profile only for the same subject', async () => {
    clerk.user = subject('clerk_A');
    server.mutations.set(upsertMutation, async () => 'users_clerk_A');
    server.queries.set(profileQuery, () => profileFor('clerk_A'));
    const client = new ConvexClientDouble('https://auth-test.example.invalid');
    const app = renderApp(client);
    await app.render();
    await settleTasks();
    await app.render();
    assert.equal(seen().access, 'ready');

    server.queries.set(profileQuery, () => undefined);
    await act(async () => {
      server.changed(profileQuery);
    });
    assert.equal(
      seen().user?.clerkId,
      'clerk_A',
      'the same subject keeps its verified profile while the query reloads',
    );

    clerk.user = subject('clerk_B');
    await app.render();
    assert.equal(seen().user, null, 'subject B never sees the profile verified for subject A');
    await app.unmount();
  });

  it('banned and deleted profiles stay exposed, so the resolver reports them as unavailable', async () => {
    clerk.user = subject('clerk_A');
    server.mutations.set(upsertMutation, async () => 'users_clerk_A');
    server.queries.set(profileQuery, () => profileFor('clerk_A', { isBanned: true }));
    const client = new ConvexClientDouble('https://auth-test.example.invalid');
    const app = renderApp(client);
    await app.render();
    await settleTasks();
    await app.render();
    assert.equal(seen().user?.isBanned, true);
    assert.equal(seen().access, 'unavailable');

    server.queries.set(profileQuery, () => profileFor('clerk_A', { deletedAt: 5 }));
    await act(async () => {
      server.changed(profileQuery);
    });
    assert.equal(seen().user?.deletedAt, 5);
    assert.equal(seen().access, 'unavailable');
    await app.unmount();
  });
});
