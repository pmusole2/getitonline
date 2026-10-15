import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { runInNewContext } from 'node:vm';

import React from 'react';
import ts from 'typescript';

import {
  createControls,
  createHarness,
  findNodes,
  textOf,
  withFallback,
  type Props,
} from '../../../../tests/support/componentHarness';
import type { RuntimeConfig } from './runtime';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const runtimePath = resolve(root, 'apps/mobile/src/config/runtime.ts');
const buildPath = resolve(root, 'apps/mobile/app.config.ts');
const publicEnv = {
  EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_synthetic',
  EXPO_PUBLIC_CONVEX_URL: 'https://synthetic.convex.cloud',
};

function isRecord(value: unknown): value is Props {
  return typeof value === 'object' && value !== null;
}

// Evaluate the installed production source, with an isolated process and Constants boundary. Never load dotenv
// or inspect the host environment. The implementation and its validation branches are not replaced.
function evaluate(file: string, env: Record<string, string>, extra: Props = {}): Props {
  const exports: Props = {};
  const module = { exports };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;

  runInNewContext(
    code,
    {
      exports,
      module,
      process: { env: { ...env } },
      URL,
      require: (name: string): unknown => {
        assert.equal(name, 'expo-constants', 'only the native Constants boundary may be imported');

        return { __esModule: true, default: { expoConfig: { extra } } };
      },
    },
    { filename: file },
  );

  return module.exports;
}

function isRuntimeConfig(value: unknown): value is RuntimeConfig {
  return (
    isRecord(value) &&
    typeof value.appEnv === 'string' &&
    (value.clerkPublishableKey === null || typeof value.clerkPublishableKey === 'string') &&
    (value.convexUrl === null || typeof value.convexUrl === 'string') &&
    Array.isArray(value.missingPublicEnvVars) &&
    value.missingPublicEnvVars.every(
      (key: unknown) => key === 'EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY' || key === 'EXPO_PUBLIC_CONVEX_URL',
    )
  );
}

function runtime(env: Record<string, string>, extra: Props = {}): RuntimeConfig {
  const exports = evaluate(runtimePath, env, extra);
  assert.ok(typeof exports.getRuntimeConfig === 'function');
  const value: unknown = Reflect.apply(exports.getRuntimeConfig, undefined, []);
  assert.ok(isRuntimeConfig(value));

  return value;
}

function build(env: Record<string, string>): Props {
  const value = evaluate(buildPath, env).default;
  assert.ok(isRecord(value));

  return value;
}

function openApp(config: RuntimeConfig): ReturnType<typeof createHarness> {
  // Native/auth/navigation providers are inert. The actual App function and ConfigurationErrorScreen execute.
  // Feed the value produced by the actual runtime, rather than a manually reconstructed gate fixture.
  return createHarness({
    controls: createControls(),
    packages: { react: withFallback({ ...React, default: React, useEffect: () => undefined }) },
    files: {
      [runtimePath]: { getRuntimeConfig: () => config },
      [resolve(root, 'apps/mobile/src/context/AuthProvider.tsx')]: withFallback({}),
      [resolve(root, 'apps/mobile/src/context/ConvexClientProvider.tsx')]: withFallback({}),
      [resolve(root, 'apps/mobile/src/context/GuestCartProvider.tsx')]: withFallback({}),
      [resolve(root, 'apps/mobile/src/context/ThemeProvider.tsx')]: withFallback({}),
      [resolve(root, 'apps/mobile/src/navigation/RootNavigator.tsx')]: withFallback({}),
      [resolve(root, 'apps/mobile/src/components/ClientGate.tsx')]: withFallback({}),
      [resolve(root, 'apps/mobile/src/utils/tokenCache.ts')]: withFallback({}),
      [resolve(root, 'apps/mobile/src/theme/index.ts')]: withFallback({}),
    },
  });
}

function renderApp(config: RuntimeConfig): ReturnType<ReturnType<typeof createHarness>['render']> {
  const harness = openApp(config);
  const App = harness.load(resolve(root, 'apps/mobile/App.tsx')).default;
  assert.ok(typeof App === 'function');

  return harness.render(() => {
    const element: unknown = Reflect.apply(App, undefined, []);
    assert.ok(isRecord(element) && isRecord(element.props));
    // The harness supports function components; unwrap only the actual class error boundary, after the App
    // gate has run. No substitute App, gate or provider props are constructed by the test.
    if (typeof element.type === 'function' && element.type.name === 'ErrorBoundary') {
      return element.props.children;
    }

    return element;
  });
}

for (const appEnv of ['development', 'production']) {
  test(`${appEnv} Clerk/Convex-only config starts the actual App without API_URL`, () => {
    const env = { ...publicEnv, EXPO_PUBLIC_APP_ENV: appEnv };
    const config = runtime(env);
    assert.equal(config.appEnv, appEnv);
    assert.equal(config.clerkPublishableKey, 'pk_test_synthetic');
    assert.equal(config.convexUrl, 'https://synthetic.convex.cloud');
    assert.deepEqual(Array.from(config.missingPublicEnvVars), []);
    assert.equal('apiUrl' in config, false);
    const expo = build(env);
    assert.ok(isRecord(expo.extra));
    assert.equal(expo.extra.appEnv, appEnv);
    assert.equal('apiUrl' in expo.extra, false);
    assert.ok(isRecord(expo.ios) && isRecord(expo.android));
    assert.equal(expo.ios.bundleIdentifier, 'com.getitonline.app');
    assert.equal(expo.ios.scheme, 'getitonline');
    assert.equal(expo.ios.runtimeVersion, 'getitonline-org-1');
    assert.equal(expo.android.package, 'com.gettitonline.app');
    assert.equal(expo.android.scheme, 'gettitonline');
    assert.ok(Array.isArray(expo.plugins) && expo.plugins.includes('expo-secure-store'));
    const rendered = renderApp(config);
    assert.ok(!textOf(rendered.tree).includes('App configuration is incomplete'));
    assert.equal(
      findNodes(rendered.tree, (node) => node.name === 'ClerkProvider')[0]?.props.publishableKey,
      'pk_test_synthetic',
    );
    assert.equal(
      findNodes(rendered.tree, (node) => node.name === 'ConvexClientProvider')[0]?.props.url,
      'https://synthetic.convex.cloud',
    );
  });
}

test('runtime keeps APP_ENV precedence, trimming and development default, and ignores retired URL inputs', () => {
  for (const [env, extra, want] of [
    [
      { ...publicEnv, EXPO_PUBLIC_APP_ENV: ' production ', EXPO_PUBLIC_API_URL: 'http://localhost:3001' },
      { appEnv: 'development', apiUrl: 'http://stale.invalid' },
      'production',
    ],
    [publicEnv, { appEnv: ' production ', apiUrl: 'http://localhost:3001' }, 'production'],
    [{ ...publicEnv, EXPO_PUBLIC_APP_ENV: ' ' }, { appEnv: ' ' }, 'development'],
  ] as const) {
    const config = runtime(env, extra);
    assert.equal(config.appEnv, want);
    assert.deepEqual(Array.from(config.missingPublicEnvVars), []);
    assert.equal('apiUrl' in config, false);
  }
  const expo = build({ ...publicEnv, EXPO_PUBLIC_APP_ENV: 'production', EXPO_PUBLIC_API_URL: 'http://localhost:3001' });
  assert.ok(isRecord(expo.extra));
  assert.equal('apiUrl' in expo.extra, false);
});

for (const key of ['EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY', 'EXPO_PUBLIC_CONVEX_URL'] as const) {
  test(`missing ${key} still denies production and actual development provider startup`, () => {
    const env: Record<string, string> = { ...publicEnv, [key]: ' ' };
    assert.throws(() => runtime({ ...env, EXPO_PUBLIC_APP_ENV: 'production' }), new RegExp(key));
    assert.throws(() => build({ ...env, EXPO_PUBLIC_APP_ENV: 'production' }), new RegExp(key));
    const config = runtime(env);
    assert.deepEqual(Array.from(config.missingPublicEnvVars), [key]);
    const rendered = renderApp(config);
    assert.ok(textOf(rendered.tree).includes('App configuration is incomplete'));
    assert.ok(textOf(rendered.tree).includes(key.replace('EXPO_PUBLIC_', '').replaceAll('_', ' ')));
    assert.equal(
      findNodes(rendered.tree, (node) => node.name === 'ClerkProvider' || node.name === 'ConvexClientProvider').length,
      0,
    );
  });
}

for (const profile of ['production', 'internal-test', 'internal-test-ios', 'organization-ios']) {
  test(`${profile} build keeps all real mandatory public settings without API_URL`, () => {
    const env = { ...publicEnv, EXPO_PUBLIC_APP_ENV: 'development', EAS_BUILD_PROFILE: profile };
    const config = build(env);
    assert.ok(isRecord(config.extra));
    assert.equal(config.extra.appEnv, 'development');
    assert.equal('apiUrl' in config.extra, false);

    for (const key of ['EXPO_PUBLIC_APP_ENV', 'EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY', 'EXPO_PUBLIC_CONVEX_URL']) {
      assert.throws(() => build({ ...env, [key]: ' ' }), new RegExp(key));
    }
  });
}

test('ordinary development build keeps its APP_ENV default and EAS metadata precedence', () => {
  const config = build({
    EAS_BUILD_PROFILE: 'development',
    EAS_PROJECT_ID: 'synthetic-eas-project',
    EXPO_PUBLIC_EAS_PROJECT_ID: 'unused',
  });
  assert.ok(isRecord(config.extra) && isRecord(config.extra.eas) && isRecord(config.updates));
  assert.equal(config.extra.appEnv, 'development');
  assert.equal(config.extra.eas.projectId, 'synthetic-eas-project');
  assert.equal(config.updates.url, 'https://u.expo.dev/synthetic-eas-project');
  assert.equal('apiUrl' in config.extra, false);
});

test('actual development App admits valid Clerk/Convex runtime without the retired API setting', () => {
  const rendered = renderApp(runtime(publicEnv));
  assert.ok(!textOf(rendered.tree).includes('App configuration is incomplete'), textOf(rendered.tree));
  assert.equal(
    findNodes(rendered.tree, (node) => node.name === 'ClerkProvider')[0]?.props.publishableKey,
    'pk_test_synthetic',
  );
  assert.equal(
    findNodes(rendered.tree, (node) => node.name === 'ConvexClientProvider')[0]?.props.url,
    'https://synthetic.convex.cloud',
  );
});
