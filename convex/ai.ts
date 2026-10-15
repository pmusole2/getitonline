import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { action } from "./_generated/server";
import { hasCurrentAiConsent } from "./lib/aiConsent";
import {
  acceptMessage,
  buildChatMessages,
  capHistory,
  fallbackChatReply,
  identityReply,
  parseModelChatOutput,
  type ChatContext,
  type ChatRefusalCode,
  type ChatResult,
  type ChatTurn,
} from "./lib/aiChatPolicy";
import { isAssistantIdentityQuestion } from "./lib/assistantIdentity";
import { callChatModel, describeAiConfiguration, type AiEnv, type AiFetch } from "./lib/aiProvider";

// Pinkie's chat action. Order of operations is fixed: validate input, answer identity questions with no work, require
// current consent, resolve the caller, check the provider is configured, reserve usage, read minimized context, call the
// model, then validate its output. Every refusal happens before a reservation, and every reservation before a provider call.

export type ChatDeps = {
  env: () => AiEnv;
  fetchImpl?: AiFetch;
  timeoutMs?: number;
};

type ChatArgs = {
  message: string;
  conversationHistory?: ChatTurn[];
  consentVersion?: number;
  sessionId?: string;
  currentScreen?: string;
  productId?: Id<"products">;
};

type ChatActionCtx = Pick<ActionCtx, "auth" | "runQuery" | "runMutation">;

type ResolvedCaller = { kind: "account"; userId: Id<"users"> } | { kind: "guest"; sessionId: string };

type CallerResolution = { ok: true; caller: ResolvedCaller } | { ok: false; code: ChatRefusalCode };

const AI_LIMIT_MESSAGE = "AI usage limit reached";
const INVALID_SESSION_MESSAGE = "Invalid AI session";
const CHAT_MAX_TOKENS = 1000;
const CHAT_TEMPERATURE = 0.7;

const chatArgs = {
  message: v.string(),
  conversationHistory: v.optional(
    v.array(
      v.object({
        role: v.union(v.literal("user"), v.literal("assistant")),
        content: v.string(),
      })
    )
  ),
  consentVersion: v.optional(v.number()),
  sessionId: v.optional(v.string()),
  currentScreen: v.optional(v.string()),
  productId: v.optional(v.id("products")),
};

function refuse(code: ChatRefusalCode): ChatResult {
  return { ok: false, code };
}

function fallback(message: string): ChatResult {
  return { ok: true, source: "fallback", ...fallbackChatReply(message) };
}

// The caller comes only from the verified identity. A signed-in account that is unknown, banned, or deleted is refused
// and never falls through to guest. A guest must send a session ID, and cannot name any account.
async function resolveCaller(ctx: ChatActionCtx, sessionId: string | undefined): Promise<CallerResolution> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity) {
    const account = await ctx.runQuery(internal.aiData.resolveChatAccount, { clerkId: identity.subject });
    return account.ok
      ? { ok: true, caller: { kind: "account", userId: account.userId } }
      : { ok: false, code: "account_unavailable" };
  }
  const guestSession = sessionId?.trim() ?? "";
  return guestSession === ""
    ? { ok: false, code: "session_required" }
    : { ok: true, caller: { kind: "guest", sessionId: guestSession } };
}

// Reserves one call across every bucket. A refused reservation changes nothing and returns its code.
async function reserve(ctx: ChatActionCtx, caller: ResolvedCaller): Promise<ChatRefusalCode | null> {
  try {
    await ctx.runMutation(internal.aiUsage.reserveAiCall, {
      caller:
        caller.kind === "account"
          ? { kind: "account", userId: caller.userId }
          : { kind: "guest", sessionId: caller.sessionId },
    });
    return null;
  } catch (error: unknown) {
    // Convex may wrap the thrown message, so match on the text rather than equality.
    const message = error instanceof Error ? error.message : "";
    if (message.includes(AI_LIMIT_MESSAGE)) {
      return "rate_limited";
    }
    if (message.includes(INVALID_SESSION_MESSAGE)) {
      return "session_required";
    }
    throw error;
  }
}

async function readContext(
  ctx: ChatActionCtx,
  caller: ResolvedCaller,
  args: ChatArgs,
  message: string
): Promise<ChatContext | null> {
  try {
    return await ctx.runQuery(internal.aiData.chatContext, {
      caller: caller.kind === "account" ? { kind: "account", userId: caller.userId } : { kind: "guest" },
      message,
      productId: args.productId,
    });
  } catch {
    // Logs the safe code only; the error text can carry query data.
    console.error("[ai] chat context failed");
    return null;
  }
}

async function runChat(ctx: ChatActionCtx, args: ChatArgs, deps: ChatDeps): Promise<ChatResult> {
  // (a) Validate and cap the input. Blank or over-length messages are refused before any other work.
  const message = acceptMessage(args.message);
  if (message === null) {
    return refuse("invalid_request");
  }

  // (b) Identity questions get Pinkie's introduction with no consent check, reservation, database read, or provider call.
  if (isAssistantIdentityQuestion(message)) {
    return { ok: true, source: "identity", ...identityReply() };
  }

  // (c) Consent is a prerequisite for provider calls, not authentication.
  if (!hasCurrentAiConsent(args.consentVersion)) {
    return refuse("consent_required");
  }

  // (d) Resolve who is asking. Accounts come from identity; guests must present a session.
  const resolved = await resolveCaller(ctx, args.sessionId);
  if (!resolved.ok) {
    return refuse(resolved.code);
  }

  // Without a key the provider cannot be called, so return the fallback before reserving quota.
  if (!describeAiConfiguration(deps.env()).configured) {
    return fallback(message);
  }

  // (e) Reserve before any provider call. A refusal stops here.
  const refusal = await reserve(ctx, resolved.caller);
  if (refusal !== null) {
    return refuse(refusal);
  }

  // (f) Minimized context: public catalog facts, plus aggregate counts for signed-in accounts only.
  const context = await readContext(ctx, resolved.caller, args, message);
  if (context === null) {
    return fallback(message);
  }

  // (g) Call the model with the identity prompt and the capped history.
  const outcome = await callChatModel({
    messages: buildChatMessages({
      context,
      currentScreen: args.currentScreen,
      history: capHistory(args.conversationHistory ?? []),
      message,
    }),
    jsonMode: true,
    maxTokens: CHAT_MAX_TOKENS,
    temperature: CHAT_TEMPERATURE,
    env: deps.env(),
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
  });
  if (!outcome.ok) {
    return fallback(message);
  }

  // (h) Validate the model output. Unusable output falls back; a bad action is dropped on its own.
  const reply = parseModelChatOutput(outcome.text);
  if (reply === null) {
    return fallback(message);
  }
  return { ok: true, source: "ai", ...reply };
}

/**
 * Builds the chat action with its dependencies injected. Production uses `chat` below; tests inject the environment,
 * a fake fetch, and a short timeout, so the registered handler runs unchanged.
 */
export function createChatAction(deps: ChatDeps) {
  return action({
    args: chatArgs,
    handler: async (ctx, args): Promise<ChatResult> => await runChat(ctx, args, deps),
  });
}

export const chat = createChatAction({ env: () => process.env });
