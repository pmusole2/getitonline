import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceSubjectState,
  createAiRequests,
  type AiRequestDeps,
  type AiSubjectState,
  type AiTransport,
} from "./aiRequests";
import type { AiSubject } from "./aiConsent";

// Each test isolates one checkpoint in aiRequests.ts. A test passes only if the checkpoint it names is the guard that
// refuses the call: the other checkpoints see no change, or the outcome would look the same without it.
//   C1 (admit, after the consent lookup): a consent answer that arrives after a switch is refused as the switched account.
//   C2 (settle, immediately before the transport call): a switch made while the request is being built is never sent.

const IMAGE = "data:image/jpeg;base64,AAAA";

interface Harness {
  readonly transportCalls: string[];
  readonly sessionReads: number;
  readonly state: () => AiSubjectState;
  switchTo(subject: AiSubject): void;
  requests: ReturnType<typeof createAiRequests>;
}

function harness(options: {
  start: AiSubject;
  consent: (switchTo: (subject: AiSubject) => void) => Promise<boolean>;
}): Harness {
  let state: AiSubjectState = { subject: options.start, generation: 0 };
  const transportCalls: string[] = [];
  let sessionReads = 0;
  const switchTo = (subject: AiSubject) => {
    state = advanceSubjectState(state, subject);
  };
  const transport: AiTransport = {
    chat: async () => {
      transportCalls.push("chat");
      return undefined;
    },
    getRecommendations: async () => {
      transportCalls.push("getRecommendations");
      return undefined;
    },
    similarProducts: async () => {
      transportCalls.push("similarProducts");
      return undefined;
    },
    visualSearch: async () => {
      transportCalls.push("visualSearch");
      return { ok: true, source: "ai", query: "red shoes", terms: ["red"] };
    },
    moderateListing: async () => {
      transportCalls.push("moderateListing");
      return undefined;
    },
  };
  const deps: AiRequestDeps = {
    transport,
    hasConsent: () => options.consent(switchTo),
    currentSubject: () => state,
    guestSessionId: async () => {
      sessionReads += 1;
      return "guest-session-1";
    },
  };
  const h: Harness = {
    transportCalls,
    get sessionReads() {
      return sessionReads;
    },
    state: () => state,
    switchTo,
    requests: createAiRequests(deps),
  };
  return h;
}

const accountChanged = (error: unknown) =>
  error instanceof Error &&
  error.name === "AiRequestError" &&
  error.message.includes("account_changed");

test("C1: a consent refusal that arrives after the account changed is reported as account_changed", async () => {
  const h = harness({
    start: "account:clerk_a",
    consent: async (switchTo) => {
      switchTo("account:clerk_b");
      return false;
    },
  });

  await assert.rejects(
    h.requests.visualSearch({ imageDataUrl: IMAGE }),
    accountChanged,
  );
  assert.deepEqual(h.transportCalls, [], "nothing is sent");
});

test("C1: a guest whose consent lookup answers after a switch reads no session id and sends nothing", async () => {
  const h = harness({
    start: "guest",
    consent: async (switchTo) => {
      switchTo("account:clerk_b");
      return true;
    },
  });

  await assert.rejects(
    h.requests.visualSearch({ imageDataUrl: IMAGE }),
    accountChanged,
  );
  assert.equal(
    h.sessionReads,
    0,
    "no guest session is read on behalf of a subject that is no longer active",
  );
  assert.deepEqual(h.transportCalls, []);
});

test("C2: a switch made while the request is being built is refused before the transport is called", async () => {
  const h = harness({
    start: "account:clerk_a",
    consent: async () => true,
  });
  // The caller's photo is read while the transport arguments are built, after the consent check and before dispatch.
  // Reading it changes the active account, so only the check immediately before dispatch can see the change.
  const input = {
    get imageDataUrl(): string {
      h.switchTo("account:clerk_b");
      return IMAGE;
    },
  };

  await assert.rejects(h.requests.visualSearch(input), accountChanged);
  assert.deepEqual(
    h.transportCalls,
    [],
    "the transport is never called for the account that was replaced",
  );
});

test("C2: the same request with no switch reaches the transport exactly once", async () => {
  const h = harness({
    start: "account:clerk_a",
    consent: async () => true,
  });

  const reply = await h.requests.visualSearch({ imageDataUrl: IMAGE });

  assert.equal(reply.query, "red shoes");
  assert.deepEqual(h.transportCalls, ["visualSearch"]);
});
