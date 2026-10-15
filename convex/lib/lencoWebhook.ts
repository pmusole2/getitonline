import { v, type Infer } from "convex/values";
import { decodeLencoWebhookReceipt, isValidProviderId, isValidReference, type JsonValue } from "./lencoAdapter";
import type { ProviderReceiptFacts } from "./providerOperationContracts";

export const webhookEventKindValidator = v.union(
  v.literal("collection_successful"),
  v.literal("collection_failed"),
  v.literal("transfer_successful"),
  v.literal("transfer_failed"),
  v.literal("collection_settled"),
  v.literal("unknown")
);

export const webhookClassificationValidator = v.union(
  v.literal("terminal"),
  v.literal("lookup_required"),
  v.literal("enrichment"),
  v.literal("malformed"),
  v.literal("unhandled"),
  v.literal("review"),
  v.literal("unmapped"),
  v.literal("ambiguous"),
  v.literal("unsupported")
);

export const webhookResultValidator = v.union(
  v.literal("pending"),
  v.literal("applied"),
  v.literal("review"),
  v.literal("unsupported")
);

export type WebhookEventKind = Infer<typeof webhookEventKindValidator>;
export type WebhookClassification = Infer<typeof webhookClassificationValidator>;

// Selectors/receipt exist only during verified processing, never in the inbox.
export type NormalizedWebhook = {
  eventKind: WebhookEventKind;
  classification: WebhookClassification;
  reference?: string;
  providerId?: string;
  receipt?: ProviderReceiptFacts;
};

function object(value: JsonValue | undefined): { [key: string]: JsonValue } | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function eventKind(value: JsonValue | undefined): WebhookEventKind {
  switch (value) {
    case "collection.successful":
      return "collection_successful";
    case "collection.failed":
      return "collection_failed";
    case "transfer.successful":
      return "transfer_successful";
    case "transfer.failed":
      return "transfer_failed";
    case "collection.settled":
      return "collection_settled";
    default:
      return "unknown";
  }
}

/** Must only be called AFTER exact-byte HMAC verification. No raw/error text escapes. */
export function normalizeVerifiedWebhook(raw: Uint8Array): NormalizedWebhook {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return { eventKind: "unknown", classification: "malformed" };
  }
  const envelope = object(parsed);
  if (envelope === null || typeof envelope.event !== "string") {
    return { eventKind: "unknown", classification: "malformed" };
  }
  const kind = eventKind(envelope.event);
  if (kind === "unknown") {
    return { eventKind: kind, classification: "unhandled" };
  }
  const data = object(envelope.data);
  if (data === null) {
    return { eventKind: kind, classification: "malformed" };
  }
  const base = {
    eventKind: kind,
    ...(typeof data.reference === "string" && isValidReference(data.reference) ? { reference: data.reference } : {}),
    ...(typeof data.id === "string" && isValidProviderId(data.id) ? { providerId: data.id } : {}),
  };
  // Card/other collection types have no authority in this migration, including enrichment.
  if (kind.startsWith("collection_") && data.type !== undefined && data.type !== "mobile-money") {
    return { eventKind: kind, classification: "unhandled" };
  }
  if (kind === "collection_settled") {
    return { ...base, classification: "enrichment" };
  }
  const status = kind.endsWith("successful") ? "successful" : "failed";
  if (data.status !== status) {
    return { ...base, classification: "review" };
  }
  const receipt = decodeLencoWebhookReceipt(kind.startsWith("collection_") ? "collection" : "transfer", data);
  if (receipt === null) {
    return { ...base, classification: "lookup_required" };
  }
  return { ...base, classification: "terminal", receipt };
}

export async function verifiedBodyDigest(raw: Uint8Array): Promise<string> {
  const copy = new Uint8Array(raw.length);
  copy.set(raw);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
