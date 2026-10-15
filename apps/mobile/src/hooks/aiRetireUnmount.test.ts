import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import * as React from 'react';
import { createElement } from 'react';
import * as ReactDomClient from 'react-dom/client';
import type { ReactNode } from 'react';

import * as ReactConvex from 'convex/react';
import { getFunctionName } from 'convex/server';

import * as shared from '../../../../packages/shared/src/index';
import { api } from '../../../../convex/_generated/api';
import { mountUnderConvex, type FakeConvexClient } from '../../../../tests/support/realReactRender';
import { createControls, createHarness, withFallback } from '../../../../tests/support/componentHarness';
import type { AiActions } from './useAiActions';
import type { useAiActions as UseAiActions } from './useAiActions';

// Real React (react-dom, and the real useAction from convex/react under a real ConvexProvider) renders the real mobile
// hook. A subject change is a keyed remount, as ConvexClientProvider does it. The auth context, the consent service, and
// AsyncStorage are the only stand-ins, so a test controls which account is active.

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const repoFile = (relativePath: string) => resolve(repoRoot, relativePath);
const hookFile = repoFile('apps/mobile/src/hooks/useAiActions.ts');
const authFile = repoFile('apps/mobile/src/context/AuthProvider.tsx');
const consentFile = repoFile('apps/mobile/src/services/aiConsent.ts');

const tick = () => new Promise((done) => setImmediate(done));

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) {
    await tick();
  }
  assert.equal(predicate(), true, 'the condition was not reached');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const MODERATE = getFunctionName(api.aiModeration.moderateListing);
const replies: Record<string, unknown> = {
  [MODERATE]: {
    ok: true,
    source: 'ai',
    saved: true,
    revision: 1,
    status: 'clear',
    summary: 'Looks fine.',
    flags: [],
  },
};

interface ActionCall {
  readonly action: string;
  readonly args: Record<string, unknown>;
}

// The real useAction calls client.action with the function reference. A held call waits until the test releases it.
function actionClient() {
  const calls: ActionCall[] = [];
  const holds: Array<{ promise: Promise<unknown> }> = [];
  const client = {
    action(reference: Parameters<typeof getFunctionName>[0], args: unknown): Promise<unknown> {
      const name = getFunctionName(reference);
      calls.push({ action: name === MODERATE ? 'moderateListing' : name, args: isRecord(args) ? args : {} });
      const hold = holds.shift();
      if (hold !== undefined) {
        return hold.promise;
      }
      return Promise.resolve(replies[name]);
    },
  };
  return {
    client,
    calls,
    holdNextCall(): (value: unknown) => void {
      let resolve: (value: unknown) => void = () => undefined;
      const promise = new Promise<unknown>((done) => {
        resolve = done;
      });
      holds.push({ promise });
      return resolve;
    },
  };
}

interface HookEnv {
  readonly controls: ReturnType<typeof createControls>;
  readonly actions: ReturnType<typeof actionClient>;
  readonly mounted: ReturnType<typeof mountUnderConvex>;
  readonly reports: Map<string, AiActions>;
  readonly useHook: typeof UseAiActions;
}

interface ProbeProps {
  readonly label: string;
  readonly useHook: typeof UseAiActions;
  readonly reports: Map<string, AiActions>;
}

// The probe is a real component: it calls the real hook during its render, and records what the hook returned.
function Probe(props: ProbeProps): null {
  props.reports.set(props.label, props.useHook());
  return null;
}

function setUp(signedInAs: string): HookEnv {
  const controls = createControls();
  controls.auth = {
    isLoading: false,
    isSignedIn: true,
    user: null,
    clerkUser: { id: signedInAs },
    authSyncError: null,
  };
  const actions = actionClient();
  const fake: FakeConvexClient = { client: actions.client, lifecycle: [], deliver: () => undefined };
  const mounted = mountUnderConvex(fake);

  const harness = createHarness({
    controls,
    convexApi: { api },
    files: {
      [authFile]: withFallback({ useAppAuth: () => controls.auth }),
      [consentFile]: withFallback({ hasAIConsent: async () => true }),
    },
    packages: {
      react: withFallback({ ...React }),
      '@gettitonline/shared': withFallback({ ...shared }),
      'convex/react': withFallback({ ...ReactConvex }),
      'expo-crypto': withFallback({ randomUUID: () => '00000000-0000-4000-8000-000000000000' }),
      '@react-native-async-storage/async-storage': withFallback({
        default: {
          getItem: async () => null,
          setItem: async () => undefined,
        },
      }),
    },
  });
  const useHook = harness.load(hookFile).useAiActions as typeof UseAiActions;
  return { controls, actions, mounted, reports: new Map(), useHook };
}

// realReactRender's root is not strict, and react-dom replays layout effects only in a strict root. A root created with
// unstable_strictMode replays them as setup, cleanup, setup in one synchronous commit, as the development app does. This
// renders the Convex provider into such a root, in the document mountUnderConvex installed.
interface DocumentLike {
  createElement(tag: string): object;
}

interface StrictRoot {
  render(children: ReactNode): void;
  unmount(): void;
}

interface StrictRenderer {
  createRoot(container: object, options: object): StrictRoot;
}

interface StrictProviderModule {
  ConvexProvider(props: { client: object; children?: ReactNode }): ReactNode | Promise<ReactNode>;
}

const strictRenderer: StrictRenderer = ReactDomClient;
const strictProviders: StrictProviderModule = ReactConvex;

function isDocumentLike(value: unknown): value is DocumentLike {
  return isRecord(value) && typeof value.createElement === 'function';
}

async function renderInStrictRoot(client: object, element: ReactNode): Promise<void> {
  const win: unknown = Reflect.get(globalThis, 'window');
  const doc: unknown = isRecord(win) ? Reflect.get(win, 'document') : undefined;
  if (!isDocumentLike(doc)) {
    throw new Error('mountUnderConvex must install a document first');
  }
  const root = strictRenderer.createRoot(doc.createElement('div'), { unstable_strictMode: true });
  await React.act(async () => {
    root.render(createElement(strictProviders.ConvexProvider, { client }, element));
  });
}

function probe(env: HookEnv, label: string, key: string): ReactNode {
  return createElement(Probe, { key, label, useHook: env.useHook, reports: env.reports });
}

function actionsFor(env: HookEnv, label: string): AiActions {
  const actions = env.reports.get(label);
  if (actions === undefined) {
    throw new Error(`the ${label} hook must have rendered`);
  }
  return actions;
}

const rejectsWith = (code: string) => (error: unknown) =>
  error instanceof Error && error.name === 'AiRequestError' && error.message.includes(code);

const MODERATE_INPUT = { productId: 'products_1' };

describe('mobile useAiActions after a keyed remount', () => {
  it('a pending reply from the old account is refused after the remount to the new account', async () => {
    const env = setUp('clerk_a');
    await env.mounted.render(probe(env, 'A', 'clerk_a'));
    const a = actionsFor(env, 'A');
    const releaseA = env.actions.holdNextCall();

    const pendingA = a.moderateListing(MODERATE_INPUT);
    await until(() => env.actions.calls.length === 1);

    env.controls.auth = {
      isLoading: false,
      isSignedIn: true,
      user: null,
      clerkUser: { id: 'clerk_b' },
      authSyncError: null,
    };
    await env.mounted.render(probe(env, 'B', 'clerk_b'));
    releaseA(replies[MODERATE]);

    await assert.rejects(pendingA, rejectsWith('account_changed'));
    assert.equal(a.isCurrent(), false, "the old account's hook is no longer current");
  });

  it("after the remount, the old account's callbacks never reach the transport", async () => {
    const env = setUp('clerk_a');
    await env.mounted.render(probe(env, 'A', 'clerk_a'));
    const a = actionsFor(env, 'A');

    env.controls.auth = {
      isLoading: false,
      isSignedIn: true,
      user: null,
      clerkUser: { id: 'clerk_b' },
      authSyncError: null,
    };
    await env.mounted.render(probe(env, 'B', 'clerk_b'));

    await assert.rejects(a.moderateListing(MODERATE_INPUT), rejectsWith('account_changed'));
    assert.deepEqual(env.actions.calls, [], 'no call is sent on behalf of the old account');
  });

  it('a real unmount with no remount refuses a pending reply', async () => {
    const env = setUp('clerk_a');
    await env.mounted.render(probe(env, 'A', 'clerk_a'));
    const a = actionsFor(env, 'A');
    const releaseA = env.actions.holdNextCall();

    const pendingA = a.moderateListing(MODERATE_INPUT);
    await until(() => env.actions.calls.length === 1);
    await env.mounted.unmount();
    releaseA(replies[MODERATE]);

    await assert.rejects(pendingA, rejectsWith('account_changed'));
    assert.equal(a.isCurrent(), false);
  });

  it('re-rendering the same account keeps the hook current and its callbacks working', async () => {
    const env = setUp('clerk_a');
    await env.mounted.render(probe(env, 'A', 'clerk_a'));
    await env.mounted.render(probe(env, 'A', 'clerk_a'));

    await actionsFor(env, 'A').moderateListing(MODERATE_INPUT);

    assert.equal(actionsFor(env, 'A').isCurrent(), true);
    assert.equal(env.actions.calls.length, 1);
  });

  it('in a StrictMode root, the effect replay does not retire a live hook', async () => {
    const env = setUp('clerk_a');
    await renderInStrictRoot(env.actions.client, probe(env, 'A', 'clerk_a'));
    const a = actionsFor(env, 'A');

    await a.moderateListing(MODERATE_INPUT);

    assert.equal(a.isCurrent(), true);
    assert.equal(env.actions.calls.length, 1);
  });
});
