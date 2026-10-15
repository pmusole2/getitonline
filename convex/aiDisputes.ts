import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { admitCaller, reserveCall, type GateRefusalCode } from "./lib/aiGate";
import {
  DISPUTE_LIMITS,
  DISPUTE_MODEL_SETTINGS,
  analysisResult,
  buildAnalysisMessages,
  buildObjectiveAnalysisMessages,
  buildRephraseMessages,
  buildResolutionMessages,
  buildSuggestionMessages,
  escapedLength,
  objectiveAnalysisResult,
  parseAnalysisOutput,
  parseObjectiveAnalysisOutput,
  parseRephraseOutput,
  parseResolutionOutput,
  parseSuggestionOutput,
  passThroughReason,
  type AnalysisResult,
  type ConversationContext,
  type DisputeFailure,
  type DisputeRefusalCode,
  type DraftResolution,
  type RephraseResult,
  type ResolutionResult,
  type SuggestResult,
} from "./lib/aiDisputePolicy";
import { callChatModel, describeAiConfiguration, type AiEnv, type AiFetch, type AiMessage } from "./lib/aiProvider";
import type { ConversationRead } from "./aiDisputesData";

// Pinkie's dispute actions: rephrase a draft, suggest replies, analyze a dispute, and draft a resolution message. Order of
// operations is fixed: validate input, require current consent, resolve the account from identity, read the dispute
// through an internal query that applies the access rules, decide any no-model result, reserve usage, call the model, then
// validate the output. Every refusal happens before a reservation, and every reservation before a provider call. A
// participant's analysis is personalized and returned to that caller only. A reviewer's analysis is objective, and it is
// the only analysis stored, through an internal mutation. Failures return a typed result, never a made-up answer.

export type DisputeDeps = {
  env: () => AiEnv;
  fetchImpl?: AiFetch;
  timeoutMs?: number;
};

type Caller = { kind: "account"; userId: Id<"users"> };
type Admission = { ok: true; caller: Caller } | DisputeFailure;
type DisputeActionCtx = Pick<ActionCtx, "auth" | "runQuery" | "runMutation">;

// Dispute actions require an account. The session code can only come from a guest path, so it maps to account_required.
function refusalOf(code: GateRefusalCode): DisputeRefusalCode {
  return code === "session_required" ? "account_required" : code;
}

function refuse(code: DisputeRefusalCode): DisputeFailure {
  return { ok: false, code };
}

async function admitAccount(ctx: DisputeActionCtx, consentVersion: number | undefined): Promise<Admission> {
  const admission = await admitCaller(ctx, { consentVersion, sessionId: undefined, requireAccount: true });
  if (!admission.ok) {
    return refuse(refusalOf(admission.code));
  }
  if (admission.caller.kind !== "account") {
    return refuse("account_required");
  }
  return { ok: true, caller: { kind: "account", userId: admission.caller.userId } };
}

// Reserves one call. A refused reservation changes nothing and returns its refusal.
async function reserve(ctx: DisputeActionCtx, caller: Caller): Promise<DisputeFailure | null> {
  const refusal = await reserveCall(ctx, caller);
  return refusal === null ? null : refuse(refusalOf(refusal));
}

// A failed read is logged by its safe label only, because its error text can carry query data.
async function readOrNull<T>(label: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    console.error(`[ai] ${label} failed`);
    return null;
  }
}

async function askModel(
  messages: AiMessage[],
  settings: { maxTokens: number; temperature: number },
  deps: DisputeDeps
): Promise<string | null> {
  const outcome = await callChatModel({
    messages,
    jsonMode: true,
    maxTokens: settings.maxTokens,
    temperature: settings.temperature,
    env: deps.env(),
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
  });
  return outcome.ok ? outcome.text : null;
}

const disputeArgs = {
  disputeId: v.id("disputes"),
  consentVersion: v.optional(v.number()),
};

const rephraseArgs = {
  ...disputeArgs,
  message: v.string(),
};

const resolutionArgs = {
  ...disputeArgs,
  resolutionType: v.union(v.literal("full_refund"), v.literal("partial_refund"), v.literal("no_refund")),
  refundAmount: v.optional(v.number()),
};

function conversationOf(read: Extract<ConversationRead, { ok: true }>): ConversationContext {
  return {
    side: read.side,
    title: read.title,
    description: read.description,
    category: read.category,
    productTitle: read.productTitle,
    orderAmount: read.orderAmount,
    orderCreatedAt: read.orderCreatedAt,
    evidenceCount: read.evidenceCount,
    messages: read.messages,
  };
}

async function readRephrase(ctx: DisputeActionCtx, userId: Id<"users">, disputeId: Id<"disputes">) {
  return await readOrNull("dispute read", () =>
    ctx.runQuery(internal.aiDisputesData.disputeForRephrase, { userId, disputeId })
  );
}

async function readConversation(ctx: DisputeActionCtx, userId: Id<"users">, disputeId: Id<"disputes">) {
  return await readOrNull("dispute read", () =>
    ctx.runQuery(internal.aiDisputesData.disputeConversation, { userId, disputeId })
  );
}

async function readResolution(ctx: DisputeActionCtx, userId: Id<"users">, disputeId: Id<"disputes">) {
  return await readOrNull("dispute read", () =>
    ctx.runQuery(internal.aiDisputesData.disputeForResolution, { userId, disputeId })
  );
}

async function runRephrase(
  ctx: DisputeActionCtx,
  args: { disputeId: Id<"disputes">; message: string; consentVersion?: number },
  deps: DisputeDeps
): Promise<RephraseResult> {
  const message = args.message.trim();
  if (message === "") {
    return refuse("invalid_request");
  }
  // Both checks are on the raw draft, before escaping, and refuse rather than cut.
  if (message.length > DISPUTE_LIMITS.rephraseLength || escapedLength(message) > DISPUTE_LIMITS.escapedDataLength) {
    return refuse("too_long");
  }

  const admission = await admitAccount(ctx, args.consentVersion);
  if (!admission.ok) {
    return admission;
  }
  const read = await readRephrase(ctx, admission.caller.userId, args.disputeId);
  if (read === null) {
    return refuse("unavailable");
  }
  if (!read.ok) {
    return refuse(read.code);
  }

  // A draft with quotation marks, a draft that asks who the assistant is, or a short draft is passed through unchanged, with no
  // model call and no reservation. The reason codes are documented in passThroughReason.
  // "unchanged" promises byte-identical text, so the caller's original string is returned, not the trimmed copy.
  if (passThroughReason(message) !== null) {
    return { ok: true, source: "unchanged", rephrased: args.message };
  }
  if (!describeAiConfiguration(deps.env()).configured) {
    return refuse("unavailable");
  }
  const reserved = await reserve(ctx, admission.caller);
  if (reserved !== null) {
    return reserved;
  }

  const text = await askModel(
    buildRephraseMessages({
      context: { side: read.side, title: read.title, description: read.description },
      message,
    }),
    DISPUTE_MODEL_SETTINGS.rephrase,
    deps
  );
  const rephrased = text === null ? null : parseRephraseOutput(text, message);
  return rephrased === null ? refuse("unavailable") : { ok: true, source: "ai", rephrased };
}

async function runSuggest(
  ctx: DisputeActionCtx,
  args: { disputeId: Id<"disputes">; consentVersion?: number },
  deps: DisputeDeps
): Promise<SuggestResult> {
  const admission = await admitAccount(ctx, args.consentVersion);
  if (!admission.ok) {
    return admission;
  }
  const read = await readConversation(ctx, admission.caller.userId, args.disputeId);
  if (read === null) {
    return refuse("unavailable");
  }
  if (!read.ok) {
    return refuse(read.code);
  }
  if (!describeAiConfiguration(deps.env()).configured) {
    return refuse("unavailable");
  }
  const reserved = await reserve(ctx, admission.caller);
  if (reserved !== null) {
    return reserved;
  }

  const context = conversationOf(read);
  const text = await askModel(buildSuggestionMessages({ context }), DISPUTE_MODEL_SETTINGS.suggest, deps);
  // Suggestions have no caller draft, so no assistant mention is allowed in them.
  const suggestions = text === null ? null : parseSuggestionOutput(text, read.side, "");
  return suggestions === null ? refuse("unavailable") : { ok: true, source: "ai", suggestions };
}

async function runAnalyze(
  ctx: DisputeActionCtx,
  args: { disputeId: Id<"disputes">; consentVersion?: number },
  deps: DisputeDeps
): Promise<AnalysisResult> {
  const admission = await admitAccount(ctx, args.consentVersion);
  if (!admission.ok) {
    return admission;
  }
  const read = await readConversation(ctx, admission.caller.userId, args.disputeId);
  if (read === null) {
    return refuse("unavailable");
  }
  if (!read.ok) {
    return refuse(read.code);
  }
  if (!describeAiConfiguration(deps.env()).configured) {
    return refuse("unavailable");
  }
  const reserved = await reserve(ctx, admission.caller);
  if (reserved !== null) {
    return reserved;
  }

  const context = conversationOf(read);
  if (read.reviewer) {
    return await analyzeAsReviewer(ctx, { userId: admission.caller.userId, disputeId: args.disputeId }, context, deps);
  }

  // A participant gets the analysis written for their side. It is returned to them and never stored.
  const text = await askModel(buildAnalysisMessages({ context }), DISPUTE_MODEL_SETTINGS.analyze, deps);
  const output = text === null ? null : parseAnalysisOutput(text);
  return output === null ? refuse("unavailable") : { ok: true, source: "ai", ...analysisResult(output, read.side) };
}

// A reviewer gets an objective, third-person analysis. It is the only analysis stored, once, through the internal write that
// rechecks the reviewer and the dispute.
async function analyzeAsReviewer(
  ctx: DisputeActionCtx,
  target: { userId: Id<"users">; disputeId: Id<"disputes"> },
  context: ConversationContext,
  deps: DisputeDeps
): Promise<AnalysisResult> {
  const text = await askModel(buildObjectiveAnalysisMessages({ context }), DISPUTE_MODEL_SETTINGS.analyze, deps);
  const output = text === null ? null : parseObjectiveAnalysisOutput(text);
  if (output === null) {
    return refuse("unavailable");
  }

  let saved: boolean;
  try {
    saved = await ctx.runMutation(internal.aiDisputesData.persistAnalysis, {
      userId: target.userId,
      disputeId: target.disputeId,
      aiSummary: output.summary,
      aiSuggestions: output.suggestedResolutions.map((resolution) => resolution.description),
    });
  } catch {
    console.error("[ai] dispute save failed");
    return refuse("unavailable");
  }
  if (!saved) {
    return refuse("not_found");
  }
  return { ok: true, source: "ai", ...objectiveAnalysisResult(output) };
}

// The refund rules are checked before any read, and the amount against the order after it.
function refundInputIsValid(resolution: DraftResolution, refundAmount: number | undefined): boolean {
  if (resolution !== "partial_refund") {
    return true;
  }
  return refundAmount !== undefined && Number.isFinite(refundAmount) && refundAmount > 0;
}

async function runResolution(
  ctx: DisputeActionCtx,
  args: { disputeId: Id<"disputes">; resolutionType: DraftResolution; refundAmount?: number; consentVersion?: number },
  deps: DisputeDeps
): Promise<ResolutionResult> {
  if (!refundInputIsValid(args.resolutionType, args.refundAmount)) {
    return refuse("invalid_request");
  }

  const admission = await admitAccount(ctx, args.consentVersion);
  if (!admission.ok) {
    return admission;
  }
  const read = await readResolution(ctx, admission.caller.userId, args.disputeId);
  if (read === null) {
    return refuse("unavailable");
  }
  if (!read.ok) {
    return refuse(read.code);
  }
  if (
    args.resolutionType === "partial_refund" &&
    (read.orderAmount === null || (args.refundAmount ?? 0) > read.orderAmount)
  ) {
    return refuse("invalid_request");
  }
  if (!describeAiConfiguration(deps.env()).configured) {
    return refuse("unavailable");
  }
  const reserved = await reserve(ctx, admission.caller);
  if (reserved !== null) {
    return reserved;
  }

  const context = {
    title: read.title,
    category: read.category,
    productTitle: read.productTitle,
    orderAmount: read.orderAmount,
  };
  const text = await askModel(
    buildResolutionMessages({ context, resolutionType: args.resolutionType, refundAmount: args.refundAmount }),
    DISPUTE_MODEL_SETTINGS.resolution,
    deps
  );
  const message = text === null ? null : parseResolutionOutput(text);
  return message === null ? refuse("unavailable") : { ok: true, source: "ai", message };
}

/** Builds the rephrase action with its dependencies injected. Production uses `rephraseMessage` below. */
export function createRephraseMessageAction(deps: DisputeDeps) {
  return action({
    args: rephraseArgs,
    handler: async (ctx, args): Promise<RephraseResult> => await runRephrase(ctx, args, deps),
  });
}

export function createSuggestResponsesAction(deps: DisputeDeps) {
  return action({
    args: disputeArgs,
    handler: async (ctx, args): Promise<SuggestResult> => await runSuggest(ctx, args, deps),
  });
}

export function createAnalyzeDisputeAction(deps: DisputeDeps) {
  return action({
    args: disputeArgs,
    handler: async (ctx, args): Promise<AnalysisResult> => await runAnalyze(ctx, args, deps),
  });
}

export function createGenerateResolutionMessageAction(deps: DisputeDeps) {
  return action({
    args: resolutionArgs,
    handler: async (ctx, args): Promise<ResolutionResult> => await runResolution(ctx, args, deps),
  });
}

export const rephraseMessage = createRephraseMessageAction({ env: () => process.env });
export const suggestResponses = createSuggestResponsesAction({ env: () => process.env });
export const analyzeDispute = createAnalyzeDisputeAction({ env: () => process.env });
export const generateResolutionMessage = createGenerateResolutionMessageAction({ env: () => process.env });
