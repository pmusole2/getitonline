// User-facing copy for every AI request outcome. Each refusal code has copy, and the record type makes a missing code a
// compile error. The copy says what happened and never claims an AI success.
import { AiRequestError, type AiRequestCode } from "./aiRequests";

export const AI_REFUSAL_COPY: Record<AiRequestCode, string> = {
  consent_required:
    "AI features are off until you allow Gettitonline to send this to OpenAI. Nothing was sent.",
  session_required:
    "Pinkie could not start a guest session on this device. Try again.",
  account_required: "Sign in to use this AI feature.",
  account_unavailable:
    "Your account cannot use AI features right now. Contact support if this continues.",
  rate_limited: "AI usage limit reached for now. Try again later.",
  invalid_request: "That request could not be sent. Check it and try again.",
  product_unavailable: "This product is no longer available for suggestions.",
  forbidden: "Only reviewers and admins can run AI moderation.",
  not_found: "This listing could not be found. It may have been removed.",
  stale:
    "The listing changed while AI moderation ran. Run AI moderation again.",
  invalid_output: "The AI result could not be used. Nothing was saved.",
  too_long: "Your draft is too long to rephrase. Shorten it and try again.",
  unavailable: "AI is unavailable right now. Try again later.",
  account_changed:
    "Your account changed while this was running. The result was discarded.",
};

// Quotation marks the backend never changes, the same set the server checks, after full-width forms are folded. A draft
// with one of these is held as written, so a reply that names quotation marks is always true.
const QUOTATION_MARKS = /["“”„‟«»‹›`「」『』‘‚‛]/u;

export function hasQuotationMark(draft: string): boolean {
  return QUOTATION_MARKS.test(draft.normalize("NFKC"));
}

// The message a screen shows for a failed AI request. A discarded result returns null, so the screen shows nothing.
// Anything that is not a typed request error gets the generic copy, and its own message is never shown.
export function aiFailureMessage(error: unknown): string | null {
  if (error instanceof AiRequestError) {
    return error.code === "account_changed"
      ? null
      : AI_REFUSAL_COPY[error.code];
  }
  return AI_REFUSAL_COPY.unavailable;
}
