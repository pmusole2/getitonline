// Parsers for the results of Pinkie's Convex actions. Every result arrives as `unknown`, and each parser checks the
// full shape before returning a typed value. A refusal with a known code is returned as a value; anything else that
// does not match the contract throws AiResultError, so a caller can show the unavailable state and never use a
// partly-valid result.

export const AI_REFUSAL_CODES = [
  "account_required",
  "account_unavailable",
  "consent_required",
  "forbidden",
  "invalid_output",
  "invalid_request",
  "not_found",
  "product_unavailable",
  "rate_limited",
  "session_required",
  "stale",
  "too_long",
  "unavailable",
] as const;

export type AiRefusalCode = (typeof AI_REFUSAL_CODES)[number];
export type AiRefusal = { ok: false; code: AiRefusalCode };

export class AiResultError extends Error {
  constructor() {
    super("AI result has an unexpected shape");
    this.name = "AiResultError";
  }
}

const CHAT_SOURCES = ["ai", "fallback", "identity"] as const;
const DISCOVERY_SOURCES = ["ai", "fallback"] as const;
const MODERATION_SOURCES = ["ai", "fallback"] as const;
const MODERATION_AI_STATUSES = ["clear", "flagged"] as const;
const REPHRASE_SOURCES = ["ai", "unchanged"] as const;
const DISPUTE_AI_SOURCES = ["ai"] as const;
export const SENTIMENTS = [
  "cooperative",
  "frustrated",
  "hostile",
  "neutral",
] as const;
const RISK_LEVELS = ["low", "medium", "high"] as const;
const RESOLUTION_KINDS = [
  "full_refund",
  "partial_refund",
  "no_refund",
  "replacement",
  "mutual_agreement",
] as const;
// 'moderator' is the reviewer view: the server returns it for an admin or moderator, never for a buyer or seller.
const DISPUTE_VIEWER_ROLES = ["buyer", "seller", "moderator"] as const;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export type ChatAction =
  | { type: "navigate"; label: string; payload: { screen: string } }
  | { type: "search"; label: string; payload: { query: string } };

export type ChatResult =
  | {
      ok: true;
      source: (typeof CHAT_SOURCES)[number];
      reply: string;
      actions: ChatAction[];
    }
  | AiRefusal;

export type RecommendationsResult =
  | {
      ok: true;
      source: (typeof DISCOVERY_SOURCES)[number];
      productIds: string[];
      reasoning: string;
    }
  | AiRefusal;

export type SimilarProductsResult =
  | {
      ok: true;
      source: (typeof DISCOVERY_SOURCES)[number];
      productIds: string[];
    }
  | AiRefusal;

export type VisualSearchResult =
  | {
      ok: true;
      source: (typeof DISCOVERY_SOURCES)[number];
      query: string;
      terms: string[];
    }
  | AiRefusal;

// A fallback is never saved. Its status is 'error', so it cannot be mistaken for a moderation decision.
export type ModerationResult =
  | {
      ok: true;
      source: "ai";
      saved: true;
      revision: number;
      status: (typeof MODERATION_AI_STATUSES)[number];
      summary: string;
      flags: string[];
    }
  | {
      ok: true;
      source: "fallback";
      saved: false;
      revision: number;
      status: "error";
      summary: string;
      flags: string[];
    }
  | AiRefusal;

// The success shape of each result, for callers that have already handled refusals.
export type ChatReply = Exclude<ChatResult, AiRefusal>;
export type RecommendationsReply = Exclude<RecommendationsResult, AiRefusal>;
export type SimilarProductsReply = Exclude<SimilarProductsResult, AiRefusal>;
export type VisualSearchReply = Exclude<VisualSearchResult, AiRefusal>;
export type ModerationReply = Exclude<ModerationResult, AiRefusal>;

type Record_ = Record<string, unknown>;
type Outcome = { ok: true; value: Record_ } | AiRefusal;

function isRecord(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new AiResultError();
  }
  return value;
}

function readString(value: Record_, key: string): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new AiResultError();
  }
  return field;
}

function readStringList(value: unknown): string[] {
  return readArray(value).map((item) => {
    if (typeof item !== "string") {
      throw new AiResultError();
    }
    return item;
  });
}

function readRevision(value: Record_): number {
  const revision = value.revision;
  if (
    typeof revision !== "number" ||
    !Number.isInteger(revision) ||
    revision < 0
  ) {
    throw new AiResultError();
  }
  return revision;
}

function readOneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  const match = allowed.find((item) => item === value);
  if (match === undefined) {
    throw new AiResultError();
  }
  return match;
}

function readOutcome(raw: unknown): Outcome {
  if (!isRecord(raw) || typeof raw.ok !== "boolean") {
    throw new AiResultError();
  }
  if (raw.ok) {
    return { ok: true, value: raw };
  }
  const code = AI_REFUSAL_CODES.find((item) => item === raw.code);
  if (code === undefined) {
    throw new AiResultError();
  }
  return { ok: false, code };
}

function readChatAction(raw: unknown): ChatAction {
  if (!isRecord(raw)) {
    throw new AiResultError();
  }
  const label = readString(raw, "label");
  const payload = raw.payload;
  if (!isRecord(payload)) {
    throw new AiResultError();
  }
  if (raw.type === "navigate") {
    return {
      type: "navigate",
      label,
      payload: { screen: readString(payload, "screen") },
    };
  }
  if (raw.type === "search") {
    return {
      type: "search",
      label,
      payload: { query: readString(payload, "query") },
    };
  }
  throw new AiResultError();
}

export function parseChatResult(raw: unknown): ChatResult {
  const outcome = readOutcome(raw);
  if (!outcome.ok) {
    return outcome;
  }
  const { value } = outcome;
  return {
    ok: true,
    source: readOneOf(value.source, CHAT_SOURCES),
    reply: readString(value, "reply"),
    actions: readArray(value.actions).map(readChatAction),
  };
}

export function parseRecommendationsResult(
  raw: unknown,
): RecommendationsResult {
  const outcome = readOutcome(raw);
  if (!outcome.ok) {
    return outcome;
  }
  const { value } = outcome;
  return {
    ok: true,
    source: readOneOf(value.source, DISCOVERY_SOURCES),
    productIds: readStringList(value.productIds),
    reasoning: readString(value, "reasoning"),
  };
}

export function parseSimilarProductsResult(
  raw: unknown,
): SimilarProductsResult {
  const outcome = readOutcome(raw);
  if (!outcome.ok) {
    return outcome;
  }
  const { value } = outcome;
  return {
    ok: true,
    source: readOneOf(value.source, DISCOVERY_SOURCES),
    productIds: readStringList(value.productIds),
  };
}

export function parseVisualSearchResult(raw: unknown): VisualSearchResult {
  const outcome = readOutcome(raw);
  if (!outcome.ok) {
    return outcome;
  }
  const { value } = outcome;
  return {
    ok: true,
    source: readOneOf(value.source, DISCOVERY_SOURCES),
    query: readString(value, "query"),
    terms: readStringList(value.terms),
  };
}

export type Sentiment = (typeof SENTIMENTS)[number];

// A draft that is not changed is returned as 'unchanged' with the same text, so the caller keeps what the user wrote.
export type RephraseResult =
  | { ok: true; source: (typeof REPHRASE_SOURCES)[number]; rephrased: string }
  | AiRefusal;

export type SuggestionsResult =
  | { ok: true; source: "ai"; suggestions: string[] }
  | AiRefusal;

export type ResolutionMessageResult =
  | { ok: true; source: "ai"; message: string }
  | AiRefusal;

export interface DisputeSuggestedResolution {
  type: (typeof RESOLUTION_KINDS)[number];
  description: string;
  fairnessScore: number;
}

// The shape the server returns. A participant's keyPoints.yourClaims and theirClaims are personalized, and the
// sentiment yours and theirs follow the viewer. A reviewer's result has empty yourClaims and theirClaims, and the
// buyer and seller fields hold the objective analysis for each side.
export type DisputeAnalysisResult =
  | {
      ok: true;
      source: "ai";
      summary: string;
      keyPoints: {
        yourClaims: string[];
        theirClaims: string[];
        buyerClaims: string[];
        sellerClaims: string[];
      };
      sentiment: {
        yours: Sentiment;
        theirs: Sentiment;
        buyer: Sentiment;
        seller: Sentiment;
      };
      suggestedResolutions: DisputeSuggestedResolution[];
      recommendedAction: string;
      riskLevel: (typeof RISK_LEVELS)[number];
      additionalNotes: string;
      viewerRole: (typeof DISPUTE_VIEWER_ROLES)[number];
    }
  | AiRefusal;

export type RephraseReply = Exclude<RephraseResult, AiRefusal>;
export type SuggestionsReply = Exclude<SuggestionsResult, AiRefusal>;
export type ResolutionMessageReply = Exclude<
  ResolutionMessageResult,
  AiRefusal
>;
export type DisputeAnalysisReply = Exclude<DisputeAnalysisResult, AiRefusal>;

export function parseModerationResult(raw: unknown): ModerationResult {
  const outcome = readOutcome(raw);
  if (!outcome.ok) {
    return outcome;
  }
  const { value } = outcome;
  const source = readOneOf(value.source, MODERATION_SOURCES);
  const revision = readRevision(value);
  const summary = readString(value, "summary");
  const flags = readStringList(value.flags);

  if (source === "fallback") {
    if (value.saved !== false || value.status !== "error") {
      throw new AiResultError();
    }
    return {
      ok: true,
      source,
      saved: false,
      revision,
      status: "error",
      summary,
      flags,
    };
  }

  if (value.saved !== true) {
    throw new AiResultError();
  }
  return {
    ok: true,
    source,
    saved: true,
    revision,
    status: readOneOf(value.status, MODERATION_AI_STATUSES),
    summary,
    flags,
  };
}

function readNumber(value: Record_, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new AiResultError();
  }
  return field;
}

function readRecord(value: Record_, key: string): Record_ {
  const field = value[key];
  if (!isRecord(field)) {
    throw new AiResultError();
  }
  return field;
}

function readSuggestedResolution(raw: unknown): DisputeSuggestedResolution {
  if (!isRecord(raw)) {
    throw new AiResultError();
  }
  return {
    type: readOneOf(raw.type, RESOLUTION_KINDS),
    description: readString(raw, "description"),
    fairnessScore: readNumber(raw, "fairnessScore"),
  };
}

export function parseRephraseResult(raw: unknown): RephraseResult {
  const outcome = readOutcome(raw);
  if (!outcome.ok) {
    return outcome;
  }
  const { value } = outcome;
  return {
    ok: true,
    source: readOneOf(value.source, REPHRASE_SOURCES),
    rephrased: readString(value, "rephrased"),
  };
}

export function parseSuggestionsResult(raw: unknown): SuggestionsResult {
  const outcome = readOutcome(raw);
  if (!outcome.ok) {
    return outcome;
  }
  const { value } = outcome;
  return {
    ok: true,
    source: readOneOf(value.source, DISPUTE_AI_SOURCES),
    suggestions: readStringList(value.suggestions),
  };
}

export function parseDisputeAnalysisResult(
  raw: unknown,
): DisputeAnalysisResult {
  const outcome = readOutcome(raw);
  if (!outcome.ok) {
    return outcome;
  }
  const { value } = outcome;
  const keyPoints = readRecord(value, "keyPoints");
  const sentiment = readRecord(value, "sentiment");
  return {
    ok: true,
    source: readOneOf(value.source, DISPUTE_AI_SOURCES),
    summary: readString(value, "summary"),
    keyPoints: {
      yourClaims: readStringList(keyPoints.yourClaims),
      theirClaims: readStringList(keyPoints.theirClaims),
      buyerClaims: readStringList(keyPoints.buyerClaims),
      sellerClaims: readStringList(keyPoints.sellerClaims),
    },
    sentiment: {
      yours: readOneOf(sentiment.yours, SENTIMENTS),
      theirs: readOneOf(sentiment.theirs, SENTIMENTS),
      buyer: readOneOf(sentiment.buyer, SENTIMENTS),
      seller: readOneOf(sentiment.seller, SENTIMENTS),
    },
    suggestedResolutions: readArray(value.suggestedResolutions).map(
      readSuggestedResolution,
    ),
    recommendedAction: readString(value, "recommendedAction"),
    riskLevel: readOneOf(value.riskLevel, RISK_LEVELS),
    additionalNotes: readString(value, "additionalNotes"),
    viewerRole: readOneOf(value.viewerRole, DISPUTE_VIEWER_ROLES),
  };
}

export function parseResolutionResult(raw: unknown): ResolutionMessageResult {
  const outcome = readOutcome(raw);
  if (!outcome.ok) {
    return outcome;
  }
  const { value } = outcome;
  return {
    ok: true,
    source: readOneOf(value.source, DISPUTE_AI_SOURCES),
    message: readString(value, "message"),
  };
}
