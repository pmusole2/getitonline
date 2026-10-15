import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import * as shared from '../../../../packages/shared/src/index';
import { AI_REFUSAL_COPY, type RecommendationsResponse } from '../services/aiAdapters';
import { createControls, createHarness, withFallback, type Props } from '../../../../tests/support/componentHarness';
import type { useAIRecommendations } from './useAIRecommendations';

// Runs the real useAIRecommendations hook with its effects. The AI actions are a controlled stand-in: each request is
// held until the test settles it, so a late reply can be replayed after the account changes.

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const repoFile = (relativePath: string) => resolve(repoRoot, relativePath);
const hookFile = repoFile('apps/mobile/src/hooks/useAIRecommendations.ts');
const aiActionsFile = repoFile('apps/mobile/src/hooks/useAiActions.ts');
const authFile = repoFile('apps/mobile/src/context/AuthProvider.tsx');

type HookResult = ReturnType<typeof useAIRecommendations>;
type Outcome = { kind: 'resolve'; value: RecommendationsResponse } | { kind: 'reject'; error: unknown };

interface PendingRequest {
  readonly subject: string;
  settle(outcome: Outcome): void;
}

function fakeAiActions() {
  const pending: PendingRequest[] = [];
  const state: { subject: string } = { subject: 'account:a' };
  // Like the real hook, each subject gets its own actions object, and that object stops being current on a switch.
  const byAccount = new Map<string, Props>();
  const actionsFor = (subject: string): Props => {
    const existing = byAccount.get(subject);
    if (existing !== undefined) return existing;
    const actions: Props = {
      subject,
      isCurrent: () => state.subject === subject,
      getRecommendations: () =>
        new Promise<RecommendationsResponse>((resolveRequest, rejectRequest) => {
          pending.push({
            subject,
            settle(outcome) {
              if (outcome.kind === 'resolve') {
                resolveRequest(outcome.value);
              } else {
                rejectRequest(outcome.error);
              }
            },
          });
        }),
    };
    byAccount.set(subject, actions);
    return actions;
  };
  return { forActiveSubject: () => actionsFor(state.subject), pending, state };
}

function setAccount(controls: ReturnType<typeof createControls>, accountId: string): void {
  controls.auth = {
    isLoading: false,
    isSignedIn: true,
    user: { _id: `users|${accountId}`, role: 'user' },
    clerkUser: { id: `clerk_${accountId}` },
    authSyncError: null,
  };
}

function harnessFor(controls: ReturnType<typeof createControls>, actionsFor: () => Props) {
  return createHarness({
    controls,
    effects: true,
    files: {
      [aiActionsFile]: withFallback({
        useAiActions: () => {
          controls.hook('useAiActions');
          return actionsFor();
        },
      }),
      [authFile]: withFallback({
        useAppAuth: () => {
          controls.hook('useContext');
          return controls.auth;
        },
      }),
    },
    packages: {
      '@gettitonline/shared': withFallback({ ...shared }),
    },
  });
}

describe('useAIRecommendations with AI actions', () => {
  it('a change of account clears the recommendations and discards a late reply for the previous account', async () => {
    const controls = createControls();
    setAccount(controls, 'a');
    const fake = fakeAiActions();
    const harness = harnessFor(controls, fake.forActiveSubject);
    const useHook = harness.load(hookFile).useAIRecommendations as typeof useAIRecommendations;
    let latest: HookResult | undefined;
    const Probe = (): null => {
      latest = useHook({ limit: 3 });
      return null;
    };

    harness.render(Probe);
    const requestForA = fake.pending[0];
    assert.ok(requestForA, 'account A asks for recommendations');

    setAccount(controls, 'b');
    fake.state.subject = 'account:b';
    harness.render(Probe);
    await harness.settle();
    assert.equal(fake.pending.length, 2, 'account B asks for its own recommendations');

    requestForA.settle({ kind: 'resolve', value: { productIds: ['p-a'], reasoning: 'for account A', source: 'ai' } });
    await harness.settle();
    harness.render(Probe);
    assert.equal(latest?.reasoning, null, 'the reply for account A is not shown to account B');
    assert.equal(latest?.error, null);

    const requestForB = fake.pending[1];
    requestForB?.settle({ kind: 'resolve', value: { productIds: ['p-b'], reasoning: 'for account B', source: 'ai' } });
    await harness.settle();
    harness.render(Probe);
    assert.equal(latest?.reasoning, 'for account B');
  });

  it('a consent refusal shows no error and no recommendations, as before', async () => {
    const controls = createControls();
    setAccount(controls, 'a');
    const fake = fakeAiActions();
    const harness = harnessFor(controls, fake.forActiveSubject);
    const useHook = harness.load(hookFile).useAIRecommendations as typeof useAIRecommendations;
    let latest: HookResult | undefined;
    const Probe = (): null => {
      latest = useHook({ limit: 3 });
      return null;
    };

    harness.render(Probe);
    fake.pending[0]?.settle({ kind: 'reject', error: new shared.AiRequestError('consent_required') });
    await harness.settle();
    harness.render(Probe);

    assert.equal(latest?.error, null);
    assert.equal(latest?.reasoning, null);
    assert.equal(latest?.isLoading, false);
  });

  it('a typed refusal shows its user-facing copy', async () => {
    const controls = createControls();
    setAccount(controls, 'a');
    const fake = fakeAiActions();
    const harness = harnessFor(controls, fake.forActiveSubject);
    const useHook = harness.load(hookFile).useAIRecommendations as typeof useAIRecommendations;
    let latest: HookResult | undefined;
    const Probe = (): null => {
      latest = useHook({ limit: 3 });
      return null;
    };

    harness.render(Probe);
    fake.pending[0]?.settle({ kind: 'reject', error: new shared.AiRequestError('rate_limited') });
    await harness.settle();
    harness.render(Probe);

    assert.equal(latest?.error, AI_REFUSAL_COPY.rate_limited);
  });
});
