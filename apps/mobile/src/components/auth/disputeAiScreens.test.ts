import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AI_CONSENT_VERSION } from '../../../../../packages/shared/src/ai/aiConsent';
import {
  findNodes,
  pressButton,
  textOf,
  type Props,
  type RenderedChild,
} from '../../../../../tests/support/componentHarness';
import { buyerAccount, mountDisputeScreen, type MountedScreen } from './disputeAiHarness';

// Real ChatScreen and DisputeDetailScreen with the real AI hook. Each test checks what the request carries, what the
// screen shows for each typed outcome, and that a result from a previous account never reaches the screen.

const navigation: Props = { goBack: () => undefined, navigate: () => undefined, replace: () => undefined };
const chatProps: Props = { route: { params: { disputeId: 'disputes|buyer' } }, navigation };
const detailProps: Props = { route: { params: { disputeId: 'disputes|buyer' } }, navigation };
const rephraseAction = 'aiDisputes.rephraseMessage';
const analyzeAction = 'aiDisputes.analyzeDispute';

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

const reviewerAccount: Props = { ...buyerAccount, _id: 'users|mod', clerkId: 'clerk_mod', role: 'moderator' };

const buyerAnalysis = {
  ok: true,
  source: 'ai',
  summary: 'The parcel was late.',
  keyPoints: {
    yourClaims: ['It never arrived'],
    theirClaims: ['It shipped on time'],
    buyerClaims: ['It never arrived'],
    sellerClaims: ['It shipped on time'],
  },
  sentiment: { yours: 'frustrated', theirs: 'cooperative', buyer: 'frustrated', seller: 'cooperative' },
  suggestedResolutions: [],
  recommendedAction: 'Share the tracking number.',
  riskLevel: 'medium',
  additionalNotes: '',
  viewerRole: 'buyer',
};

// The reviewer's result: the buyer and seller columns carry different claims and sentiments, so a swap shows.
const reviewerAnalysis = {
  ok: true,
  source: 'ai',
  summary: 'The buyer reports a missing parcel and the seller reports a shipment.',
  keyPoints: {
    yourClaims: [],
    theirClaims: [],
    buyerClaims: ['The item never arrived'],
    sellerClaims: ['Shipped on 3 May with tracking'],
  },
  sentiment: { yours: 'frustrated', theirs: 'cooperative', buyer: 'frustrated', seller: 'cooperative' },
  suggestedResolutions: [],
  recommendedAction: 'Ask the carrier for a trace.',
  riskLevel: 'high',
  additionalNotes: '',
  viewerRole: 'moderator',
};

type Tree = readonly RenderedChild[];

function composerDraft(tree: Tree, text: string): void {
  const change = findNodes(tree, (node) => node.name === 'TextInput')[0]?.props.onChangeText;
  if (typeof change !== 'function') {
    throw new Error('the message composer must be rendered');
  }
  change(text);
}

function composerValue(tree: Tree): unknown {
  return findNodes(tree, (node) => node.name === 'TextInput')[0]?.props.value;
}

// The text of the container that holds a labelled group, such as "Buyer's Position:" and its claims.
function groupText(tree: Tree, label: string): string {
  const [group] = findNodes(tree, (node) =>
    node.children.some((child) => typeof child !== 'string' && textOf([child]) === label),
  );
  return group === undefined ? '' : textOf(group.children);
}

function callsTo(screen: MountedScreen, action: string): unknown[] {
  return screen.controls.calls.filter((call) => call.name === `action:${action}`).map((call) => call.args[0]);
}

async function typeAndCheck(screen: MountedScreen, draft: string): Promise<Tree> {
  composerDraft(screen.render(chatProps).tree, draft);
  const tree = screen.render(chatProps).tree;
  assert.ok(pressButton(tree, 'Check'), 'the check control must be shown for a long enough draft');
  await screen.settle();
  return screen.render(chatProps).tree;
}

function chatScreen(options: {
  prompt?: boolean;
  stored?: boolean;
  actions?: Record<string, () => Promise<unknown>>;
}): MountedScreen {
  return mountDisputeScreen({
    file: 'apps/mobile/src/screens/disputes/ChatScreen.tsx',
    account: buyerAccount,
    queries: { 'messages.getMessages': [buyerMessage], 'disputes.getDispute': dispute },
    actions: options.actions,
    consent: { prompt: options.prompt ?? true, stored: options.stored ?? true },
  });
}

function detailScreen(options: {
  account?: Props;
  reply?: unknown;
  prompt?: boolean;
  record?: Props;
  hold?: { release?: (reply: unknown) => void };
}): MountedScreen {
  const actions =
    options.hold === undefined
      ? { [analyzeAction]: async () => options.reply }
      : {
          [analyzeAction]: () =>
            new Promise<unknown>((resolve) => {
              if (options.hold !== undefined) options.hold.release = resolve;
            }),
        };
  return mountDisputeScreen({
    file: 'apps/mobile/src/screens/disputes/DisputeDetailScreen.tsx',
    account: options.account ?? buyerAccount,
    queries: { 'disputes.getDispute': options.record ?? dispute },
    actions,
    consent: { prompt: options.prompt ?? true, stored: true },
  });
}

async function generateAnalysis(screen: MountedScreen): Promise<Tree> {
  assert.ok(pressButton(screen.render(detailProps).tree, 'Generate Analysis'), 'the analysis control must be shown');
  await screen.settle();
  return screen.render(detailProps).tree;
}

describe('ChatScreen rephrase', () => {
  it('a rewrite from the assistant is offered, and the draft stays until the user accepts it', async () => {
    const draft = 'send the tracking number now pls';
    const screen = chatScreen({
      actions: {
        [rephraseAction]: async () => ({ ok: true, source: 'ai', rephrased: 'Please send the tracking number today.' }),
      },
    });

    let tree = await typeAndCheck(screen, draft);

    assert.deepEqual(callsTo(screen, rephraseAction), [
      { disputeId: 'disputes|buyer', message: draft, consentVersion: AI_CONSENT_VERSION },
    ]);
    assert.ok(textOf(tree).includes('Please send the tracking number today.'), textOf(tree));
    assert.equal(composerValue(tree), draft, 'the draft is not replaced before the user accepts');

    assert.ok(pressButton(tree, 'Use Suggestion'));
    tree = screen.render(chatProps).tree;
    assert.equal(composerValue(tree), 'Please send the tracking number today.');
  });

  it('an unchanged draft keeps the user text and says it was left as written', async () => {
    const draft = 'Where is my order? It was due on Monday.';
    const screen = chatScreen({
      actions: { [rephraseAction]: async () => ({ ok: true, source: 'unchanged', rephrased: draft }) },
    });

    const tree = await typeAndCheck(screen, draft);

    assert.ok(textOf(tree).includes('Your message was left as written.'), textOf(tree));
    assert.ok(!textOf(tree).includes('Suggested Improvement'), 'no rewrite is offered for an unchanged draft');
    assert.equal(composerValue(tree), draft);
  });

  it('an unchanged draft with quotation marks says those are never changed', async () => {
    const draft = 'He wrote "I will pay" and never did.';
    const screen = chatScreen({
      actions: { [rephraseAction]: async () => ({ ok: true, source: 'unchanged', rephrased: draft }) },
    });

    const tree = await typeAndCheck(screen, draft);

    assert.ok(textOf(tree).includes('Messages with quotation marks are never changed'), textOf(tree));
    assert.equal(composerValue(tree), draft);
  });

  it('a draft that is too long gets the too-long copy, and the draft is kept', async () => {
    const draft = 'x'.repeat(2000);
    const screen = chatScreen({ actions: { [rephraseAction]: async () => ({ ok: false, code: 'too_long' }) } });

    const tree = await typeAndCheck(screen, draft);

    assert.ok(textOf(tree).includes('Your draft is too long to rephrase'), textOf(tree).slice(0, 200));
    assert.equal(composerValue(tree), draft);
  });

  it('a declined consent prompt sends no rephrase request', async () => {
    const screen = chatScreen({
      prompt: false,
      actions: { [rephraseAction]: async () => ({ ok: true, source: 'ai', rephrased: 'x' }) },
    });

    const tree = await typeAndCheck(screen, 'send the tracking number now pls');

    assert.deepEqual(callsTo(screen, rephraseAction), []);
    assert.ok(textOf(tree).includes('is off until you allow AI features'), textOf(tree));
  });

  it('a consent refusal from the backend shows the consent copy and no rewrite', async () => {
    const screen = chatScreen({ actions: { [rephraseAction]: async () => ({ ok: false, code: 'consent_required' }) } });

    const tree = await typeAndCheck(screen, 'send the tracking number now pls');

    assert.ok(textOf(tree).includes('AI features are off until you allow'), textOf(tree));
    assert.ok(!textOf(tree).includes('Suggested Improvement'));
  });

  it('a rewrite that arrives after the account changed is discarded', async () => {
    let release: ((reply: unknown) => void) | undefined;
    const screen = chatScreen({
      actions: {
        [rephraseAction]: () =>
          new Promise<unknown>((resolve) => {
            release = resolve;
          }),
      },
    });
    composerDraft(screen.render(chatProps).tree, 'send the tracking number now pls');
    assert.ok(pressButton(screen.render(chatProps).tree, 'Check'));
    await screen.settle();

    screen.signInAs({ ...buyerAccount, _id: 'users|other', clerkId: 'clerk_other' });
    screen.render(chatProps);
    release?.({ ok: true, source: 'ai', rephrased: 'Rewrite for the previous account.' });
    await screen.settle();

    assert.ok(!textOf(screen.render(chatProps).tree).includes('Rewrite for the previous account.'));
  });
});

describe('DisputeDetailScreen analysis', () => {
  it("a participant's analysis shows their own claims, and says it is shown only to them", async () => {
    const screen = detailScreen({ reply: buyerAnalysis });

    const tree = await generateAnalysis(screen);

    assert.deepEqual(callsTo(screen, analyzeAction), [
      { disputeId: 'disputes|buyer', consentVersion: AI_CONSENT_VERSION },
    ]);
    assert.ok(groupText(tree, 'Your Position:').includes('It never arrived'), groupText(tree, 'Your Position:'));
    assert.ok(!groupText(tree, 'Your Position:').includes('It shipped on time'));
    assert.ok(
      groupText(tree, "Seller's Position:").includes('It shipped on time'),
      groupText(tree, "Seller's Position:"),
    );
    assert.ok(textOf(tree).includes('Shown only to you'), textOf(tree));
    assert.ok(!textOf(tree).includes('Saved for all participants'));
  });

  it("a reviewer sees the buyer's claims under Buyer and the seller's under Seller, and is told it is saved", async () => {
    const screen = detailScreen({ account: reviewerAccount, reply: reviewerAnalysis });

    const tree = await generateAnalysis(screen);

    assert.ok(
      groupText(tree, "Buyer's Position:").includes('The item never arrived'),
      groupText(tree, "Buyer's Position:"),
    );
    assert.ok(
      !groupText(tree, "Buyer's Position:").includes('Shipped on 3 May'),
      'the seller claim is not in the buyer column',
    );
    assert.ok(
      groupText(tree, "Seller's Position:").includes('Shipped on 3 May with tracking'),
      groupText(tree, "Seller's Position:"),
    );
    assert.ok(
      !groupText(tree, "Seller's Position:").includes('never arrived'),
      'the buyer claim is not in the seller column',
    );
    assert.ok(textOf(tree).includes('Saved for all participants'), textOf(tree));
  });

  it('a declined consent prompt sends no analysis request', async () => {
    const screen = detailScreen({ prompt: false, reply: buyerAnalysis });

    const tree = await generateAnalysis(screen);

    assert.deepEqual(callsTo(screen, analyzeAction), []);
    assert.ok(textOf(tree).includes('is off until you allow AI features'), textOf(tree));
  });

  it('a forbidden refusal reads as a dispute, and shows no analysis', async () => {
    const screen = detailScreen({ reply: { ok: false, code: 'forbidden' } });

    const tree = await generateAnalysis(screen);

    assert.ok(
      textOf(tree).includes('AI help for a dispute is only available to its parties and reviewers.'),
      textOf(tree),
    );
    assert.ok(!textOf(tree).includes('Shown only to you'));
  });

  it('an analysis that arrives after the account changed is discarded and never shown', async () => {
    const hold: { release?: (reply: unknown) => void } = {};
    const screen = detailScreen({ hold });
    assert.ok(pressButton(screen.render(detailProps).tree, 'Generate Analysis'));
    await screen.settle();

    screen.signInAs({ ...buyerAccount, _id: 'users|other', clerkId: 'clerk_other' });
    screen.render(detailProps);
    hold.release?.(buyerAnalysis);
    await screen.settle();

    assert.ok(!textOf(screen.render(detailProps).tree).includes('The parcel was late.'));
  });

  it('a persisted analysis on the dispute is still shown, and no request is sent to show it', () => {
    const screen = detailScreen({
      record: { ...dispute, aiSummary: 'Stored summary of the dispute.', aiSuggestions: ['Offer a partial refund'] },
      reply: buyerAnalysis,
    });

    const tree = screen.render(detailProps).tree;

    assert.ok(textOf(tree).includes('Stored summary of the dispute.'), textOf(tree));
    assert.deepEqual(callsTo(screen, analyzeAction), []);
  });
});
