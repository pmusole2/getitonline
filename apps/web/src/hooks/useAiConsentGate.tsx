"use client";

import { useCallback, useState } from "react";
import type { AiSubject } from "@gettitonline/shared";
import {
  AiConsentDialog,
  type AiConsentFeature,
} from "@/components/ai/AiConsentDialog";
import {
  acceptAiConsent,
  browserStore,
  decideAiConsent,
} from "./aiConsentGate";

interface PendingAction {
  readonly feature: AiConsentFeature;
  readonly subject: AiSubject;
  readonly run: () => Promise<void>;
  readonly onDecline: () => void;
}

// Runs an AI action only after consent is current for the subject that started it. Without consent, the disclosure opens
// first, and the action runs only if the person allows it. Declining runs nothing.
export function useAiConsentGate(subject: AiSubject) {
  const [pending, setPending] = useState<PendingAction | null>(null);

  const runWithConsent = useCallback(
    async (
      feature: AiConsentFeature,
      run: () => Promise<void>,
      onDecline: () => void,
    ): Promise<void> => {
      if ((await decideAiConsent(browserStore, subject)) === "allowed") {
        await run();
        return;
      }
      setPending({ feature, subject, run, onDecline });
    },
    [subject],
  );

  const accept = async () => {
    const current = pending;
    setPending(null);
    if (current === null) return;
    await acceptAiConsent(browserStore, current.subject);
    await current.run();
  };

  const decline = () => {
    const current = pending;
    setPending(null);
    current?.onDecline();
  };

  const consentDialog = (
    <AiConsentDialog
      open={pending !== null}
      feature={pending?.feature ?? "image_search"}
      onAccept={() => {
        // The action reports its own failures. This only keeps the discarded promise from rejecting.
        accept().catch(() => undefined);
      }}
      onDecline={decline}
    />
  );

  return { runWithConsent, consentDialog };
}
