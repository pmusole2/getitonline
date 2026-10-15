import assert from 'node:assert/strict';
import test from 'node:test';

import * as aiHealth from './aiHealth';
import { createCtx, createDb, handlerOf, type Db } from '../tests/support/convexFakeDb';

// The health query reads only environment presence. It takes no arguments and never reaches the provider, so the
// fake database is only there to satisfy the handler signature.

type Args = Record<string, unknown>;
type AiHealth = { configured: boolean; model: string };

const getAiHealth = handlerOf<Args, AiHealth>(aiHealth.getAiHealth);

const KEY = 'fixture-credential-value-for-health-test';

function newDb(): Db {
  return createDb({});
}

async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const names = ['OPENAI_API_KEY', 'OPENAI_MODEL'];
  const saved = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) {
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) {
      process.env[name] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

test('health reports not configured when the key is missing', async () => {
  const result = await withEnv({}, () => getAiHealth(createCtx(newDb(), null), {}));

  assert.deepEqual(result, { configured: false, model: 'gpt-4o-mini' });
});

test('health reports not configured when the key is blank', async () => {
  const result = await withEnv({ OPENAI_API_KEY: '   ' }, () => getAiHealth(createCtx(newDb(), null), {}));

  assert.deepEqual(result, { configured: false, model: 'gpt-4o-mini' });
});

test('health reports configured with the default model when a key is present', async () => {
  const result = await withEnv({ OPENAI_API_KEY: KEY }, () => getAiHealth(createCtx(newDb(), null), {}));

  assert.deepEqual(result, { configured: true, model: 'gpt-4o-mini' });
});

test('health reports the OPENAI_MODEL override and ignores a blank one', async () => {
  const overridden = await withEnv({ OPENAI_API_KEY: KEY, OPENAI_MODEL: 'gpt-4o' }, () =>
    getAiHealth(createCtx(newDb(), null), {}),
  );
  assert.deepEqual(overridden, { configured: true, model: 'gpt-4o' });

  const blank = await withEnv({ OPENAI_API_KEY: KEY, OPENAI_MODEL: ' ' }, () =>
    getAiHealth(createCtx(newDb(), null), {}),
  );
  assert.deepEqual(blank, { configured: true, model: 'gpt-4o-mini' });
});

test('health never returns the key or any part of it', async () => {
  const result = await withEnv({ OPENAI_API_KEY: KEY }, () => getAiHealth(createCtx(newDb(), null), {}));

  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(JSON.stringify(result).includes(KEY.slice(3, 20)), false);
});

test('getAiHealth never calls fetch for any environment combination', async () => {
  const envs: Array<Record<string, string | undefined>> = [
    {},
    { OPENAI_API_KEY: '' },
    { OPENAI_API_KEY: KEY },
    { OPENAI_API_KEY: KEY, OPENAI_MODEL: 'gpt-4o' },
    { OPENAI_API_KEY: KEY, OPENAI_MODEL: 'bad model' },
    { OPENAI_API_KEY: 'sk-FAKE\nInjected: FAKE-PROMPT' },
    { OPENAI_MODEL: 'gpt-4o' },
  ];
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  const spy = async (): Promise<Response> => {
    fetchCalls += 1;
    throw new Error('getAiHealth must not reach the network');
  };
  globalThis.fetch = spy;
  try {
    for (const env of envs) {
      await withEnv(env, () => getAiHealth(createCtx(newDb(), null), {}));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalls, 0);
});

test('health does not depend on who is asking', async () => {
  const guest = await withEnv({ OPENAI_API_KEY: KEY }, () => getAiHealth(createCtx(newDb(), null), {}));
  const signedIn = await withEnv({ OPENAI_API_KEY: KEY }, () => getAiHealth(createCtx(newDb(), 'clerk_user'), {}));

  assert.deepEqual(guest, signedIn);
});
