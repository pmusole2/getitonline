import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import { resolveAccountAccess } from '../../../../packages/shared/src/utils/accountAccess';
import {
  createControls,
  createHarness,
  findNodes,
  withFallback,
  type Harness,
  type HarnessControls,
  type Props,
  type RenderResult,
} from '../../../../tests/support/componentHarness';

// Renders the real ThemeProvider with controlled auth and a fake local store. Preferences are requested only for a ready
// account, with no user ID. A previous account's preferences are never applied to a new account, and a late save from a
// previous account never clears the sync state of the current one. Guests keep the saved local theme.

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const repoFile = (relativePath: string) => resolve(repoRoot, relativePath);

const THEME_KEY = '@gettitonline_theme';

const ada: Props = {
  _id: 'users|ada',
  clerkId: 'clerk_ada',
  email: 'ada@example.invalid',
  firstName: 'Ada',
  lastName: 'Lovelace',
  role: 'user',
  isBanned: false,
};

const bea: Props = { ...ada, _id: 'users|bea', clerkId: 'clerk_bea', firstName: 'Bea', lastName: 'Buyer' };

function isRecord(value: unknown): value is Props {
  return typeof value === 'object' && value !== null;
}

function sessionFor(user: Props | null, overrides: Props = {}): Props {
  return {
    isLoading: false,
    isSignedIn: user !== null,
    user,
    clerkUser: null,
    authSyncError: null,
    postAuthDestination: null,
    setPostAuthDestination: () => undefined,
    retryUserSync: () => undefined,
    signOut: async () => undefined,
    ...overrides,
  };
}

function storeFake(entries: Map<string, string>) {
  return {
    getItem: async (key: string) => entries.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}

function openTheme(controls: HarnessControls, entries: Map<string, string>) {
  const harness = createHarness({
    controls,
    effects: true,
    files: {
      [repoFile('apps/mobile/src/context/AuthProvider.tsx')]: withFallback({
        useAppAuth: () => {
          controls.hook('useContext');
          return controls.auth;
        },
      }),
    },
    packages: {
      '@gettitonline/shared': withFallback({ resolveAccountAccess }),
      'react-native': withFallback({ useColorScheme: () => 'light' }),
      '@react-native-async-storage/async-storage': { __esModule: true, default: storeFake(entries) },
    },
  });
  const component = harness.load(repoFile('apps/mobile/src/context/ThemeProvider.tsx')).ThemeProvider;
  return { harness, component };
}

// Effects load the saved theme and then apply the server theme, one state update per pass, so render until settled.
async function settled(harness: Harness, component: unknown): Promise<RenderResult> {
  let result = harness.render(component, { children: null });
  for (let pass = 0; pass < 4; pass += 1) {
    await harness.settle();
    result = harness.render(component, { children: null });
  }
  return result;
}

function providerValue(result: RenderResult): Props {
  const [provider] = findNodes(result.tree, (node) => node.name === 'Provider');
  const value = provider?.props.value;
  if (!isRecord(value)) {
    throw new Error('the theme provider must render its value');
  }
  return value;
}

function setThemeModeOf(result: RenderResult): (mode: string) => Promise<unknown> {
  const setThemeMode = providerValue(result).setThemeMode;
  if (typeof setThemeMode !== 'function') {
    throw new Error('setThemeMode must be provided');
  }
  return (mode: string) => Promise.resolve(Reflect.apply(setThemeMode, undefined, [mode]));
}

function preferenceRequests(result: RenderResult) {
  return result.queryCalls.filter((call) => call.name === 'users.getPreferences');
}

describe('ThemeProvider guests and access', () => {
  it('a guest keeps the saved local theme, and makes no preference request', async () => {
    const controls = createControls();
    controls.auth = sessionFor(null, { isSignedIn: false });
    const { harness, component } = openTheme(controls, new Map([[THEME_KEY, 'dark']]));

    const result = await settled(harness, component);

    assert.equal(providerValue(result).themeMode, 'dark');
    assert.ok(
      preferenceRequests(result).every((call) => call.args === 'skip'),
      'a guest must not request preferences',
    );
  });

  it('pending authentication and account recovery make no preference request', async () => {
    for (const overrides of [
      { isLoading: true, user: null },
      { isSignedIn: true, user: null, authSyncError: 'We could not finish setting up your account.' },
    ]) {
      const controls = createControls();
      controls.auth = sessionFor(null, overrides);
      controls.queries = { 'users.getPreferences': { themeMode: 'dark', notificationsEnabled: true } };
      const { harness, component } = openTheme(controls, new Map([[THEME_KEY, 'light']]));

      const result = await settled(harness, component);

      assert.equal(providerValue(result).themeMode, 'light');
      assert.ok(preferenceRequests(result).every((call) => call.args === 'skip'));
    }
  });

  it('a banned account makes no preference request, and its theme choice is not sent to the server', async () => {
    const controls = createControls();
    controls.auth = sessionFor({ ...ada, isBanned: true });
    controls.queries = { 'users.getPreferences': { themeMode: 'dark', notificationsEnabled: true } };
    const entries = new Map([[THEME_KEY, 'light']]);
    const { harness, component } = openTheme(controls, entries);

    const result = await settled(harness, component);
    assert.ok(
      preferenceRequests(result).every((call) => call.args === 'skip'),
      'a banned account must not be asked',
    );

    await setThemeModeOf(result)('dark');

    assert.equal(controls.calls.filter((call) => call.name.startsWith('mutation:')).length, 0);
    assert.equal(entries.get(THEME_KEY), 'dark', 'the device keeps the choice locally');
  });
});

describe('ThemeProvider ready accounts', () => {
  it('a ready account requests its preferences with no user ID argument', async () => {
    const controls = createControls();
    controls.auth = sessionFor(ada);
    controls.queries = { 'users.getPreferences': { themeMode: 'dark', notificationsEnabled: true } };
    const { harness, component } = openTheme(controls, new Map());

    const result = await settled(harness, component);

    assert.deepEqual(preferenceRequests(result)[0]?.args, {});
  });

  it('a ready account applies its saved theme over the local one, and keeps it on the device', async () => {
    for (const themeMode of ['light', 'dark', 'system']) {
      const controls = createControls();
      controls.auth = sessionFor(ada);
      const entries = new Map([[THEME_KEY, 'light']]);
      const { harness, component } = openTheme(controls, entries);

      // The account's result arrives after it is ready, as a subscription does; the device theme loads first.
      await settled(harness, component);
      controls.queries = { 'users.getPreferences': { themeMode, notificationsEnabled: true } };
      const result = await settled(harness, component);

      assert.equal(providerValue(result).themeMode, themeMode);
      assert.equal(entries.get(THEME_KEY), themeMode);
    }
  });

  it('a theme choice is saved with no user ID argument', async () => {
    const controls = createControls();
    controls.auth = sessionFor(ada);
    controls.queries = { 'users.getPreferences': { themeMode: 'dark', notificationsEnabled: true } };
    const { harness, component } = openTheme(controls, new Map());
    const result = await settled(harness, component);

    await setThemeModeOf(result)('light');

    const saved = controls.calls.find((call) => call.name === 'mutation:users.updateThemeMode');
    assert.deepEqual(saved?.args[0], { themeMode: 'light' });
  });

  it('a guest theme choice is saved on the device only', async () => {
    const controls = createControls();
    controls.auth = sessionFor(null, { isSignedIn: false });
    const entries = new Map<string, string>();
    const { harness, component } = openTheme(controls, entries);
    const result = await settled(harness, component);

    await setThemeModeOf(result)('dark');

    assert.equal(entries.get(THEME_KEY), 'dark');
    assert.equal(controls.calls.filter((call) => call.name.startsWith('mutation:')).length, 0);
  });
});

describe('ThemeProvider account switching', () => {
  it('a previous account preference that is still on screen is not applied to the next account', async () => {
    const controls = createControls();
    const previous = { themeMode: 'dark', notificationsEnabled: true };
    controls.auth = sessionFor(null, { isSignedIn: false });
    controls.queries = { 'users.getPreferences': previous };
    const { harness, component } = openTheme(controls, new Map([[THEME_KEY, 'light']]));
    assert.equal(providerValue(await settled(harness, component)).themeMode, 'light');

    // Bea's sign-in lands while the query still holds Ada's result, as a cached result does until a new one arrives.
    controls.auth = sessionFor(bea);
    assert.equal(providerValue(await settled(harness, component)).themeMode, 'light');

    controls.queries = { 'users.getPreferences': { themeMode: 'system', notificationsEnabled: true } };
    assert.equal(providerValue(await settled(harness, component)).themeMode, 'system');
  });

  it('a save from the previous account does not clear the sync state of the current account', async () => {
    const controls = createControls();
    controls.auth = sessionFor(ada);
    controls.queries = { 'users.getPreferences': { themeMode: 'dark', notificationsEnabled: true } };
    const finish: Array<() => void> = [];
    controls.mutations['users.updateThemeMode'] = () =>
      new Promise<void>((resolveSave) => {
        finish.push(resolveSave);
      });
    const { harness, component } = openTheme(controls, new Map());

    let result = await settled(harness, component);
    void setThemeModeOf(result)('light');
    result = await settled(harness, component);
    assert.equal(providerValue(result).isSyncing, true, 'the first save is in flight');

    controls.auth = sessionFor(bea);
    result = await settled(harness, component);
    void setThemeModeOf(result)('system');
    result = await settled(harness, component);
    assert.equal(providerValue(result).isSyncing, true, 'the second save is in flight');

    finish[0]?.();
    result = await settled(harness, component);
    assert.equal(providerValue(result).isSyncing, true, 'the newer session is still saving');

    finish[1]?.();
    result = await settled(harness, component);
    assert.equal(providerValue(result).isSyncing, false, 'the newer session finished saving');
  });
});
