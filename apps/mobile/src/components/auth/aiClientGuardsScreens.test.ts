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
  pressButton,
  textOf,
  withFallback,
  type ActionHandler,
  type Props,
  type RenderedChild,
} from '../../../../../tests/support/componentHarness';

// Real dispute, chat, and search screens with the real AI hook. The consent prompt is held open by the test, and so is
// the Convex action, so the test can switch accounts while each one is pending. A result from the previous account must
// never reach what the screen shows for the new account.

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const repoFile = (relativePath: string) => resolve(repoRoot, relativePath);

const buyer: Props = {
  _id: 'users|buyer',
  clerkId: 'clerk_buyer',
  email: 'buyer@example.invalid',
  firstName: 'Bea',
  lastName: 'Buyer',
  role: 'user',
  isBanned: false,
};
const otherBuyer: Props = { ...buyer, _id: 'users|buyer2', clerkId: 'clerk_buyer2' };

const dispute: Props = {
  _id: 'disputes|buyer',
  buyerId: 'users|buyer',
  sellerId: 'users|seller',
  title: 'Late delivery',
  description: 'The item did not arrive',
  category: 'not_received',
  status: 'in_discussion',
  evidence: [],
  createdAt: 1767225600000,
  updatedAt: 1767225600000,
  aiSummary: undefined,
  aiSuggestions: [],
};
const buyerMessage: Props = {
  _id: 'messages|1',
  disputeId: 'disputes|buyer',
  senderId: 'users|buyer',
  content: 'Where is my order?',
  isSystemMessage: false,
  createdAt: 1,
  sender: { _id: 'users|buyer', firstName: 'Bea', lastName: 'Buyer', role: 'user' },
};

const analysisReply = {
  ok: true,
  source: 'ai',
  summary: 'The parcel was late.',
  keyPoints: { yourClaims: [], theirClaims: [], buyerClaims: [], sellerClaims: [] },
  sentiment: { yours: 'neutral', theirs: 'neutral', buyer: 'neutral', seller: 'neutral' },
  suggestedResolutions: [],
  recommendedAction: 'Share the tracking number.',
  riskLevel: 'low',
  additionalNotes: '',
  viewerRole: 'buyer',
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function signedIn(account: Props): Props {
  return {
    isLoading: false,
    isSignedIn: true,
    user: account,
    clerkUser: { id: String(account.clerkId) },
    authSyncError: null,
  };
}

interface MountOptions {
  readonly file: string;
  readonly account: Props;
  readonly queries?: Props;
  readonly actions?: Record<string, ActionHandler>;
  readonly routeParams?: Props;
  readonly consentPrompt: boolean | Promise<boolean>;
}

function mount(options: MountOptions) {
  const controls = createControls();
  controls.auth = signedIn(options.account);
  controls.queries = options.queries ?? { 'messages.getMessages': [buyerMessage], 'disputes.getDispute': dispute };
  controls.actions = options.actions ?? {};
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
      [repoFile('apps/mobile/src/services/aiConsent.ts')]: withFallback({
        requestAIConsent: async () => options.consentPrompt,
        hasAIConsent: async () => true,
      }),
    },
    packages: {
      '@gettitonline/shared': withFallback({ ...shared, resolveAccountAccess }),
    },
  });
  const component = harness.load(repoFile(options.file)).default;
  const props: Props = { route: { params: options.routeParams ?? { disputeId: 'disputes|buyer' } }, navigation: {} };
  return {
    controls,
    render: (): readonly RenderedChild[] => harness.render(component, props).tree,
    settle: () => harness.settle(),
    signInAs: (account: Props) => {
      controls.auth = signedIn(account);
    },
  };
}

describe('dispute, chat, and search screens ignore a result from the previous account', () => {
  it('the dispute analysis for A that finishes after a switch is not shown to B', async () => {
    const reply = deferred<unknown>();
    const screen = mount({
      file: 'apps/mobile/src/screens/disputes/DisputeDetailScreen.tsx',
      account: buyer,
      actions: { 'aiDisputes.analyzeDispute': () => reply.promise },
      consentPrompt: true,
    });
    pressButton(screen.render(), 'Generate Analysis');
    await tick();

    screen.signInAs(otherBuyer);
    screen.render();
    reply.resolve(analysisReply);
    await screen.settle();
    const tree = screen.render();

    assert.equal(textOf(tree).includes('The parcel was late.'), false, "A's analysis is not shown to B");
  });

  it("the rephrase for A's draft that finishes after a switch is not offered to B", async () => {
    const reply = deferred<unknown>();
    const screen = mount({
      file: 'apps/mobile/src/screens/disputes/ChatScreen.tsx',
      account: buyer,
      actions: { 'aiDisputes.rephraseMessage': () => reply.promise },
      consentPrompt: true,
    });
    const [input] = findNodes(screen.render(), (node) => node.name === 'TextInput');
    (input?.props.onChangeText as (value: string) => void)("A's long private draft about the parcel");
    await tick();
    assert.ok(pressButton(screen.render(), 'Check'), 'the check control is shown for a long enough draft');
    await tick();

    screen.signInAs(otherBuyer);
    screen.render();
    reply.resolve({ ok: true, source: 'ai', rephrased: "A's rephrased text for the seller" });
    await screen.settle();
    const tree = screen.render();

    assert.equal(textOf(tree).includes("A's rephrased text"), false, "A's suggestion is not offered to B");
    assert.equal(textOf(tree).includes('suggests a clearer message'), false, 'no suggestion banner for B');
  });

  it("the visual search for A's photo that finishes after a switch never fills B's search", async () => {
    const reply = deferred<unknown>();
    const screen = mount({
      file: 'apps/mobile/src/screens/browse/SearchScreen.tsx',
      account: buyer,
      routeParams: { imageDataUrl: 'data:image/jpeg;base64,AAAA' },
      actions: { 'aiDiscovery.visualSearch': () => reply.promise },
      consentPrompt: true,
    });
    screen.render();
    await tick();

    screen.signInAs(otherBuyer);
    screen.render();
    reply.resolve({ ok: true, source: 'ai', query: "A's stale photo query", terms: [] });
    await screen.settle();
    const tree = screen.render();

    const [bar] = findNodes(tree, (node) => node.name === 'Searchbar');
    assert.notEqual(bar?.props.value, "A's stale photo query", "A's result is not the new account's search");
    assert.equal(textOf(tree).includes("A's stale photo query"), false);
  });
});
