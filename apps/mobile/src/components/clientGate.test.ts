import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import React, { act, createElement, useEffect, type ReactNode } from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import * as ConvexReact from 'convex/react';
import { anyApi } from 'convex/server';

import {
  isHttpsStoreUrl,
  readClientGateContract,
  resolveClientGate,
} from '../../../../packages/shared/src/utils/clientGate';
import {
  createControls,
  createHarness,
  findNodes,
  pressButton,
  textOf,
  withFallback,
  type HarnessControls,
  type Props,
} from '../../../../tests/support/componentHarness';
import { createFakeConvexClient, deliver, mountUnderConvex } from '../../../../tests/support/realReactRender';

// Runs the real ClientGate and UpdateRequiredScreen with controlled React Native, Expo, and Convex values.
// The gate query is faked through useQueries, so a test decides what the server returned, including an Error.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const file = (path: string) => resolve(root, path);
const storeUrl = 'https://apps.apple.com/app/id1234567890';
const gateKey = 'appConfig.getClientGate';
// The saved block the gate keeps across launches. Seeding it here means a test can model a cold start.
const blockedBuildKey = 'gettitonline.clientGate.blockedBuild.v1';
const blockingGate = { updateRequired: true, minimumBuild: 50, storeUrl, paymentsEnabled: true };
const currentGate = { updateRequired: false, minimumBuild: 1, storeUrl: null, paymentsEnabled: true };

interface Setup {
  readonly platform: 'ios' | 'android' | 'web';
  // The app-config build number. Under remote app versioning it is usually absent, so it is only a fallback.
  readonly buildNumber: string | undefined;
  // The native build number, as expo-application reads it from the installed binary.
  readonly nativeBuildVersion?: string | null;
  readonly gate: unknown;
  readonly storage?: FakeAsyncStorage;
}

// Stands in for @react-native-async-storage/async-storage. A failing read models a storage that cannot be opened.
class FakeAsyncStorage {
  readonly items: Map<string, string>;
  failReads = false;

  constructor(initial: Record<string, string> = {}) {
    this.items = new Map(Object.entries(initial));
  }

  async getItem(key: string): Promise<string | null> {
    if (this.failReads) {
      throw new Error('storage unavailable');
    }
    return this.items.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.items.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.items.delete(key);
  }
}

function open(setup: Setup) {
  const controls = createControls();
  controls.queries = { [gateKey]: setup.gate };
  const appStateListeners: ((next: string) => void)[] = [];
  const storage = setup.storage ?? new FakeAsyncStorage();
  const harness = createHarness({
    controls,
    effects: true,
    // The error boundary is a class, which the harness cannot invoke, so it is replaced by a pass-through here.
    files: {
      [file('apps/mobile/src/components/ClientGateBoundary.tsx')]: withFallback({
        ClientGateBoundary: (props: Props) => props.children,
      }),
    },
    packages: {
      '@gettitonline/shared': withFallback({ resolveClientGate, readClientGateContract, isHttpsStoreUrl }),
      'react-native': withFallback({
        Platform: { OS: setup.platform },
        AppState: {
          currentState: 'active',
          addEventListener: (_type: string, listener: (next: string) => void) => {
            appStateListeners.push(listener);
            return { remove: () => undefined };
          },
        },
        Linking: {
          openURL: (...args: unknown[]) => {
            controls.calls.push({ name: 'Linking.openURL', args });
            return Promise.resolve();
          },
        },
      }),
      'expo-constants': withFallback({
        default: {
          expoConfig: {
            ios: { buildNumber: setup.buildNumber },
            android: { versionCode: setup.buildNumber === undefined ? undefined : Number(setup.buildNumber) },
          },
        },
      }),
      'expo-application': withFallback({ nativeBuildVersion: setup.nativeBuildVersion }),
      // The app imports the storage as a default export, so the fake is exposed under `default`.
      '@react-native-async-storage/async-storage': withFallback({
        default: {
          getItem: (key: string) => storage.getItem(key),
          setItem: (key: string, value: string) => storage.setItem(key, value),
          removeItem: (key: string) => storage.removeItem(key),
        },
      }),
    },
  });
  const gate = harness.load(file('apps/mobile/src/components/ClientGate.tsx')).ClientGate as (
    props: Record<string, unknown>,
  ) => unknown;
  const screen = harness.load(file('apps/mobile/src/components/UpdateRequiredScreen.tsx')).UpdateRequiredScreen as (
    props: Record<string, unknown>,
  ) => unknown;

  return {
    controls,
    appStateListeners,
    storage,
    // Renders the gate, lets its launch check settle, then renders again so the settled decision shows.
    async launch() {
      harness.render(gate, { children: 'App content' });
      await harness.settle();
      return harness.render(gate, { children: 'App content' });
    },
    screen: (props: Record<string, unknown>) => harness.render(screen, props),
  };
}

// Sends a background-then-foreground pair, as the OS does when the app returns to the foreground.
function resume(listeners: readonly ((next: string) => void)[]) {
  for (const listener of listeners) {
    listener('background');
    listener('active');
  }
}

// The gate's subscription lifecycle, in order: 'subscribe', 'unsubscribe', or 'identity-change'.
function gateWatchEvents(controls: HarnessControls): string[] {
  return controls.queryWatches.filter((watch) => watch.name === gateKey).map((watch) => watch.event);
}

const iosBuild42 = { platform: 'ios', buildNumber: '42' } as const;

test('the blocking screen shows when the server requires an update, above the app content', async () => {
  const result = await open({
    ...iosBuild42,
    gate: { updateRequired: true, minimumBuild: 50, storeUrl, paymentsEnabled: true },
  }).launch();
  assert.ok(textOf(result.tree).includes('Update required'), textOf(result.tree));
  assert.ok(!textOf(result.tree).includes('App content'));
});

test('the app content stays visible while the gate query is still loading', async () => {
  const result = await open({ ...iosBuild42, gate: undefined }).launch();
  assert.ok(textOf(result.tree).includes('App content'));
  assert.ok(!textOf(result.tree).includes('Update required'));
});

for (const [label, gate] of [
  ['an error-shaped result', null],
  ['a malformed flag', { updateRequired: 'true', storeUrl }],
  ['a current build', { updateRequired: false, minimumBuild: 40, storeUrl: null, paymentsEnabled: true }],
] as const) {
  test(`the app content stays visible for ${label} (version gate fails open)`, async () => {
    const result = await open({ ...iosBuild42, gate }).launch();
    assert.ok(textOf(result.tree).includes('App content'), textOf(result.tree));
    assert.ok(!textOf(result.tree).includes('Update required'));
  });
}

test('a build without a numeric native build number skips the check and never queries the gate', async () => {
  const setup = open({ platform: 'ios', buildNumber: 'dev', gate: blockingGate });
  const result = await setup.launch();
  assert.ok(textOf(result.tree).includes('App content'));
  const gateCalls = result.queryCalls.filter((call) => call.name === gateKey);
  assert.equal(gateCalls.length, 0);
});

test('a gate query that fails with a server error leaves the app open', async () => {
  const result = await open({ ...iosBuild42, gate: new Error('server unavailable') }).launch();
  assert.ok(textOf(result.tree).includes('App content'), textOf(result.tree));
  assert.ok(!textOf(result.tree).includes('Update required'));
});

test('a blocked build stays blocked while the gate re-checks on resume and the query is still loading', async () => {
  const setup = open({ ...iosBuild42, gate: blockingGate });
  assert.ok(textOf((await setup.launch()).tree).includes('Update required'));

  const watchesBeforeResume = gateWatchEvents(setup.controls).length;
  setup.controls.queries[gateKey] = undefined;
  resume(setup.appStateListeners);
  const resumed = await setup.launch();
  assert.ok(textOf(resumed.tree).includes('Update required'), textOf(resumed.tree));
  assert.ok(!textOf(resumed.tree).includes('App content'));
  assert.deepEqual(gateWatchEvents(setup.controls).slice(watchesBeforeResume), ['unsubscribe', 'subscribe']);
});

test('a blocked build stays blocked when the re-check on resume fails with a server error', async () => {
  const setup = open({ ...iosBuild42, gate: blockingGate });
  assert.ok(textOf((await setup.launch()).tree).includes('Update required'));

  setup.controls.queries[gateKey] = undefined;
  resume(setup.appStateListeners);
  assert.ok(textOf((await setup.launch()).tree).includes('Update required'));

  setup.controls.queries[gateKey] = new Error('server unavailable');
  resume(setup.appStateListeners);
  const failed = await setup.launch();
  assert.ok(textOf(failed.tree).includes('Update required'), textOf(failed.tree));
  assert.ok(!textOf(failed.tree).includes('App content'));
});

test('a blocked build stays blocked when a re-check returns a malformed result', async () => {
  const setup = open({ ...iosBuild42, gate: blockingGate });
  assert.ok(textOf((await setup.launch()).tree).includes('Update required'));

  setup.controls.queries[gateKey] = { updateRequired: 'true', storeUrl };
  resume(setup.appStateListeners);
  assert.ok(textOf((await setup.launch()).tree).includes('Update required'));
});

test('a blocked build is unblocked by a successful result that says the build is acceptable', async () => {
  const setup = open({ ...iosBuild42, gate: blockingGate });
  assert.ok(textOf((await setup.launch()).tree).includes('Update required'));

  setup.controls.queries[gateKey] = currentGate;
  resume(setup.appStateListeners);
  const unblocked = await setup.launch();
  assert.ok(textOf(unblocked.tree).includes('App content'), textOf(unblocked.tree));
  assert.ok(!textOf(unblocked.tree).includes('Update required'));
});

test('an open build that then gets an Error result stays open', async () => {
  const setup = open({ ...iosBuild42, gate: currentGate });
  assert.ok(textOf((await setup.launch()).tree).includes('App content'));

  setup.controls.queries[gateKey] = new Error('server unavailable');
  resume(setup.appStateListeners);
  const failed = await setup.launch();
  assert.ok(textOf(failed.tree).includes('App content'), textOf(failed.tree));
  assert.ok(!textOf(failed.tree).includes('Update required'));
});

test('a server block is saved for the installed build, so a later cold start can keep it', async () => {
  const setup = open({ ...iosBuild42, gate: blockingGate });
  await setup.launch();
  const saved = JSON.parse(setup.storage.items.get(blockedBuildKey) ?? 'null');
  assert.deepEqual(saved, { platform: 'ios', build: 42, minimumBuild: 50, storeUrl });
});

test('a cold start with a saved block and a failing gate query stays blocked', async () => {
  const storage = new FakeAsyncStorage({
    [blockedBuildKey]: JSON.stringify({ platform: 'ios', build: 42, minimumBuild: 50, storeUrl }),
  });
  const setup = open({ ...iosBuild42, gate: new Error('network unavailable'), storage });
  const result = await setup.launch();
  assert.ok(textOf(result.tree).includes('Update required'), textOf(result.tree));
  assert.ok(!textOf(result.tree).includes('App content'));
  assert.ok(pressButton(result.tree, 'Update now'), 'the saved store link is offered');
});

test('a cold start with a saved block for an older build is ignored, so the app opens', async () => {
  const storage = new FakeAsyncStorage({
    [blockedBuildKey]: JSON.stringify({ build: 41, minimumBuild: 50, storeUrl }),
  });
  const setup = open({ ...iosBuild42, gate: new Error('network unavailable'), storage });
  const result = await setup.launch();
  assert.ok(textOf(result.tree).includes('App content'), textOf(result.tree));
  assert.ok(!textOf(result.tree).includes('Update required'));
});

test('a saved block that is not valid JSON or has the wrong shape is ignored, so the app opens', async () => {
  for (const raw of ['not json', JSON.stringify({ build: 42, minimumBuild: '50', storeUrl })]) {
    const storage = new FakeAsyncStorage({ [blockedBuildKey]: raw });
    const result = await open({ ...iosBuild42, gate: new Error('network unavailable'), storage }).launch();
    assert.ok(textOf(result.tree).includes('App content'), raw);
  }
});

test('a storage read failure fails open, even when the gate query also fails', async () => {
  const storage = new FakeAsyncStorage({
    [blockedBuildKey]: JSON.stringify({ platform: 'ios', build: 42, minimumBuild: 50, storeUrl }),
  });
  storage.failReads = true;
  const result = await open({ ...iosBuild42, gate: new Error('network unavailable'), storage }).launch();
  assert.ok(textOf(result.tree).includes('App content'), textOf(result.tree));
  assert.ok(!textOf(result.tree).includes('Update required'));
});

test('a native build number from expo-application is checked when the app config has no build number', async () => {
  const result = await open({
    platform: 'ios',
    buildNumber: undefined,
    nativeBuildVersion: '42',
    gate: blockingGate,
  }).launch();
  const gateCall = result.queryCalls.find((call) => call.name === gateKey && call.args !== 'skip');
  assert.deepEqual(gateCall?.args, { platform: 'ios', build: 42 });
  assert.ok(textOf(result.tree).includes('Update required'), textOf(result.tree));
});

test('the native build number wins over the app-config build number', async () => {
  const result = await open({
    platform: 'ios',
    buildNumber: '7',
    nativeBuildVersion: '42',
    gate: currentGate,
  }).launch();
  const gateCall = result.queryCalls.find((call) => call.name === gateKey && call.args !== 'skip');
  assert.deepEqual(gateCall?.args, { platform: 'ios', build: 42 });
});

test('a native Android build number is checked against the gate and blocks a retired build', async () => {
  const result = await open({
    platform: 'android',
    buildNumber: undefined,
    nativeBuildVersion: '7',
    gate: blockingGate,
  }).launch();
  const gateCall = result.queryCalls.find((call) => call.name === gateKey && call.args !== 'skip');
  assert.deepEqual(gateCall?.args, { platform: 'android', build: 7 });
  assert.ok(textOf(result.tree).includes('Update required'), textOf(result.tree));
});

test('an installed build below, equal to, and above the minimum is blocked, allowed, and allowed', async () => {
  const minimumBuild = 50;
  for (const [build, blocked] of [
    ['49', true],
    ['50', false],
    ['51', false],
  ] as const) {
    const gate = { updateRequired: Number(build) < minimumBuild, minimumBuild, storeUrl, paymentsEnabled: true };
    const result = await open({ platform: 'ios', buildNumber: undefined, nativeBuildVersion: build, gate }).launch();
    const gateCall = result.queryCalls.find((call) => call.name === gateKey && call.args !== 'skip');
    assert.deepEqual(gateCall?.args, { platform: 'ios', build: Number(build) });
    assert.equal(textOf(result.tree).includes('Update required'), blocked, `build ${build}`);
  }
});

test('a native build that is retired while the app runs is blocked on resume', async () => {
  const setup = open({ platform: 'ios', buildNumber: undefined, nativeBuildVersion: '42', gate: currentGate });
  assert.ok(textOf((await setup.launch()).tree).includes('App content'));

  setup.controls.queries[gateKey] = blockingGate;
  resume(setup.appStateListeners);
  assert.ok(textOf((await setup.launch()).tree).includes('Update required'));
});

test('a native build number that is not a positive whole number skips the check when the app config has none', async () => {
  for (const nativeBuildVersion of ['', 'dev', '0', '1.5', '-3', '42abc', ' 42']) {
    const setup = open({ platform: 'ios', buildNumber: undefined, nativeBuildVersion, gate: blockingGate });
    const result = await setup.launch();
    assert.ok(textOf(result.tree).includes('App content'), JSON.stringify(nativeBuildVersion));
    assert.equal(
      result.queryCalls.filter((call) => call.name === gateKey).length,
      0,
      JSON.stringify(nativeBuildVersion),
    );
  }
});

test('a zero app-config build number is not a real build, so the check is skipped', async () => {
  const result = await open({
    platform: 'ios',
    buildNumber: '0',
    nativeBuildVersion: null,
    gate: blockingGate,
  }).launch();
  assert.ok(textOf(result.tree).includes('App content'), textOf(result.tree));
  assert.equal(result.queryCalls.filter((call) => call.name === gateKey).length, 0);
});

test('a native build number that is not usable falls back to the app-config build number', async () => {
  const result = await open({
    platform: 'ios',
    buildNumber: '42',
    nativeBuildVersion: 'dev',
    gate: currentGate,
  }).launch();
  const gateCall = result.queryCalls.find((call) => call.name === gateKey && call.args !== 'skip');
  assert.deepEqual(gateCall?.args, { platform: 'ios', build: 42 });
});

test('an open build stays open while the gate re-checks on resume and the query is still loading', async () => {
  const setup = open({ ...iosBuild42, gate: currentGate });
  assert.ok(textOf((await setup.launch()).tree).includes('App content'));

  setup.controls.queries[gateKey] = undefined;
  resume(setup.appStateListeners);
  const resumed = await setup.launch();
  assert.ok(textOf(resumed.tree).includes('App content'), textOf(resumed.tree));
  assert.ok(!textOf(resumed.tree).includes('Update required'));
});

test('a platform other than iOS or Android skips the check', async () => {
  const result = await open({ platform: 'web', buildNumber: '1', gate: blockingGate }).launch();
  assert.ok(textOf(result.tree).includes('App content'));
});

test('an Android build queries the gate with its versionCode', async () => {
  const result = await open({
    platform: 'android',
    buildNumber: '7',
    gate: { updateRequired: false, minimumBuild: 1, storeUrl: null, paymentsEnabled: true },
  }).launch();
  const gateCall = result.queryCalls.find((call) => call.name === gateKey && call.args !== 'skip');
  assert.deepEqual(gateCall?.args, { platform: 'android', build: 7 });
});

test('returning to the foreground re-checks the gate and blocks a build that was just retired', async () => {
  const setup = open({
    ...iosBuild42,
    gate: { updateRequired: false, minimumBuild: 1, storeUrl: null, paymentsEnabled: true },
  });
  const first = await setup.launch();
  assert.ok(textOf(first.tree).includes('App content'));

  const watchesBeforeResume = gateWatchEvents(setup.controls).length;
  setup.controls.queries[gateKey] = { updateRequired: true, minimumBuild: 50, storeUrl, paymentsEnabled: true };
  for (const listener of setup.appStateListeners) {
    listener('background');
    listener('active');
  }
  const resumed = await setup.launch();
  assert.ok(textOf(resumed.tree).includes('Update required'), textOf(resumed.tree));
  assert.deepEqual(gateWatchEvents(setup.controls).slice(watchesBeforeResume), ['unsubscribe', 'subscribe']);
});

test('the gate request object keeps its identity across renders, so useQueries does not re-subscribe', async () => {
  const setup = open({ ...iosBuild42, gate: currentGate });
  await setup.launch();
  await setup.launch();
  assert.deepEqual(gateWatchEvents(setup.controls), ['subscribe']);
});

test('the update screen offers an Update now store link only for a valid https URL', () => {
  for (const url of [storeUrl, 'https://play.google.com/store/apps/details?id=com.example']) {
    const { screen, controls } = open({ ...iosBuild42, gate: undefined });
    const result = screen({ storeUrl: url });
    assert.ok(textOf(result.tree).includes('Update required'));
    assert.ok(pressButton(result.tree, 'Update now'));
    assert.deepEqual(controls.calls.at(-1), { name: 'Linking.openURL', args: [url] });
  }
});

test('the update screen hides the store link when the URL is missing or not https', () => {
  for (const url of [null, 'http://apps.apple.com/app/id1', 'javascript:alert(1)', '']) {
    const result = open({ ...iosBuild42, gate: undefined }).screen({ storeUrl: url });
    assert.ok(textOf(result.tree).includes('Update required'));
    assert.equal(findNodes(result.tree, (node) => textOf(node.children) === 'Update now').length, 0, String(url));
  }
});

// Real React and convex/react, with the hook loaded from source. The fake client delivers results and Errors through
// the real watch protocol, so an unstable request object loops during render here exactly as it does in the app.
const realGateName = 'appConfig:getClientGate';

function mountRealClientGate() {
  const harness = createHarness({
    controls: createControls(),
    convexApi: { api: anyApi },
    packages: {
      react: React,
      'convex/react': ConvexReact,
      'react-native': withFallback({
        Platform: { OS: 'ios' },
        AppState: {
          currentState: 'active',
          addEventListener: () => ({ remove: () => undefined }),
        },
      }),
      'expo-constants': withFallback({
        default: { expoConfig: { ios: { buildNumber: '42' }, android: { versionCode: 42 } } },
      }),
      'expo-application': withFallback({ nativeBuildVersion: '42' }),
      '@gettitonline/shared': withFallback({ resolveClientGate, readClientGateContract, isHttpsStoreUrl }),
    },
  });
  const useClientGate = harness.load(file('apps/mobile/src/hooks/useClientGate.ts')).useClientGate as () => unknown;
  const observed = { renders: 0, last: undefined as unknown };
  function Probe(): null {
    observed.renders += 1;
    observed.last = useClientGate();
    return null;
  }
  return { Probe, observed };
}

test('the real useQueries renders the gate without a render loop, and a parent re-render keeps the decision', async () => {
  const convex = createFakeConvexClient();
  const { Probe, observed } = mountRealClientGate();
  const mounted = mountUnderConvex(convex);
  await mounted.render(createElement(Probe));
  await deliver(convex, realGateName, blockingGate);
  assert.deepEqual(observed.last, {
    status: 'settled',
    decision: { status: 'update-required', minimumBuild: 50, storeUrl },
  });

  await mounted.render(createElement(Probe));
  assert.deepEqual(observed.last, {
    status: 'settled',
    decision: { status: 'update-required', minimumBuild: 50, storeUrl },
  });
  assert.ok(observed.renders <= 4, `rendered ${observed.renders} times`);
  assert.deepEqual(convex.lifecycle, [`subscribe:${realGateName}`]);
  await mounted.unmount();
});

test('the real useQueries reports an Error as pending, so the gate keeps its last decision', async () => {
  const convex = createFakeConvexClient();
  const { Probe, observed } = mountRealClientGate();
  const mounted = mountUnderConvex(convex);
  await mounted.render(createElement(Probe));
  await deliver(convex, realGateName, new Error('server unavailable'));
  assert.deepEqual(observed.last, { status: 'pending' });
  await mounted.unmount();
  assert.deepEqual(convex.lifecycle.slice(-1), [`unsubscribe:${realGateName}`]);
});

// Real React and convex/react mount the whole gate, so the app content's mount and effects are the real ones. The
// storage read can be held, failed, or answered later, and the AppState fake records each subscription.
const realBlockedKey = blockedBuildKey;

// Storage whose reads wait until the test answers them, so a test can run the gate while hydration is still pending.
class HeldAsyncStorage {
  readonly items: Map<string, string>;
  holdReads = false;
  failReads = false;
  private waiting: Array<() => void> = [];

  constructor(initial: Record<string, string> = {}) {
    this.items = new Map(Object.entries(initial));
  }

  getItem(key: string): Promise<string | null> {
    // The value is read when the request starts, as a storage read is, so a later write does not change this answer.
    const value = this.items.get(key) ?? null;
    if (this.holdReads) {
      return new Promise<string | null>((resolveRead, rejectRead) => {
        this.waiting.push(() => (this.failReads ? rejectRead(new Error('storage unavailable')) : resolveRead(value)));
      });
    }
    if (this.failReads) {
      return Promise.reject(new Error('storage unavailable'));
    }
    return Promise.resolve(this.items.get(key) ?? null);
  }

  setItem(key: string, value: string): Promise<void> {
    this.items.set(key, value);
    return Promise.resolve();
  }

  removeItem(key: string): Promise<void> {
    this.items.delete(key);
    return Promise.resolve();
  }

  // Answers every held read.
  answerReads(): void {
    const answers = this.waiting;
    this.waiting = [];
    for (const answer of answers) {
      answer();
    }
  }
}

interface RealGateSetup {
  readonly platform?: 'ios' | 'android';
  readonly nativeBuildVersion?: string;
  readonly storage: HeldAsyncStorage;
}

// Labels rendered by the stand-in text components that are mounted now, so a test asserts what the user can see.
const shownLabels = new Set<string>();
// The app content's lifecycle, in order. A protected effect that runs in the window shows up here.
const appEvents: string[] = [];

function ShownLabel({ children }: { readonly children?: ReactNode }) {
  const label = typeof children === 'string' ? children : '';
  useEffect(() => {
    shownLabels.add(label);
    return () => {
      shownLabels.delete(label);
    };
  }, [label]);
  return null;
}

function AppContent() {
  useEffect(() => {
    appEvents.push('app-mounted');
    return () => {
      appEvents.push('app-unmounted');
    };
  }, []);
  return null;
}

function mountRealGate(setup: RealGateSetup) {
  // A failed test can leave its tree mounted, so each mount starts from empty shared state.
  shownLabels.clear();
  appEvents.length = 0;
  const appStateListeners = new Set<(next: string) => void>();
  const convex = createFakeConvexClient();
  const harness = createHarness({
    controls: createControls(),
    convexApi: { api: anyApi },
    packages: {
      react: React,
      'react/jsx-runtime': JsxRuntime,
      'convex/react': ConvexReact,
      'react-native': withFallback({
        Platform: { OS: setup.platform ?? 'ios' },
        AppState: {
          currentState: 'active',
          addEventListener: (_type: string, listener: (next: string) => void) => {
            appStateListeners.add(listener);
            return { remove: () => appStateListeners.delete(listener) };
          },
        },
        View: ({ children }: { readonly children?: ReactNode }) => children ?? null,
        StyleSheet: withFallback({ create: (styles: Props) => styles }),
        Linking: withFallback({}),
      }),
      'react-native-paper': withFallback({
        Text: ShownLabel,
        Button: () => null,
        useTheme: () => withFallback({ colors: withFallback({}) }),
      }),
      'expo-constants': withFallback({
        default: {
          expoConfig: {
            ios: { buildNumber: '42' },
            android: { versionCode: 42 },
          },
        },
      }),
      'expo-application': withFallback({ nativeBuildVersion: setup.nativeBuildVersion ?? '42' }),
      '@react-native-async-storage/async-storage': withFallback({
        default: {
          getItem: (key: string) => setup.storage.getItem(key),
          setItem: (key: string, value: string) => setup.storage.setItem(key, value),
          removeItem: (key: string) => setup.storage.removeItem(key),
        },
      }),
      '@gettitonline/shared': withFallback({ resolveClientGate, readClientGateContract, isHttpsStoreUrl }),
    },
  });
  const ClientGateUnderTest = harness.load(file('apps/mobile/src/components/ClientGate.tsx')).ClientGate as (props: {
    readonly children: ReactNode;
  }) => ReactNode;
  const mounted = mountUnderConvex(convex);
  return {
    convex,
    appStateListeners,
    async render() {
      await mounted.render(createElement(ClientGateUnderTest, null, createElement(AppContent)));
    },
    unmount: () => mounted.unmount(),
  };
}

const realGateKey = 'appConfig:getClientGate';
const iosStorageBlock = JSON.stringify({ platform: 'ios', build: 42, minimumBuild: 50, storeUrl });

test('real React: app content is not mounted while a saved block is still being read, even when the gate query is offline', async () => {
  const storage = new HeldAsyncStorage({ [realBlockedKey]: iosStorageBlock });
  storage.holdReads = true;
  appEvents.length = 0;
  const gate = mountRealGate({ storage });
  await gate.render();
  assert.deepEqual(appEvents, [], 'no app content mounts before hydration');

  await act(async () => {
    storage.answerReads();
  });
  await gate.render();
  assert.ok(shownLabels.has('Update required'), 'the saved block for this build blocks the app');
  assert.deepEqual(appEvents, [], 'the blocked app never mounts');
  await gate.unmount();
});

test('real React: with no saved block, the app opens only after hydration completes', async () => {
  const storage = new HeldAsyncStorage();
  storage.holdReads = true;
  appEvents.length = 0;
  const gate = mountRealGate({ storage });
  await gate.render();
  assert.deepEqual(appEvents, [], 'the app waits for storage');

  await act(async () => {
    storage.answerReads();
  });
  await gate.render();
  assert.deepEqual(appEvents, ['app-mounted']);
  assert.ok(!shownLabels.has('Update required'));
  await gate.unmount();
});

test('real React: a storage read that fails releases the hold and opens the app', async () => {
  const storage = new HeldAsyncStorage({ [realBlockedKey]: iosStorageBlock });
  storage.holdReads = true;
  storage.failReads = true;
  appEvents.length = 0;
  const gate = mountRealGate({ storage });
  await gate.render();
  await act(async () => {
    storage.answerReads();
  });
  await gate.render();
  assert.deepEqual(appEvents, ['app-mounted']);
  await gate.unmount();
});

test('real React: a storage read that never answers opens the app after the bounded hold', async () => {
  const storage = new HeldAsyncStorage({ [realBlockedKey]: iosStorageBlock });
  storage.holdReads = true;
  appEvents.length = 0;
  const gate = mountRealGate({ storage });
  await gate.render();
  assert.deepEqual(appEvents, [], 'the app waits while the read is pending');

  await act(async () => {
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_200));
  });
  await gate.render();
  assert.deepEqual(appEvents, ['app-mounted'], 'the hold is bounded, so a stuck read cannot block the app for good');
  await gate.unmount();
});

test('real React: a server result that clears the build wins over a saved block read later', async () => {
  const storage = new HeldAsyncStorage({ [realBlockedKey]: iosStorageBlock });
  storage.holdReads = true;
  appEvents.length = 0;
  const gate = mountRealGate({ storage });
  await gate.render();
  await act(async () => {
    gate.convex.deliver(realGateKey, currentGate);
  });
  await gate.render();
  assert.deepEqual(appEvents, ['app-mounted'], 'the settled server result opens the app');

  await act(async () => {
    storage.answerReads();
  });
  await gate.render();
  assert.ok(
    !shownLabels.has('Update required'),
    'a stored block read after the server cleared the build does not re-block it',
  );
  assert.deepEqual(appEvents, ['app-mounted']);
  await gate.unmount();
});

test('real React: a saved block recorded for another platform is ignored', async () => {
  const androidRecord = JSON.stringify({ platform: 'android', build: 42, minimumBuild: 50, storeUrl });
  const storage = new HeldAsyncStorage({ [realBlockedKey]: androidRecord });
  appEvents.length = 0;
  const gate = mountRealGate({ storage, platform: 'ios' });
  await gate.render();
  await act(async () => {
    storage.answerReads();
  });
  await gate.render();
  assert.ok(!shownLabels.has('Update required'), 'an Android record does not block an iOS build');
  assert.deepEqual(appEvents, ['app-mounted']);
  await gate.unmount();
});

test('real React: unmounting the gate removes its AppState listener', async () => {
  const storage = new HeldAsyncStorage();
  const gate = mountRealGate({ storage });
  await gate.render();
  assert.equal(gate.appStateListeners.size, 1, 'the gate listens for returns to the foreground');

  await gate.unmount();
  assert.equal(gate.appStateListeners.size, 0, 'the listener is removed when the gate unmounts');
});
