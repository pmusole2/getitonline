import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import {
  storageUploadMessage,
  uploadFileToStorage,
  type StorageUploadDeps,
  type StorageUploadOutcome,
} from "./useStorageUpload";

// The upload pipeline with fakes for the Convex mutations, the storage POST, and the URL read. Each fake records its
// calls in order, so a test can assert that a stopped upload made no later request.

const STORAGE_ID = "st_logo";
const UPLOAD_URL = "https://upload.example.invalid/session";
const PUBLIC_URL = "https://files.example.invalid/st_logo";

interface FakeOptions {
  // Registration calls that fail before the first success.
  readonly registrationFailures?: number;
  // Resolves the upload URL request only when the test releases it.
  readonly holdGenerate?: boolean;
  // Resolves the storage POST only when the test releases it.
  readonly holdPost?: boolean;
  readonly postOk?: boolean;
  readonly receipt?: unknown;
  readonly url?: string | null;
}

interface Fake {
  readonly deps: StorageUploadDeps;
  readonly events: string[];
  readonly registrations: unknown[];
  stop(): void;
  releaseGenerate(): void;
  releasePost(): void;
}

function fakeDeps(options: FakeOptions = {}): Fake {
  const events: string[] = [];
  const registrations: unknown[] = [];
  let current = true;
  let failuresLeft = options.registrationFailures ?? 0;
  let releaseGenerate: () => void = () => undefined;
  let releasePost: () => void = () => undefined;
  const generateGate = options.holdGenerate
    ? new Promise<void>((resolve) => {
        releaseGenerate = resolve;
      })
    : Promise.resolve();
  const postGate = options.holdPost
    ? new Promise<void>((resolve) => {
        releasePost = resolve;
      })
    : Promise.resolve();

  const deps: StorageUploadDeps = {
    generateUploadUrl: async () => {
      events.push("generate");
      await generateGate;
      return UPLOAD_URL;
    },
    send: async (uploadUrl) => {
      events.push(`send:${uploadUrl}`);
      await postGate;
      return {
        ok: options.postOk ?? true,
        json: async () =>
          "receipt" in options ? options.receipt : { storageId: STORAGE_ID },
      };
    },
    saveImageMetadata: async (args) => {
      events.push("register");
      registrations.push(args);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error("registration rejected for token tok_secret_123");
      }
    },
    getUrl: async () => {
      events.push("url");
      return "url" in options ? (options.url ?? null) : PUBLIC_URL;
    },
    isCurrent: () => current,
  };

  return {
    deps,
    events,
    registrations,
    stop: () => {
      current = false;
    },
    releaseGenerate: () => releaseGenerate(),
    releasePost: () => releasePost(),
  };
}

function logo(): File {
  return new File(["pixels"], "logo.png", { type: "image/png" });
}

function uploaded(outcome: StorageUploadOutcome): {
  storageId: string;
  url: string;
} {
  assert.equal(
    outcome.status,
    "uploaded",
    `expected an upload, got ${JSON.stringify(outcome)}`,
  );
  return outcome;
}

describe("uploadFileToStorage registers every file before its URL is used", () => {
  let consoleError: ReturnType<typeof mock.method>;
  const logged: unknown[][] = [];

  beforeEach(() => {
    logged.length = 0;
    consoleError = mock.method(console, "error", (...args: unknown[]) => {
      logged.push(args);
    });
  });

  afterEach(() => {
    consoleError.mock.restore();
  });

  it("generates a URL, posts the file, registers it as public, and then reads its URL", async () => {
    const fake = fakeDeps();
    const file = logo();

    const outcome = uploaded(await uploadFileToStorage(file, fake.deps));

    assert.equal(outcome.url, PUBLIC_URL);
    assert.equal(outcome.storageId, STORAGE_ID);
    assert.deepEqual(fake.events, [
      "generate",
      `send:${UPLOAD_URL}`,
      "register",
      "url",
    ]);
    assert.deepEqual(fake.registrations, [
      {
        storageId: STORAGE_ID,
        fileName: "logo.png",
        contentType: "image/png",
        size: file.size,
        purpose: "public",
      },
    ]);
  });

  it("retries a failed registration once, and a retry that succeeds completes the upload", async () => {
    const fake = fakeDeps({ registrationFailures: 1 });

    const outcome = uploaded(await uploadFileToStorage(logo(), fake.deps));

    assert.equal(outcome.url, PUBLIC_URL);
    assert.equal(
      fake.registrations.length,
      2,
      "the registration is attempted twice",
    );
    assert.deepEqual(
      fake.registrations[0],
      fake.registrations[1],
      "the retry sends the same arguments",
    );
  });

  it("fails with registration_failed when both registration attempts fail, and never reads or returns the URL", async () => {
    const fake = fakeDeps({ registrationFailures: 2 });

    const outcome = await uploadFileToStorage(logo(), fake.deps);

    assert.deepEqual(outcome, {
      status: "failed",
      reason: "registration_failed",
    });
    assert.equal(fake.registrations.length, 2);
    assert.equal(
      fake.events.includes("url"),
      false,
      "the URL is not read for an unregistered file",
    );
    const text = JSON.stringify(logged);
    assert.ok(
      text.includes("image_metadata_registration_failed"),
      "the safe code is logged",
    );
    assert.equal(
      text.includes("tok_secret_123"),
      false,
      "the error message is not logged",
    );
  });

  it("fails with upload_failed when the storage POST is rejected, and registers nothing", async () => {
    const fake = fakeDeps({ postOk: false });

    const outcome = await uploadFileToStorage(logo(), fake.deps);

    assert.deepEqual(outcome, { status: "failed", reason: "upload_failed" });
    assert.deepEqual(fake.registrations, []);
  });

  it("fails with upload_failed when the storage receipt has no storage ID", async () => {
    const fake = fakeDeps({ receipt: { unexpected: true } });

    const outcome = await uploadFileToStorage(logo(), fake.deps);

    assert.deepEqual(outcome, { status: "failed", reason: "upload_failed" });
    assert.deepEqual(fake.registrations, []);
  });

  it("fails with url_unavailable after a registration when the storage URL cannot be read", async () => {
    const fake = fakeDeps({ url: null });

    const outcome = await uploadFileToStorage(logo(), fake.deps);

    assert.deepEqual(outcome, { status: "failed", reason: "url_unavailable" });
    assert.equal(fake.registrations.length, 1);
  });

  it("is cancelled while the upload URL is pending, so no file is posted or registered", async () => {
    const fake = fakeDeps({ holdGenerate: true });

    const pending = uploadFileToStorage(logo(), fake.deps);
    fake.stop();
    fake.releaseGenerate();
    const outcome = await pending;

    assert.deepEqual(outcome, { status: "cancelled" });
    assert.deepEqual(
      fake.events,
      ["generate"],
      "no POST and no registration after the stop",
    );
  });

  it("is cancelled during the POST, so no registration follows and the stored file is left unregistered", async () => {
    const fake = fakeDeps({ holdPost: true });

    const pending = uploadFileToStorage(logo(), fake.deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.stop();
    fake.releasePost();
    const outcome = await pending;

    assert.deepEqual(outcome, { status: "cancelled" });
    assert.deepEqual(
      fake.registrations,
      [],
      "no registration is attempted after the stop",
    );
    assert.equal(fake.events.includes("url"), false);
  });

  it("is cancelled between registration attempts, so the failed registration is not retried", async () => {
    const fake = fakeDeps({ registrationFailures: 2 });
    const failingRegistration = fake.deps.saveImageMetadata;
    const deps: StorageUploadDeps = {
      ...fake.deps,
      saveImageMetadata: async (args) => {
        const attempt = failingRegistration(args);
        fake.stop();
        return attempt;
      },
    };

    const outcome = await uploadFileToStorage(logo(), deps);

    assert.deepEqual(outcome, { status: "cancelled" });
    assert.equal(
      fake.registrations.length,
      1,
      "the stopped upload makes no second registration",
    );
  });
});

describe("storageUploadMessage", () => {
  it("gives a clear, non-empty message for each outcome that is not a success", () => {
    const messages = [
      storageUploadMessage({ status: "failed", reason: "upload_failed" }),
      storageUploadMessage({ status: "failed", reason: "registration_failed" }),
      storageUploadMessage({ status: "failed", reason: "url_unavailable" }),
      storageUploadMessage({ status: "cancelled" }),
    ];
    for (const message of messages) {
      assert.ok(message.trim().length > 0);
    }
    assert.equal(
      new Set(messages).size,
      messages.length,
      "each outcome has its own message",
    );
  });
});
