import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, URL } from "node:url";

import { getFunctionName } from "convex/server";

import * as shared from "../../../../packages/shared/src/index";
import { api } from "../../../../convex/_generated/api";
import {
  aiConsentStorageKey,
  GUEST_SESSION_STORAGE_KEY,
  recordAiConsent,
  type AiSubject,
  type KeyValueStore,
} from "../../../../packages/shared/src/index";
import {
  createControls,
  createHarness,
  withFallback,
} from "../../../../tests/support/componentHarness";
import type { WebAiActions } from "./useAiActions";
import type { useAiActions as UseAiActions } from "./useAiActions";

// Runs the real web useAiActions hook. The Convex actions are recorded by name, and the browser store is an in-memory
// store whose reads can be held open, so a test switches the signed-in account while a consent or session lookup is pending.

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const repoFile = (relativePath: string) => resolve(repoRoot, relativePath);
const hookFile = repoFile("apps/web/src/hooks/useAiActions.ts");
const consentGateFile = repoFile("apps/web/src/hooks/aiConsentGate.ts");

interface ActionCall {
  readonly action: string;
  readonly args: Record<string, unknown>;
}

const actionNames = new Map<string, string>([
  [getFunctionName(api.aiDiscovery.visualSearch), "visualSearch"],
  [getFunctionName(api.aiModeration.moderateListing), "moderateListing"],
]);

const replies: Record<string, unknown> = {
  visualSearch: {
    ok: true,
    source: "ai",
    query: "red shoes",
    terms: ["red", "shoes"],
  },
  moderateListing: {
    ok: true,
    source: "ai",
    saved: true,
    revision: 1,
    status: "clear",
    summary: "Looks fine.",
    flags: [],
  },
};

const IMAGE = "data:image/jpeg;base64,AAAA";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Reads of a held key wait until the test releases them. Every other read answers at once.
function browserMemory() {
  const values = new Map<string, string>();
  const holds = new Map<string, Promise<void>>();
  const reads: string[] = [];
  const store: KeyValueStore = {
    async getItem(key) {
      reads.push(key);
      const hold = holds.get(key);
      if (hold !== undefined) {
        holds.delete(key);
        await hold;
      }
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
  };
  return {
    store,
    values,
    reads,
    holdNextRead(key: string) {
      const gate = deferred<void>();
      holds.set(key, gate.promise);
      return () => gate.resolve();
    },
  };
}

interface WebHarness {
  readonly actions: () => WebAiActions;
  readonly calls: ActionCall[];
  readonly memory: ReturnType<typeof browserMemory>;
  switchAccount(userId: string | null): WebAiActions;
}

async function renderWebActions(options: {
  userId: string | null;
  consentedFor: AiSubject[];
  onRead?: (key: string) => void;
}): Promise<WebHarness> {
  const controls = createControls();
  controls.auth = { userId: options.userId };
  const memory = browserMemory();
  for (const subject of options.consentedFor) {
    await recordAiConsent(memory.store, subject);
  }
  const calls: ActionCall[] = [];
  // The real consent gate, with only its browser store replaced. The decision the hook uses is the real one.
  const realGate = createHarness({ controls: createControls() }).load(
    consentGateFile,
  );

  const harness = createHarness({
    controls,
    effects: true,
    convexApi: { api },
    files: {
      [consentGateFile]: withFallback({
        ...realGate,
        browserStore: memory.store,
      }),
    },
    packages: {
      "@gettitonline/shared": withFallback({ ...shared }),
      "@clerk/nextjs": withFallback({
        useAuth: () => {
          controls.hook("useAuth");
          return controls.auth;
        },
      }),
      "convex/react": withFallback({
        useAction: (reference: Parameters<typeof getFunctionName>[0]) => {
          const action =
            actionNames.get(getFunctionName(reference)) ?? "unknown";
          return async (args: Record<string, unknown>) => {
            calls.push({ action, args });
            return replies[action];
          };
        },
      }),
    },
  });

  const useHook = harness.load(hookFile).useAiActions as typeof UseAiActions;
  const holder: { actions?: WebAiActions } = {};
  // The probe reports what the hook returned to the holder, so the component body only calls the hook.
  const report = (value: WebAiActions) => {
    holder.actions = value;
  };
  const Probe = (props: { report: typeof report }): null => {
    props.report(useHook());
    return null;
  };
  harness.render(Probe, { report });

  return {
    actions: () => {
      if (holder.actions === undefined)
        throw new Error("the hook must return actions");
      return holder.actions;
    },
    calls,
    memory,
    switchAccount: (userId) => {
      controls.auth = { userId };
      harness.render(Probe, { report });
      if (holder.actions === undefined)
        throw new Error("the hook must return actions");
      return holder.actions;
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const rejectsWith = (code: string) => (error: unknown) =>
  error instanceof Error &&
  error.name === "AiRequestError" &&
  error.message.includes(code);

describe("web useAiActions stale-subject guards", () => {
  it("a switch during the consent lookup dispatches nothing, even when the next account is consented", async () => {
    const web = await renderWebActions({
      userId: "clerk_a",
      consentedFor: ["account:clerk_a", "account:clerk_b"],
    });
    const release = web.memory.holdNextRead(
      aiConsentStorageKey("account:clerk_a"),
    );

    const pending = web.actions().visualSearch({ imageDataUrl: IMAGE });
    await tick();
    web.switchAccount("clerk_b");
    release();

    await assert.rejects(pending, rejectsWith("account_changed"));
    assert.deepEqual(
      web.calls,
      [],
      "the transport is never called under the new account",
    );
  });

  it("a switch during the guest session lookup dispatches nothing", async () => {
    const web = await renderWebActions({
      userId: null,
      consentedFor: ["guest", "account:clerk_b"],
    });
    const release = web.memory.holdNextRead(GUEST_SESSION_STORAGE_KEY);

    const pending = web.actions().visualSearch({ imageDataUrl: IMAGE });
    await tick();
    web.switchAccount("clerk_b");
    release();

    await assert.rejects(pending, rejectsWith("account_changed"));
    assert.deepEqual(web.calls, []);
  });

  it("a switch made inside the last consent read, right before dispatch, dispatches nothing", async () => {
    const web = await renderWebActions({
      userId: "clerk_a",
      consentedFor: ["account:clerk_a", "account:clerk_b"],
    });
    const release = web.memory.holdNextRead(
      aiConsentStorageKey("account:clerk_a"),
    );

    const pending = web.actions().moderateListing({ productId: "products_1" });
    await tick();
    web.switchAccount("clerk_b");
    release();

    await assert.rejects(pending, rejectsWith("account_changed"));
    assert.deepEqual(web.calls, []);
  });

  it("a callback created for A refuses to run under B, with no consent read and no transport call", async () => {
    const web = await renderWebActions({
      userId: "clerk_a",
      consentedFor: ["account:clerk_a", "account:clerk_b"],
    });
    const visualForA = web.actions().visualSearch;
    const readsBefore = web.memory.reads.length;

    web.switchAccount("clerk_b");

    await assert.rejects(
      visualForA({ imageDataUrl: IMAGE }),
      rejectsWith("account_changed"),
    );
    assert.equal(
      web.memory.reads
        .slice(readsBefore)
        .includes(aiConsentStorageKey("account:clerk_b")),
      false,
      "B's consent is never read on behalf of A",
    );
    assert.deepEqual(web.calls, []);
  });

  it("a callback created after the switch dispatches exactly once for the new account", async () => {
    const web = await renderWebActions({
      userId: "clerk_a",
      consentedFor: ["account:clerk_a", "account:clerk_b"],
    });

    const fresh = web.switchAccount("clerk_b");
    const result = await fresh.visualSearch({ imageDataUrl: IMAGE });

    assert.equal(result.query, "red shoes");
    assert.deepEqual(
      web.calls.map((call) => call.action),
      ["visualSearch"],
    );
  });

  it("the same subject with no switch dispatches exactly once", async () => {
    const web = await renderWebActions({
      userId: "clerk_a",
      consentedFor: ["account:clerk_a"],
    });

    await web.actions().visualSearch({ imageDataUrl: IMAGE });

    assert.equal(web.calls.length, 1);
  });
});
