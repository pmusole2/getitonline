"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type AiConsentFeature = "image_search" | "listing_moderation";

const AI_PRIVACY_POLICY_URL =
  "https://www.gettitonline.com/getitonline-privacy-policy/";

// What each feature sends to the AI provider. The shared parts say who receives it, how long it is kept, and what not to submit.
const DISCLOSURES: Record<
  AiConsentFeature,
  { title: string; data: string; purpose: string }
> = {
  image_search: {
    title: "Send this photo to AI for search?",
    data: "The photo you choose is sent to the AI provider.",
    purpose: "OpenAI reads the photo to suggest search words.",
  },
  listing_moderation: {
    title: "Send this listing to AI for review?",
    data: "The stored title, description, price, quantity, and category of this listing are sent to the AI provider.",
    purpose:
      "OpenAI checks the listing and returns an advisory result, which is saved for review.",
  },
};

interface AiConsentDialogProps {
  open: boolean;
  feature: AiConsentFeature;
  onAccept: () => void;
  onDecline: () => void;
}

export function AiConsentDialog({
  open,
  feature,
  onAccept,
  onDecline,
}: AiConsentDialogProps) {
  const disclosure = DISCLOSURES[feature];

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onDecline();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{disclosure.title}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>Recipient: OpenAI, LLC via the Gettitonline backend.</p>
              <p>{disclosure.data}</p>
              <p>{disclosure.purpose}</p>
              <p>
                OpenAI API inputs and outputs are not used for model training by
                default and may be retained for abuse monitoring for up to 30
                days.
              </p>
              <p>
                This processing may occur outside Zambia. Do not submit
                passwords, payment card numbers, or government identifiers.
              </p>
              <p>
                You can decline and keep using the rest of the site without AI
                features.{" "}
                <a
                  href={AI_PRIVACY_POLICY_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Privacy policy
                </a>
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onDecline}>
            Not now
          </Button>
          <Button onClick={onAccept}>Allow</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
