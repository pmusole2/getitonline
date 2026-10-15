import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { act, createElement, type ReactNode } from "react";
import { getFunctionName } from "convex/server";

import type * as HookModule from "./useStorageUpload";
import { api } from "../../../../convex/_generated/api";
import { ConvexClientDouble } from "../../../../tests/support/convexSubjectClientDouble";
import {
  clerk,
  mountWithClient,
  resetDoubles,
  server,
  settleTasks,
  subject,
} from "../../../../tests/support/convexSubjectHarness";

// Runs the real useStorageUpload hook under the real ConvexProviderWithClerk, with one client double. The storage POST is a
// counting fake, so a test decides when the POST resolves. The subject guard lives in the hook, so these tests fail if
// the hook stops checking its readiness generation.
let useStorageUpload: typeof HookModule.useStorageUpload;
before(async () => {
  ({ useStorageUpload } = await import("./useStorageUpload"));
});

type Upload = ReturnType<typeof HookModule.useStorageUpload>;

let latest: Upload | null = null;

// Hands each render's upload function to the test. The test reads it through upload(), never during render.
function record(next: Upload): void {
  latest = next;
}

function Probe({ onRender }: { onRender: (next: Upload) => void }): ReactNode {
  onRender(useStorageUpload());
  return null;
}

function upload(): Upload {
  assert.ok(latest, "the hook rendered");
  return latest;
}

const generateUploadUrl = getFunctionName(api.storage.generateUploadUrl);
const saveImageMetadata = getFunctionName(api.storage.saveImageMetadata);
const getUrl = getFunctionName(api.storage.getUrl);

const UPLOAD_URL = "https://upload.example.invalid/session";
const PUBLIC_URL = "https://files.example.invalid/st_logo";
const STORAGE_ID = "st_logo";

const saved: unknown[] = [];
const posts: string[] = [];
const postGate: { hold: boolean; release: (() => void) | null } = {
  hold: false,
  release: null,
};

// Stands in for the storage POST. It records each post, waits when the test holds it, and returns a storage receipt.
async function fakePost(input: string, init?: { method?: string }) {
  if (init?.method === "POST") {
    posts.push(input);
  }
  if (postGate.hold) {
    await new Promise<void>((resolve) => {
      postGate.release = resolve;
    });
  }
  return {
    ok: true,
    json: async () => ({ storageId: STORAGE_ID }),
  };
}

function logo(): File {
  return new File(["pixels"], "logo.png", { type: "image/png" });
}

const realFetch = globalThis.fetch;

describe("useStorageUpload stops an upload when its subject, mount, or Convex session changes", () => {
  let consoleError: ReturnType<typeof mock.method>;

  beforeEach(() => {
    resetDoubles();
    latest = null;
    saved.length = 0;
    posts.length = 0;
    postGate.hold = false;
    postGate.release = null;
    Reflect.set(globalThis, "fetch", fakePost);
    server.mutations.set(generateUploadUrl, async () => UPLOAD_URL);
    server.mutations.set(saveImageMetadata, async (args) => {
      saved.push(args);
      return null;
    });
    server.queries.set(getUrl, () => PUBLIC_URL);
    clerk.user = subject("clerk_A");
    consoleError = mock.method(console, "error", () => undefined);
  });

  afterEach(() => {
    consoleError.mock.restore();
    Reflect.set(globalThis, "fetch", realFetch);
  });

  it("a signed-in subject uploads, registers the file as public, and returns its public URL", async () => {
    const client = new ConvexClientDouble(
      "https://upload-test.example.invalid",
    );
    const root = mountWithClient(client);
    await root.render(createElement(Probe, { onRender: record }));
    await settleTasks();

    const outcome = await upload()(logo());

    assert.deepEqual(outcome, {
      status: "uploaded",
      storageId: STORAGE_ID,
      url: PUBLIC_URL,
    });
    assert.deepEqual(saved, [
      {
        storageId: STORAGE_ID,
        fileName: "logo.png",
        contentType: "image/png",
        size: 6,
        purpose: "public",
      },
    ]);
    await root.unmount();
  });

  it("a subject change while the upload URL is pending posts nothing and registers nothing for either subject", async () => {
    let releaseUploadUrl: () => void = () => undefined;
    server.mutations.set(
      generateUploadUrl,
      () =>
        new Promise<string>((resolve) => {
          releaseUploadUrl = () => resolve(UPLOAD_URL);
        }),
    );
    const client = new ConvexClientDouble(
      "https://upload-test.example.invalid",
    );
    const root = mountWithClient(client);
    await root.render(createElement(Probe, { onRender: record }));
    await settleTasks();

    const pending = upload()(logo());
    await settleTasks();
    clerk.user = subject("clerk_B");
    await root.render(createElement(Probe, { onRender: record }));
    await act(async () => {
      releaseUploadUrl();
    });
    const outcome = await pending;
    await settleTasks();

    assert.deepEqual(outcome, { status: "cancelled" });
    assert.deepEqual(posts, [], "no file is posted for the switched subject");
    assert.deepEqual(
      saved,
      [],
      "no ownership row is written for either subject",
    );
    await root.unmount();
  });

  it("unmounting during the POST registers nothing", async () => {
    postGate.hold = true;
    const client = new ConvexClientDouble(
      "https://upload-test.example.invalid",
    );
    const root = mountWithClient(client);
    await root.render(createElement(Probe, { onRender: record }));
    await settleTasks();

    const pending = upload()(logo());
    await settleTasks();
    assert.equal(posts.length, 1, "the POST is in flight");
    await root.unmount();
    postGate.release?.();
    const outcome = await pending;
    await settleTasks();

    assert.deepEqual(outcome, { status: "cancelled" });
    assert.deepEqual(saved, [], "an unmounted screen registers nothing");
  });

  it("losing Convex authentication while the upload URL is pending posts nothing and cancels", async () => {
    let releaseUploadUrl: () => void = () => undefined;
    server.mutations.set(
      generateUploadUrl,
      () =>
        new Promise<string>((resolve) => {
          releaseUploadUrl = () => resolve(UPLOAD_URL);
        }),
    );
    const client = new ConvexClientDouble(
      "https://upload-test.example.invalid",
    );
    const root = mountWithClient(client);
    await root.render(createElement(Probe, { onRender: record }));
    await settleTasks();

    const pending = upload()(logo());
    await settleTasks();
    await act(async () => {
      server.setAuthenticated(false);
    });
    await act(async () => {
      releaseUploadUrl();
    });
    const outcome = await pending;
    await settleTasks();

    assert.deepEqual(outcome, { status: "cancelled" });
    assert.deepEqual(
      posts,
      [],
      "no file is posted without an authenticated session",
    );
    assert.deepEqual(saved, [], "nothing is registered");
    await root.unmount();
  });

  it("a registration that fails on both attempts fails the upload and never reads the URL", async () => {
    server.mutations.set(saveImageMetadata, async (args) => {
      saved.push(args);
      throw new Error("registration rejected for token tok_secret_123");
    });
    const client = new ConvexClientDouble(
      "https://upload-test.example.invalid",
    );
    const root = mountWithClient(client);
    await root.render(createElement(Probe, { onRender: record }));
    await settleTasks();

    const outcome = await upload()(logo());

    assert.deepEqual(outcome, {
      status: "failed",
      reason: "registration_failed",
    });
    assert.equal(saved.length, 2, "registration is retried once");
    assert.equal(
      client.events.includes(`query:${getUrl}`),
      false,
      "the URL is not read for an unregistered file",
    );
    await root.unmount();
  });
});
