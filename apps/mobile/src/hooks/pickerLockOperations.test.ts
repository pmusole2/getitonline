import assert from 'node:assert/strict';
import Module from 'node:module';
import { afterEach, before, beforeEach, describe, it, type TestContext } from 'node:test';
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

// Runs the real useImageUpload hook under the real ConvexProviderWithClerk. The picker stays open until the test settles
// it, so two picks can overlap, and each picker launch is counted. One picker or upload operation runs at a time: a pick
// that arrives while another is in flight opens no picker and starts no work.

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

interface Gate<T> {
  resolve(value: T): void;
  reject(reason: unknown): void;
}

// The settle handle of each picker that is still open.
const open: {
  permission: Gate<PermissionResult> | null;
  gallery: Gate<PickerResult> | null;
  camera: Gate<PickerResult> | null;
} = { permission: null, gallery: null, camera: null };

// Counts launches, so a test can tell a picker that never opened from one that opened and then ignored its result.
const launches = { permission: 0, gallery: 0, camera: 0 };

const pickerStub = {
  MediaTypeOptions: { Images: 'images' },
  requestCameraPermissionsAsync: (): Promise<PermissionResult> => {
    launches.permission += 1;
    return new Promise((resolve, reject) => {
      open.permission = { resolve, reject };
    });
  },
  launchImageLibraryAsync: (): Promise<PickerResult> => {
    launches.gallery += 1;
    return new Promise((resolve, reject) => {
      open.gallery = { resolve, reject };
    });
  },
  launchCameraAsync: (): Promise<PickerResult> => {
    launches.camera += 1;
    return new Promise((resolve, reject) => {
      open.camera = { resolve, reject };
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

let useImageUpload: typeof HookModule.useImageUpload;
before(async () => {
  ({ useImageUpload } = await import('./useImageUpload'));
});

type UploadApi = ReturnType<typeof HookModule.useImageUpload>;
type InitialImages = NonNullable<Parameters<typeof HookModule.useImageUpload>[0]>;

const latest: { current: UploadApi | null } = { current: null };

// Probes hand their view here, so no render assigns to a variable outside the component.
function record(view: UploadApi): void {
  latest.current = view;
}

function Probe(props: { initial: InitialImages }): ReactNode {
  record(useImageUpload(props.initial));
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
const fetches: { url: string; method: string | undefined }[] = [];

// Stands in for fetch. Every request is recorded, and no request leaves the test.
async function fakeFetch(
  input: string,
  init?: { method?: string },
): Promise<{ ok: boolean; blob(): Promise<{ size: number; type: string }>; json(): Promise<{ storageId: string }> }> {
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

// Images already on the screen, as the hook receives them from its caller.
function seed(count: number): InitialImages {
  return Array.from({ length: count }, (_, i) => ({
    url: `https://files.example.invalid/seed_${i}`,
    storageId: `seed_${i}`,
  }));
}

function uploadUrlRequests(client: ConvexClientDouble): number {
  return client.events.filter((event) => event === `mutation:${generateUploadUrl}`).length;
}

// Tracks whether a pick has settled, without awaiting it. A pick that wrongly opens a picker never settles, so a test
// must not await it.
function track(pending: Promise<void>): { settled(): boolean } {
  let done = false;
  void pending.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return { settled: () => done };
}

// Mounts the screen for one test. The screen is unmounted when the test ends, even when an assertion fails first.
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

async function settle(resolve: () => void): Promise<void> {
  await act(async () => {
    resolve();
    await settleTasks();
  });
}

const realFetch = globalThis.fetch;

describe('pickerLock serializes picker and upload operations', () => {
  beforeEach(() => {
    resetDoubles();
    latest.current = null;
    saved.length = 0;
    fetches.length = 0;
    launches.permission = 0;
    launches.gallery = 0;
    launches.camera = 0;
    open.permission = null;
    open.gallery = null;
    open.camera = null;
    imageControl.holdCompression = false;
    imageControl.held.length = 0;
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

  it('a second pickImages while the first is open opens no second picker, and the limit holds', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe, { initial: seed(7) }));
    imageControl.holdCompression = true;

    await act(async () => {
      void upload().pickImages(8);
      await settleTasks();
    });
    const second = track(upload().pickImages(8));
    await settle(() => undefined);
    assert.equal(launches.gallery, 1, 'the second pick opens no second picker');
    assert.equal(second.settled(), true, 'the second pick returns at once');

    await settle(() => open.gallery?.resolve({ canceled: false, assets: [asset('one')] }));
    assert.equal(upload().isUploading, true, 'the first pick is uploading');
    const held = imageControl.held[0];
    assert.ok(held, 'compression of the first pick started');

    const third = track(upload().pickImages(8));
    await settle(() => undefined);
    assert.equal(launches.gallery, 1, 'a pick during the upload opens no picker');
    assert.equal(third.settled(), true);

    await settle(() => held.release({ uri: 'file:///cache/one.jpg.compressed.jpg' }));
    assert.equal(upload().images.length, 8, 'the single pick adds one image to the seven');
    assert.equal(upload().isUploading, false, 'the only operation finished, so uploading ends');
    assert.equal(uploadUrlRequests(client), 1, 'only one file is uploaded');
    assert.equal(launches.gallery, 1);
    await root.unmount();
  });

  it('a second pickFromCamera while the first is open requests no second permission and opens no second camera', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe, { initial: seed(0) }));

    await act(async () => {
      void upload().pickFromCamera();
      await settleTasks();
    });
    const second = track(upload().pickFromCamera());
    await settle(() => undefined);
    assert.equal(launches.permission, 1, 'the second call requests no permission');
    assert.equal(second.settled(), true);

    await settle(() => open.permission?.resolve({ status: 'granted' }));
    assert.equal(launches.camera, 1, 'the camera opens once');
    await settle(() => open.camera?.resolve({ canceled: true, assets: [] }));
    assert.equal(upload().isUploading, false);
    await root.unmount();
  });

  it('a camera pick requested while a gallery pick is open does nothing, and the gallery pick still finishes alone', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe, { initial: seed(0) }));

    await act(async () => {
      void upload().pickImages(8);
      await settleTasks();
    });
    const camera = track(upload().pickFromCamera());
    await settle(() => undefined);
    assert.equal(launches.permission, 0, 'the camera permission is not requested during a gallery pick');
    assert.equal(camera.settled(), true);

    await settle(() => open.gallery?.resolve({ canceled: true, assets: [] }));
    assert.equal(upload().isUploading, false);
    assert.equal(launches.gallery, 1);
    await root.unmount();
  });

  it('isUploading stays true through the upload until the only operation finishes', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe, { initial: seed(0) }));
    imageControl.holdCompression = true;

    await act(async () => {
      void upload().pickImages(8);
      await settleTasks();
    });
    await settle(() => open.gallery?.resolve({ canceled: false, assets: [asset('a')] }));
    assert.equal(upload().isUploading, true, 'the upload is in progress');

    const held = imageControl.held[0];
    assert.ok(held, 'compression started');
    await settle(() => held.release({ uri: 'file:///cache/a.jpg.compressed.jpg' }));
    assert.equal(upload().isUploading, false, 'uploading ends with the operation');
    assert.equal(upload().images.length, 1);
    await root.unmount();
  });

  it('a cancelled gallery pick releases the lock, so the next pick opens a picker', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe, { initial: seed(0) }));

    await act(async () => {
      void upload().pickImages(8);
      await settleTasks();
    });
    await settle(() => open.gallery?.resolve({ canceled: true, assets: [] }));

    await act(async () => {
      void upload().pickImages(8);
      await settleTasks();
    });
    assert.equal(launches.gallery, 2, 'a later pick opens the picker');
    await root.unmount();
  });

  it('a denied camera permission releases the lock, so a later camera pick requests permission again', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe, { initial: seed(0) }));

    await act(async () => {
      void upload().pickFromCamera();
      await settleTasks();
    });
    await settle(() => open.permission?.resolve({ status: 'denied' }));
    assert.equal(launches.camera, 0, 'a denied permission opens no camera');
    assert.equal(upload().isUploading, false);

    await act(async () => {
      void upload().pickFromCamera();
      await settleTasks();
    });
    assert.equal(launches.permission, 2, 'the later pick asks for permission again');
    await settle(() => open.permission?.resolve({ status: 'granted' }));
    assert.equal(launches.camera, 1, 'the later pick opens the camera');
    await root.unmount();
  });

  it('a thrown picker error releases the lock, so a later pick works', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe, { initial: seed(0) }));

    // The rejection is handled as it is created, so a failed pick is reported by the assertion, not as an unhandled error.
    let failure: unknown = null;
    await act(async () => {
      void upload()
        .pickImages(8)
        .catch((error: unknown) => {
          failure = error;
        });
      await settleTasks();
    });
    await act(async () => {
      open.gallery?.reject(new Error('picker crashed'));
      await settleTasks();
    });
    assert.ok(failure instanceof Error, 'the picker error reaches the caller');
    assert.equal(failure.message, 'picker crashed');
    assert.equal(upload().isUploading, false);

    await act(async () => {
      void upload().pickImages(8);
      await settleTasks();
    });
    assert.equal(launches.gallery, 2, 'the pick after the error opens the picker');
    await root.unmount();
  });

  it('a gallery result that arrives after a subject change releases the lock, so a pick for the new subject works', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe, { initial: seed(0) }));

    await act(async () => {
      void upload().pickImages(8);
      await settleTasks();
    });
    clerk.user = subject('clerk_B');
    await root.render(createElement(Probe, { initial: seed(0) }));
    await settle(() => open.gallery?.resolve({ canceled: false, assets: [asset('late')] }));
    assert.equal(uploadUrlRequests(client), 0, 'the stale result uploads nothing');
    assert.deepEqual(upload().images, []);

    await act(async () => {
      void upload().pickImages(8);
      await settleTasks();
    });
    assert.equal(launches.gallery, 2, 'the new subject can open a picker');
    await root.unmount();
  });

  it('a camera result that arrives after a subject change releases the lock', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe, { initial: seed(0) }));

    await act(async () => {
      void upload().pickFromCamera();
      await settleTasks();
    });
    await settle(() => open.permission?.resolve({ status: 'granted' }));
    clerk.user = subject('clerk_B');
    await root.render(createElement(Probe, { initial: seed(0) }));
    await settle(() => open.camera?.resolve({ canceled: false, assets: [asset('late')] }));
    assert.equal(uploadUrlRequests(client), 0);

    await act(async () => {
      void upload().pickFromCamera();
      await settleTasks();
    });
    assert.equal(launches.permission, 2, 'the new subject can start a camera pick');
    await root.unmount();
  });

  it('a pick that resolves after unmount does no work, and a fresh mount picks normally', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe, { initial: seed(0) }));

    await act(async () => {
      void upload().pickImages(8);
      await settleTasks();
    });
    await root.unmount();
    await settle(() => open.gallery?.resolve({ canceled: false, assets: [asset('late')] }));
    assert.equal(uploadUrlRequests(client), 0, 'an unmounted screen uploads nothing');
    assert.deepEqual(fetches, [], 'no file is read or posted');

    const next = mountScreen(t, new ConvexClientDouble(CONVEX_URL));
    await next.render(createElement(Probe, { initial: seed(0) }));
    await act(async () => {
      void upload().pickImages(8);
      await settleTasks();
    });
    assert.equal(launches.gallery, 2, 'the fresh mount opens its own picker');
    await next.unmount();
  });

  it('seven images accept one more pick, and a further pick at eight opens no picker', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe, { initial: seed(7) }));

    await act(async () => {
      void upload().pickImages(8);
      await settleTasks();
    });
    await settle(() => open.gallery?.resolve({ canceled: false, assets: [asset('eighth')] }));
    assert.equal(upload().images.length, 8, 'the eighth image is added');

    const further = track(upload().pickImages(8));
    await settle(() => undefined);
    assert.equal(launches.gallery, 1, 'at the limit no picker opens');
    assert.equal(further.settled(), true);
    await root.unmount();
  });

  it('a picker result with more assets than the remaining slots uploads only the slots that remain', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe, { initial: seed(7) }));

    await act(async () => {
      void upload().pickImages(8);
      await settleTasks();
    });
    await settle(() => open.gallery?.resolve({ canceled: false, assets: [asset('one'), asset('two')] }));

    assert.equal(uploadUrlRequests(client), 1, 'only the remaining slot is uploaded');
    assert.equal(upload().images.length, 8, 'the limit is never exceeded');
    await root.unmount();
  });

  it('a camera capture at the limit opens no permission request', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe, { initial: seed(8) }));

    await act(async () => {
      void upload().pickFromCamera(8);
      await settleTasks();
    });
    assert.equal(launches.permission, 0, 'at the limit no camera permission is requested');
    await root.unmount();
  });

  it('a camera capture below the limit requests permission and adds one image', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe, { initial: seed(7) }));

    await act(async () => {
      void upload().pickFromCamera(8);
      await settleTasks();
    });
    assert.equal(launches.permission, 1, 'below the limit the camera is requested');
    await settle(() => open.permission?.resolve({ status: 'granted' }));
    await settle(() => open.camera?.resolve({ canceled: false, assets: [asset('shot')] }));
    assert.equal(upload().images.length, 8, 'the capture adds one image');
    await root.unmount();
  });

  // Both picker callbacks are retained from one render. The later renders are never read again, so the limit must come
  // from the committed images in imagesRef, not from the images captured in the retained callbacks.
  it('a retained gallery pick, then a retained camera pick from the same render, is rejected at the limit', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe, { initial: seed(7) }));
    const { pickImages, pickFromCamera } = upload();

    await act(async () => {
      void pickImages(8);
      await settleTasks();
    });
    await settle(() => open.gallery?.resolve({ canceled: false, assets: [asset('eighth')] }));
    assert.equal(upload().images.length, 8, 'the retained gallery pick fills the last slot');
    assert.equal(uploadUrlRequests(client), 1, 'one file is uploaded');

    const camera = track(pickFromCamera(8));
    await settle(() => undefined);
    assert.equal(camera.settled(), true, 'the retained camera pick returns at once');
    assert.equal(launches.permission, 0, 'the retained camera pick requests no permission');
    assert.equal(launches.camera, 0, 'the retained camera pick opens no camera');
    assert.equal(uploadUrlRequests(client), 1, 'the retained camera pick uploads nothing');
    assert.equal(upload().images.length, 8, 'the limit is never exceeded');
    await root.unmount();
  });

  it('a retained camera capture, then a retained gallery pick from the same render, is rejected at the limit', async (t) => {
    const client = new ConvexClientDouble(CONVEX_URL);
    const root = mountScreen(t, client);
    await root.render(createElement(Probe, { initial: seed(7) }));
    const { pickImages, pickFromCamera } = upload();

    await act(async () => {
      void pickFromCamera(8);
      await settleTasks();
    });
    await settle(() => open.permission?.resolve({ status: 'granted' }));
    await settle(() => open.camera?.resolve({ canceled: false, assets: [asset('shot')] }));
    assert.equal(upload().images.length, 8, 'the retained camera capture fills the last slot');
    assert.equal(uploadUrlRequests(client), 1, 'one file is uploaded');

    const gallery = track(pickImages(8));
    await settle(() => undefined);
    assert.equal(gallery.settled(), true, 'the retained gallery pick returns at once');
    assert.equal(launches.gallery, 0, 'the retained gallery pick opens no picker');
    assert.equal(uploadUrlRequests(client), 1, 'the retained gallery pick uploads nothing');
    assert.equal(upload().images.length, 8, 'the limit is never exceeded');
    await root.unmount();
  });
});
