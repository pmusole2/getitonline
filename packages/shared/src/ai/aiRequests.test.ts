import assert from "node:assert/strict";
import test from "node:test";

import { AI_CONSENT_VERSION, type AiSubject } from "./aiConsent";
import {
  AiRequestError,
  createAiRequests,
  createDisputeRequests,
  type AiTransport,
  type DisputeTransport,
} from "./aiRequests";
import {
  getOrCreateGuestSessionId,
  isValidGuestSessionId,
  type KeyValueStore,
} from "./aiGuestSession";

type Call = { method: string; args: Record<string, unknown> };

function disputeAnalysisReply() {
  return {
    ok: true,
    source: "ai",
    summary: "The parcel was late.",
    keyPoints: {
      yourClaims: [],
      theirClaims: [],
      buyerClaims: ["Never arrived"],
      sellerClaims: [],
    },
    sentiment: {
      yours: "neutral",
      theirs: "neutral",
      buyer: "neutral",
      seller: "neutral",
    },
    suggestedResolutions: [],
    recommendedAction: "Share the tracking number.",
    riskLevel: "low",
    additionalNotes: "",
    viewerRole: "moderator",
  };
}

interface Fixture {
  readonly calls: Call[];
  readonly transport: AiTransport;
  readonly disputeTransport: DisputeTransport;
  readonly setReply: (
    method: keyof AiTransport | keyof DisputeTransport,
    reply: () => Promise<unknown>,
  ) => void;
}

// Each method returns a reply chosen by the test. The default reply is a valid AI result for that method.
function fakeTransport(): Fixture {
  const calls: Call[] = [];
  const replies = new Map<string, () => Promise<unknown>>([
    [
      "chat",
      async () => ({ ok: true, source: "ai", reply: "Hello", actions: [] }),
    ],
    [
      "getRecommendations",
      async () => ({
        ok: true,
        source: "ai",
        productIds: ["p1"],
        reasoning: "Because.",
      }),
    ],
    [
      "similarProducts",
      async () => ({ ok: true, source: "ai", productIds: ["p2"] }),
    ],
    [
      "visualSearch",
      async () => ({ ok: true, source: "ai", query: "bike", terms: ["bike"] }),
    ],
    [
      "moderateListing",
      async () => ({
        ok: true,
        source: "ai",
        saved: true,
        revision: 2,
        status: "clear",
        summary: "Looks fine.",
        flags: [],
      }),
    ],
    [
      "rephraseMessage",
      async () => ({
        ok: true,
        source: "ai",
        rephrased: "Please send the tracking number.",
      }),
    ],
    [
      "suggestResponses",
      async () => ({
        ok: true,
        source: "ai",
        suggestions: ["Thanks, I will check."],
      }),
    ],
    ["analyzeDispute", async () => disputeAnalysisReply()],
    [
      "generateResolutionMessage",
      async () => ({
        ok: true,
        source: "ai",
        message: "We will refund the order.",
      }),
    ],
  ]);
  const record = (method: string, args: Record<string, unknown>) => {
    calls.push({ method, args });
    const reply = replies.get(method);
    if (!reply) throw new Error(`no reply for ${method}`);
    return reply();
  };
  const transport: AiTransport = {
    chat: (args) => record("chat", { ...args }),
    getRecommendations: (args) => record("getRecommendations", { ...args }),
    similarProducts: (args) => record("similarProducts", { ...args }),
    visualSearch: (args) => record("visualSearch", { ...args }),
    moderateListing: (args) => record("moderateListing", { ...args }),
  };
  const disputeTransport: DisputeTransport = {
    rephraseMessage: (args) => record("rephraseMessage", { ...args }),
    suggestResponses: (args) => record("suggestResponses", { ...args }),
    analyzeDispute: (args) => record("analyzeDispute", { ...args }),
    generateResolutionMessage: (args) =>
      record("generateResolutionMessage", { ...args }),
  };
  return {
    calls,
    transport,
    disputeTransport,
    setReply: (method, reply) => {
      replies.set(method, reply);
    },
  };
}

function memoryStore(): KeyValueStore {
  const values = new Map<string, string>();
  return {
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
  };
}

function setup(
  options: {
    consented?: AiSubject[];
    subject?: AiSubject;
    guestId?: string;
  } = {},
) {
  const fixture = fakeTransport();
  const consented = new Set<AiSubject>(options.consented ?? []);
  const initial: AiSubject = options.subject ?? "guest";
  const state = { subject: initial, generation: 0 };
  const gate = {
    hasConsent: async (subject: AiSubject) => consented.has(subject),
    currentSubject: () => ({
      subject: state.subject,
      generation: state.generation,
    }),
    guestSessionId: async () => options.guestId ?? "guest-session-1",
  };
  const requests = createAiRequests({ transport: fixture.transport, ...gate });
  const disputes = createDisputeRequests({
    transport: fixture.disputeTransport,
    ...gate,
  });
  return { ...fixture, requests, disputes, state };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the call to reject");
}

test("no consent for the active subject means no provider-bound call at all", async () => {
  const { requests, calls } = setup({ subject: "account:u1", consented: [] });

  const attempts = [
    requests.chat({ message: "hi" }),
    requests.getRecommendations({ limit: 3 }),
    requests.similarProducts({ productId: "p1" }),
    requests.visualSearch({ imageDataUrl: "data:image/jpeg;base64,AAA" }),
    requests.moderateListing({ productId: "p1" }),
  ];
  for (const attempt of attempts) {
    const error = await rejectionOf(attempt);
    assert.ok(error instanceof AiRequestError);
    assert.equal(error.code, "consent_required");
  }
  assert.deepEqual(calls, [], "the transport is never called without consent");
});

test("consent given to one account does not let another account call", async () => {
  const { requests, calls, state } = setup({
    subject: "account:a",
    consented: ["account:a"],
  });
  state.subject = "account:b";
  state.generation += 1;

  const error = await rejectionOf(requests.chat({ message: "hi" }));

  assert.ok(error instanceof AiRequestError);
  assert.equal(error.code, "consent_required");
  assert.deepEqual(calls, []);
});

test("every AI request carries the current consent version", async () => {
  const { requests, calls } = setup({
    subject: "account:u1",
    consented: ["account:u1"],
  });

  await requests.chat({ message: "hi" });
  await requests.getRecommendations({ limit: 3 });
  await requests.similarProducts({ productId: "p1" });
  await requests.visualSearch({ imageDataUrl: "data:image/jpeg;base64,AAA" });
  await requests.moderateListing({ productId: "p1" });

  assert.equal(calls.length, 5);
  for (const call of calls) {
    assert.equal(
      call.args.consentVersion,
      AI_CONSENT_VERSION,
      `${call.method} sends the version`,
    );
  }
});

test("a guest sends one stable, valid session id on every call", async () => {
  const store = memoryStore();
  const calls: Call[] = [];
  const guest = createAiRequests({
    transport: recordingTransport(calls),
    hasConsent: async () => true,
    currentSubject: () => ({ subject: "guest", generation: 0 }),
    guestSessionId: () =>
      getOrCreateGuestSessionId(store, () => "a1b2c3d4-guest-uuid"),
  });

  await guest.chat({ message: "first" });
  await guest.visualSearch({ imageDataUrl: "data:image/jpeg;base64,AAA" });

  const sessionIds = calls.map((call) => call.args.sessionId);
  assert.equal(sessionIds[0], "a1b2c3d4-guest-uuid");
  assert.equal(
    sessionIds[1],
    "a1b2c3d4-guest-uuid",
    "the same id on each call",
  );
  assert.equal(isValidGuestSessionId(sessionIds[0]), true);
});

function recordingTransport(calls: Call[]): AiTransport {
  const record = async (
    method: string,
    args: Record<string, unknown>,
    reply: unknown,
  ) => {
    calls.push({ method, args });
    return reply;
  };
  return {
    chat: (args) =>
      record(
        "chat",
        { ...args },
        { ok: true, source: "ai", reply: "Hi", actions: [] },
      ),
    getRecommendations: (args) =>
      record(
        "getRecommendations",
        { ...args },
        { ok: true, source: "ai", productIds: [], reasoning: "x" },
      ),
    similarProducts: (args) =>
      record(
        "similarProducts",
        { ...args },
        { ok: true, source: "ai", productIds: [] },
      ),
    visualSearch: (args) =>
      record(
        "visualSearch",
        { ...args },
        { ok: true, source: "ai", query: "q", terms: [] },
      ),
    moderateListing: (args) =>
      record(
        "moderateListing",
        { ...args },
        {
          ok: true,
          source: "ai",
          saved: true,
          revision: 1,
          status: "clear",
          summary: "s",
          flags: [],
        },
      ),
  };
}

test("a signed-in account never sends a session id", async () => {
  const { requests, calls } = setup({
    subject: "account:u1",
    consented: ["account:u1"],
  });

  await requests.chat({ message: "hi" });
  await requests.visualSearch({ imageDataUrl: "data:image/jpeg;base64,AAA" });
  await requests.similarProducts({ productId: "p1" });

  for (const call of calls) {
    assert.equal(
      "sessionId" in call.args,
      false,
      `${call.method} carries no session id`,
    );
  }
});

test("moderation sends only the product id and the consent version", async () => {
  const { requests, calls } = setup({
    subject: "account:reviewer",
    consented: ["account:reviewer"],
  });

  await requests.moderateListing({ productId: "prod_1" });

  assert.deepEqual(calls, [
    {
      method: "moderateListing",
      args: { productId: "prod_1", consentVersion: AI_CONSENT_VERSION },
    },
  ]);
});

test("a guest is refused for recommendations and moderation before any call", async () => {
  const { requests, calls } = setup({ subject: "guest", consented: ["guest"] });

  const recommendations = await rejectionOf(
    requests.getRecommendations({ limit: 3 }),
  );
  const moderation = await rejectionOf(
    requests.moderateListing({ productId: "p1" }),
  );

  assert.ok(recommendations instanceof AiRequestError);
  assert.equal(recommendations.code, "account_required");
  assert.ok(moderation instanceof AiRequestError);
  assert.equal(moderation.code, "account_required");
  assert.deepEqual(calls, []);
});

test("a result that arrives after the account changed is discarded", async () => {
  const { requests, setReply, state } = setup({
    subject: "account:a",
    consented: ["account:a"],
  });
  let release: ((reply: unknown) => void) | undefined;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  setReply("chat", () => {
    markStarted();
    return new Promise((resolve) => {
      release = resolve;
    });
  });

  const pending = requests.chat({ message: "hi" });
  await started;
  state.subject = "account:b";
  state.generation += 1;
  release?.({ ok: true, source: "ai", reply: "For account A", actions: [] });

  const error = await rejectionOf(pending);
  assert.ok(error instanceof AiRequestError);
  assert.equal(
    error.code,
    "account_changed",
    "the late reply is not returned to the new account",
  );
});

test("a typed refusal from the backend is thrown with its code", async () => {
  const { requests, setReply } = setup({
    subject: "account:u1",
    consented: ["account:u1"],
  });
  setReply("visualSearch", async () => ({ ok: false, code: "rate_limited" }));

  const error = await rejectionOf(
    requests.visualSearch({ imageDataUrl: "data:image/jpeg;base64,AAA" }),
  );

  assert.ok(error instanceof AiRequestError);
  assert.equal(error.code, "rate_limited");
});

test("a malformed result and a failed transport both surface as unavailable", async () => {
  const { requests, setReply } = setup({
    subject: "account:u1",
    consented: ["account:u1"],
  });
  setReply("chat", async () => ({
    ok: true,
    source: "ai",
    reply: 7,
    actions: [],
  }));
  setReply("getRecommendations", async () => {
    throw new Error("network down");
  });

  const malformed = await rejectionOf(requests.chat({ message: "hi" }));
  const failed = await rejectionOf(requests.getRecommendations({ limit: 2 }));

  assert.ok(malformed instanceof AiRequestError);
  assert.equal(malformed.code, "unavailable");
  assert.ok(failed instanceof AiRequestError);
  assert.equal(failed.code, "unavailable");
});

test("a fallback is returned as a fallback, never as an ai result", async () => {
  const { requests, setReply } = setup({
    subject: "account:u1",
    consented: ["account:u1"],
  });
  setReply("chat", async () => ({
    ok: true,
    source: "fallback",
    reply: "Canned.",
    actions: [],
  }));
  setReply("visualSearch", async () => ({
    ok: true,
    source: "fallback",
    query: "",
    terms: [],
  }));
  setReply("moderateListing", async () => ({
    ok: true,
    source: "fallback",
    saved: false,
    revision: 4,
    status: "error",
    summary: "AI moderation failed.",
    flags: ["ai_request_failed"],
  }));

  const chat = await requests.chat({ message: "hi" });
  const visual = await requests.visualSearch({
    imageDataUrl: "data:image/jpeg;base64,AAA",
  });
  const moderation = await requests.moderateListing({ productId: "p1" });

  assert.equal(chat.source, "fallback");
  assert.equal(visual.source, "fallback");
  assert.equal(moderation.source, "fallback");
  assert.equal(moderation.saved, false);
});

test("chat passes its history, screen, and product through unchanged", async () => {
  const { requests, calls } = setup({
    subject: "account:u1",
    consented: ["account:u1"],
  });

  await requests.chat({
    message: "Is this a good price?",
    conversationHistory: [{ role: "user", content: "Hi" }],
    currentScreen: "ProductDetail",
    productId: "prod_9",
  });

  assert.deepEqual(calls[0]?.args, {
    message: "Is this a good price?",
    conversationHistory: [{ role: "user", content: "Hi" }],
    currentScreen: "ProductDetail",
    productId: "prod_9",
    consentVersion: AI_CONSENT_VERSION,
  });
});

test("every dispute call is refused for a guest before any call, with account_required", async () => {
  const { disputes, calls } = setup({ subject: "guest", consented: ["guest"] });

  const attempts = [
    disputes.rephraseMessage({ disputeId: "d1", message: "Hello there" }),
    disputes.suggestResponses({ disputeId: "d1" }),
    disputes.analyzeDispute({ disputeId: "d1" }),
    disputes.generateResolutionMessage({
      disputeId: "d1",
      resolutionType: "no_refund",
    }),
  ];
  for (const attempt of attempts) {
    const error = await rejectionOf(attempt);
    assert.ok(error instanceof AiRequestError);
    assert.equal(error.code, "account_required");
  }
  assert.deepEqual(
    calls,
    [],
    "no guest session or dispute call reaches the transport",
  );
});

test("without consent for the account, no dispute call reaches the transport", async () => {
  const { disputes, calls } = setup({ subject: "account:u1", consented: [] });

  const attempts = [
    disputes.rephraseMessage({ disputeId: "d1", message: "Hello there" }),
    disputes.suggestResponses({ disputeId: "d1" }),
    disputes.analyzeDispute({ disputeId: "d1" }),
    disputes.generateResolutionMessage({
      disputeId: "d1",
      resolutionType: "full_refund",
    }),
  ];
  for (const attempt of attempts) {
    const error = await rejectionOf(attempt);
    assert.ok(error instanceof AiRequestError);
    assert.equal(error.code, "consent_required");
  }
  assert.deepEqual(calls, []);
});

test("each dispute call sends only the dispute id, its own input, and the consent version", async () => {
  const { disputes, calls } = setup({
    subject: "account:u1",
    consented: ["account:u1"],
  });

  await disputes.rephraseMessage({ disputeId: "d1", message: "Hello there" });
  await disputes.suggestResponses({ disputeId: "d1" });
  await disputes.analyzeDispute({ disputeId: "d1" });
  await disputes.generateResolutionMessage({
    disputeId: "d1",
    resolutionType: "no_refund",
  });
  await disputes.generateResolutionMessage({
    disputeId: "d1",
    resolutionType: "partial_refund",
    refundAmount: 40,
  });

  assert.deepEqual(calls, [
    {
      method: "rephraseMessage",
      args: {
        disputeId: "d1",
        message: "Hello there",
        consentVersion: AI_CONSENT_VERSION,
      },
    },
    {
      method: "suggestResponses",
      args: { disputeId: "d1", consentVersion: AI_CONSENT_VERSION },
    },
    {
      method: "analyzeDispute",
      args: { disputeId: "d1", consentVersion: AI_CONSENT_VERSION },
    },
    {
      method: "generateResolutionMessage",
      args: {
        disputeId: "d1",
        resolutionType: "no_refund",
        consentVersion: AI_CONSENT_VERSION,
      },
    },
    {
      method: "generateResolutionMessage",
      args: {
        disputeId: "d1",
        resolutionType: "partial_refund",
        refundAmount: 40,
        consentVersion: AI_CONSENT_VERSION,
      },
    },
  ]);
});

test("a dispute analysis that arrives after the account changed is discarded", async () => {
  const { disputes, setReply, state } = setup({
    subject: "account:a",
    consented: ["account:a"],
  });
  let release: ((reply: unknown) => void) | undefined;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  setReply("analyzeDispute", () => {
    markStarted();
    return new Promise((resolve) => {
      release = resolve;
    });
  });

  const pending = disputes.analyzeDispute({ disputeId: "d1" });
  await started;
  state.subject = "account:b";
  state.generation += 1;
  release?.(disputeAnalysisReply());

  const error = await rejectionOf(pending);
  assert.ok(error instanceof AiRequestError);
  assert.equal(
    error.code,
    "account_changed",
    "the reviewer analysis is not shown to the new account",
  );
});

test("a dispute refusal is thrown with its code, including too_long", async () => {
  const { disputes, setReply } = setup({
    subject: "account:u1",
    consented: ["account:u1"],
  });
  setReply("rephraseMessage", async () => ({ ok: false, code: "too_long" }));

  const error = await rejectionOf(
    disputes.rephraseMessage({ disputeId: "d1", message: "x".repeat(2001) }),
  );

  assert.ok(error instanceof AiRequestError);
  assert.equal(error.code, "too_long");
});

test("an unchanged rephrase is returned with the same text, so the draft is kept", async () => {
  const { disputes, setReply } = setup({
    subject: "account:u1",
    consented: ["account:u1"],
  });
  setReply("rephraseMessage", async () => ({
    ok: true,
    source: "unchanged",
    rephrased: 'He said "no"',
  }));

  const result = await disputes.rephraseMessage({
    disputeId: "d1",
    message: 'He said "no"',
  });

  assert.deepEqual(result, {
    ok: true,
    source: "unchanged",
    rephrased: 'He said "no"',
  });
});

test("a malformed dispute analysis is unavailable, never a partial analysis", async () => {
  const { disputes, setReply } = setup({
    subject: "account:u1",
    consented: ["account:u1"],
  });
  setReply("analyzeDispute", async () => ({
    ...disputeAnalysisReply(),
    summary: 3,
  }));

  const error = await rejectionOf(disputes.analyzeDispute({ disputeId: "d1" }));

  assert.ok(error instanceof AiRequestError);
  assert.equal(error.code, "unavailable");
});

test("cart recommendation snapshots reach the transport without changing browsing requests", async () => {
  const { requests, calls } = setup({
    subject: "account:u1",
    consented: ["account:u1"],
  });
  await requests.getRecommendations({ limit: 3, cartProductIds: ["ps5"] });
  await requests.getRecommendations({ limit: 3 });
  assert.deepEqual(calls[0]?.args, {
    consentVersion: AI_CONSENT_VERSION,
    limit: 3,
    cartProductIds: ["ps5"],
  });
  assert.deepEqual(calls[1]?.args, {
    consentVersion: AI_CONSENT_VERSION,
    limit: 3,
  });
});
