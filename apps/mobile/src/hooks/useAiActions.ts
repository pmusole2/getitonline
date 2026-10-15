import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAction } from 'convex/react';
import * as Crypto from 'expo-crypto';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  aiSubjectFor,
  createAiRequests,
  createDisputeRequests,
  getOrCreateGuestSessionId,
  advanceSubjectState,
  bindToSubject,
  retiredSubjectState,
  type AiGateDeps,
  type AiRequests,
  type AiSubject,
  type AiSubjectState,
  type AiTransport,
  type ChatInput,
  type DisputeRequests,
  type DisputeResolutionType,
  type DisputeTransport,
  type KeyValueStore,
} from '@gettitonline/shared';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { useAppAuth } from '../context/AuthProvider';
import {
  adaptChat,
  adaptDisputeAnalysis,
  adaptModerateListing,
  adaptRecommendations,
  adaptRephrase,
  adaptResolutionMessage,
  adaptSimilarProducts,
  adaptSuggestions,
  adaptVisualSearch,
  type ChatResponse,
  type DisputeAnalysisView,
  type ModerateListingResponse,
  type RecommendationsResponse,
  type RephraseOutcome,
  type VisualSearchResponse,
} from '../services/aiAdapters';
import { hasAIConsent } from '../services/aiConsent';

// Pinkie's calls go through the Convex client. Every call checks consent for the subject that started it, and a result
// that arrives after the active account changed is discarded (AiRequestError 'account_changed').
export interface AiActions {
  // The account the actions belong to. A screen clears its account-specific state when this changes.
  readonly subject: AiSubject;
  // False once the active account has changed since these actions were created. A screen checks it after each await and
  // writes nothing for a result that is no longer current.
  isCurrent(): boolean;
  chat(input: ChatInput): Promise<ChatResponse>;
  getRecommendations(input: { limit?: number; cartProductIds?: string[] }): Promise<RecommendationsResponse>;
  getSimilarProducts(input: { productId: string; limit?: number }): Promise<string[]>;
  visualSearch(input: { imageDataUrl: string }): Promise<VisualSearchResponse>;
  moderateListing(input: { productId: string }): Promise<ModerateListingResponse>;
  // Dispute calls take the dispute id and their own input. The backend derives the account, side, and role.
  rephraseMessage(input: { disputeId: string; message: string }): Promise<RephraseOutcome>;
  suggestResponses(input: { disputeId: string }): Promise<string[]>;
  analyzeDispute(input: { disputeId: string }): Promise<DisputeAnalysisView>;
  generateResolutionMessage(input: {
    disputeId: string;
    resolutionType: DisputeResolutionType;
    refundAmount?: number;
  }): Promise<string>;
}

const guestSessionStore: KeyValueStore = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
};

export function useAiActions(): AiActions {
  const { clerkUser } = useAppAuth();
  // The same identity AuthProvider uses for the consent subject, so consent and results follow one account.
  const subject = aiSubjectFor(clerkUser?.id ?? null);

  // The subject state changes during the render that shows the new subject, so everything created from that render belongs
  // to it. The ref that later callbacks read is updated at commit, before an event can reach a callback.
  const [tracked, setTracked] = useState<AiSubjectState>({ subject, generation: 0 });
  const active = advanceSubjectState(tracked, subject);
  if (active !== tracked) {
    setTracked(active);
  }
  const activeRef = useRef(active);
  // False until this instance commits, and again once it unmounts. The app remounts the tree under a new key per account,
  // so a real unmount is final: an action started before it is refused at every later checkpoint. StrictMode replays
  // layout effects as setup, cleanup, setup in one synchronous commit, so no event or reply can see the gap, and a live
  // hook stays live.
  const liveRef = useRef(false);
  useLayoutEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    activeRef.current = active;
  }, [active]);
  const currentSubject = useCallback(
    () => (liveRef.current ? activeRef.current : retiredSubjectState(activeRef.current)),
    [],
  );

  const chatAction = useAction(api.ai.chat);
  const recommendationsAction = useAction(api.aiDiscovery.getRecommendations);
  const similarAction = useAction(api.aiDiscovery.similarProducts);
  const visualAction = useAction(api.aiDiscovery.visualSearch);
  const moderateAction = useAction(api.aiModeration.moderateListing);
  const rephraseAction = useAction(api.aiDisputes.rephraseMessage);
  const suggestAction = useAction(api.aiDisputes.suggestResponses);
  const analyzeAction = useAction(api.aiDisputes.analyzeDispute);
  const resolutionAction = useAction(api.aiDisputes.generateResolutionMessage);

  const transport = useMemo<AiTransport>(
    () => ({
      // The Convex product id type is branded. The id comes from a product the app already loaded, and the backend
      // validates it as a product id before any work.
      chat: (args) =>
        chatAction({
          ...args,
          productId: args.productId === undefined ? undefined : (args.productId as Id<'products'>),
        }),
      getRecommendations: ({ cartProductIds, ...args }) =>
        recommendationsAction({
          ...args,
          ...(cartProductIds === undefined ? {} : { cartProductIds: cartProductIds.map((id) => id as Id<'products'>) }),
        }),
      similarProducts: (args) => similarAction({ ...args, productId: args.productId as Id<'products'> }),
      visualSearch: (args) => visualAction(args),
      moderateListing: (args) => moderateAction({ ...args, productId: args.productId as Id<'products'> }),
    }),
    [chatAction, recommendationsAction, similarAction, visualAction, moderateAction],
  );

  // The dispute id is a branded id from a dispute the screen already loaded. The backend validates it before any work.
  const disputeTransport = useMemo<DisputeTransport>(
    () => ({
      rephraseMessage: (args) => rephraseAction({ ...args, disputeId: args.disputeId as Id<'disputes'> }),
      suggestResponses: (args) => suggestAction({ ...args, disputeId: args.disputeId as Id<'disputes'> }),
      analyzeDispute: (args) => analyzeAction({ ...args, disputeId: args.disputeId as Id<'disputes'> }),
      generateResolutionMessage: (args) => resolutionAction({ ...args, disputeId: args.disputeId as Id<'disputes'> }),
    }),
    [rephraseAction, suggestAction, analyzeAction, resolutionAction],
  );

  // The consent, session, and account checks. Both groups of calls share them, so neither can skip a check.
  const gate = useMemo<AiGateDeps>(
    () => ({
      hasConsent: (consentSubject) => hasAIConsent(consentSubject),
      currentSubject,
      guestSessionId: () => getOrCreateGuestSessionId(guestSessionStore, () => Crypto.randomUUID()),
    }),
    [currentSubject],
  );

  const requests = useMemo<AiRequests>(() => createAiRequests({ ...gate, transport }), [gate, transport]);
  const disputeRequests = useMemo<DisputeRequests>(
    () => createDisputeRequests({ ...gate, transport: disputeTransport }),
    [gate, disputeTransport],
  );

  // Each action is bound to the subject active when this object was created. A callback kept from before a switch refuses
  // to run, so it never checks consent, reads a session, or sends a draft as the new account. `isCurrent` tells a screen
  // whether its continuation after an await still belongs to the active account.
  return useMemo<AiActions>(() => {
    const bound = <Args extends unknown[], Result>(action: (...args: Args) => Promise<Result>) =>
      bindToSubject(active, () => currentSubject(), action);

    return {
      subject,
      isCurrent: () => currentSubject().generation === active.generation,
      chat: bound(async (input: ChatInput) => adaptChat(await requests.chat(input))),
      getRecommendations: bound(async (input: { limit?: number; cartProductIds?: string[] }) =>
        adaptRecommendations(await requests.getRecommendations(input)),
      ),
      getSimilarProducts: bound(async (input: { productId: string; limit?: number }) =>
        adaptSimilarProducts(await requests.similarProducts(input)),
      ),
      visualSearch: bound(async (input: { imageDataUrl: string }) =>
        adaptVisualSearch(await requests.visualSearch(input)),
      ),
      moderateListing: bound(async (input: { productId: string }) =>
        adaptModerateListing(await requests.moderateListing(input)),
      ),
      rephraseMessage: bound(async (input: { disputeId: string; message: string }) =>
        adaptRephrase(await disputeRequests.rephraseMessage(input), input.message),
      ),
      suggestResponses: bound(async (input: { disputeId: string }) =>
        adaptSuggestions(await disputeRequests.suggestResponses(input)),
      ),
      analyzeDispute: bound(async (input: { disputeId: string }) =>
        adaptDisputeAnalysis(await disputeRequests.analyzeDispute(input)),
      ),
      generateResolutionMessage: bound(
        async (input: { disputeId: string; resolutionType: DisputeResolutionType; refundAmount?: number }) =>
          adaptResolutionMessage(await disputeRequests.generateResolutionMessage(input)),
      ),
    };
  }, [active, currentSubject, requests, disputeRequests, subject]);
}
