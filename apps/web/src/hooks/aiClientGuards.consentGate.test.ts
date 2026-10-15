import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath, URL } from "node:url";

import * as shared from "../../../../packages/shared/src/index";
import {
  aiConsentStorageKey,
  hasCurrentAiConsent,
  type AiSubject,
} from "../../../../packages/shared/src/index";
import {
  createControls,
  createHarness,
  withFallback,
} from "../../../../tests/support/componentHarness";
import {
  acceptAiConsent,
  browserStore,
  decideAiConsent,
} from "./aiConsentGate";
import type { useAiConsentGate as UseAiConsentGate } from "./useAiConsentGate";

// The real browser store runs against a window.localStorage that can be made to throw, as in private mode or when the
// quota is full. The gate must settle in every case, and no rejection may escape a discarded promise.

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const repoFile = (relativePath: string) => resolve(repoRoot, relativePath);
const gateFile = repoFile("apps/web/src/hooks/useAiConsentGate.tsx");
const dialogFile = repoFile("apps/web/src/components/ai/AiConsentDialog.tsx");

interface StorageControl {
  readonly values: Map<string, string>;
  failReads: boolean;
  failWrites: boolean;
}

const subject: AiSubject = "account:clerk_a";

function installLocalStorage(): StorageControl {
  const control: StorageControl = {
    values: new Map(),
    failReads: false,
    failWrites: false,
  };
  const localStorage = {
    getItem(key: string): string | null {
      if (control.failReads)
        throw new Error("SecurityError: storage is disabled");
      return control.values.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      if (control.failWrites) throw new Error("QuotaExceededError");
      control.values.set(key, value);
    },
  };
  Object.defineProperty(globalThis, "window", {
    value: { localStorage },
    configurable: true,
    writable: true,
  });
  return control;
}

function removeWindow(): void {
  Reflect.deleteProperty(globalThis, "window");
}

interface DialogProps {
  readonly open: boolean;
  readonly onAccept: () => void;
  readonly onDecline: () => void;
}

function isDialogProps(value: unknown): value is DialogProps {
  return (
    typeof value === "object" &&
    value !== null &&
    "open" in value &&
    "onAccept" in value &&
    "onDecline" in value
  );
}

function dialogOf(element: unknown): DialogProps {
  if (
    typeof element === "object" &&
    element !== null &&
    "props" in element &&
    isDialogProps(element.props)
  ) {
    return element.props;
  }
  throw new Error("the consent dialog element is missing");
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function renderGate() {
  const controls = createControls();
  const harness = createHarness({
    controls,
    effects: true,
    aliases: { "@/": resolve(repoRoot, "apps/web/src") },
    files: {
      [dialogFile]: withFallback({ AiConsentDialog: () => null }),
    },
    packages: {
      "@gettitonline/shared": withFallback({ ...shared }),
    },
  });
  const useGate = harness.load(gateFile)
    .useAiConsentGate as typeof UseAiConsentGate;
  const holder: { gate?: ReturnType<typeof UseAiConsentGate> } = {};
  // The probe reports what the hook returned to the holder, so the component body only calls the hook.
  const report = (value: ReturnType<typeof UseAiConsentGate>) => {
    holder.gate = value;
  };
  const Probe = (props: { report: typeof report }): null => {
    props.report(useGate(subject));
    return null;
  };
  harness.render(Probe, { report });
  const gate = () => {
    if (holder.gate === undefined)
      throw new Error("the gate must return its handlers");
    return holder.gate;
  };
  return { gate, rerender: () => harness.render(Probe, { report }) };
}

describe("web AI consent storage failures", () => {
  let unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    removeWindow();
  });

  it("a throwing read is treated as no consent, so the person is prompted", async () => {
    const storage = installLocalStorage();
    storage.failReads = true;

    assert.equal(await decideAiConsent(browserStore, subject), "prompt");
  });

  it("a throwing write still keeps the acceptance for this session", async () => {
    const storage = installLocalStorage();
    storage.failWrites = true;

    await acceptAiConsent(browserStore, subject);

    assert.equal(
      storage.values.has(aiConsentStorageKey(subject)),
      false,
      "nothing was stored",
    );
    assert.equal(
      await decideAiConsent(browserStore, subject),
      "allowed",
      "the acceptance holds in memory",
    );
  });

  it("an acceptance written to storage is still read back as current consent", async () => {
    installLocalStorage();
    await acceptAiConsent(browserStore, subject);

    assert.equal(await hasCurrentAiConsent(browserStore, subject), true);
  });

  it("with storage that throws on read, the gate opens the disclosure and settles, with no unhandled rejection", async () => {
    const storage = installLocalStorage();
    storage.failReads = true;
    const { gate, rerender } = renderGate();
    let ran = 0;

    await gate().runWithConsent(
      "image_search",
      async () => {
        ran += 1;
      },
      () => undefined,
    );
    rerender();
    await tick();

    assert.equal(ran, 0, "the action waits for the disclosure");
    assert.equal(
      dialogOf(gate().consentDialog).open,
      true,
      "the disclosure opens",
    );
    assert.deepEqual(unhandled, []);
  });

  it("with storage that throws on write, accepting still runs the action once, with no unhandled rejection", async () => {
    const storage = installLocalStorage();
    storage.failReads = true;
    storage.failWrites = true;
    const { gate, rerender } = renderGate();
    let ran = 0;

    await gate().runWithConsent(
      "listing_moderation",
      async () => {
        ran += 1;
      },
      () => undefined,
    );
    rerender();
    dialogOf(gate().consentDialog).onAccept();
    await tick();
    await tick();

    assert.equal(ran, 1, "the accepted action runs once");
    assert.deepEqual(
      unhandled,
      [],
      "the discarded accept promise does not reject",
    );
  });

  it("a declined disclosure settles without running the action, even when storage throws", async () => {
    const storage = installLocalStorage();
    storage.failReads = true;
    const { gate, rerender } = renderGate();
    let ran = 0;
    let declined = 0;

    await gate().runWithConsent(
      "image_search",
      async () => {
        ran += 1;
      },
      () => {
        declined += 1;
      },
    );
    rerender();
    dialogOf(gate().consentDialog).onDecline();
    await tick();

    assert.equal(ran, 0);
    assert.equal(declined, 1);
    assert.deepEqual(unhandled, []);
  });
});

describe("web callers restore their busy state", () => {
  const read = (relativePath: string) =>
    readFileSync(resolve(repoRoot, relativePath), "utf8");

  it("the listing review moderation sets busy only inside the action, so a gate that opens the disclosure leaves nothing running", () => {
    const page = read(
      "apps/web/src/app/(admin)/admin/products/review/page.tsx",
    );
    const handler = page.slice(
      page.indexOf("const handleAiModeration"),
      page.indexOf("return (", page.indexOf("const handleAiModeration")),
    );

    assert.ok(handler.includes("runWithConsent("), "the handler uses the gate");
    assert.ok(
      handler.indexOf("setRunningAiFor(listing._id)") >
        handler.indexOf("runWithConsent("),
      "busy is set by the action, not before the gate",
    );
    assert.match(
      handler,
      /finally \{[\s\S]*?setRunningAiFor\(\(current\) =>\s*current === listing\._id \? null : current/,
      "busy is cleared in finally, for this listing only",
    );
  });

  it("the home visual search clears its loading state in finally around the gate", () => {
    const page = read("apps/web/src/app/(main)/page.tsx");
    const handler = page.slice(
      page.indexOf("const handleImageSearch"),
      page.indexOf("return (", page.indexOf("const handleImageSearch")),
    );

    assert.match(
      handler,
      /try \{\s*await aiGate\.runWithConsent\(/,
      "the gate call sits in a try block",
    );
    assert.match(
      handler,
      /finally \{\s*setImageSearchLoading\(false\);/,
      "loading is cleared in finally",
    );
  });
});
