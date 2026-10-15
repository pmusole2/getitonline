import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import ts from 'typescript';

// Renders the real mobile AuthProvider and web useAuth hook with mocked React and Convex hooks.
// Covers lost Convex sign-in, including a cached profile that has not yet been cleared.
type Probe = Record<string, unknown> & {
  user: { _id: string } | null;
  isLoading: boolean;
  isSignedIn?: boolean;
  authSyncError?: string | null;
};

type Scenario = 'lost-profile-cleared' | 'lost-profile-cached';

function loadComponent(relativePath: string, exported: string, scenario: Scenario) {
  const hookState: unknown[] = [];
  const dependencies: unknown[][] = [];
  let pending: Array<() => void> = [];
  let stateIndex = 0;
  let effectIndex = 0;
  let profile: { _id: string; clerkId: string; role: string; isBanned: boolean } | null = null;
  let backendAuthenticated = true;
  let syncs = 0;
  const clerkUser = { id: 'offline_subject', firstName: 'Fixture', lastName: 'User', primaryEmailAddress: { emailAddress: 'fixture@example.invalid' } };
  const row = { _id: 'offline_user', clerkId: clerkUser.id, role: 'user', isBanned: false };
  const clerk = {
    useAuth: () => ({ isLoaded: true, isSignedIn: true, signOut: async () => {} }),
    useUser: () => ({ user: clerkUser }),
  };
  const upsert = async () => {
    syncs++;
    if (!backendAuthenticated) throw new Error('Unauthenticated');
    return row._id;
  };
  const react = {
    createContext: () => ({ Provider: 'Provider' }),
    useContext: () => null,
    useState(initial: unknown) {
      const index = stateIndex++;
      if (!(index in hookState)) hookState[index] = typeof initial === 'function' ? initial() : initial;
      return [hookState[index], (value: unknown) => {
        hookState[index] = typeof value === 'function' ? value(hookState[index]) : value;
      }];
    },
    useRef(initial: unknown) {
      const index = stateIndex++;
      if (!(index in hookState)) hookState[index] = { current: initial };
      return hookState[index];
    },
    useEffect(callback: () => void, deps: unknown[]) {
      const index = effectIndex++;
      const previous = dependencies[index];
      if (!previous || deps.some((value, j) => !Object.is(value, previous[j]))) pending.push(callback);
      dependencies[index] = deps;
    },
  };
  const packages: Record<string, unknown> = {
    react: { ...react, default: react, __esModule: true },
    'react/jsx-runtime': { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) },
    '@clerk/clerk-expo': clerk,
    '@clerk/nextjs': clerk,
    'convex/react': {
      useQuery: () => profile,
      useMutation: () => upsert,
      useConvexAuth: () => ({ isLoading: false, isAuthenticated: backendAuthenticated }),
    },
  };
  const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  const requireLocal = (name: string): unknown => {
    if (name in packages) return packages[name];
    if (name.endsWith('/_generated/api')) return { api: { users: { getUserByClerkId: 'self', upsertUser: 'upsert' } } };
    if (name.endsWith('/services/aiConsent')) return { setAIConsentSubject: () => {} };
    throw new Error(`Unexpected dependency: ${name}`);
  };
  new Function('require', 'module', 'exports', compiled)(requireLocal, mod, mod.exports);

  const render = (): Probe => {
    stateIndex = 0;
    effectIndex = 0;
    const component = mod.exports[exported] as (props: { children: null }) => { props: { value: Probe } } & Probe;
    const output = component({ children: null });
    return exported === 'AuthProvider' ? output.props.value : output;
  };
  const flush = async () => {
    const effects = pending;
    pending = [];
    for (const callback of effects) callback();
    await Promise.resolve();
    await Promise.resolve();
  };

  return {
    render,
    flush,
    healthy: () => { profile = { ...row, clerkId: row.clerkId }; },
    loseBackendAuth: () => {
      backendAuthenticated = false;
      if (scenario === 'lost-profile-cleared') profile = null;
    },
    restoreBackendAuth: () => {
      backendAuthenticated = true;
      profile = { ...row, clerkId: row.clerkId };
    },
    syncs: () => syncs,
  };
}

for (const [relativePath, exported] of [
  ['./AuthProvider.tsx', 'AuthProvider'],
  ['../../../web/src/hooks/useAuth.ts', 'useAuth'],
] as const) {
  for (const scenario of ['lost-profile-cleared', 'lost-profile-cached'] as const) {
    test(`${exported} hides the user and recovers when Convex sign-in is lost (${scenario})`, async () => {
      const harness = loadComponent(relativePath, exported, scenario);

      await harness.flush();
      harness.healthy();
      harness.render();
      await harness.flush();
      const healthy = harness.render();
      assert.equal(healthy.isLoading, false);
      assert.equal(healthy.user?._id, 'offline_user');

      harness.loseBackendAuth();
      harness.render();
      await harness.flush();
      const lost = harness.render();
      assert.equal(lost.user, null, 'no user may be exposed without live Convex auth');
      assert.equal(lost.isLoading, false, 'must not spin on loading');
      if (exported === 'AuthProvider') {
        assert.ok(lost.authSyncError, 'mobile must show the retry screen');
      } else {
        assert.equal(lost.isSignedIn, false, 'web must not report signed in');
      }

      const syncsBeforeRecovery = harness.syncs();
      harness.restoreBackendAuth();
      harness.render();
      await harness.flush();
      harness.render();
      await harness.flush();
      const recovered = harness.render();
      assert.ok(harness.syncs() > syncsBeforeRecovery, 'sync must re-run when Convex sign-in returns');
      assert.equal(recovered.user?._id, 'offline_user');
      assert.equal(recovered.isLoading, false);
    });
  }
}
