import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { act, createElement, type ReactNode } from 'react';
import { getFunctionName } from 'convex/server';

import type * as HookModule from './useImageUpload';
import { api } from '../../../../convex/_generated/api';
import { ConvexClientDouble } from '../../../../tests/support/convexSubjectClientDouble';
import { imageControl } from '../../../../tests/support/convexSubjectDoubles';
import {
  clerk,
  mountWithClient,
  resetDoubles,
  server,
  settleTasks,
  subject,
} from '../../../../tests/support/convexSubjectHarness';

// Runs the real useImageUpload hook under the real ConvexProviderWithClerk, with one client double. Compression is the
// Expo manipulator double, and the upload fetch is a counting fake, so a test decides when each external step resolves.
let useImageUpload: typeof HookModule.useImageUpload;
before(async () => {
  ({ useImageUpload } = await import('./useImageUpload'));
});

type UploadApi = ReturnType<typeof HookModule.useImageUpload>;

let latest: UploadApi | null = null;

function Probe(): ReactNode {
  latest = useImageUpload();
  return null;
}

function upload(): UploadApi {
  assert.ok(latest, 'the hook rendered');
  return latest;
}

const generateUploadUrl = getFunctionName(api.storage.generateUploadUrl);
const saveImageMetadata = getFunctionName(api.storage.saveImageMetadata);
const getUrl = getFunctionName(api.storage.getUrl);

const UPLOAD_URL = 'https://upload.example.invalid/session';
const PUBLIC_URL = 'https://files.example.invalid/st_1';
const STORAGE_ID = 'st_1';

// The arguments of each ownership registration, in call order.
const saved: unknown[] = [];

interface FetchCall {
  readonly url: string;
  readonly method: string | undefined;
}

const fetches: FetchCall[] = [];
// When set, the upload POST waits until the test releases it.
const uploadGate: { hold: boolean; release: (() => void) | null } = { hold: false, release: null };

// Stands in for fetch. The local image read returns a blob, the storage POST returns a storage ID, and nothing touches a
// network.
async function fakeFetch(
  input: string,
  init?: { method?: string },
): Promise<{ ok: boolean; blob(): Promise<{ size: number; type: string }>; json(): Promise<{ storageId: string }> }> {
  fetches.push({ url: input, method: init?.method });
  if (init?.method === 'POST' && uploadGate.hold) {
    await new Promise<void>((resolve) => {
      uploadGate.release = resolve;
    });
  }
  return {
    ok: true,
    blob: async () => ({ size: 3, type: 'image/jpeg' }),
    json: async () => ({ storageId: STORAGE_ID }),
  };
}

function uploadCalls(client: ConvexClientDouble): string[] {
  return client.events.filter((event) => event === `mutation:${generateUploadUrl}`);
}

// The storage POSTs, which carry the file bytes to the upload URL.
function postedBodies(): FetchCall[] {
  return fetches.filter((call) => call.method === 'POST');
}

const realFetch = globalThis.fetch;

describe('useImageUpload binds each upload to its mount and Clerk subject', () => {
  beforeEach(() => {
    resetDoubles();
    latest = null;
    saved.length = 0;
    fetches.length = 0;
    imageControl.holdCompression = false;
    imageControl.held.length = 0;
    imageControl.pick = { canceled: true, assets: [] };
    uploadGate.hold = false;
    uploadGate.release = null;
    Reflect.set(globalThis, 'fetch', fakeFetch);
    server.mutations.set(generateUploadUrl, async () => UPLOAD_URL);
    server.mutations.set(saveImageMetadata, async (args) => {
      saved.push(args);
      return null;
    });
    server.queries.set(getUrl, () => PUBLIC_URL);
    clerk.user = subject('clerk_A');
  });

  afterEach(() => {
    Reflect.set(globalThis, 'fetch', realFetch);
  });

  it('a mounted subject uploads, registers the file as public, and returns its public URL', async () => {
    const client = new ConvexClientDouble('https://upload-test.example.invalid');
    const root = mountWithClient(client);
    await root.render(createElement(Probe));

    const url = await upload().uploadSingleImage('file:///cache/photo.jpg');

    assert.equal(url, PUBLIC_URL);
    assert.deepEqual(saved, [
      {
        storageId: STORAGE_ID,
        fileName: 'photo.jpg.compressed.jpg',
        contentType: 'image/jpeg',
        size: 3,
        purpose: 'public',
      },
    ]);
    await root.unmount();
  });

  it('unmounting while compression is held sends no upload request when compression resolves', async () => {
    const client = new ConvexClientDouble('https://upload-test.example.invalid');
    const root = mountWithClient(client);
    await root.render(createElement(Probe));
    imageControl.holdCompression = true;

    const pending = upload().uploadSingleImage('file:///cache/photo.jpg');
    await root.unmount();
    const held = imageControl.held[0];
    assert.ok(held, 'compression started');
    held.release({ uri: 'file:///cache/photo.jpg.compressed.jpg' });
    const result = await pending;
    await settleTasks();

    assert.equal(result, null, 'the upload is cancelled, not completed');
    assert.deepEqual(uploadCalls(client), [], 'no upload URL is requested after unmount');
    assert.deepEqual(fetches, [], 'no file request is made after unmount');
  });

  it('a subject change while compression is held cancels the upload before any upload URL is requested', async () => {
    const client = new ConvexClientDouble('https://upload-test.example.invalid');
    const root = mountWithClient(client);
    await root.render(createElement(Probe));
    imageControl.holdCompression = true;

    const pending = upload().uploadSingleImage('file:///cache/photo.jpg');
    clerk.user = subject('clerk_B');
    await root.render(createElement(Probe));
    const held = imageControl.held[0];
    assert.ok(held, 'compression started');
    held.release({ uri: 'file:///cache/photo.jpg.compressed.jpg' });
    const result = await pending;
    await settleTasks();

    assert.equal(result, null, 'an upload started for subject A does not complete for subject B');
    assert.deepEqual(uploadCalls(client), [], 'no upload URL is requested for the switched subject');
    assert.deepEqual(saved, [], 'no ownership row is registered for the switched subject');
    await root.unmount();
  });

  it('unmounting during the storage upload does not register the uploaded file', async () => {
    const client = new ConvexClientDouble('https://upload-test.example.invalid');
    const root = mountWithClient(client);
    await root.render(createElement(Probe));
    uploadGate.hold = true;

    const pending = upload().uploadSingleImage('file:///cache/photo.jpg');
    await settleTasks();
    await root.unmount();
    uploadGate.release?.();
    const result = await pending;
    await settleTasks();

    assert.equal(result, null);
    assert.deepEqual(saved, [], 'an unmounted screen registers nothing');
    assert.equal(
      fetches.filter((call) => call.url === 'file:///cache/photo.jpg.compressed.jpg').length,
      1,
      'the local image is read once, before the unmount',
    );
  });

  it('a registration that succeeds on the retry completes the upload and records the owner', async () => {
    let attempts = 0;
    server.mutations.set(saveImageMetadata, async (args) => {
      saved.push(args);
      attempts += 1;
      if (attempts === 1) {
        throw new Error('transient registration failure');
      }
      return null;
    });
    const client = new ConvexClientDouble('https://upload-test.example.invalid');
    const root = mountWithClient(client);
    await root.render(createElement(Probe));

    const url = await upload().uploadSingleImage('file:///cache/photo.jpg');

    assert.equal(url, PUBLIC_URL, 'the retried registration makes the file usable');
    assert.equal(saved.length, 2, 'registration is attempted twice');
    assert.deepEqual(saved[0], saved[1], 'the retry registers the same file with the same arguments');
    await root.unmount();
  });

  it('a registration that fails on both attempts fails the upload, never reads the URL, and logs only a safe code', async () => {
    server.mutations.set(saveImageMetadata, async (args) => {
      saved.push(args);
      throw new Error('registration rejected for token tok_secret_123');
    });
    const logged: unknown[][] = [];
    const errorLog = mock.method(console, 'error', (...args: unknown[]) => {
      logged.push(args);
    });
    try {
      const client = new ConvexClientDouble('https://upload-test.example.invalid');
      const root = mountWithClient(client);
      await root.render(createElement(Probe));

      const url = await upload().uploadSingleImage('file:///cache/photo.jpg');

      assert.equal(url, null, 'an unregistered file is not handed out as a usable image');
      assert.equal(saved.length, 2, 'registration is retried once, then given up');
      assert.equal(
        client.events.includes(`query:${getUrl}`),
        false,
        'the public URL is not read for an unregistered file',
      );
      const text = JSON.stringify(logged);
      assert.ok(text.includes('image_metadata_registration_failed'), 'the safe code is logged');
      assert.equal(text.includes('tok_secret_123'), false, 'the error message is not logged');
      await root.unmount();
    } finally {
      errorLog.mock.restore();
    }
  });

  it('losing Convex authentication while the upload URL is pending posts no file and cancels the upload', async () => {
    let releaseUploadUrl: () => void = () => undefined;
    server.mutations.set(
      generateUploadUrl,
      () =>
        new Promise<string>((resolve) => {
          releaseUploadUrl = () => resolve(UPLOAD_URL);
        }),
    );
    const client = new ConvexClientDouble('https://upload-test.example.invalid');
    const root = mountWithClient(client);
    await root.render(createElement(Probe));

    const pending = upload().uploadSingleImage('file:///cache/photo.jpg');
    await settleTasks();
    await act(async () => {
      server.setAuthenticated(false);
    });
    await act(async () => {
      releaseUploadUrl();
    });
    const result = await pending;
    await settleTasks();

    assert.equal(result, null, 'the upload is cancelled once the session is no longer authenticated');
    assert.deepEqual(postedBodies(), [], 'no file is posted without an authenticated session');
    assert.deepEqual(saved, [], 'nothing is registered');
    await root.unmount();
  });

  it('losing Convex authentication during the file post registers nothing, leaving the stored file unregistered', async () => {
    uploadGate.hold = true;
    const client = new ConvexClientDouble('https://upload-test.example.invalid');
    const root = mountWithClient(client);
    await root.render(createElement(Probe));

    const pending = upload().uploadSingleImage('file:///cache/photo.jpg');
    await settleTasks();
    assert.equal(postedBodies().length, 1, 'the file post is in flight');
    await act(async () => {
      server.setAuthenticated(false);
    });
    await act(async () => {
      uploadGate.release?.();
    });
    const result = await pending;
    await settleTasks();

    // The stored file exists with no ownership row. Only a backend sweep can remove it, see the report.
    assert.equal(result, null, 'the upload is cancelled, not completed');
    assert.deepEqual(saved, [], 'no ownership row is written after authentication is lost');
    await root.unmount();
  });

  it('a subject change during a picked upload clears the uploading state and adds no image', async () => {
    const client = new ConvexClientDouble('https://upload-test.example.invalid');
    const root = mountWithClient(client);
    await root.render(createElement(Probe));
    imageControl.holdCompression = true;
    imageControl.pick = {
      canceled: false,
      assets: [{ uri: 'file:///cache/photo.jpg', width: 10, height: 10, fileSize: 3, mimeType: 'image/jpeg' }],
    };

    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = upload().pickImages(1);
      await settleTasks();
    });
    assert.equal(upload().isUploading, true, 'the pick is uploading');

    clerk.user = subject('clerk_B');
    await root.render(createElement(Probe));
    const held = imageControl.held[0];
    assert.ok(held, 'compression started');
    await act(async () => {
      held.release({ uri: 'file:///cache/photo.jpg.compressed.jpg' });
      await pending;
    });

    assert.equal(upload().isUploading, false, 'a cancelled upload does not leave the screen stuck uploading');
    assert.deepEqual(upload().images, [], 'an upload for subject A adds no image for subject B');
    await root.unmount();
  });
});
