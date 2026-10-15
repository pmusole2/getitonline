import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AI_CONSENT_VERSION } from '../../../../../packages/shared/src/ai/aiConsent';
import { findNodes, textOf, type Props } from '../../../../../tests/support/componentHarness';
import { buyerAccount, mountDisputeScreen, type MountedScreen } from './disputeAiHarness';

// Runs the real ChatScreen and presses its suggestions control. The assistant is sent the dispute id and the consent
// version only. The server reads the conversation and the viewer's side from the dispute, so the client sends neither.

const suggestAction = 'aiDisputes.suggestResponses';

const navigation: Props = { goBack: () => undefined, navigate: () => undefined, replace: () => undefined };
const chatProps: Props = { route: { params: { disputeId: 'disputes|other' } }, navigation };

const dispute: Props = {
  _id: 'disputes|other',
  buyerId: 'users|buyer',
  sellerId: 'users|seller',
  title: 'Late delivery',
  description: 'The item did not arrive',
  category: 'not_received',
  status: 'in_discussion',
  evidence: [],
  createdAt: 1,
  updatedAt: 1,
  aiSummary: undefined,
  aiSuggestions: [],
};

const sellerMessage: Props = {
  _id: 'messages|1',
  disputeId: 'disputes|other',
  senderId: 'users|seller',
  content: 'Where is my order?',
  isSystemMessage: false,
  createdAt: 1,
  sender: { _id: 'users|seller', firstName: 'Sam', lastName: 'Seller', role: 'user' },
};

function mountChat(options: { prompt: boolean; reply: unknown }): MountedScreen {
  return mountDisputeScreen({
    file: 'apps/mobile/src/screens/disputes/ChatScreen.tsx',
    account: buyerAccount,
    queries: { 'messages.getMessages': [sellerMessage], 'disputes.getDispute': dispute },
    actions: { [suggestAction]: async () => options.reply },
    consent: { prompt: options.prompt, stored: true },
  });
}

async function pressSuggestions(screen: MountedScreen) {
  const [lightbulb] = findNodes(
    screen.render(chatProps).tree,
    (node) => node.name === 'IconButton' && node.props.icon === 'lightbulb-outline',
  );
  const onPress = lightbulb?.props.onPress;
  if (typeof onPress !== 'function') {
    throw new Error('the suggestions control must be rendered');
  }
  await onPress();
  await screen.settle();
  return screen.render(chatProps).tree;
}

function suggestionCalls(screen: MountedScreen): unknown[] {
  return screen.controls.calls.filter((call) => call.name === `action:${suggestAction}`).map((call) => call.args[0]);
}

describe('ChatScreen suggestions', () => {
  it('asks for suggestions with the dispute id and the consent version, and shows what the server returns', async () => {
    const screen = mountChat({
      prompt: true,
      reply: {
        ok: true,
        source: 'ai',
        suggestions: ['Thanks for your patience', 'Could you share the tracking number?'],
      },
    });

    const tree = await pressSuggestions(screen);

    assert.deepEqual(suggestionCalls(screen), [{ disputeId: 'disputes|other', consentVersion: AI_CONSENT_VERSION }]);
    assert.ok(textOf(tree).includes('Thanks for your patience'), textOf(tree));
    assert.ok(textOf(tree).includes('Could you share the tracking number?'), textOf(tree));
  });

  it('an unavailable suggestion request shows the unavailable copy and no invented suggestions', async () => {
    const screen = mountChat({ prompt: true, reply: { ok: false, code: 'unavailable' } });

    const tree = await pressSuggestions(screen);

    assert.ok(textOf(tree).includes('AI is unavailable right now. Try again later.'), textOf(tree));
    assert.ok(!textOf(tree).includes('I understand your concern'), 'no fabricated suggestion may be shown');
  });

  it('a declined consent prompt sends no suggestion request', async () => {
    const screen = mountChat({ prompt: false, reply: { ok: true, source: 'ai', suggestions: ['Never shown'] } });

    const tree = await pressSuggestions(screen);

    assert.deepEqual(suggestionCalls(screen), [], 'the assistant is not asked without consent');
    assert.ok(textOf(tree).includes('is off until you allow AI features'), textOf(tree));
  });
});
