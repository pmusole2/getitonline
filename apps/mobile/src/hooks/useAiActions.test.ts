import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import { getFunctionName } from 'convex/server';

import * as shared from '../../../../packages/shared/src/index';
import { api } from '../../../../convex/_generated/api';
import { AI_CONSENT_VERSION } from '../../../../packages/shared/src/ai/aiConsent';
import { createControls, createHarness, withFallback } from '../../../../tests/support/componentHarness';
import type { AiActions } from './useAiActions';
import type { useAiActions as UseAiActions } from './useAiActions';

// Runs the real useAiActions hook. The Convex actions are recorded by reference, so each test can see the exact
// arguments each call sends. Storage, the consent store, and the auth context are controlled.

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const repoFile = (relativePath: string) => resolve(repoRoot, relativePath);
const hookFile = repoFile('apps/mobile/src/hooks/useAiActions.ts');
const authFile = repoFile('apps/mobile/src/context/AuthProvider.tsx');
const consentFile = repoFile('apps/mobile/src/services/aiConsent.ts');

interface ActionCall {
  readonly action: string;
  readonly args: Record<string, unknown>;
}

// Actions are matched by Convex function name, because the generated api object can hand out new reference objects.
const actionNames = new Map<string, string>([
  [getFunctionName(api.ai.chat), 'chat'],
  [getFunctionName(api.aiDiscovery.getRecommendations), 'getRecommendations'],
  [getFunctionName(api.aiDiscovery.similarProducts), 'similarProducts'],
  [getFunctionName(api.aiDiscovery.visualSearch), 'visualSearch'],
  [getFunctionName(api.aiModeration.moderateListing), 'moderateListing'],
  [getFunctionName(api.aiDisputes.rephraseMessage), 'rephraseMessage'],
  [getFunctionName(api.aiDisputes.suggestResponses), 'suggestResponses'],
  [getFunctionName(api.aiDisputes.analyzeDispute), 'analyzeDispute'],
  [getFunctionName(api.aiDisputes.generateResolutionMessage), 'generateResolutionMessage'],
]);

const replies: Record<string, unknown> = {
  getRecommendations: { ok: true, source: 'ai', productIds: ['controller'], reasoning: 'Suggested for your cart' },
  chat: { ok: true, source: 'ai', reply: 'Hello from Pinkie', actions: [] },
  moderateListing: {
    ok: true,
    source: 'ai',
    saved: true,
    revision: 1,
    status: 'clear',
    summary: 'Looks fine.',
    flags: [],
  },
  rephraseMessage: { ok: true, source: 'ai', rephrased: 'Please send the tracking number.' },
  suggestResponses: { ok: true, source: 'ai', suggestions: ['Thanks, I will check.'] },
  analyzeDispute: {
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
  },
  generateResolutionMessage: { ok: true, source: 'ai', message: 'We will refund the order.' },
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function signedInAuth(clerkId: string) {
  return {
    isLoading: false,
    isSignedIn: true,
    user: { _id: `users|${clerkId}` },
    clerkUser: { id: clerkId },
    authSyncError: null,
  };
}

function memoryStorage(holdRead?: () => Promise<void>) {
  const values = new Map<string, string>();
  return {
    default: {
      async getItem(key: string) {
        if (holdRead !== undefined) {
          await holdRead();
        }
        return values.get(key) ?? null;
      },
      async setItem(key: string, value: string) {
        values.set(key, value);
      },
    },
    values,
  };
}

// A held action does not resolve until the test releases it, so a test can switch accounts while the call is in flight.
function renderActions(options: {
  signedIn: boolean;
  consented: boolean;
  hold?: string;
  holdConsent?: boolean;
  holdSessionRead?: boolean;
  onConsentCheck?: (subject: string) => void;
}) {
  const controls = createControls();
  controls.auth = options.signedIn
    ? signedInAuth('clerk_a')
    : { isLoading: false, isSignedIn: false, user: null, clerkUser: null, authSyncError: null };
  const held: { release?: (reply: unknown) => void } = {};
  const calls: ActionCall[] = [];
  const consentGate = deferred<boolean>();
  const sessionGate = deferred<void>();
  const storage = memoryStorage(options.holdSessionRead === true ? () => sessionGate.promise : undefined);
  const consentSubjects: string[] = [];

  const harness = createHarness({
    controls,
    effects: true,
    convexApi: { api },
    files: {
      [authFile]: withFallback({
        useAppAuth: () => {
          controls.hook('useContext');
          return controls.auth;
        },
      }),
      [consentFile]: withFallback({
        hasAIConsent: async (subject: string) => {
          consentSubjects.push(subject);
          options.onConsentCheck?.(subject);
          if (options.holdConsent === true) {
            return consentGate.promise;
          }
          return options.consented;
        },
      }),
    },
    packages: {
      '@gettitonline/shared': withFallback({ ...shared }),
      '@react-native-async-storage/async-storage': withFallback(storage),
      'expo-crypto': withFallback({ randomUUID: () => 'b7e1c2d4-0000-4000-8000-guest0000001' }),
      'convex/react': withFallback({
        useAction: (reference: Parameters<typeof getFunctionName>[0]) => {
          const action = actionNames.get(getFunctionName(reference)) ?? 'unknown';
          return async (args: Record<string, unknown>) => {
            calls.push({ action, args });
            if (action === options.hold) {
              return new Promise<unknown>((resolve) => {
                held.release = resolve;
              });
            }
            return replies[action];
          };
        },
      }),
    },
  });

  const useHook = harness.load(hookFile).useAiActions as typeof UseAiActions;
  const holder: { actions?: AiActions } = {};
  const Probe = (): null => {
    holder.actions = useHook();
    return null;
  };
  harness.render(Probe);
  const actions = holder.actions;
  if (actions === undefined) {
    throw new Error('the hook must return actions');
  }
  return {
    actions,
    calls,
    storage,
    consentSubjects,
    // Re-renders the same hook after the auth context changed, as a sign-in to another account does.
    switchAccount: (clerkId: string) => {
      controls.auth = signedInAuth(clerkId);
      harness.render(Probe);
      return holder.actions;
    },
    releaseHeld: (reply: unknown) => held.release?.(reply),
    releaseConsent: (value: boolean) => consentGate.resolve(value),
    releaseSessionRead: () => sessionGate.resolve(),
  };
}

describe('useAiActions', () => {
  it('a guest sends the same stored random session id on every call, and never an account id', async () => {
    const { actions, calls, storage } = renderActions({ signedIn: false, consented: true });

    await actions.chat({ message: 'first' });
    await actions.chat({ message: 'second' });

    const sessionIds = calls.map((call) => call.args.sessionId);
    assert.equal(sessionIds[0], 'b7e1c2d4-0000-4000-8000-guest0000001');
    assert.equal(sessionIds[1], sessionIds[0], 'the id is stable across calls');
    assert.equal(storage.values.size, 1, 'the id is persisted once');
    assert.equal(
      calls.every((call) => call.args.consentVersion === AI_CONSENT_VERSION),
      true,
    );
  });

  it('a signed-in account sends no session id, so the backend decides the account from identity', async () => {
    const { actions, calls } = renderActions({ signedIn: true, consented: true });

    await actions.chat({ message: 'hi' });

    assert.equal(calls.length, 1);
    assert.equal('sessionId' in (calls[0]?.args ?? {}), false);
  });

  it('moderation sends only the product id and the consent version', async () => {
    const { actions, calls } = renderActions({ signedIn: true, consented: true });

    const result = await actions.moderateListing({ productId: 'prod_42' });

    assert.deepEqual(calls, [
      { action: 'moderateListing', args: { productId: 'prod_42', consentVersion: AI_CONSENT_VERSION } },
    ]);
    assert.equal(result.saved, true);
  });

  it('without consent no action is called at all', async () => {
    const { actions, calls, consentSubjects } = renderActions({ signedIn: true, consented: false });

    await assert.rejects(actions.chat({ message: 'hi' }), (error: unknown) => {
      return error instanceof Error && error.name === 'AiRequestError' && /consent_required/.test(error.message);
    });
    assert.deepEqual(calls, [], 'the provider-bound action is never called');
    assert.deepEqual(consentSubjects, ['account:clerk_a'], 'consent is checked for the signed-in account');
  });
});

describe('useAiActions dispute actions', () => {
  it('each dispute action sends only the dispute id, its own input, and the consent version', async () => {
    const { actions, calls } = renderActions({ signedIn: true, consented: true });

    await actions.rephraseMessage({ disputeId: 'disputes_1', message: 'Where is my order?' });
    await actions.suggestResponses({ disputeId: 'disputes_1' });
    await actions.analyzeDispute({ disputeId: 'disputes_1' });
    await actions.generateResolutionMessage({
      disputeId: 'disputes_1',
      resolutionType: 'partial_refund',
      refundAmount: 40,
    });

    assert.deepEqual(calls, [
      {
        action: 'rephraseMessage',
        args: { disputeId: 'disputes_1', message: 'Where is my order?', consentVersion: AI_CONSENT_VERSION },
      },
      { action: 'suggestResponses', args: { disputeId: 'disputes_1', consentVersion: AI_CONSENT_VERSION } },
      { action: 'analyzeDispute', args: { disputeId: 'disputes_1', consentVersion: AI_CONSENT_VERSION } },
      {
        action: 'generateResolutionMessage',
        args: {
          disputeId: 'disputes_1',
          resolutionType: 'partial_refund',
          refundAmount: 40,
          consentVersion: AI_CONSENT_VERSION,
        },
      },
    ]);
  });

  it('without consent no dispute action is called, and the account is the one checked', async () => {
    const { actions, calls, consentSubjects } = renderActions({ signedIn: true, consented: false });

    const attempts = [
      actions.rephraseMessage({ disputeId: 'disputes_1', message: 'Where is my order?' }),
      actions.suggestResponses({ disputeId: 'disputes_1' }),
      actions.analyzeDispute({ disputeId: 'disputes_1' }),
      actions.generateResolutionMessage({ disputeId: 'disputes_1', resolutionType: 'no_refund' }),
    ];
    for (const attempt of attempts) {
      await assert.rejects(
        attempt,
        (error: unknown) => error instanceof Error && /consent_required/.test(error.message),
      );
    }
    assert.deepEqual(calls, [], 'no dispute action reaches the backend without consent');
    assert.deepEqual(consentSubjects, ['account:clerk_a', 'account:clerk_a', 'account:clerk_a', 'account:clerk_a']);
  });

  it('a guest is refused every dispute action before any call', async () => {
    const { actions, calls } = renderActions({ signedIn: false, consented: true });

    await assert.rejects(actions.analyzeDispute({ disputeId: 'disputes_1' }), (error: unknown) => {
      return error instanceof Error && /account_required/.test(error.message);
    });
    await assert.rejects(actions.suggestResponses({ disputeId: 'disputes_1' }), (error: unknown) => {
      return error instanceof Error && /account_required/.test(error.message);
    });
    assert.deepEqual(calls, []);
  });

  it("the signed-in account's analysis is returned as that viewer's view", async () => {
    const { actions } = renderActions({ signedIn: true, consented: true });

    const view = await actions.analyzeDispute({ disputeId: 'disputes_1' });

    assert.equal(view.viewer, 'participant');
    assert.equal(view.viewer === 'participant' ? view.side : '', 'buyer');
    assert.deepEqual(view.viewer === 'participant' ? view.yourClaims : [], ['It never arrived']);
  });

  it('a dispute analysis that arrives after the account changed is discarded, and never returned', async () => {
    const { actions, calls, releaseHeld, switchAccount } = renderActions({
      signedIn: true,
      consented: true,
      hold: 'analyzeDispute',
    });

    const pending = actions.analyzeDispute({ disputeId: 'disputes_1' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1, 'the analysis reached the backend before the switch');

    switchAccount('clerk_b');
    releaseHeld(replies.analyzeDispute);

    await assert.rejects(pending, (error: unknown) => {
      return error instanceof Error && error.name === 'AiRequestError' && /account_changed/.test(error.message);
    });
  });
});

describe('useAiActions stale-subject guards', () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const rejectsWith = (code: string) => (error: unknown) =>
    error instanceof Error && error.name === 'AiRequestError' && error.message.includes(code);

  it('a switch during the consent lookup dispatches nothing, even when the next account is consented', async () => {
    const { actions, calls, releaseConsent, switchAccount, consentSubjects } = renderActions({
      signedIn: true,
      consented: true,
      holdConsent: true,
    });

    const pending = actions.chat({ message: "A's private draft" });
    await tick();
    switchAccount('clerk_b');
    releaseConsent(true);

    await assert.rejects(pending, rejectsWith('account_changed'));
    assert.deepEqual(calls, [], 'the transport is never called under the new account');
    assert.deepEqual(consentSubjects, ['account:clerk_a'], "B's consent is not read on A's behalf");
  });

  it('a switch during the guest session lookup dispatches nothing', async () => {
    const { actions, calls, releaseSessionRead, switchAccount } = renderActions({
      signedIn: false,
      consented: true,
      holdSessionRead: true,
    });

    const pending = actions.chat({ message: "guest's draft" });
    await tick();
    switchAccount('clerk_b');
    releaseSessionRead();

    await assert.rejects(pending, rejectsWith('account_changed'));
    assert.deepEqual(calls, [], 'no call reaches the backend for the new account');
  });

  it('a switch made inside the last consent check, right before dispatch, dispatches nothing', async () => {
    const holder: { switchTo?: (clerkId: string) => void } = {};
    const { actions, calls, switchAccount } = renderActions({
      signedIn: true,
      consented: true,
      onConsentCheck: () => holder.switchTo?.('clerk_b'),
    });
    holder.switchTo = (clerkId) => {
      switchAccount(clerkId);
    };

    await assert.rejects(actions.chat({ message: 'draft' }), rejectsWith('account_changed'));
    assert.deepEqual(calls, []);
  });

  it('a callback created for A refuses to run under B, with no consent check and no backend call', async () => {
    const { actions, calls, consentSubjects, switchAccount } = renderActions({ signedIn: true, consented: true });
    const chatForA = actions.chat;

    switchAccount('clerk_b');

    await assert.rejects(chatForA({ message: "A's draft" }), rejectsWith('account_changed'));
    assert.equal(consentSubjects.includes('account:clerk_b'), false, 'B is never checked on behalf of A');
    assert.deepEqual(calls, []);
  });

  it('a dispute callback created for A refuses to run under B, with no backend call', async () => {
    const { actions, calls, switchAccount } = renderActions({ signedIn: true, consented: true });
    const suggestForA = actions.suggestResponses;

    switchAccount('clerk_b');

    await assert.rejects(suggestForA({ disputeId: 'disputes_1' }), rejectsWith('account_changed'));
    assert.deepEqual(calls, []);
  });

  it('a callback created after the switch works, and dispatches exactly once', async () => {
    const { switchAccount, calls } = renderActions({ signedIn: true, consented: true });

    const fresh = switchAccount('clerk_b');
    const reply = await fresh?.chat({ message: 'hello from B' });

    assert.equal(reply?.message, 'Hello from Pinkie');
    assert.deepEqual(
      calls.filter((call) => call.action === 'chat').map((call) => call.args.message),
      ['hello from B'],
    );
  });

  it('the same subject with no switch dispatches exactly once', async () => {
    const { actions, calls } = renderActions({ signedIn: true, consented: true });

    await actions.chat({ message: 'hi' });

    assert.equal(calls.filter((call) => call.action === 'chat').length, 1);
  });
});

it('cart recommendations send the snapshot through the real mobile action boundary', async () => {
  const { actions, calls } = renderActions({ signedIn: true, consented: true });
  await actions.getRecommendations({ limit: 3, cartProductIds: ['ps5'] });
  assert.deepEqual(calls, [
    { action: 'getRecommendations', args: { consentVersion: AI_CONSENT_VERSION, limit: 3, cartProductIds: ['ps5'] } },
  ]);
});
