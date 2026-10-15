import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, URL } from "node:url";
import * as React from "react";
import { act, createElement } from "react";
import type { ReactNode } from "react";
import * as jsxRuntime from "react/jsx-runtime";

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
  createControls,
  createHarness,
  withFallback,
} from "../../../../tests/support/componentHarness";
import type { WebAiActions } from "./useAiActions";
import type { useAiActions as UseAiActions } from "./useAiActions";
import type { useAiConsentGate as UseAiConsentGate } from "./useAiConsentGate";

// The real consent gate and the real action hook run together under real React. Both read the same browser store, so
// the test sees one consent decision. The store is a localStorage stand-in that can fail reads or writes, as private
// mode and a full quota do. The dialog is the only component stand-in: the test accepts it through its onAccept prop.

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const hookFile = resolve(repoRoot, "apps/web/src/hooks/useAiActions.ts");
const gateFile = resolve(repoRoot, "apps/web/src/hooks/useAiConsentGate.tsx");
const dialogFile = resolve(
  repoRoot,
  "apps/web/src/components/ai/AiConsentDialog.tsx",
);

const IMAGE = "data:image/jpeg;base64,AAAA";
const tick = () => new Promise((done) => setImmediate(done));

async function until(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) {
    await tick();
  }
  assert.equal(predicate(), true, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const VISUAL_SEARCH = getFunctionName(api.aiDiscovery.visualSearch);
const MODERATE = getFunctionName(api.aiModeration.moderateListing);
const replies: Record<string, unknown> = {
  [VISUAL_SEARCH]: {
    ok: true,
    source: "ai",
    query: "red shoes",
    terms: ["red", "shoes"],
  },
  [MODERATE]: {
    ok: true,
    source: "ai",
    saved: true,
    revision: 1,
    status: "clear",
    summary: "Looks fine.",
    flags: [],
  },
};

interface ActionCall {
  readonly action: string;
  readonly args: Record<string, unknown>;
}

function actionClient() {
  const calls: ActionCall[] = [];
  const client = {
    action(
      reference: Parameters<typeof getFunctionName>[0],
      args: unknown,
    ): Promise<unknown> {
      const name = getFunctionName(reference);
      calls.push({
        action:
          name === VISUAL_SEARCH
            ? "visualSearch"
            : name === MODERATE
              ? "moderateListing"
              : name,
        args: isRecord(args) ? args : {},
      });
      return Promise.resolve(replies[name]);
    },
  };
  return { client, calls };
}

// A localStorage stand-in. Reads and writes fail while the matching flag is set, as they do in a restricted browser.
function browserStorage() {
  const values = new Map<string, string>();
  const control = { failReads: false, failWrites: false };
  const adapter: KeyValueStore = {
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
  };
  return {
    values,
    control,
    adapter,
    getItem(key: string): string | null {
      if (control.failReads) {
        throw new Error("SecurityError: storage is disabled");
      }
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      if (control.failWrites) {
        throw new Error("QuotaExceededError");
      }
      values.set(key, value);
    },
  };
}

type Gate = ReturnType<typeof UseAiConsentGate>;

interface Rendered {
  readonly actions: WebAiActions;
  readonly gate: Gate;
}

interface ProbeProps {
  readonly label: string;
  readonly useHook: typeof UseAiActions;
  readonly useGate: typeof UseAiConsentGate;
  readonly reports: Map<string, Rendered>;
}

// The probe is a real component. It calls the real action hook, then the real consent gate for the subject that hook reports.
function Probe(props: ProbeProps): null {
  const actions = props.useHook();
  const gate = props.useGate(actions.subject);
  props.reports.set(props.label, { actions, gate });
  return null;
}

interface Env {
  readonly controls: ReturnType<typeof createControls>;
  readonly calls: ActionCall[];
  readonly storage: ReturnType<typeof browserStorage>;
  readonly mounted: ReturnType<typeof mountUnderConvex>;
  readonly reports: Map<string, Rendered>;
  readonly useHook: typeof UseAiActions;
  readonly useGate: typeof UseAiConsentGate;
}

async function setUp(options: {
  signedInAs: string;
  consentedFor?: AiSubject[];
}): Promise<Env> {
  const controls = createControls();
  controls.auth = { userId: options.signedInAs };
  const transport = actionClient();
  const fake: FakeConvexClient = {
    client: transport.client,
    lifecycle: [],
    deliver: () => undefined,
  };
  const mounted = mountUnderConvex(fake);

  const storage = browserStorage();
  const win: unknown = Reflect.get(globalThis, "window");
  if (typeof win !== "object" || win === null) {
    throw new Error("the window must exist after mounting");
  }
  Reflect.set(win, "localStorage", storage);
  for (const subject of options.consentedFor ?? []) {
    await recordAiConsent(storage.adapter, subject);
  }

  const harness = createHarness({
    controls,
    aliases: { "@/": resolve(repoRoot, "apps/web/src") },
    convexApi: { api },
    files: {
      [dialogFile]: withFallback({ AiConsentDialog: () => null }),
    },
    packages: {
      react: withFallback({ ...React }),
      "react/jsx-runtime": withFallback({ ...jsxRuntime }),
      "@gettitonline/shared": withFallback({ ...shared }),
      "convex/react": withFallback({ ...ReactConvex }),
      "@clerk/nextjs": withFallback({ useAuth: () => controls.auth }),
    },
  });
  return {
    controls,
    calls: transport.calls,
    storage,
    mounted,
    reports: new Map(),
    useHook: harness.load(hookFile).useAiActions as typeof UseAiActions,
    useGate: harness.load(gateFile).useAiConsentGate as typeof UseAiConsentGate,
  };
}

function probe(env: Env, label: string, key: string): ReactNode {
  return createElement(Probe, {
    key,
    label,
    useHook: env.useHook,
    useGate: env.useGate,
    reports: env.reports,
  });
}

function renderedFor(env: Env, label: string): Rendered {
  const rendered = env.reports.get(label);
  if (rendered === undefined) {
    throw new Error(`the ${label} hooks must have rendered`);
  }
  return rendered;
}

function dialogOpen(env: Env, label: string): boolean {
  return renderedFor(env, label).gate.consentDialog.props.open === true;
}

// Accepts the open disclosure, as the person does with the dialog's accept button.
function acceptDialog(env: Env, label: string): void {
  const dialog: unknown = renderedFor(env, label).gate.consentDialog;
  if (
    !isRecord(dialog) ||
    !isRecord(dialog.props) ||
    typeof dialog.props.onAccept !== "function"
  ) {
    throw new Error("the consent dialog must expose onAccept");
  }
  const onAccept: unknown = dialog.props.onAccept;
  if (typeof onAccept !== "function") {
    throw new Error("onAccept must be a function");
  }
  onAccept();
}

// Starts a gated request as a page does: the gate decides, and the request runs only when consent allows it.
async function gatedVisualSearch(
  env: Env,
  label: string,
  onRun: () => void,
): Promise<void> {
  const { actions, gate } = renderedFor(env, label);
  await act(async () => {
    await gate.runWithConsent(
      "image_search",
      async () => {
        onRun();
        await actions.visualSearch({ imageDataUrl: IMAGE });
      },
      () => undefined,
    );
  });
}

describe("web consent: the gate and the action hook share one decision", () => {
  it("an acceptance the browser could not store still admits the visual search, which dispatches exactly once", async () => {
    const env = await setUp({ signedInAs: "clerk_a" });
    env.storage.control.failWrites = true;
    await act(async () => {
      await env.mounted.render(probe(env, "A", "clerk_a"));
    });
    let runs = 0;

    await gatedVisualSearch(env, "A", () => {
      runs += 1;
    });
    await until(
      () => dialogOpen(env, "A"),
      "the disclosure must open for an unconsented account",
    );
    act(() => {
      acceptDialog(env, "A");
    });
    await until(
      () => env.calls.length === 1,
      "the accepted request must reach the transport once the person has accepted",
    );
    await tick();

    assert.equal(runs, 1, "the gated request runs exactly once");
    assert.deepEqual(
      env.calls.map((call) => call.action),
      ["visualSearch"],
    );
  });

  it("an acceptance the browser could not store also admits moderation, which dispatches exactly once", async () => {
    const env = await setUp({ signedInAs: "clerk_a" });
    env.storage.control.failWrites = true;
    await act(async () => {
      await env.mounted.render(probe(env, "A", "clerk_a"));
    });
    const { actions, gate } = renderedFor(env, "A");

    await act(async () => {
      await gate.runWithConsent(
        "listing_moderation",
        async () => {
          await actions.moderateListing({ productId: "products_1" });
        },
        () => undefined,
      );
    });
    await until(
      () => dialogOpen(env, "A"),
      "the disclosure must open for an unconsented account",
    );
    act(() => {
      acceptDialog(env, "A");
    });
    await until(
      () => env.calls.length === 1,
      "the accepted moderation must reach the transport once",
    );
    await tick();

    assert.deepEqual(
      env.calls.map((call) => call.action),
      ["moderateListing"],
    );
  });

  it("an acceptance held in memory is not inherited by another subject", async () => {
    const env = await setUp({ signedInAs: "clerk_a" });
    env.storage.control.failWrites = true;
    await act(async () => {
      await env.mounted.render(probe(env, "A", "clerk_a"));
    });
    await gatedVisualSearch(env, "A", () => undefined);
    await until(
      () => dialogOpen(env, "A"),
      "the disclosure must open for account A",
    );
    act(() => {
      acceptDialog(env, "A");
    });
    await until(
      () => env.calls.length === 1,
      "account A's accepted request must dispatch",
    );

    env.controls.auth = { userId: "clerk_b" };
    await act(async () => {
      await env.mounted.render(probe(env, "B", "clerk_b"));
    });
    await assert.rejects(
      renderedFor(env, "B").actions.visualSearch({ imageDataUrl: IMAGE }),
      (error: unknown) =>
        error instanceof Error && error.message.includes("consent_required"),
    );
    assert.equal(env.calls.length, 1, "account B's request sends nothing");

    let bRuns = 0;
    await gatedVisualSearch(env, "B", () => {
      bRuns += 1;
    });
    await until(
      () => dialogOpen(env, "B"),
      "account B must be prompted, not admitted by A's acceptance",
    );
    assert.equal(
      bRuns,
      0,
      "account B's gated request does not run before it accepts",
    );
  });

  it("a storage read failure still prompts, and the hook refuses without sending", async () => {
    const env = await setUp({
      signedInAs: "clerk_a",
      consentedFor: ["account:clerk_a"],
    });
    env.storage.control.failReads = true;
    await act(async () => {
      await env.mounted.render(probe(env, "A", "clerk_a"));
    });

    await assert.rejects(
      renderedFor(env, "A").actions.visualSearch({ imageDataUrl: IMAGE }),
      (error: unknown) =>
        error instanceof Error && error.message.includes("consent_required"),
    );
    assert.equal(env.calls.length, 0);

    await gatedVisualSearch(env, "A", () => undefined);
    await until(
      () => dialogOpen(env, "A"),
      "an unreadable consent record must prompt again",
    );
  });

  it("a stored consent is admitted by the gate and the hook alike, with no prompt", async () => {
    const env = await setUp({
      signedInAs: "clerk_a",
      consentedFor: ["account:clerk_a"],
    });
    await act(async () => {
      await env.mounted.render(probe(env, "A", "clerk_a"));
    });
    let runs = 0;

    await gatedVisualSearch(env, "A", () => {
      runs += 1;
    });
    await until(
      () => env.calls.length === 1,
      "a consented request must dispatch",
    );

    assert.equal(runs, 1);
    assert.equal(
      dialogOpen(env, "A"),
      false,
      "no disclosure opens for a consented account",
    );
  });
});
