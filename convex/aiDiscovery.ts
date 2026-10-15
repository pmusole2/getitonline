import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { admitCaller, reserveCall, type GateCtx } from "./lib/aiGate";
import {
  DISCOVERY_LIMITS,
  CART_RECOMMENDATION_EMPTY_REASONING,
  CART_RECOMMENDATION_REASONING,
  RECOMMENDATION_FALLBACK_REASONING,
  RECOMMENDATION_MAX_TOKENS,
  RECOMMENDATION_TEMPERATURE,
  SIMILAR_MAX_TOKENS,
  SIMILAR_TEMPERATURE,
  VISUAL_MAX_TOKENS,
  VISUAL_TEMPERATURE,
  buildRecommendationPrompt,
  buildCartRecommendationPrompt,
  buildSimilarPrompt,
  buildVisualMessages,
  clampLimit,
  newestFallback,
  parseProductIdsOutput,
  parseVisualOutput,
  recommendationReasoning,
  sameCategoryFallback,
  type DiscoveryCandidate,
  type CartRecommendationContext,
  type DiscoveryRefusalCode,
  type RecommendationContext,
  type RecommendationResult,
  type SimilarContext,
  type SimilarResult,
  type VisualResult,
} from "./lib/aiDiscoveryPolicy";
import {
  callChatModel,
  describeAiConfiguration,
  isSupportedImageDataUrl,
  type AiEnv,
  type AiFetch,
  type AiMessage,
} from "./lib/aiProvider";

// Pinkie's discovery actions. Order of operations is fixed: validate input, require current consent, resolve the caller,
// read public candidates, build the prompt within its budget, check the provider is configured, reserve usage, call the
// model, then keep only IDs that were shown and are still eligible. Refusals happen before any reservation, and a
// reservation happens before any provider call. A path with no provider call never reserves. Every failure returns the
// fallback with source "fallback", never a success.

export type DiscoveryDeps = {
  env: () => AiEnv;
  fetchImpl?: AiFetch;
  timeoutMs?: number;
};

type RecommendationArgs = { limit?: number; consentVersion?: number; cartProductIds?: Id<"products">[] };
type SimilarArgs = { productId: Id<"products">; limit?: number; consentVersion?: number; sessionId?: string };
type VisualArgs = { imageDataUrl: string; consentVersion?: number; sessionId?: string };

const consentVersion = v.optional(v.number());
const sessionId = v.optional(v.string());

const recommendationArgs = {
  cartProductIds: v.optional(v.array(v.id("products"))),
  limit: v.optional(v.number()),
  consentVersion,
};

const similarArgs = {
  productId: v.id("products"),
  limit: v.optional(v.number()),
  consentVersion,
  sessionId,
};

const visualArgs = {
  imageDataUrl: v.string(),
  consentVersion,
  sessionId,
};

function refuse(code: DiscoveryRefusalCode): { ok: false; code: DiscoveryRefusalCode } {
  return { ok: false, code };
}

// Reads the candidate set. A failed read is logged by its safe label only, because its error text can carry query data.
async function readRecommendationContext(ctx: GateCtx, userId: Id<"users">): Promise<RecommendationContext | null> {
  try {
    return await ctx.runQuery(internal.aiDiscoveryData.recommendationContext, { userId });
  } catch {
    console.error("[ai] discovery context failed");
    return null;
  }
}

async function readSimilarContext(ctx: GateCtx, productId: Id<"products">): Promise<SimilarContext | null> {
  try {
    return await ctx.runQuery(internal.aiDiscoveryData.similarContext, { productId });
  } catch {
    console.error("[ai] discovery context failed");
    return null;
  }
}

// Rechecks product IDs against current eligibility after the provider returns. Returns null when the check itself fails.
// The caller then returns an empty result with no further query, so an unverified ID is never returned.
async function stillEligible(ctx: GateCtx, productIds: Id<"products">[]): Promise<Id<"products">[] | null> {
  if (productIds.length === 0) {
    return [];
  }
  try {
    const eligible = new Set(await ctx.runQuery(internal.aiDiscoveryData.eligibleProducts, { productIds }));
    return productIds.filter((id) => eligible.has(id));
  } catch {
    console.error("[ai] discovery eligibility failed");
    return null;
  }
}

// Asks the model. Returns the reply text, or null for any provider failure, which the caller turns into a fallback.
async function askModel(
  messages: AiMessage[],
  options: { maxTokens: number; temperature: number },
  deps: DiscoveryDeps
): Promise<string | null> {
  const outcome = await callChatModel({
    messages,
    jsonMode: true,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    env: deps.env(),
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
  });
  return outcome.ok ? outcome.text : null;
}

async function recommendationFallback(
  ctx: GateCtx,
  candidates: DiscoveryCandidate[],
  limit: number
): Promise<RecommendationResult> {
  const productIds = (await stillEligible(ctx, newestFallback(candidates, limit))) ?? [];
  return { ok: true, source: "fallback", productIds, reasoning: RECOMMENDATION_FALLBACK_REASONING };
}

// Returned when the eligibility recheck itself failed. It carries no IDs and performs no further eligibility query.
const EMPTY_RECOMMENDATION_FALLBACK: RecommendationResult = {
  ok: true,
  source: "fallback",
  productIds: [],
  reasoning: RECOMMENDATION_FALLBACK_REASONING,
};

// Returned when the similar-products check fails, or the source is no longer eligible. It carries no IDs.
const EMPTY_SIMILAR_FALLBACK: SimilarResult = { ok: true, source: "fallback", productIds: [] };

// The one post-provider check for similar products. It covers the source, the model picks, and the fallback candidates in a
// single eligibility query, and every returned ID is selected from that verified set. A failed check, or a source that is no
// longer eligible, returns the empty fallback, so no pick or fallback ID is returned without the source.
async function verifiedSimilar(
  ctx: GateCtx,
  source: DiscoveryCandidate,
  picked: Id<"products">[] | null,
  candidates: DiscoveryCandidate[],
  limit: number
): Promise<SimilarResult> {
  const fallbackIds = sameCategoryFallback(source, candidates, limit);
  const checked = await stillEligible(ctx, [source.id, ...(picked ?? []), ...fallbackIds]);
  if (checked === null) {
    return EMPTY_SIMILAR_FALLBACK;
  }
  const verified = new Set(checked);
  if (!verified.has(source.id)) {
    return EMPTY_SIMILAR_FALLBACK;
  }
  const eligiblePicks = (picked ?? []).filter((id) => verified.has(id) && id !== source.id);
  if (eligiblePicks.length > 0) {
    return { ok: true, source: "ai", productIds: eligiblePicks };
  }
  return {
    ok: true,
    source: "fallback",
    productIds: fallbackIds.filter((id) => verified.has(id) && id !== source.id),
  };
}

// The one post-provider check for recommendations. The model picks and the newest fallback listings share one eligibility
// query, and every returned ID is selected from that verified set. A failed check returns the empty fallback.
async function verifiedRecommendations(
  ctx: GateCtx,
  context: RecommendationContext,
  picked: Id<"products">[] | null,
  limit: number
): Promise<RecommendationResult> {
  const fallbackIds = newestFallback(context.candidates, limit);
  const checked = await stillEligible(ctx, [...(picked ?? []), ...fallbackIds]);
  if (checked === null) {
    return EMPTY_RECOMMENDATION_FALLBACK;
  }
  const verified = new Set(checked);
  const eligiblePicks = (picked ?? []).filter((id) => verified.has(id));
  if (eligiblePicks.length > 0) {
    return { ok: true, source: "ai", productIds: eligiblePicks, reasoning: recommendationReasoning(context) };
  }
  return {
    ok: true,
    source: "fallback",
    productIds: fallbackIds.filter((id) => verified.has(id)),
    reasoning: RECOMMENDATION_FALLBACK_REASONING,
  };
}

const EMPTY_CART_RECOMMENDATION: RecommendationResult = {
  ok: true,
  source: "fallback",
  productIds: [],
  reasoning: CART_RECOMMENDATION_EMPTY_REASONING,
};

async function readCartContext(
  ctx: GateCtx,
  userId: Id<"users">,
  cartProductIds: Id<"products">[]
): Promise<CartRecommendationContext | null> {
  try {
    return await ctx.runQuery(internal.aiDiscoveryData.cartRecommendationContext, { userId, cartProductIds });
  } catch {
    console.error("[ai] cart discovery context failed");
    return null;
  }
}

async function runCartRecommendations(
  ctx: GateCtx,
  userId: Id<"users">,
  cartProductIds: Id<"products">[],
  limit: number,
  deps: DiscoveryDeps
): Promise<RecommendationResult> {
  if (cartProductIds.length === 0 || cartProductIds.length > DISCOVERY_LIMITS.cartProducts) {
    return EMPTY_CART_RECOMMENDATION;
  }
  const context = await readCartContext(ctx, userId, cartProductIds);
  if (context === null) {
    return EMPTY_CART_RECOMMENDATION;
  }
  const prompt = buildCartRecommendationPrompt({ context, limit });
  if (prompt.shownIds.length === 0 || !describeAiConfiguration(deps.env()).configured) {
    return EMPTY_CART_RECOMMENDATION;
  }
  const reserved = await reserveCall(ctx, { kind: "account", userId });
  if (reserved !== null) {
    return refuse(reserved);
  }
  const text = await askModel(
    prompt.messages,
    { maxTokens: RECOMMENDATION_MAX_TOKENS, temperature: RECOMMENDATION_TEMPERATURE },
    deps
  );
  const picked = text === null ? null : parseProductIdsOutput(text, prompt.shownIds, limit);
  if (picked === null) {
    return EMPTY_CART_RECOMMENDATION;
  }

  // One query snapshot rechecks caller cart identity, source metadata, and candidate eligibility together.
  const current = await readCartContext(ctx, userId, cartProductIds);
  if (current === null || current.snapshot !== context.snapshot) {
    return EMPTY_CART_RECOMMENDATION;
  }
  const productIds = picked.filter((id) => {
    const before = context.candidates.find((candidate) => candidate.id === id);
    const after = current.candidates.find((candidate) => candidate.id === id);
    return before !== undefined && after !== undefined && JSON.stringify(before) === JSON.stringify(after);
  });
  return productIds.length > 0
    ? { ok: true, source: "ai", productIds, reasoning: CART_RECOMMENDATION_REASONING }
    : EMPTY_CART_RECOMMENDATION;
}

async function runRecommendations(
  ctx: GateCtx,
  args: RecommendationArgs,
  deps: DiscoveryDeps
): Promise<RecommendationResult> {
  const limit = clampLimit(
    args.limit,
    DISCOVERY_LIMITS.recommendationLimit.max,
    DISCOVERY_LIMITS.recommendationLimit.default
  );

  // Recommendations need a signed-in account. A guest is refused here, before any database read.
  const admission = await admitCaller(ctx, {
    consentVersion: args.consentVersion,
    sessionId: undefined,
    requireAccount: true,
  });
  if (!admission.ok) {
    return refuse(admission.code);
  }
  if (admission.caller.kind !== "account") {
    return refuse("account_required");
  }

  if (args.cartProductIds !== undefined) {
    return await runCartRecommendations(ctx, admission.caller.userId, args.cartProductIds, limit, deps);
  }

  const context = await readRecommendationContext(ctx, admission.caller.userId);
  if (context === null) {
    return await recommendationFallback(ctx, [], limit);
  }

  const prompt = buildRecommendationPrompt({ context, limit });
  if (prompt.shownIds.length === 0 || !describeAiConfiguration(deps.env()).configured) {
    return await recommendationFallback(ctx, context.candidates, limit);
  }

  const reserved = await reserveCall(ctx, admission.caller);
  if (reserved !== null) {
    return refuse(reserved);
  }

  const text = await askModel(
    prompt.messages,
    { maxTokens: RECOMMENDATION_MAX_TOKENS, temperature: RECOMMENDATION_TEMPERATURE },
    deps
  );
  const picked = text === null ? null : parseProductIdsOutput(text, prompt.shownIds, limit);
  return await verifiedRecommendations(ctx, context, picked, limit);
}

async function runSimilar(ctx: GateCtx, args: SimilarArgs, deps: DiscoveryDeps): Promise<SimilarResult> {
  const limit = clampLimit(args.limit, DISCOVERY_LIMITS.similarLimit.max, DISCOVERY_LIMITS.similarLimit.default);

  const admission = await admitCaller(ctx, {
    consentVersion: args.consentVersion,
    sessionId: args.sessionId,
    requireAccount: false,
  });
  if (!admission.ok) {
    return refuse(admission.code);
  }

  const context = await readSimilarContext(ctx, args.productId);
  if (context === null) {
    return { ok: true, source: "fallback", productIds: [] };
  }
  const { source, candidates } = context;
  if (source === null) {
    return refuse("product_unavailable");
  }

  const prompt = buildSimilarPrompt({ source, candidates, limit });
  if (prompt.shownIds.length === 0 || !describeAiConfiguration(deps.env()).configured) {
    return await verifiedSimilar(ctx, source, null, candidates, limit);
  }

  const reserved = await reserveCall(ctx, admission.caller);
  if (reserved !== null) {
    return refuse(reserved);
  }

  const text = await askModel(
    prompt.messages,
    { maxTokens: SIMILAR_MAX_TOKENS, temperature: SIMILAR_TEMPERATURE },
    deps
  );
  const picked = text === null ? null : parseProductIdsOutput(text, prompt.shownIds, limit);
  return await verifiedSimilar(ctx, source, picked, candidates, limit);
}

const EMPTY_VISUAL_FALLBACK: VisualResult = { ok: true, source: "fallback", query: "", terms: [] };

async function runVisual(ctx: GateCtx, args: VisualArgs, deps: DiscoveryDeps): Promise<VisualResult> {
  // The image is checked before consent, identity, or quota, so a bad image costs nothing.
  if (!isSupportedImageDataUrl(args.imageDataUrl)) {
    return refuse("invalid_request");
  }

  const admission = await admitCaller(ctx, {
    consentVersion: args.consentVersion,
    sessionId: args.sessionId,
    requireAccount: false,
  });
  if (!admission.ok) {
    return refuse(admission.code);
  }

  // Visual search has no non-AI result, so a missing key returns the empty fallback without reserving quota.
  if (!describeAiConfiguration(deps.env()).configured) {
    return EMPTY_VISUAL_FALLBACK;
  }

  const reserved = await reserveCall(ctx, admission.caller);
  if (reserved !== null) {
    return refuse(reserved);
  }

  const text = await askModel(
    buildVisualMessages(args.imageDataUrl),
    { maxTokens: VISUAL_MAX_TOKENS, temperature: VISUAL_TEMPERATURE },
    deps
  );
  const output = text === null ? null : parseVisualOutput(text);
  if (output === null) {
    return EMPTY_VISUAL_FALLBACK;
  }
  return { ok: true, source: "ai", query: output.query, terms: output.terms };
}

/**
 * Builds the recommendations action with its dependencies injected. Production uses `getRecommendations` below; tests
 * inject the environment, a fake fetch, and a short timeout, so the registered handler runs unchanged.
 */
export function createRecommendationsAction(deps: DiscoveryDeps) {
  return action({
    args: recommendationArgs,
    handler: async (ctx, args): Promise<RecommendationResult> => await runRecommendations(ctx, args, deps),
  });
}

export function createSimilarProductsAction(deps: DiscoveryDeps) {
  return action({
    args: similarArgs,
    handler: async (ctx, args): Promise<SimilarResult> => await runSimilar(ctx, args, deps),
  });
}

export function createVisualSearchAction(deps: DiscoveryDeps) {
  return action({
    args: visualArgs,
    handler: async (ctx, args): Promise<VisualResult> => await runVisual(ctx, args, deps),
  });
}

export const getRecommendations = createRecommendationsAction({ env: () => process.env });
export const similarProducts = createSimilarProductsAction({ env: () => process.env });
export const visualSearch = createVisualSearchAction({ env: () => process.env });
