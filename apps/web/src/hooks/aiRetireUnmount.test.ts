import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, URL } from "node:url";
import * as React from "react";
import { createElement } from "react";
import * as ReactDomClient from "react-dom/client";
import type { ReactNode } from "react";

import * as ReactConvex from "convex/react";
import { getFunctionName } from "convex/server";

import * as shared from "../../../../packages/shared/src/index";
import { api } from "../../../../convex/_generated/api";
import {
  recordAiConsent,
  type AiSubject,
  type KeyValueStore,
} from "../../../../packages/shared/src/index";
import {
  mountUnderConvex,
  type FakeConvexClient,
} from "../../../../tests/support/realReactRender";
import {
  createHarness,
  withFallback,
  createControls,
} from "../../../../tests/support/componentHarness";
import type { WebAiActions } from "./useAiActions";
import type { useAiActions as UseAiActions } from "./useAiActions";

// Real React (react-dom and the real useAction from convex/react under a real ConvexProvider) renders the real web hook.
// A subject change is a keyed remount, as ConvexClientProvider does it. The Clerk auth and the browser storage are
// the only stand-ins, so a test controls which account is active and what the browser remembers.

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const hookFile = resolve(repoRoot, "apps/web/src/hooks/useAiActions.ts");

const IMAGE = "data:image/jpeg;base64,AAAA";
const tick = () => new Promise((done) => setImmediate(done));

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) {
    await tick();
  }
  assert.equal(predicate(), true, "the condition was not reached");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const VISUAL_SEARCH = getFunctionName(api.aiDiscovery.visualSearch);
const replies: Record<string, unknown> = {
  [VISUAL_SEARCH]: {
    ok: true,
    source: "ai",
    query: "red shoes",
    terms: ["red", "shoes"],
  },
};

interface ActionCall {
  readonly action: string;
  readonly args: Record<string, unknown>;
}

// The real useAction calls client.action with the function reference. A held call waits until the test releases it.
function actionClient() {
  const calls: ActionCall[] = [];
  const holds: Array<{
    resolve: (value: unknown) => void;
    promise: Promise<unknown>;
  }> = [];
  const client = {
    action(
      reference: Parameters<typeof getFunctionName>[0],
      args: unknown,
    ): Promise<unknown> {
      const name = getFunctionName(reference);
      calls.push({
        action: name === VISUAL_SEARCH ? "visualSearch" : name,
        args: isRecord(args) ? args : {},
      });
      const hold = holds.shift();
      if (hold !== undefined) {
        return hold.promise;
      }
      return Promise.resolve(replies[name]);
    },
  };
  return {
    client,
    calls,
    holdNextCall(): (value: unknown) => void {
      let resolve: (value: unknown) => void = () => undefined;
      const promise = new Promise<unknown>((done) => {
        resolve = done;
      });
      holds.push({ resolve, promise });
      return resolve;
    },
  };
}

function consentStorage() {
  const values = new Map<string, string>();
  const store: KeyValueStore = {
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
  };
  return {
    store,
    values,
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
  };
}

interface HookEnv {
  readonly controls: ReturnType<typeof createControls>;
  readonly actions: ReturnType<typeof actionClient>;
  readonly mounted: ReturnType<typeof mountUnderConvex>;
  readonly reports: Map<string, WebAiActions>;
  readonly useHook: typeof UseAiActions;
}

interface ProbeProps {
  readonly label: string;
  readonly useHook: typeof UseAiActions;
  readonly reports: Map<string, WebAiActions>;
}

// The probe is a real component: it calls the real hook during its render, and records what the hook returned.
function Probe(props: ProbeProps): null {
  props.reports.set(props.label, props.useHook());
  return null;
}

async function setUp(signedInAs: string | null): Promise<HookEnv> {
  const controls = createControls();
  controls.auth = { userId: signedInAs };
  const actions = actionClient();
  const fake: FakeConvexClient = {
    client: actions.client,
    lifecycle: [],
    deliver: () => undefined,
  };
  const mounted = mountUnderConvex(fake);

  const storage = consentStorage();
  const win: unknown = Reflect.get(globalThis, "window");
  if (typeof win !== "object" || win === null) {
    throw new Error("the window must exist after mounting");
  }
  Reflect.set(win, "localStorage", storage);
  for (const subject of ["account:clerk_a", "account:clerk_b"] as AiSubject[]) {
    await recordAiConsent(storage.store, subject);
  }

  const harness = createHarness({
    controls,
    convexApi: { api },
    packages: {
      react: withFallback({ ...React }),
      "@gettitonline/shared": withFallback({ ...shared }),
      "convex/react": withFallback({ ...ReactConvex }),
      "@clerk/nextjs": withFallback({
        useAuth: () => controls.auth,
      }),
    },
  });
  const useHook = harness.load(hookFile).useAiActions as typeof UseAiActions;
  return { controls, actions, mounted, reports: new Map(), useHook };
}

// realReactRender's root is not strict, and react-dom replays layout effects only in a strict root. A root created with
// unstable_strictMode replays them as setup, cleanup, setup in one synchronous commit, as the development app does. This
// renders the Convex provider into such a root, in the document mountUnderConvex installed.
interface DocumentLike {
  createElement(tag: string): object;
}

interface StrictRoot {
  render(children: ReactNode): void;
  unmount(): void;
}

interface StrictRenderer {
  createRoot(container: object, options: object): StrictRoot;
}

interface StrictProviderModule {
  ConvexProvider(props: {
    client: object;
    children?: ReactNode;
  }): ReactNode | Promise<ReactNode>;
}

const strictRenderer: StrictRenderer = ReactDomClient;
const strictProviders: StrictProviderModule = ReactConvex;

function isDocumentLike(value: unknown): value is DocumentLike {
  return isRecord(value) && typeof value.createElement === "function";
}

async function renderInStrictRoot(
  client: object,
  element: ReactNode,
): Promise<void> {
  const win: unknown = Reflect.get(globalThis, "window");
  const doc: unknown = isRecord(win) ? Reflect.get(win, "document") : undefined;
  if (!isDocumentLike(doc)) {
    throw new Error("mountUnderConvex must install a document first");
  }
  const root = strictRenderer.createRoot(doc.createElement("div"), {
    unstable_strictMode: true,
  });
  await React.act(async () => {
    root.render(
      createElement(strictProviders.ConvexProvider, { client }, element),
    );
  });
}

function probe(env: HookEnv, label: string, key: string): ReactNode {
  return createElement(Probe, {
    key,
    label,
    useHook: env.useHook,
    reports: env.reports,
  });
}

function actionsFor(env: HookEnv, label: string): WebAiActions {
  const actions = env.reports.get(label);
  if (actions === undefined) {
    throw new Error(`the ${label} hook must have rendered`);
  }
  return actions;
}

const rejectsWith = (code: string) => (error: unknown) =>
  error instanceof Error &&
  error.name === "AiRequestError" &&
  error.message.includes(code);

describe("web useAiActions after a keyed remount", () => {
  it("a pending reply from the old account is refused after the remount to the new account", async () => {
    const env = await setUp("clerk_a");
    await env.mounted.render(probe(env, "A", "clerk_a"));
    const a = actionsFor(env, "A");
    const releaseA = env.actions.holdNextCall();

    const pendingA = a.visualSearch({ imageDataUrl: IMAGE });
    await until(() => env.actions.calls.length === 1);

    env.controls.auth = { userId: "clerk_b" };
    await env.mounted.render(probe(env, "B", "clerk_b"));
    releaseA(replies[VISUAL_SEARCH]);

    await assert.rejects(pendingA, rejectsWith("account_changed"));
    assert.equal(
      a.isCurrent(),
      false,
      "the old account's hook is no longer current",
    );
  });

  it("after the remount, the old account's callbacks never reach the transport", async () => {
    const env = await setUp("clerk_a");
    await env.mounted.render(probe(env, "A", "clerk_a"));
    const a = actionsFor(env, "A");

    env.controls.auth = { userId: "clerk_b" };
    await env.mounted.render(probe(env, "B", "clerk_b"));

    await assert.rejects(
      a.visualSearch({ imageDataUrl: IMAGE }),
      rejectsWith("account_changed"),
    );
    assert.deepEqual(
      env.actions.calls,
      [],
      "no call is sent on behalf of the old account",
    );
  });

  it("the new account's hook still dispatches exactly once after the remount", async () => {
    const env = await setUp("clerk_a");
    await env.mounted.render(probe(env, "A", "clerk_a"));

    env.controls.auth = { userId: "clerk_b" };
    await env.mounted.render(probe(env, "B", "clerk_b"));
    const result = await actionsFor(env, "B").visualSearch({
      imageDataUrl: IMAGE,
    });

    assert.equal(result.query, "red shoes");
    assert.deepEqual(
      env.actions.calls.map((call) => call.action),
      ["visualSearch"],
    );
    assert.equal(actionsFor(env, "B").isCurrent(), true);
  });

  it("a real unmount with no remount refuses a pending reply", async () => {
    const env = await setUp("clerk_a");
    await env.mounted.render(probe(env, "A", "clerk_a"));
    const a = actionsFor(env, "A");
    const releaseA = env.actions.holdNextCall();

    const pendingA = a.visualSearch({ imageDataUrl: IMAGE });
    await until(() => env.actions.calls.length === 1);
    await env.mounted.unmount();
    releaseA(replies[VISUAL_SEARCH]);

    await assert.rejects(pendingA, rejectsWith("account_changed"));
    assert.equal(a.isCurrent(), false);
  });

  it("re-rendering the same account keeps the hook current and its callbacks working", async () => {
    const env = await setUp("clerk_a");
    await env.mounted.render(probe(env, "A", "clerk_a"));
    await env.mounted.render(probe(env, "A", "clerk_a"));

    const result = await actionsFor(env, "A").visualSearch({
      imageDataUrl: IMAGE,
    });

    assert.equal(result.query, "red shoes");
    assert.equal(actionsFor(env, "A").isCurrent(), true);
    assert.equal(env.actions.calls.length, 1);
  });

  it("in a StrictMode root, the effect replay does not retire a live hook", async () => {
    const env = await setUp("clerk_a");
    await renderInStrictRoot(env.actions.client, probe(env, "A", "clerk_a"));
    const a = actionsFor(env, "A");

    const result = await a.visualSearch({ imageDataUrl: IMAGE });

    assert.equal(result.query, "red shoes");
    assert.equal(a.isCurrent(), true);
    assert.equal(env.actions.calls.length, 1);
  });
});
