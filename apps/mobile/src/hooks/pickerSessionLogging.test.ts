import assert from 'node:assert/strict';
import Module from 'node:module';
import { format } from 'node:util';
import { afterEach, before, beforeEach, describe, it, mock, type TestContext } from 'node:test';
import { act, createElement, type ReactNode } from 'react';
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

// Runs the real useImageUpload hook under the real ConvexProviderWithClerk, and records every console.error call. Each
// failure stage injects an internal error whose text is a sentinel. The sentinel must never reach the log, and the log
// carries only the fixed diagnostic code of the stage that failed.

const SENTINEL = 'reviewer_internal_token_123';
const UPLOAD_FAILED_CODE = 'image_upload_failed';
const REGISTRATION_FAILED_CODE = 'image_metadata_registration_failed';

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

const picked: { gallery: PickerResult; camera: PickerResult } = {
  gallery: { canceled: true, assets: [] },
  camera: { canceled: true, assets: [] },
};

const pickerStub = {
  MediaTypeOptions: { Images: 'images' },
  requestCameraPermissionsAsync: async (): Promise<{ status: string }> => ({ status: 'granted' }),
  launchImageLibraryAsync: async (): Promise<PickerResult> => picked.gallery,
  launchCameraAsync: async (): Promise<PickerResult> => picked.camera,
};

// Installed after the harness, so the picker resolves to this stand-in while the other doubles stay in place.
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

function Probe(): ReactNode {
  latest.current = useImageUpload();
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

// Which external step fails. The POST failure throws the sentinel from the fetch itself, the way a network error does.
type FailureStage = 'upload_url' | 'post' | 'registration';

const failure: { stage: FailureStage | null } = { stage: null };

async function fakeFetch(
  _input: string,
  init?: { method?: string },
): Promise<{ ok: boolean; blob(): Promise<{ size: number; type: string }>; json(): Promise<{ storageId: string }> }> {
  if (init?.method === 'POST' && failure.stage === 'post') {
    throw new Error(`storage rejected ${SENTINEL}`);
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

// Mounts the screen for one test and unmounts it when the test ends, even when an assertion fails first.
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

describe('pickerSession logs only fixed diagnostic codes for upload failures', () => {
  beforeEach(() => {
    resetDoubles();
    latest.current = null;
    failure.stage = null;
    picked.gallery = { canceled: true, assets: [] };
    picked.camera = { canceled: true, assets: [] };
    Reflect.set(globalThis, 'fetch', fakeFetch);
    server.mutations.set(generateUploadUrl, async () => UPLOAD_URL);
    server.mutations.set(saveImageMetadata, async () => null);
    server.queries.set(getUrl, () => PUBLIC_URL);
    clerk.user = subject('clerk_A');
  });

  afterEach(() => {
    Reflect.set(globalThis, 'fetch', realFetch);
  });

  const sources = ['gallery', 'camera'] as const;
  const stages: readonly { stage: FailureStage; code: string }[] = [
    { stage: 'upload_url', code: UPLOAD_FAILED_CODE },
    { stage: 'post', code: UPLOAD_FAILED_CODE },
    { stage: 'registration', code: REGISTRATION_FAILED_CODE },
  ];

  for (const source of sources) {
    for (const { stage, code } of stages) {
      it(`a ${source} ${stage} failure logs only ${code} and never the internal error text`, async (t) => {
        failure.stage = stage;
        if (stage === 'upload_url') {
          server.mutations.set(generateUploadUrl, async () => {
            throw new Error(SENTINEL);
          });
        }
        if (stage === 'registration') {
          server.mutations.set(saveImageMetadata, async () => {
            throw new Error(SENTINEL);
          });
        }
        const picks = { canceled: false, assets: [asset('one')] };
        if (source === 'gallery') {
          picked.gallery = picks;
        } else {
          picked.camera = picks;
        }

        const logged: unknown[][] = [];
        const errorLog = mock.method(console, 'error', (...args: unknown[]) => {
          logged.push(args);
        });
        try {
          const client = new ConvexClientDouble('https://upload-test.example.invalid');
          const root = mountScreen(t, client);
          await root.render(createElement(Probe));

          await act(async () => {
            if (source === 'gallery') {
              await upload().pickImages(1);
            } else {
              await upload().pickFromCamera();
            }
          });
          await settleTasks();

          // The text the console prints for each call, so an Error object's message is included as printed.
          const text = logged.map((args) => format(...args)).join('\n');
          assert.equal(text.includes(SENTINEL), false, 'the internal error text is never logged');
          assert.ok(
            logged.some((args) => args.length === 1 && args[0] === code),
            `the log carries exactly the fixed code ${code}`,
          );
          assert.equal(
            logged.flat().some((arg) => arg instanceof Error),
            false,
            'no error object is logged',
          );
          await root.unmount();
        } finally {
          errorLog.mock.restore();
        }
      });
    }
  }
});
