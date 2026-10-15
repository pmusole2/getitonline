import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import * as shared from '../../../../../packages/shared/src/index';
import { resolveAccountAccess } from '../../../../../packages/shared/src/utils/accountAccess';
import {
  createControls,
  createHarness,
  findNodes,
  fixture,
  hasNode,
  pressButton,
  textOf,
  withFallback,
  type HarnessControls,
  type Props,
  type RenderResult,
} from '../../../../../tests/support/componentHarness';

// Renders the real dispute screens with controlled auth and query state. A dispute screen must not mount its
// content, and so must not request dispute data, unless the account is ready. The dispute list must ask for the
// verified account's own disputes, with no caller-supplied buyer ID, and submitting a dispute must send no buyer ID.

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const repoFile = (relativePath: string) => resolve(repoRoot, relativePath);

type Access = 'signed-out' | 'banned' | 'pending' | 'recovery' | 'ready';
type Tree = RenderResult['tree'];

function isRecord(value: unknown): value is Props {
  return typeof value === 'object' && value !== null;
}

const navigation: Props = { goBack: () => undefined, navigate: () => undefined, replace: () => undefined };

const order = {
  _id: 'orders|buyer',
  orderNumber: 'ORD-1',
  buyerId: 'users|buyer',
  sellerId: 'users|seller',
  status: 'delivered',
  items: [],
  totalAmount: 100,
  createdAt: 1767225600000,
};

const dispute = {
  _id: 'disputes|buyer',
  orderId: 'orders|buyer',
  escrowId: 'escrow|buyer',
  buyerId: 'users|buyer',
  sellerId: 'users|seller',
  title: 'Late delivery',
  description: 'The item did not arrive',
  category: 'not_received',
  status: 'open',
  evidence: [],
  createdAt: 1767225600000,
  updatedAt: 1767225600000,
};

interface ScreenCase {
  readonly label: string;
  readonly file: string;
  readonly gate: string;
  readonly props: Props;
  readonly ready: Props;
  readonly requested: string;
  readonly shown: (tree: Tree) => boolean;
}

const SCREENS: readonly ScreenCase[] = [
  {
    label: 'DisputesListScreen',
    file: 'apps/mobile/src/screens/disputes/DisputesListScreen.tsx',
    gate: 'DisputesListScreen',
    props: { navigation },
    ready: { 'disputes.getBuyerDisputes': [], 'disputes.getSellerDisputes': [] },
    requested: 'disputes.getBuyerDisputes',
    shown: (tree) => hasNode(tree, 'SegmentedButtons'),
  },
  {
    label: 'ChatScreen',
    file: 'apps/mobile/src/screens/disputes/ChatScreen.tsx',
    gate: 'ChatScreen',
    props: { route: { params: { disputeId: 'disputes|buyer' } }, navigation },
    ready: { 'messages.getMessages': [], 'disputes.getDispute': fixture(dispute) },
    requested: 'disputes.getDispute',
    // The composer exists only in the chat content; the notice repeats the screen title, so the title cannot mark it.
    shown: (tree) => hasNode(tree, 'TextInput'),
  },
  {
    label: 'DisputeDetailScreen',
    file: 'apps/mobile/src/screens/disputes/DisputeDetailScreen.tsx',
    gate: 'DisputeDetailScreen',
    props: { route: { params: { disputeId: 'disputes|buyer' } }, navigation },
    ready: { 'disputes.getDispute': fixture(dispute) },
    requested: 'disputes.getDispute',
    shown: (tree) => textOf(tree).includes('Late delivery'),
  },
];

function record(controls: HarnessControls, name: string, args: unknown[] = []): void {
  controls.calls.push({ name, args });
}

function auth(controls: HarnessControls, access: Access, actor: Props = {}): Props {
  const account: Props = {
    _id: 'users|buyer',
    clerkId: 'clerk_buyer',
    email: 'buyer@example.invalid',
    firstName: 'Bea',
    lastName: 'Buyer',
    role: 'user',
    isBanned: false,
    ...actor,
  };
  const session: Props = {
    isLoading: false,
    isSignedIn: true,
    user: account,
    clerkUser: null,
    authSyncError: null,
    postAuthDestination: null,
    setPostAuthDestination: () => undefined,
    retryUserSync: () => record(controls, 'retryUserSync'),
    signOut: async () => record(controls, 'signOut'),
  };
  switch (access) {
    case 'signed-out':
      return { ...session, isSignedIn: false, user: null };
    case 'banned':
      return { ...session, user: { ...account, isBanned: true } };
    case 'pending':
      return { ...session, isLoading: true, user: null };
    case 'recovery':
      return { ...session, user: null, authSyncError: 'We could not finish setting up your account.' };
    case 'ready':
      return session;
  }
}

function openScreen(
  screen: ScreenCase,
  access: Access,
  queries: Props = screen.ready,
  props: Props = screen.props,
  actor: Props = {},
) {
  const controls = createControls();
  controls.auth = auth(controls, access, actor);
  controls.queries = queries;
  const harness = createHarness({
    controls,
    files: {
      [repoFile('apps/mobile/src/context/AuthProvider.tsx')]: withFallback({
        useAppAuth: () => {
          controls.hook('useContext');
          return controls.auth;
        },
      }),
    },
    packages: {
      '@gettitonline/shared': withFallback({ ...shared, resolveAccountAccess }),
    },
  });
  const component = harness.load(repoFile(screen.file)).default;
  return {
    controls,
    render: (): RenderResult => harness.render(component, props),
  };
}

const requestedQueries = (result: RenderResult) => result.queryCalls.filter((call) => call.args !== 'skip');

for (const screen of SCREENS) {
  describe(`${screen.label} access`, () => {
    it('settled signed-out visitors get sign-in and no dispute request', () => {
      const result = openScreen(screen, 'signed-out').render();
      const text = textOf(result.tree);

      assert.ok(text.includes('Sign In'), text);
      assert.equal(requestedQueries(result).length, 0, 'no dispute query may be requested');
      assert.ok(!screen.shown(result.tree), 'dispute content must not show');
    });

    it('banned accounts get the unavailable state and no dispute request', () => {
      const result = openScreen(screen, 'banned').render();
      const text = textOf(result.tree);

      assert.ok(text.includes('Account unavailable'), text);
      assert.equal(requestedQueries(result).length, 0, 'no dispute query may be requested');
      assert.ok(!screen.shown(result.tree), 'dispute content must not show');
    });

    it('pending authentication shows loading and no dispute request', () => {
      const result = openScreen(screen, 'pending').render();

      assert.ok(hasNode(result.tree, 'ActivityIndicator'), 'loading indicator');
      assert.equal(requestedQueries(result).length, 0, 'no dispute query may be requested');
    });

    it('an eligible user sees the content, and the dispute query is requested', () => {
      const result = openScreen(screen, 'ready').render();

      assert.ok(screen.shown(result.tree), textOf(result.tree));
      assert.ok(
        requestedQueries(result).some((call) => call.name === screen.requested),
        `${screen.requested} must be requested`,
      );
    });

    it('losing access hides cached dispute content, and restoring access brings it back', () => {
      const { controls, render } = openScreen(screen, 'ready');
      assert.ok(screen.shown(render().tree));

      controls.auth = auth(controls, 'banned');
      const lost = render();
      assert.ok(!screen.shown(lost.tree), 'cached dispute content must not remain on screen');
      assert.equal(requestedQueries(lost).length, 0, 'no dispute query may be requested after access is lost');

      controls.auth = auth(controls, 'ready');
      assert.ok(screen.shown(render().tree), 'content returns when access is restored');
    });
  });
}

describe('DisputesListScreen requests', () => {
  it("asks for the signed-in buyer's disputes with no buyer ID argument", () => {
    const screen = SCREENS.find((candidate) => candidate.label === 'DisputesListScreen');
    assert.ok(screen);
    const result = openScreen(screen, 'ready').render();

    const buyer = result.queryCalls.find((call) => call.name === 'disputes.getBuyerDisputes');
    assert.deepEqual(buyer?.args, {}, 'the verified account is the only buyer the list may ask for');
  });

  it('asks for seller disputes only for the signed-in account', () => {
    const screen = SCREENS.find((candidate) => candidate.label === 'DisputesListScreen');
    assert.ok(screen);
    const result = openScreen(screen, 'ready').render();

    const seller = result.queryCalls.find((call) => call.name === 'disputes.getSellerDisputes');
    assert.deepEqual(seller?.args, { sellerId: 'users|buyer' });
  });
});

describe('CreateDisputeScreen submission', () => {
  it('sends the order and the dispute content, and no buyer ID, to createDispute', async () => {
    const controls = createControls();
    controls.auth = auth(controls, 'ready');
    controls.queries = { 'orders.getOrder': fixture(order) };
    const harness = createHarness({
      controls,
      files: {
        [repoFile('apps/mobile/src/context/AuthProvider.tsx')]: withFallback({
          useAppAuth: () => {
            controls.hook('useContext');
            return controls.auth;
          },
        }),
      },
      packages: {
        '@gettitonline/shared': withFallback({ ...shared, resolveAccountAccess }),
      },
    });
    const component = harness.load(repoFile('apps/mobile/src/screens/disputes/CreateDisputeScreen.tsx')).default;
    const params = { route: { params: { orderId: 'orders|buyer' } }, navigation };

    const initial = harness.render(component, params).tree;
    const field = (label: string) =>
      findNodes(initial, (node) => node.name === 'TextInput' && node.props.label === label)[0];
    const setTitle = field('Title')?.props.onChangeText;
    const setDescription = field('Description')?.props.onChangeText;
    if (typeof setTitle !== 'function' || typeof setDescription !== 'function') {
      throw new Error('the title and description inputs must be rendered');
    }
    setTitle('Late delivery');
    setDescription('The item did not arrive');

    const tree = harness.render(component, params).tree;
    assert.ok(pressButton(tree, 'Submit Dispute'), 'submit button');

    const submitted = controls.calls.find((call) => call.name === 'mutation:disputes.createDispute');
    const args = submitted?.args[0];
    if (!isRecord(args)) {
      throw new Error('createDispute must be called with an arguments object');
    }
    assert.equal('buyerId' in args, false, 'the acting buyer must not be sent');
    assert.equal(args.orderId, 'orders|buyer');
    assert.equal(args.title, 'Late delivery');
  });
});

// The conversation waits for the requested dispute. A missing dispute gets an actionable state, not a composer.
describe('ChatScreen conversation state', () => {
  function chatScreen(): ScreenCase {
    const screen = SCREENS.find((candidate) => candidate.label === 'ChatScreen');
    assert.ok(screen);
    return screen;
  }

  const companyDispute = {
    ...dispute,
    _id: 'disputes|company',
    buyerId: 'users|buyer',
    sellerId: 'users|company',
    status: 'in_discussion',
  };

  it('waits for the requested dispute before showing the composer', () => {
    const screen = chatScreen();
    const result = openScreen(screen, 'ready', { 'messages.getMessages': [] }).render();

    assert.ok(hasNode(result.tree, 'ActivityIndicator'), 'loading while the dispute is pending');
    assert.ok(!screen.shown(result.tree), 'no composer before the dispute has loaded');
  });

  it('a missing dispute shows an actionable state with a way back, and no composer', () => {
    const screen = chatScreen();
    const backs: string[] = [];
    const props: Props = {
      route: { params: { disputeId: 'disputes|gone' } },
      navigation: {
        ...navigation,
        goBack: () => {
          backs.push('back');
        },
      },
    };
    const result = openScreen(
      screen,
      'ready',
      { 'messages.getMessages': [], 'disputes.getDispute': null },
      props,
    ).render();

    assert.ok(textOf(result.tree).includes('no longer available'), textOf(result.tree));
    assert.ok(!screen.shown(result.tree), 'no composer for a dispute that does not exist');
    assert.ok(pressButton(result.tree, 'Back to disputes'), 'the missing state offers a way back');
    assert.deepEqual(backs, ['back']);
  });

  it('a configured catalog manager sees the company conversation and sends as the verified actor', () => {
    const screen = chatScreen();
    const delegate: Props = {
      _id: 'users|catalog',
      clerkId: 'clerk_catalog',
      role: 'catalog_manager',
      firstName: 'Cora',
      lastName: 'Catalog',
    };
    const props: Props = { route: { params: { disputeId: 'disputes|company' } }, navigation };
    const { controls, render } = openScreen(
      screen,
      'ready',
      { 'messages.getMessages': [], 'disputes.getDispute': fixture(companyDispute) },
      props,
      delegate,
    );

    const initial = render().tree;
    assert.ok(screen.shown(initial), textOf(initial));
    const setText = findNodes(initial, (node) => node.name === 'TextInput')[0]?.props.onChangeText;
    if (typeof setText !== 'function') {
      throw new Error('the message composer must be rendered');
    }
    setText('We are checking this');

    const tree = render().tree;
    const send = findNodes(tree, (node) => node.name === 'TextInput')[0]?.props.right;
    if (!isRecord(send) || !isRecord(send.props) || typeof send.props.onPress !== 'function') {
      throw new Error('the send control must be rendered');
    }
    send.props.onPress();

    const sent = controls.calls.find((call) => call.name === 'mutation:messages.sendMessage');
    assert.deepEqual(sent?.args[0], { disputeId: 'disputes|company', content: 'We are checking this' });
  });
});
