import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_REFUSAL_CODES,
  AiResultError,
  parseChatResult,
  parseDisputeAnalysisResult,
  parseModerationResult,
  parseRecommendationsResult,
  parseRephraseResult,
  parseResolutionResult,
  parseSimilarProductsResult,
  parseSuggestionsResult,
  parseVisualSearchResult,
} from "./aiResults";

function assertMalformed(parse: () => unknown, label: string): void {
  assert.throws(parse, AiResultError, `${label} must be rejected as malformed`);
}

test("chat keeps the reply, source, and both allowed action types", () => {
  const parsed = parseChatResult({
    ok: true,
    source: "ai",
    reply: "Here are cheap phones.",
    actions: [
      {
        type: "navigate",
        label: "Go to Orders",
        payload: { screen: "Orders" },
      },
      { type: "search", label: "Search phones", payload: { query: "phone" } },
    ],
  });

  assert.deepEqual(parsed, {
    ok: true,
    source: "ai",
    reply: "Here are cheap phones.",
    actions: [
      {
        type: "navigate",
        label: "Go to Orders",
        payload: { screen: "Orders" },
      },
      { type: "search", label: "Search phones", payload: { query: "phone" } },
    ],
  });
});

test("chat reports fallback and identity sources as themselves, never as ai", () => {
  const fallback = parseChatResult({
    ok: true,
    source: "fallback",
    reply: "Canned.",
    actions: [],
  });
  const identity = parseChatResult({
    ok: true,
    source: "identity",
    reply: "Hi.",
    actions: [],
  });
  assert.ok(fallback.ok);
  assert.ok(identity.ok);
  assert.equal(fallback.source, "fallback");
  assert.equal(identity.source, "identity");
});

test("chat returns each typed refusal code unchanged", () => {
  for (const code of [
    "consent_required",
    "session_required",
    "account_unavailable",
    "rate_limited",
    "invalid_request",
  ]) {
    assert.deepEqual(parseChatResult({ ok: false, code }), { ok: false, code });
  }
});

test("chat rejects a refusal with an unknown code, a missing ok flag, and a bad action", () => {
  assertMalformed(
    () => parseChatResult({ ok: false, code: "exploded" }),
    "unknown refusal code",
  );
  assertMalformed(
    () => parseChatResult({ source: "ai", reply: "x", actions: [] }),
    "missing ok",
  );
  assertMalformed(() => parseChatResult(null), "non-object");
  assertMalformed(
    () =>
      parseChatResult({
        ok: true,
        source: "ai",
        reply: "x",
        actions: [{ type: "delete", label: "x", payload: {} }],
      }),
    "action with an unknown type",
  );
  assertMalformed(
    () => parseChatResult({ ok: true, source: "ai", reply: 42, actions: [] }),
    "non-string reply",
  );
  assertMalformed(
    () =>
      parseChatResult({ ok: true, source: "model", reply: "x", actions: [] }),
    "unknown source",
  );
});

test("recommendations keep product ids and reasoning, and reject non-string ids", () => {
  assert.deepEqual(
    parseRecommendationsResult({
      ok: true,
      source: "ai",
      productIds: ["p1", "p2"],
      reasoning: "Because you looked at bikes.",
    }),
    {
      ok: true,
      source: "ai",
      productIds: ["p1", "p2"],
      reasoning: "Because you looked at bikes.",
    },
  );
  const fallback = parseRecommendationsResult({
    ok: true,
    source: "fallback",
    productIds: [],
    reasoning: "Showing the newest listings.",
  });
  assert.ok(fallback.ok);
  assert.equal(fallback.source, "fallback");
  assert.deepEqual(
    parseRecommendationsResult({ ok: false, code: "account_required" }),
    { ok: false, code: "account_required" },
  );
  assertMalformed(
    () =>
      parseRecommendationsResult({
        ok: true,
        source: "ai",
        productIds: [7],
        reasoning: "x",
      }),
    "non-string product id",
  );
  assertMalformed(
    () =>
      parseRecommendationsResult({
        ok: true,
        source: "ai",
        productIds: ["p1"],
      }),
    "missing reasoning",
  );
});

test("similar products keep ids, keep the product_unavailable refusal, and reject a malformed list", () => {
  assert.deepEqual(
    parseSimilarProductsResult({ ok: true, source: "ai", productIds: ["p9"] }),
    {
      ok: true,
      source: "ai",
      productIds: ["p9"],
    },
  );
  assert.deepEqual(
    parseSimilarProductsResult({ ok: false, code: "product_unavailable" }),
    {
      ok: false,
      code: "product_unavailable",
    },
  );
  assertMalformed(
    () =>
      parseSimilarProductsResult({ ok: true, source: "ai", productIds: "p9" }),
    "string list",
  );
});

test("visual search keeps the query and terms, including the empty fallback", () => {
  assert.deepEqual(
    parseVisualSearchResult({
      ok: true,
      source: "ai",
      query: "red bicycle",
      terms: ["red", "bicycle"],
    }),
    { ok: true, source: "ai", query: "red bicycle", terms: ["red", "bicycle"] },
  );
  assert.deepEqual(
    parseVisualSearchResult({
      ok: true,
      source: "fallback",
      query: "",
      terms: [],
    }),
    {
      ok: true,
      source: "fallback",
      query: "",
      terms: [],
    },
  );
  assertMalformed(
    () =>
      parseVisualSearchResult({
        ok: true,
        source: "ai",
        query: "x",
        terms: [1],
      }),
    "non-string term",
  );
  assertMalformed(
    () => parseVisualSearchResult({ ok: true, source: "ai", terms: [] }),
    "missing query",
  );
});

test("moderation saves only the ai result; the fallback is typed as unsaved error", () => {
  assert.deepEqual(
    parseModerationResult({
      ok: true,
      source: "ai",
      saved: true,
      revision: 3,
      status: "flagged",
      summary: "Price looks wrong.",
      flags: ["price_mismatch"],
    }),
    {
      ok: true,
      source: "ai",
      saved: true,
      revision: 3,
      status: "flagged",
      summary: "Price looks wrong.",
      flags: ["price_mismatch"],
    },
  );

  assert.deepEqual(
    parseModerationResult({
      ok: true,
      source: "fallback",
      saved: false,
      revision: 3,
      status: "error",
      summary: "AI moderation failed. Manual review is still required.",
      flags: ["ai_request_failed"],
    }),
    {
      ok: true,
      source: "fallback",
      saved: false,
      revision: 3,
      status: "error",
      summary: "AI moderation failed. Manual review is still required.",
      flags: ["ai_request_failed"],
    },
  );
});

test("moderation rejects an invented status, a saved fallback, and a bad revision", () => {
  assertMalformed(
    () =>
      parseModerationResult({
        ok: true,
        source: "ai",
        saved: true,
        revision: 1,
        status: "approved",
        summary: "x",
        flags: [],
      }),
    "status outside clear or flagged",
  );
  assertMalformed(
    () =>
      parseModerationResult({
        ok: true,
        source: "fallback",
        saved: true,
        revision: 1,
        status: "error",
        summary: "x",
        flags: [],
      }),
    "fallback claiming it was saved",
  );
  assertMalformed(
    () =>
      parseModerationResult({
        ok: true,
        source: "ai",
        saved: true,
        revision: "1",
        status: "clear",
        summary: "x",
        flags: [],
      }),
    "non-numeric revision",
  );
});

test("moderation returns the typed refusals a reviewer can see", () => {
  for (const code of [
    "stale",
    "forbidden",
    "not_found",
    "invalid_output",
    "unavailable",
  ]) {
    assert.deepEqual(parseModerationResult({ ok: false, code }), {
      ok: false,
      code,
    });
  }
});

test("the refusal code list covers every code the backend can return", () => {
  for (const code of [
    "consent_required",
    "session_required",
    "account_required",
    "account_unavailable",
    "rate_limited",
    "invalid_request",
    "product_unavailable",
    "forbidden",
    "not_found",
    "stale",
    "invalid_output",
    "too_long",
    "unavailable",
  ]) {
    const listed: readonly string[] = AI_REFUSAL_CODES;
    assert.ok(listed.includes(code), `${code} is listed`);
  }
});

const disputeRefusalCodes = [
  "invalid_request",
  "too_long",
  "consent_required",
  "account_required",
  "account_unavailable",
  "not_found",
  "forbidden",
  "rate_limited",
  "unavailable",
] as const;

test("rephrase keeps the ai rewrite and the unchanged pass-through with their text", () => {
  assert.deepEqual(
    parseRephraseResult({
      ok: true,
      source: "ai",
      rephrased: "Please send the tracking number.",
    }),
    {
      ok: true,
      source: "ai",
      rephrased: "Please send the tracking number.",
    },
  );
  assert.deepEqual(
    parseRephraseResult({
      ok: true,
      source: "unchanged",
      rephrased: 'He said "no" to me',
    }),
    {
      ok: true,
      source: "unchanged",
      rephrased: 'He said "no" to me',
    },
  );
});

test("rephrase rejects a source other than ai or unchanged, a missing text, and a non-string text", () => {
  assertMalformed(
    () => parseRephraseResult({ ok: true, source: "fallback", rephrased: "x" }),
    "a fallback source",
  );
  assertMalformed(
    () => parseRephraseResult({ ok: true, source: "ai" }),
    "a rewrite without text",
  );
  assertMalformed(
    () => parseRephraseResult({ ok: true, source: "ai", rephrased: 4 }),
    "a numeric text",
  );
  assertMalformed(() => parseRephraseResult("Please send it"), "a bare string");
});

test("rephrase returns each dispute refusal code, and rejects a code outside the contract", () => {
  for (const code of disputeRefusalCodes) {
    assert.deepEqual(parseRephraseResult({ ok: false, code }), {
      ok: false,
      code,
    });
  }
  assertMalformed(
    () => parseRephraseResult({ ok: false, code: "made_up" }),
    "an unknown refusal code",
  );
});

test("suggestions keep each suggestion in order, and only the ai source is accepted", () => {
  assert.deepEqual(
    parseSuggestionsResult({
      ok: true,
      source: "ai",
      suggestions: ["Thanks, I will check.", "Can you share a photo?"],
    }),
    {
      ok: true,
      source: "ai",
      suggestions: ["Thanks, I will check.", "Can you share a photo?"],
    },
  );
  assertMalformed(
    () =>
      parseSuggestionsResult({
        ok: true,
        source: "fallback",
        suggestions: ["Hello"],
      }),
    "a fallback list",
  );
  assertMalformed(
    () =>
      parseSuggestionsResult({ ok: true, source: "ai", suggestions: "Hello" }),
    "a text list",
  );
  assertMalformed(
    () =>
      parseSuggestionsResult({
        ok: true,
        source: "ai",
        suggestions: ["Hello", 3],
      }),
    "a numeric item",
  );
  assertMalformed(
    () => parseSuggestionsResult({ ok: true, source: "ai" }),
    "a missing list",
  );
});

test("suggestions return each dispute refusal code", () => {
  for (const code of ["rate_limited", "unavailable", "not_found"]) {
    assert.deepEqual(parseSuggestionsResult({ ok: false, code }), {
      ok: false,
      code,
    });
  }
});

const participantAnalysis = {
  ok: true,
  source: "ai",
  summary: "The parcel was late.",
  keyPoints: {
    yourClaims: ["It never arrived"],
    theirClaims: ["It shipped on time"],
    buyerClaims: ["It never arrived"],
    sellerClaims: ["It shipped on time"],
  },
  sentiment: {
    yours: "frustrated",
    theirs: "cooperative",
    buyer: "frustrated",
    seller: "cooperative",
  },
  suggestedResolutions: [
    { type: "full_refund", description: "Refund the order.", fairnessScore: 8 },
  ],
  recommendedAction: "Share the tracking number.",
  riskLevel: "medium",
  additionalNotes: "",
  viewerRole: "buyer",
};

const reviewerAnalysis = {
  ...participantAnalysis,
  summary:
    "The buyer reports a missing parcel and the seller reports a shipment.",
  keyPoints: {
    yourClaims: [],
    theirClaims: [],
    buyerClaims: ["The item never arrived"],
    sellerClaims: ["Shipped on 3 May with tracking"],
  },
  sentiment: {
    yours: "frustrated",
    theirs: "cooperative",
    buyer: "frustrated",
    seller: "cooperative",
  },
  viewerRole: "moderator",
};

test("analysis keeps a participant's personalized result, with the viewer's side", () => {
  assert.deepEqual(
    parseDisputeAnalysisResult(participantAnalysis),
    participantAnalysis,
  );
});

test("analysis keeps a reviewer's objective result, with one claim list and sentiment per side", () => {
  assert.deepEqual(
    parseDisputeAnalysisResult(reviewerAnalysis),
    reviewerAnalysis,
  );
});

test("analysis rejects an unknown viewer role, sentiment, risk level, or resolution type", () => {
  assertMalformed(
    () =>
      parseDisputeAnalysisResult({
        ...participantAnalysis,
        viewerRole: "admin",
      }),
    "an unknown viewer",
  );
  assertMalformed(
    () =>
      parseDisputeAnalysisResult({
        ...participantAnalysis,
        sentiment: { ...participantAnalysis.sentiment, yours: "angry" },
      }),
    "an unknown sentiment",
  );
  assertMalformed(
    () =>
      parseDisputeAnalysisResult({
        ...participantAnalysis,
        riskLevel: "extreme",
      }),
    "an unknown risk",
  );
  assertMalformed(
    () =>
      parseDisputeAnalysisResult({
        ...participantAnalysis,
        suggestedResolutions: [
          { type: "refund_all", description: "x", fairnessScore: 5 },
        ],
      }),
    "an unknown resolution type",
  );
});

test("analysis rejects a missing side list, a non-numeric fairness score, and a fallback source", () => {
  assertMalformed(
    () =>
      parseDisputeAnalysisResult({
        ...reviewerAnalysis,
        keyPoints: { ...reviewerAnalysis.keyPoints, sellerClaims: undefined },
      }),
    "a reviewer result without the seller claims",
  );
  assertMalformed(
    () =>
      parseDisputeAnalysisResult({
        ...participantAnalysis,
        suggestedResolutions: [
          { type: "no_refund", description: "x", fairnessScore: "high" },
        ],
      }),
    "a text fairness score",
  );
  assertMalformed(
    () =>
      parseDisputeAnalysisResult({
        ...participantAnalysis,
        source: "fallback",
      }),
    "a fallback analysis",
  );
});

test("analysis returns each dispute refusal code", () => {
  for (const code of [
    "forbidden",
    "not_found",
    "rate_limited",
    "consent_required",
    "too_long",
  ]) {
    assert.deepEqual(parseDisputeAnalysisResult({ ok: false, code }), {
      ok: false,
      code,
    });
  }
});

test("a generated resolution message is kept, and rejects a missing message", () => {
  assert.deepEqual(
    parseResolutionResult({
      ok: true,
      source: "ai",
      message: "We will refund the order.",
    }),
    {
      ok: true,
      source: "ai",
      message: "We will refund the order.",
    },
  );
  assertMalformed(
    () => parseResolutionResult({ ok: true, source: "ai" }),
    "a resolution without a message",
  );
  assertMalformed(
    () => parseResolutionResult({ ok: true, source: "fallback", message: "x" }),
    "a fallback message",
  );
  assert.deepEqual(parseResolutionResult({ ok: false, code: "forbidden" }), {
    ok: false,
    code: "forbidden",
  });
});
