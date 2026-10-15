import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import { resolveAccountAccess } from '../../../../../packages/shared/src/utils/accountAccess';
import {
  createControls,
  createHarness,
  findNodes,
  hasNode,
  pressButton,
  textOf,
  withFallback,
  type HarnessControls,
  type Props,
  type RenderResult,
} from '../../../../../tests/support/componentHarness';

// Renders the real profile screen with controlled auth. The form is mounted only for a ready account, its requests carry
// no user ID, and a draft or a late save never leaks into another account or into a session that has moved on.

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const repoFile = (relativePath: string) => resolve(repoRoot, relativePath);

type Tree = RenderResult['tree'];

const navigation: Props = { goBack: () => undefined, navigate: () => undefined, replace: () => undefined };

const ada: Props = {
  _id: 'users|ada',
  clerkId: 'clerk_ada',
  email: 'ada@example.invalid',
  firstName: 'Ada',
  lastName: 'Lovelace',
  phone: '+260 971 000 001',
  role: 'user',
  isBanned: false,
  isVerified: true,
};

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

function openProfile(controls: HarnessControls) {
  const alerts: unknown[][] = [];
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
      'react-native': withFallback({
        Alert: withFallback({
          alert: (...args: unknown[]) => {
            alerts.push(args);
          },
        }),
      }),
    },
  });
  const component = harness.load(repoFile('apps/mobile/src/screens/profile/EditProfileScreen.tsx')).default;
  return {
    alerts,
    harness,
    render: (): RenderResult => harness.render(component, { navigation }),
    settle: () => harness.settle(),
  };
}

function nameInputs(tree: Tree) {
  return findNodes(tree, (node) => node.name === 'TextInput');
}

describe('EditProfileScreen access', () => {
  it('signed-out visitors get the sign-in notice, and no profile form', () => {
    const controls = createControls();
    controls.auth = sessionFor(null, { isSignedIn: false });
    const tree = openProfile(controls).render().tree;

    assert.ok(textOf(tree).includes('Sign In'), textOf(tree));
    assert.equal(hasNode(tree, 'TextInput'), false);
  });

  it('a banned account gets the unavailable notice, and no profile form', () => {
    const controls = createControls();
    controls.auth = sessionFor({ ...ada, isBanned: true });
    const tree = openProfile(controls).render().tree;

    assert.ok(textOf(tree).includes('Account unavailable'), textOf(tree));
    assert.equal(hasNode(tree, 'TextInput'), false);
  });

  it('pending authentication shows a loading indicator, and no profile form', () => {
    const controls = createControls();
    controls.auth = sessionFor(null, { isLoading: true });
    const tree = openProfile(controls).render().tree;

    assert.ok(hasNode(tree, 'ActivityIndicator'), 'loading while authentication is pending');
    assert.equal(hasNode(tree, 'TextInput'), false);
  });

  it('account recovery offers a retry, and no profile form', () => {
    const controls = createControls();
    controls.auth = sessionFor(null, { authSyncError: 'We could not finish setting up your account.' });
    const tree = openProfile(controls).render().tree;

    assert.ok(textOf(tree).includes('Account setup did not finish'), textOf(tree));
    assert.equal(hasNode(tree, 'TextInput'), false);
  });

  it('an eligible account sees its own details in the form', () => {
    const controls = createControls();
    controls.auth = sessionFor(ada);
    const tree = openProfile(controls).render().tree;

    const values = nameInputs(tree).map((input) => input.props.value);
    assert.deepEqual(values.slice(0, 3), ['Ada', 'Lovelace', '+260 971 000 001']);
    assert.equal(values[3], 'ada@example.invalid');
  });
});

describe('EditProfileScreen saves', () => {
  it('saving sends only the account fields, with no caller-supplied user ID', async () => {
    const controls = createControls();
    controls.auth = sessionFor(ada);
    const screen = openProfile(controls);
    const initial = screen.render().tree;

    const setFirstName = nameInputs(initial)[0]?.props.onChangeText;
    if (typeof setFirstName !== 'function') {
      throw new Error('the first name input must be rendered');
    }
    setFirstName('Grace');
    const tree = screen.render().tree;
    assert.ok(pressButton(tree, 'Save Changes'), 'the save button must be rendered');
    await screen.settle();

    const saved = controls.calls.find((call) => call.name === 'mutation:users.updateProfile');
    const args = saved?.args[0] as Props | undefined;
    assert.deepEqual(args, { firstName: 'Grace', lastName: 'Lovelace', phone: '+260 971 000 001' });
    assert.equal(args && 'userId' in args, false, 'the acting user must never be sent');
  });

  it('a save that finishes after the account lost access announces nothing', async () => {
    const controls = createControls();
    controls.auth = sessionFor(ada);
    const screen = openProfile(controls);
    const pending: Array<() => void> = [];
    controls.mutations['users.updateProfile'] = () =>
      new Promise<void>((resolveSave) => {
        pending.push(resolveSave);
      });

    // A second pass lets the form load the account's names before the save is pressed.
    screen.render();
    pressButton(screen.render().tree, 'Save Changes');
    assert.equal(pending.length, 1, 'the save must have started');

    controls.auth = sessionFor({ ...ada, isBanned: true });
    screen.render();

    for (const resolveSave of pending) {
      resolveSave();
    }
    await screen.settle();
    screen.render();

    assert.equal(
      screen.alerts.filter((args) => args[0] === 'Success').length,
      0,
      'a finished save must not report success for an account that has lost access',
    );
  });
});

describe('EditProfileScreen drafts', () => {
  it('a draft typed for one account is not shown for another account', () => {
    const controls = createControls();
    controls.auth = sessionFor(ada);
    const screen = openProfile(controls);
    const setFirstName = nameInputs(screen.render().tree)[0]?.props.onChangeText;
    if (typeof setFirstName !== 'function') {
      throw new Error('the first name input must be rendered');
    }
    setFirstName('Draft for Ada');

    controls.auth = sessionFor({ ...ada, _id: 'users|bea', clerkId: 'clerk_bea', firstName: 'Bea', lastName: 'Buyer' });
    const values = nameInputs(screen.render().tree).map((input) => input.props.value);

    assert.equal(values[0], 'Bea');
    assert.equal(values[1], 'Buyer');
  });

  it('access loss discards a draft, and restoring access shows the saved name', () => {
    const controls = createControls();
    const signedIn = sessionFor(ada);
    controls.auth = signedIn;
    const screen = openProfile(controls);
    const setFirstName = nameInputs(screen.render().tree)[0]?.props.onChangeText;
    if (typeof setFirstName !== 'function') {
      throw new Error('the first name input must be rendered');
    }
    setFirstName('Draft that must not survive');

    controls.auth = sessionFor({ ...ada, isBanned: true });
    screen.render();
    controls.auth = signedIn;

    assert.equal(nameInputs(screen.render().tree)[0]?.props.value, 'Ada');
  });
});
