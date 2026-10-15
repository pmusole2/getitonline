import assert from "node:assert/strict";
import test from "node:test";

import type { AiSubject } from "./aiConsent";
import {
  AiRequestError,
  advanceSubjectState,
  bindToSubject,
  createAiRequests,
  type AiSubjectState,
  type AiTransport,
} from "./aiRequests";

// These tests hold each await open, switch the active subject while it is open, and then release it. The subject
// source below advances a generation on every switch, the way the clients track the signed-in account.

interface Switchable {
  current(): AiSubjectState;
  switchTo(subject: AiSubject): void;
}

function subjectSource(initial: AiSubject): Switchable {
  let state: AiSubjectState = { subject: initial, generation: 0 };
  return {
    current: () => state,
    switchTo(subject) {
      state = { subject, generation: state.generation + 1 };
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settleTurns(): Promise<void> {
  await new Promise((done) => setImmediate(done));
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the call to reject");
}

const chatReply = { ok: true, source: "ai", reply: "Hello", actions: [] };

// Every transport method records its name, so a test can assert that nothing reached the provider.
function recordingTransport(calls: string[]): AiTransport {
  const reply = async (method: string, value: unknown) => {
    calls.push(method);
    return value;
  };
  return {
    chat: () => reply("chat", chatReply),
    getRecommendations: () =>
      reply("getRecommendations", { ok: true, source: "ai", products: [] }),
    similarProducts: () =>
      reply("similarProducts", { ok: true, source: "ai", productIds: [] }),
    visualSearch: () =>
      reply("visualSearch", { ok: true, source: "ai", productIds: [] }),
    moderateListing: () =>
      reply("moderateListing", {
        ok: true,
        source: "ai",
        saved: true,
        revision: 1,
        status: "clear",
        summary: "",
        flags: [],
      }),
  };
}

// Consent for account:a is held open by the test. Other subjects answer from the consented set at once.
function harness(options: { subject: AiSubject; consented: AiSubject[] }) {
  const source = subjectSource(options.subject);
  const calls: string[] = [];
  const consentChecks: AiSubject[] = [];
  const sessionReads: string[] = [];
  const held = deferred<boolean>();
  const consented = new Set<AiSubject>(options.consented);
  const requests = createAiRequests({
    transport: recordingTransport(calls),
    hasConsent: async (subject) => {
      consentChecks.push(subject);
      if (subject === options.subject) return held.promise;
      return consented.has(subject);
    },
    currentSubject: source.current,
    guestSessionId: async () => {
      sessionReads.push("read");
      return "guest-session-1";
    },
  });
  return { source, calls, consentChecks, sessionReads, requests, held };
}

test("a switch during the consent lookup never dispatches, for a consented next account", async () => {
  const { source, calls, requests, held } = harness({
    subject: "account:a",
    consented: ["account:b"],
  });

  const pending = requests.chat({ message: "A's private draft" });
  await settleTurns();
  source.switchTo("account:b");
  held.resolve(true);

  const error = await rejectionOf(pending);
  assert.ok(error instanceof AiRequestError);
  assert.equal(error.code, "account_changed");
  assert.deepEqual(calls, [], "the transport never runs under the new account");
});

test("a switch during the consent lookup never dispatches, for an unconsented next account", async () => {
  const { source, calls, requests, held } = harness({
    subject: "account:a",
    consented: [],
  });

  const pending = requests.chat({ message: "A's private draft" });
  await settleTurns();
  source.switchTo("account:b");
  held.resolve(true);

  const error = await rejectionOf(pending);
  assert.ok(error instanceof AiRequestError);
  assert.equal(
    error.code,
    "account_changed",
    "the switch is reported, not a consent refusal",
  );
  assert.deepEqual(calls, []);
});

test("a switch during the guest session lookup never dispatches", async () => {
  const sessionGate = deferred<string>();
  const source = subjectSource("guest");
  const calls: string[] = [];
  const requests = createAiRequests({
    transport: recordingTransport(calls),
    hasConsent: async () => true,
    currentSubject: source.current,
    guestSessionId: () => sessionGate.promise,
  });

  const pending = requests.chat({ message: "guest draft" });
  await settleTurns();
  source.switchTo("account:b");
  sessionGate.resolve("guest-session-1");

  const error = await rejectionOf(pending);
  assert.ok(error instanceof AiRequestError);
  assert.equal(error.code, "account_changed");
  assert.deepEqual(calls, []);
});

test("a switch made inside the last consent check, right before dispatch, never dispatches", async () => {
  const source = subjectSource("account:a");
  const calls: string[] = [];
  const requests = createAiRequests({
    transport: recordingTransport(calls),
    hasConsent: async (subject) => {
      if (subject === "account:a") {
        source.switchTo("account:b");
      }
      return true;
    },
    currentSubject: source.current,
    guestSessionId: async () => "unused",
  });

  const error = await rejectionOf(requests.chat({ message: "draft" }));

  assert.ok(error instanceof AiRequestError);
  assert.equal(error.code, "account_changed");
  assert.deepEqual(calls, [], "no dispatch happens after the subject moved");
});

test("an account to another account and back during the lookup is still a change", async () => {
  const { source, calls, requests, held } = harness({
    subject: "account:a",
    consented: ["account:a"],
  });

  const pending = requests.chat({ message: "draft" });
  await settleTurns();
  source.switchTo("account:b");
  source.switchTo("account:a");
  held.resolve(true);

  const error = await rejectionOf(pending);
  assert.ok(error instanceof AiRequestError);
  assert.equal(
    error.code,
    "account_changed",
    "the generation moved, so the call is not the same call",
  );
  assert.deepEqual(calls, []);
});

test("the same subject with no switch dispatches exactly once and returns the reply", async () => {
  const { calls, requests, held } = harness({
    subject: "account:a",
    consented: [],
  });

  const pending = requests.chat({ message: "hi" });
  await settleTurns();
  held.resolve(true);
  const reply = await pending;

  assert.equal(reply.ok, true);
  assert.deepEqual(calls, ["chat"]);
});

test("a callback bound to account A refuses to run under B, with no consent check, session read, or dispatch", async () => {
  const { source, calls, consentChecks, sessionReads, requests } = harness({
    subject: "account:a",
    consented: ["account:a", "account:b"],
  });
  const chatForA = bindToSubject(
    source.current(),
    source.current,
    (input: { message: string }) => requests.chat(input),
  );

  source.switchTo("account:b");
  const error = await rejectionOf(chatForA({ message: "A's draft" }));

  assert.ok(error instanceof AiRequestError);
  assert.equal(error.code, "account_changed");
  assert.deepEqual(
    consentChecks,
    [],
    "no consent is looked up for B on A's behalf",
  );
  assert.deepEqual(sessionReads, []);
  assert.deepEqual(calls, []);
});

test("a callback bound to A still dispatches while A is active, and a fresh callback works after the switch", async () => {
  const { source, calls, requests, held } = harness({
    subject: "account:a",
    consented: ["account:b"],
  });
  const chatBoundToA = bindToSubject(
    source.current(),
    source.current,
    (input: { message: string }) => requests.chat(input),
  );

  const pending = chatBoundToA({ message: "hi" });
  await settleTurns();
  held.resolve(true);
  assert.equal((await pending).ok, true);
  assert.deepEqual(calls, ["chat"]);

  source.switchTo("account:b");
  const chatBoundToB = bindToSubject(
    source.current(),
    source.current,
    (input: { message: string }) => requests.chat(input),
  );
  assert.equal((await chatBoundToB({ message: "hello from B" })).ok, true);
  assert.deepEqual(calls, ["chat", "chat"]);
});

test("advancing the subject keeps the generation for the same subject and moves it for a change", () => {
  const first: AiSubjectState = { subject: "account:a", generation: 4 };

  assert.equal(
    advanceSubjectState(first, "account:a"),
    first,
    "the same subject is the same state",
  );
  assert.deepEqual(advanceSubjectState(first, "account:b"), {
    subject: "account:b",
    generation: 5,
  });
});
