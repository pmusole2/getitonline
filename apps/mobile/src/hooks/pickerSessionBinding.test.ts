import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { afterEach, before, beforeEach, describe, it, type TestContext } from 'node:test';
import { act, createElement, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { getFunctionName } from 'convex/server';

import type * as HookModule from './useImageUpload';
import { api } from '../../../../convex/_generated/api';
import { ConvexClientDouble } from '../../../../tests/support/convexSubjectClientDouble';
import {
  clerk,
  mountWithClient,
  resetDoubles,
  server,
  settleTasks,
  subject,
} from '../../../../tests/support/convexSubjectHarness';

// Runs the real useImageUpload hook under the real ConvexProviderWithClerk. Each picker call stays open until the test
// resolves it, so a subject change, an auth loss, or an unmount can happen while the picker is still open. A picker
// result that resolves after its session ended must start no work and set no state. A pick whose session ended is never
// awaited, it goes to `unawaited`: the fixed hook returns at once, while a hook that wrongly keeps going waits on a
// picker the test never resolves, so awaiting it would hang the test.

interface PickedAsset {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
  readonly fileSize: number;
  readonly mimeType: string;
}

interface PickerResult {
  readonly canceled: boolean;
  readonly assets: PickedAsset[];
}

interface PermissionResult {
  readonly status: string;
}

// The resolver of each picker call that is still open. A call settles only when the test calls its resolver.
const open: {
  permission: ((result: PermissionResult) => void) | null;
  gallery: ((result: PickerResult) => void) | null;
  camera: ((result: PickerResult) => void) | null;
} = { permission: null, gallery: null, camera: null };

// Counts picker launches, so a test can tell a picker that never opened from one that opened and then ignored its result.
const launches = { gallery: 0, camera: 0 };

const pickerStub = {
  MediaTypeOptions: { Images: 'images' },
  requestCameraPermissionsAsync: (): Promise<PermissionResult> =>
    new Promise((resolve) => {
      open.permission = resolve;
    }),
  launchImageLibraryAsync: (): Promise<PickerResult> => {
    launches.gallery += 1;
    return new Promise((resolve) => {
      open.gallery = resolve;
    });
  },
  launchCameraAsync: (): Promise<PickerResult> => {
    launches.camera += 1;
    return new Promise((resolve) => {
      open.camera = resolve;
    });
  },
};

// Installed after the harness, so the picker resolves to this stand-in while the Clerk, Expo manipulator, and Convex
// doubles stay in place for every other module.
const previousRequire = Module.prototype.require;
Module.prototype.require = function requireWithPickerStub(this: Module, id: string): unknown {
  if (id === 'expo-image-picker') {
    return pickerStub;
  }
  return previousRequire.call(this, id);
};

// React's state setters are counted while a test window is open, so a setter call after a session ended is observed
// directly. The hook reads useState from the shared React exports at call time, so replacing it here is seen by the hook.
const reactExports: typeof import('react') = createRequire(import.meta.url)('react');
const originalUseState = reactExports.useState;
const setterCalls = { counting: false, count: 0 };

function countingUseState<S>(initialState: S | (() => S)): [S, Dispatch<SetStateAction<S>>] {
  const [value, setValue] = originalUseState(initialState);
  return [
    value,
    (action) => {
      if (setterCalls.counting) {
        setterCalls.count += 1;
      }
      setValue(action);
    },
  ];
}

let useImageUpload: typeof HookModule.useImageUpload;
before(async () => {
  ({ useImageUpload } = await import('./useImageUpload'));
});

type UploadApi = ReturnType<typeof HookModule.useImageUpload>;

const latest: { current: UploadApi | null } = { current: null };
let renders = 0;

// Probes hand their view here, so no render assigns to a variable outside the component.
function record(view: UploadApi): void {
  latest.current = view;
}

function Probe(): ReactNode {
  renders += 1;
  record(useImageUpload());
  return null;
}

function upload(): UploadApi {
  if (!latest.current) {
    throw new Error('the hook has not rendered');
  }
  return latest.current;
}

const generateUploadUrl = getFunctionName(api.storage.generateUploadUrl);
const saveImageMetadata = getFunctionName(api.storage.saveImageMetadata);
const getUrl = getFunctionName(api.storage.getUrl);

const CONVEX_URL = 'https://upload-test.example.invalid';
const UPLOAD_URL = 'https://upload.example.invalid/session';
const PUBLIC_URL = 'https://files.example.invalid/st_1';
const STORAGE_ID = 'st_1';

const saved: unknown[] = [];

interface FetchCall {
  readonly url: string;
  readonly method: string | undefined;
}

interface FakeResponse {
  readonly ok: boolean;
  blob(): Promise<{ size: number; type: string }>;
  json(): Promise<{ storageId: string }>;
}

const fetches: FetchCall[] = [];

// Stands in for fetch. Every request is recorded, and no request leaves the test.
async function fakeFetch(input: string, init?: { method?: string }): Promise<FakeResponse> {
  fetches.push({ url: input, method: init?.method });
  return {
    ok: true,
    blob: async () => ({ size: 3, type: 'image/jpeg' }),
    json: async () => ({ storageId: STORAGE_ID }),
  };
}

function asset(name: string): PickedAsset {
  return { uri: `file:///cache/${name}.jpg`, width: 1000, height: 1000, fileSize: 3, mimeType: 'image/jpeg' };
}

function uploadUrlRequests(client: ConvexClientDouble): number {
  return client.events.filter((event) => event === `mutation:${generateUploadUrl}`).length;
}

function postCount(): number {
  return fetches.filter((call) => call.method === 'POST').length;
}

// Mounts the screen for one test. The screen is unmounted when the test ends, even when an assertion fails first, so a
// failing test cannot leave a mounted tree that keeps the process alive.
function mountScreen(t: TestContext, client: ConvexClientDouble): ReturnType<typeof mountWithClient> {
  const root = mountWithClient(client);
  let mounted = true;
  const unmount = async (): Promise<void> => {
    if (mounted) {
      mounted = false;
      await root.unmount();
    }
  };
  t.after(unmount);
  return { render: root.render, unmount };
}

function assertNoWork(client: ConvexClientDouble): void {
  assert.equal(uploadUrlRequests(client), 0, 'no upload URL is requested');
  assert.deepEqual(fetches, [], 'no file is read or posted');
  assert.deepEqual(saved, [], 'nothing is registered');
}

const realFetch = globalThis.fetch;

// The picks whose session ended, which a test does not await. See the file header.
const unawaited: Promise<void>[] = [];

describe('pickerSession binds picker results to the session that opened the picker', () => {
  beforeEach(() => {
    resetDoubles();
    latest.current = null;
    renders = 0;
    saved.length = 0;
    fetches.length = 0;
    unawaited.length = 0;
    launches.gallery = 0;
    launches.camera = 0;
    open.permission = null;
    open.gallery = null;
    open.camera = null;
    setterCalls.counting = false;
    setterCalls.count = 0;
    Reflect.set(reactExports, 'useState', countingUseState);
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
    Reflect.set(reactExports, 'useState', originalUseState);
    Reflect.set(globalThis, 'fetch', realFetch);
  });

  it('a gallery pick that resolves after a subject change requests no upload URL, adds no image, and sets no state', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe));
    await act(async () => {
      unawaited.push(upload().pickImages(1));
      await settleTasks();
    });
    assert.equal(launches.gallery, 1, 'the gallery picker opened for subject A');

    clerk.user = subject('clerk_B');
    await root.render(createElement(Probe));
    await settleTasks();
    const rendersBeforeResult = renders;

    const resolve = open.gallery;
    assert.ok(resolve, 'the gallery picker is still open');
    await act(async () => {
      resolve({ canceled: false, assets: [asset('one')] });
      await settleTasks();
    });

    assertNoWork(client);
    assert.deepEqual(upload().images, []);
    assert.deepEqual(upload().validationErrors, []);
    assert.equal(upload().isUploading, false);
    assert.equal(renders, rendersBeforeResult, 'no state was set after the subject changed');
    await root.unmount();
  });

  it('a camera pick whose permission resolves after a subject change opens no camera and adds no image', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe));
    await act(async () => {
      unawaited.push(upload().pickFromCamera());
      await settleTasks();
    });
    assert.ok(open.permission, 'the camera permission request is open for subject A');

    clerk.user = subject('clerk_B');
    await root.render(createElement(Probe));
    await settleTasks();
    const rendersBeforeResult = renders;

    const resolve = open.permission;
    assert.ok(resolve);
    await act(async () => {
      resolve({ status: 'granted' });
      await settleTasks();
    });

    assert.equal(launches.camera, 0, 'the camera does not open for a stale session');
    assertNoWork(client);
    assert.deepEqual(upload().images, []);
    assert.deepEqual(upload().validationErrors, []);
    assert.equal(upload().isUploading, false);
    assert.equal(renders, rendersBeforeResult, 'no state was set after the subject changed');
    await root.unmount();
  });

  it('a camera capture that resolves after a subject change requests no upload URL, adds no image, and sets no state', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe));
    await act(async () => {
      unawaited.push(upload().pickFromCamera());
      await settleTasks();
    });
    open.permission?.({ status: 'granted' });
    await settleTasks();
    assert.equal(launches.camera, 1, 'the camera opened for subject A');

    clerk.user = subject('clerk_B');
    await root.render(createElement(Probe));
    await settleTasks();
    const rendersBeforeResult = renders;

    const resolve = open.camera;
    assert.ok(resolve, 'the camera is still open');
    await act(async () => {
      resolve({ canceled: false, assets: [asset('shot')] });
      await settleTasks();
    });

    assertNoWork(client);
    assert.deepEqual(upload().images, []);
    assert.deepEqual(upload().validationErrors, []);
    assert.equal(upload().isUploading, false);
    assert.equal(renders, rendersBeforeResult, 'no state was set after the subject changed');
    await root.unmount();
  });

  it('a gallery pick that resolves after Convex authentication is lost requests no upload URL and adds no image', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe));
    await act(async () => {
      unawaited.push(upload().pickImages(1));
      await settleTasks();
    });

    await act(async () => {
      server.setAuthenticated(false);
      await settleTasks();
    });
    const rendersBeforeResult = renders;

    const resolve = open.gallery;
    assert.ok(resolve, 'the gallery picker is still open');
    await act(async () => {
      resolve({ canceled: false, assets: [asset('one')] });
      await settleTasks();
    });

    assertNoWork(client);
    assert.deepEqual(upload().images, []);
    assert.deepEqual(upload().validationErrors, []);
    assert.equal(upload().isUploading, false);
    assert.equal(renders, rendersBeforeResult, 'no state was set after authentication was lost');
    await root.unmount();
  });

  it('a camera capture that resolves after Convex authentication is lost requests no upload URL and adds no image', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe));
    await act(async () => {
      unawaited.push(upload().pickFromCamera());
      await settleTasks();
    });
    open.permission?.({ status: 'granted' });
    await settleTasks();

    await act(async () => {
      server.setAuthenticated(false);
      await settleTasks();
    });
    const rendersBeforeResult = renders;

    const resolve = open.camera;
    assert.ok(resolve, 'the camera is still open');
    await act(async () => {
      resolve({ canceled: false, assets: [asset('shot')] });
      await settleTasks();
    });

    assertNoWork(client);
    assert.deepEqual(upload().images, []);
    assert.deepEqual(upload().validationErrors, []);
    assert.equal(upload().isUploading, false);
    assert.equal(renders, rendersBeforeResult, 'no state was set after authentication was lost');
    await root.unmount();
  });

  it('a gallery pick that resolves after unmount requests nothing and calls no state setter', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe));
    await act(async () => {
      unawaited.push(upload().pickImages(1));
      await settleTasks();
    });

    await root.unmount();
    const resolve = open.gallery;
    assert.ok(resolve, 'the gallery picker is still open');
    setterCalls.count = 0;
    setterCalls.counting = true;
    try {
      await act(async () => {
        resolve({ canceled: false, assets: [asset('one')] });
        await settleTasks();
      });
    } finally {
      setterCalls.counting = false;
    }

    assertNoWork(client);
    assert.equal(setterCalls.count, 0, 'no state setter runs after unmount');
  });

  it('a camera capture that resolves after unmount requests nothing and calls no state setter', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe));
    await act(async () => {
      unawaited.push(upload().pickFromCamera());
      await settleTasks();
    });
    open.permission?.({ status: 'granted' });
    await settleTasks();

    await root.unmount();
    const resolve = open.camera;
    assert.ok(resolve, 'the camera is still open');
    setterCalls.count = 0;
    setterCalls.counting = true;
    try {
      await act(async () => {
        resolve({ canceled: false, assets: [asset('shot')] });
        await settleTasks();
      });
    } finally {
      setterCalls.counting = false;
    }

    assertNoWork(client);
    assert.equal(setterCalls.count, 0, 'no state setter runs after unmount');
  });

  it('a gallery pick opened after a subject change uploads for the new subject', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe));
    clerk.user = subject('clerk_B');
    await root.render(createElement(Probe));
    await settleTasks();

    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = upload().pickImages(1);
      await settleTasks();
    });
    const resolve = open.gallery;
    assert.ok(resolve, 'the gallery picker is open for subject B');
    await act(async () => {
      resolve({ canceled: false, assets: [asset('one')] });
      await pending;
      await settleTasks();
    });

    assert.equal(uploadUrlRequests(client), 1, 'the pick for subject B requests one upload URL');
    assert.equal(postCount(), 1);
    assert.equal(saved.length, 1, 'the pick is registered once');
    assert.equal(upload().images.length, 1, 'the pick adds its image');
    assert.deepEqual(upload().validationErrors, []);
    await root.unmount();
  });

  it('a same-session gallery pick uploads, registers, and adds its image', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe));
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = upload().pickImages(1);
      await settleTasks();
    });
    const resolve = open.gallery;
    assert.ok(resolve, 'the gallery picker is open');
    await act(async () => {
      resolve({ canceled: false, assets: [asset('one')] });
      await pending;
      await settleTasks();
    });

    assert.equal(uploadUrlRequests(client), 1);
    assert.equal(saved.length, 1);
    assert.equal(upload().images.length, 1);
    assert.equal(upload().images[0]?.url, PUBLIC_URL);
    await root.unmount();
  });

  it('a same-session camera capture uploads, registers, and adds its image', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe));
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = upload().pickFromCamera();
      await settleTasks();
    });
    open.permission?.({ status: 'granted' });
    await settleTasks();
    const resolve = open.camera;
    assert.ok(resolve, 'the camera is open');
    await act(async () => {
      resolve({ canceled: false, assets: [asset('shot')] });
      await pending;
      await settleTasks();
    });

    assert.equal(uploadUrlRequests(client), 1);
    assert.equal(saved.length, 1);
    assert.equal(upload().images.length, 1);
    assert.equal(upload().images[0]?.url, PUBLIC_URL);
    await root.unmount();
  });
});
