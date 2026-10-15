import assert from 'node:assert/strict';
import Module from 'node:module';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
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

// Runs the real useImageUpload hook under the real ConvexProviderWithClerk. The image picker is a stand-in that returns
// the gallery and camera results a test sets, so both picker paths run. A failed upload is reported through the hook's
// validationErrors, the channel the screens already render.

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

const picker: { gallery: PickerResult; camera: PickerResult } = {
  gallery: { canceled: true, assets: [] },
  camera: { canceled: true, assets: [] },
};

const pickerStub = {
  MediaTypeOptions: { Images: 'images' },
  requestCameraPermissionsAsync: async (): Promise<{ status: string }> => ({ status: 'granted' }),
  launchImageLibraryAsync: async (): Promise<PickerResult> => picker.gallery,
  launchCameraAsync: async (): Promise<PickerResult> => picker.camera,
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

const latest: { current: UploadApi | null } = { current: null };

// Probes hand their view here, so no render assigns to a variable outside the component.
function record(view: UploadApi): void {
  latest.current = view;
}

function Probe(): ReactNode {
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

const UPLOAD_URL = 'https://upload.example.invalid/session';
const PUBLIC_URL = 'https://files.example.invalid/st_1';
const STORAGE_ID = 'st_1';
const TOKEN_SECRET = 'tok_secret_finalwave';

const UPLOAD_FAILED_ONE = '1 image could not be uploaded. Please try again.';
const UPLOAD_FAILED_TWO = '2 images could not be uploaded. Please try again.';
const REGISTRATION_FAILED_ONE = '1 image could not be saved to your account. Please try again.';

// Each storage POST takes the next answer, and a POST after the list runs out succeeds.
const postAnswers: boolean[] = [];
// Each registration call takes the next answer, and a call after the list runs out succeeds.
const registrationAnswers: ('ok' | 'fail')[] = [];
const saved: unknown[] = [];

async function fakeFetch(
  _input: string,
  init?: { method?: string },
): Promise<{ ok: boolean; blob(): Promise<{ size: number; type: string }>; json(): Promise<{ storageId: string }> }> {
  if (init?.method === 'POST') {
    const ok = postAnswers.shift() ?? true;
    return {
      ok,
      blob: async () => ({ size: 3, type: 'image/jpeg' }),
      json: async () => ({ storageId: STORAGE_ID }),
    };
  }
  return {
    ok: true,
    blob: async () => ({ size: 3, type: 'image/jpeg' }),
    json: async () => ({ storageId: STORAGE_ID }),
  };
}

function asset(name: string): PickedAsset {
  return { uri: `file:///cache/${name}.jpg`, width: 1000, height: 1000, fileSize: 3, mimeType: 'image/jpeg' };
}

const realFetch = globalThis.fetch;

describe('useImageUpload reports failed picks through validationErrors', () => {
  beforeEach(() => {
    resetDoubles();
    latest.current = null;
    saved.length = 0;
    postAnswers.length = 0;
    registrationAnswers.length = 0;
    picker.gallery = { canceled: true, assets: [] };
    picker.camera = { canceled: true, assets: [] };
    imageControl.holdCompression = false;
    imageControl.held.length = 0;
    Reflect.set(globalThis, 'fetch', fakeFetch);
    server.mutations.set(generateUploadUrl, async () => UPLOAD_URL);
    server.mutations.set(saveImageMetadata, async (args) => {
      saved.push(args);
      if (registrationAnswers.shift() === 'fail') {
        throw new Error(`registration rejected for ${TOKEN_SECRET}`);
      }
      return null;
    });
    server.queries.set(getUrl, () => PUBLIC_URL);
    clerk.user = subject('clerk_A');
  });

  afterEach(() => {
    Reflect.set(globalThis, 'fetch', realFetch);
  });

  it('a gallery pick whose registration fails twice shows a retry message, adds no image, and stops uploading', async () => {
    registrationAnswers.push('fail', 'fail');
    picker.gallery = { canceled: false, assets: [asset('one')] };
    const client = new ConvexClientDouble('https://upload-test.example.invalid');
    const root = mountWithClient(client);
    await root.render(createElement(Probe));

    await act(async () => {
      await upload().pickImages(1);
    });

    assert.equal(saved.length, 2, 'registration is attempted twice');
    assert.deepEqual(upload().images, [], 'the unregistered file is not added');
    assert.deepEqual(upload().validationErrors, [REGISTRATION_FAILED_ONE]);
    assert.equal(
      upload().validationErrors.some((message) => message.includes(TOKEN_SECRET)),
      false,
      'the internal error text is not shown',
    );
    assert.equal(upload().isUploading, false);
    await root.unmount();
  });

  it('a gallery pick whose storage upload fails shows an upload message and adds no image', async () => {
    postAnswers.push(false);
    picker.gallery = { canceled: false, assets: [asset('one')] };
    const client = new ConvexClientDouble('https://upload-test.example.invalid');
    const root = mountWithClient(client);
    await root.render(createElement(Probe));

    await act(async () => {
      await upload().pickImages(1);
    });

    assert.deepEqual(saved, [], 'nothing is registered for a file that was not stored');
    assert.deepEqual(upload().images, []);
    assert.deepEqual(upload().validationErrors, [UPLOAD_FAILED_ONE]);
    assert.equal(upload().isUploading, false);
    await root.unmount();
  });

  it('a camera capture whose registration fails twice shows a retry message and adds no image', async () => {
    registrationAnswers.push('fail', 'fail');
    picker.camera = { canceled: false, assets: [asset('shot')] };
    const client = new ConvexClientDouble('https://upload-test.example.invalid');
    const root = mountWithClient(client);
    await root.render(createElement(Probe));

    await act(async () => {
      await upload().pickFromCamera();
    });

    assert.equal(saved.length, 2, 'registration is attempted twice');
    assert.deepEqual(upload().images, [], 'the unregistered capture is not added');
    assert.deepEqual(upload().validationErrors, [REGISTRATION_FAILED_ONE]);
    assert.equal(upload().isUploading, false);
    await root.unmount();
  });

  it('a camera capture whose storage upload fails shows an upload message and adds no image', async () => {
    postAnswers.push(false);
    picker.camera = { canceled: false, assets: [asset('shot')] };
    const client = new ConvexClientDouble('https://upload-test.example.invalid');
    const root = mountWithClient(client);
    await root.render(createElement(Probe));

    await act(async () => {
      await upload().pickFromCamera();
    });

    assert.deepEqual(upload().images, []);
    assert.deepEqual(upload().validationErrors, [UPLOAD_FAILED_ONE]);
    assert.equal(upload().isUploading, false);
    await root.unmount();
  });

  it('a gallery pick cancelled by a subject change shows no message and adds no image', async () => {
    const client = new ConvexClientDouble('https://upload-test.example.invalid');
    const root = mountWithClient(client);
    await root.render(createElement(Probe));
    picker.gallery = { canceled: false, assets: [asset('one')] };
    // Compression waits for the test, so the subject can change while the pick is in flight.
    imageControl.holdCompression = true;

    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = upload().pickImages(1);
      await settleTasks();
    });
    clerk.user = subject('clerk_B');
    await root.render(createElement(Probe));
    const held = imageControl.held[0];
    assert.ok(held, 'compression started');
    await act(async () => {
      held.release({ uri: 'file:///cache/one.jpg.compressed.jpg' });
      await pending;
    });
    await settleTasks();

    assert.deepEqual(upload().validationErrors, [], 'a cancelled pick shows no error');
    assert.deepEqual(upload().images, []);
    assert.equal(upload().isUploading, false);
    assert.deepEqual(saved, [], 'nothing is registered for the switched subject');
    await root.unmount();
  });

  it('a mixed gallery pick keeps the good images and shows one message with the failure count', async () => {
    // Asset one registers, asset two fails both attempts, asset three registers.
    registrationAnswers.push('ok', 'fail', 'fail', 'ok');
    picker.gallery = { canceled: false, assets: [asset('one'), asset('two'), asset('three')] };
    const client = new ConvexClientDouble('https://upload-test.example.invalid');
    const root = mountWithClient(client);
    await root.render(createElement(Probe));

    await act(async () => {
      await upload().pickImages(5);
    });

    assert.equal(upload().images.length, 2, 'the two registered images are kept');
    assert.deepEqual(upload().validationErrors, [REGISTRATION_FAILED_ONE]);
    assert.equal(upload().isUploading, false);
    await root.unmount();
  });

  it('a gallery pick where every image fails shows one message with the total count', async () => {
    postAnswers.push(false, false);
    picker.gallery = { canceled: false, assets: [asset('one'), asset('two')] };
    const client = new ConvexClientDouble('https://upload-test.example.invalid');
    const root = mountWithClient(client);
    await root.render(createElement(Probe));

    await act(async () => {
      await upload().pickImages(5);
    });

    assert.deepEqual(upload().images, []);
    assert.deepEqual(upload().validationErrors, [UPLOAD_FAILED_TWO]);
    await root.unmount();
  });

  it('the next successful pick clears the failure message', async () => {
    registrationAnswers.push('fail', 'fail');
    picker.gallery = { canceled: false, assets: [asset('one')] };
    const client = new ConvexClientDouble('https://upload-test.example.invalid');
    const root = mountWithClient(client);
    await root.render(createElement(Probe));

    await act(async () => {
      await upload().pickImages(5);
    });
    assert.deepEqual(upload().validationErrors, [REGISTRATION_FAILED_ONE]);

    picker.gallery = { canceled: false, assets: [asset('two')] };
    await act(async () => {
      await upload().pickImages(5);
    });

    assert.deepEqual(upload().validationErrors, [], 'a new pick starts with no error');
    assert.equal(upload().images.length, 1);
    await root.unmount();
  });
});
