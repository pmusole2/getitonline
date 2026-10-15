"use client";

import { useAuth as useClerkAuth } from "@clerk/nextjs";
import { useAction } from "convex/react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  advanceSubjectState,
  aiSubjectFor,
  assertSubjectCurrent,
  createAiRequests,
  getOrCreateGuestSessionId,
  retiredSubjectState,
  type AiRequests,
  type AiSubject,
  type AiSubjectState,
  type AiTransport,
  type ModerationReply,
  type VisualSearchReply,
} from "@gettitonline/shared";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { browserStore, isAiConsentAllowed } from "./aiConsentGate";

// Pinkie's calls from the web go through the Convex actions. The subject is the signed-in Clerk account, or a guest, and
// a result that arrives after the subject changed is discarded. Consent is checked inside each call, for that subject.
export interface WebAiActions {
  readonly subject: AiSubject;
  // False once the active account has changed since these actions were created. A page checks it after each await.
  isCurrent(): boolean;
  visualSearch(input: { imageDataUrl: string }): Promise<VisualSearchReply>;
  moderateListing(input: { productId: string }): Promise<ModerationReply>;
}

export function useAiActions(): WebAiActions {
  const { userId } = useClerkAuth();
  const subject = aiSubjectFor(userId ?? null);

  // The subject state changes during the render that shows the new subject, so everything created from that render
  // belongs to it. The ref that later callbacks read is updated at commit, before an event can reach a callback.
  const [tracked, setTracked] = useState<AiSubjectState>({
    subject,
    generation: 0,
  });
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
    () =>
      liveRef.current
        ? activeRef.current
        : retiredSubjectState(activeRef.current),
    [],
  );

  const chatAction = useAction(api.ai.chat);
  const recommendationsAction = useAction(api.aiDiscovery.getRecommendations);
  const similarAction = useAction(api.aiDiscovery.similarProducts);
  const visualAction = useAction(api.aiDiscovery.visualSearch);
  const moderateAction = useAction(api.aiModeration.moderateListing);

  const transport = useMemo<AiTransport>(
    () => ({
      // The Convex product id type is branded. The id comes from a product already loaded by the page, and the backend
      // validates it as a product id before any work.
      chat: (args) =>
        chatAction({
          ...args,
          productId:
            args.productId === undefined
              ? undefined
              : (args.productId as Id<"products">),
        }),
      getRecommendations: ({ cartProductIds, ...args }) =>
        recommendationsAction({
          ...args,
          ...(cartProductIds === undefined
            ? {}
            : {
                cartProductIds: cartProductIds.map(
                  (id) => id as Id<"products">,
                ),
              }),
        }),
      similarProducts: (args) =>
        similarAction({ ...args, productId: args.productId as Id<"products"> }),
      visualSearch: (args) => visualAction(args),
      moderateListing: (args) =>
        moderateAction({
          ...args,
          productId: args.productId as Id<"products">,
        }),
    }),
    [
      chatAction,
      recommendationsAction,
      similarAction,
      visualAction,
      moderateAction,
    ],
  );

  const requests = useMemo<AiRequests>(
    () =>
      createAiRequests({
        transport,
        // The same decision the consent gate uses, so an acceptance the gate holds for this page session is admitted here too.
        hasConsent: (consentSubject) =>
          isAiConsentAllowed(browserStore, consentSubject),
        currentSubject,
        // The guest id is random and kept in this browser. It is never used as an account id.
        guestSessionId: () =>
          getOrCreateGuestSessionId(browserStore, () => crypto.randomUUID()),
      }),
    [currentSubject, transport],
  );

  // Each action checks, before anything else, that its subject state is still the active one. A callback kept across a
  // switch refuses to run. `isCurrent` tells a page whether its continuation after an await still belongs to the account.
  return useMemo<WebAiActions>(
    () => ({
      subject,
      isCurrent: () => currentSubject().generation === active.generation,
      visualSearch: async (input) => {
        assertSubjectCurrent(active, currentSubject());
        return requests.visualSearch(input);
      },
      moderateListing: async (input) => {
        assertSubjectCurrent(active, currentSubject());
        return requests.moderateListing(input);
      },
    }),
    [active, currentSubject, requests, subject],
  );
}
