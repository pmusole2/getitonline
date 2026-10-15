import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_PROVIDER_TIMEOUT_MS,
  DEFAULT_AI_MODEL,
  MAX_IMAGE_DATA_URL_LENGTH,
  callChatModel,
  describeAiConfiguration,
  isHeaderSafeToken,
  isSupportedImageDataUrl,
  type AiFetch,
  type AiMessage,
} from './aiProvider';

// The adapter is exercised against a scripted fake fetch. Each step is one provider attempt. A 'hang' step only settles
// when the adapter aborts it, so the timeout path runs through the real AbortController.

const KEY = 'sk-test-PROVIDER-KEY-0123456789';
const PROMPT = 'PRIVATE-PROMPT-TEXT-MARKER';
const REPLY = 'MODEL-REPLY-TEXT-MARKER';

type Step = { kind: 'respond'; status: number; text: string } | { kind: 'throw' } | { kind: 'hang' };

type Call = {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal };
};

function respond(status: number, body: unknown): Step {
  return { kind: 'respond', status, text: typeof body === 'string' ? body : JSON.stringify(body) };
}

function reply(content: unknown, finishReason: unknown = 'stop'): Step {
  return respond(200, { choices: [{ finish_reason: finishReason, message: { role: 'assistant', content } }] });
}

const THROW: Step = { kind: 'throw' };
const HANG: Step = { kind: 'hang' };

function fakeFetch(steps: Step[]): { fetchImpl: AiFetch; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl: AiFetch = async (url, init) => {
    calls.push({ url, init });
    const step = steps[index++];
    if (!step) {
      throw new Error('unexpected provider attempt');
    }
    if (step.kind === 'throw') {
      throw new TypeError('fetch failed');
    }
    if (step.kind === 'hang') {
      return await new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return new Response(step.text, { status: step.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

function sentField(call: Call | undefined, field: string): unknown {
  if (!call) {
    return undefined;
  }
  const body: unknown = JSON.parse(call.init.body);
  return typeof body === 'object' && body !== null ? Reflect.get(body, field) : undefined;
}

const MESSAGES: AiMessage[] = [
  { role: 'system', content: 'You are Pinkie.' },
  { role: 'user', content: PROMPT },
];

const ENV = { OPENAI_API_KEY: KEY };

async function call(steps: Step[], env: Record<string, string | undefined> = ENV) {
  const { fetchImpl, calls } = fakeFetch(steps);
  const result = await callChatModel({ messages: MESSAGES, env, fetchImpl, timeoutMs: 20 });
  return { result, calls };
}

test('a successful call returns the trimmed reply, posts the chat request, and never returns the key', async () => {
  const { result, calls } = await call([reply(`  ${REPLY}\n`)]);

  assert.deepEqual(result, { ok: true, text: REPLY });
  assert.equal(calls.length, 1);
  const [first] = calls;
  assert.ok(first);
  assert.equal(first.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(first.init.method, 'POST');
  assert.equal(first.init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(first.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(first.init.body), {
    model: DEFAULT_AI_MODEL,
    messages: MESSAGES,
    max_tokens: 1000,
    temperature: 0.7,
  });
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test('maxTokens, temperature, and jsonMode are sent when the caller sets them', async () => {
  const { fetchImpl, calls } = fakeFetch([reply(REPLY)]);
  await callChatModel({
    messages: MESSAGES,
    maxTokens: 180,
    temperature: 0.2,
    jsonMode: true,
    env: ENV,
    fetchImpl,
  });

  assert.equal(sentField(calls[0], 'max_tokens'), 180);
  assert.equal(sentField(calls[0], 'temperature'), 0.2);
  assert.deepEqual(sentField(calls[0], 'response_format'), { type: 'json_object' });
});

test('a missing or blank API key fails closed as not_configured without calling the provider', async () => {
  for (const env of [{}, { OPENAI_API_KEY: undefined }, { OPENAI_API_KEY: '' }, { OPENAI_API_KEY: '   \n' }]) {
    const { result, calls } = await call([], env);
    assert.deepEqual(result, { ok: false, code: 'not_configured' });
    assert.equal(calls.length, 0, 'no provider attempt may be made without a key');
  }
});

test('the model defaults to gpt-4o-mini, honours OPENAI_MODEL, and ignores a blank override', async () => {
  assert.equal(DEFAULT_AI_MODEL, 'gpt-4o-mini');

  const defaulted = await call([reply(REPLY)], ENV);
  assert.equal(sentField(defaulted.calls[0], 'model'), 'gpt-4o-mini');

  const overridden = await call([reply(REPLY)], { ...ENV, OPENAI_MODEL: 'gpt-4o' });
  assert.equal(sentField(overridden.calls[0], 'model'), 'gpt-4o');

  const blank = await call([reply(REPLY)], { ...ENV, OPENAI_MODEL: '  ' });
  assert.equal(sentField(blank.calls[0], 'model'), 'gpt-4o-mini');
});

const HEADER_UNSAFE_KEYS = [
  'sk-FAKE\nInjected: FAKE-PROMPT',
  'sk-FAKE\rInjected',
  'sk-FAKE\tInjected',
  'sk-FAKE Injected',
  'sk-FAKE\u0000Injected',
  'sk-FAKE\u0007Injected',
  'sk-FAKE\u007FInjected',
  'sk-FAKE-ünïcode',
  `sk-${'A'.repeat(513)}`,
];

test('a key that is not header-safe is not_configured with zero fetch calls', async () => {
  for (const key of HEADER_UNSAFE_KEYS) {
    const { result, calls } = await call([], { OPENAI_API_KEY: key });
    assert.deepEqual(result, { ok: false, code: 'not_configured' }, JSON.stringify(key));
    assert.equal(calls.length, 0, `no provider attempt may be made for ${JSON.stringify(key)}`);
  }
});

test('an invalid key reports configured:false and never echoes any part of the key', () => {
  for (const key of HEADER_UNSAFE_KEYS) {
    const result = describeAiConfiguration({ OPENAI_API_KEY: key });
    assert.deepEqual(result, { configured: false, model: 'gpt-4o-mini' }, JSON.stringify(key));
    assert.equal(JSON.stringify(result).includes('FAKE'), false);
  }
});

test('a key of exactly 512 header-safe characters is accepted', () => {
  const longest = `sk-${'A'.repeat(509)}`;
  assert.equal(longest.length, 512);
  assert.equal(describeAiConfiguration({ OPENAI_API_KEY: longest }).configured, true);
});

test('isHeaderSafeToken accepts printable ASCII within the length limit only', () => {
  assert.equal(isHeaderSafeToken('sk-abc_DEF.123!~', 512), true);
  assert.equal(isHeaderSafeToken('x'.repeat(100), 100), true);
  for (const value of ['', ' ', 'a b', 'a\tb', 'a\nb', 'a\rb', 'a\u0000b', 'a\u007Fb', 'é', 'x'.repeat(101)]) {
    assert.equal(isHeaderSafeToken(value, 100), false, JSON.stringify(value));
  }
});

test('an OPENAI_MODEL override that is not header or body safe falls back to the default model', async () => {
  for (const model of ['gpt 4o', 'gpt-4o\n5', 'gpt-4o\u00005', 'gpt-é', 'x'.repeat(101)]) {
    const { calls } = await call([reply(REPLY)], { ...ENV, OPENAI_MODEL: model });
    assert.equal(sentField(calls[0], 'model'), DEFAULT_AI_MODEL, JSON.stringify(model));
    assert.deepEqual(describeAiConfiguration({ ...ENV, OPENAI_MODEL: model }), {
      configured: true,
      model: DEFAULT_AI_MODEL,
    });
  }
});

test('an OPENAI_MODEL override of exactly 100 safe characters is honoured', async () => {
  const model = 'm'.repeat(100);
  const { calls } = await call([reply(REPLY)], { ...ENV, OPENAI_MODEL: model });
  assert.equal(sentField(calls[0], 'model'), model);
});

test('the provider timeout is 30 seconds by default', () => {
  assert.equal(AI_PROVIDER_TIMEOUT_MS, 30_000);
});

test('a timeout is retried once, and a second timeout returns timeout', async () => {
  const { result, calls } = await call([HANG, HANG]);

  assert.deepEqual(result, { ok: false, code: 'timeout' });
  assert.equal(calls.length, 2);
});

test('a timeout followed by a success returns the success', async () => {
  const { result, calls } = await call([HANG, reply(REPLY)]);

  assert.deepEqual(result, { ok: true, text: REPLY });
  assert.equal(calls.length, 2);
});

test('a 429 followed by a success returns the success after one retry', async () => {
  const { result, calls } = await call([respond(429, { error: 'slow down' }), reply(REPLY)]);

  assert.deepEqual(result, { ok: true, text: REPLY });
  assert.equal(calls.length, 2);
});

test('two 500 responses return provider_error after exactly two attempts', async () => {
  const { result, calls } = await call([respond(500, 'boom'), respond(500, 'boom')]);

  assert.deepEqual(result, { ok: false, code: 'provider_error' });
  assert.equal(calls.length, 2);
});

test('a 400 response is not retried and returns provider_error', async () => {
  const { result, calls } = await call([respond(400, { error: 'bad request' })]);

  assert.deepEqual(result, { ok: false, code: 'provider_error' });
  assert.equal(calls.length, 1);
});

test('a 401 response is not retried and returns provider_error', async () => {
  const { result, calls } = await call([respond(401, { error: 'invalid key' })]);

  assert.deepEqual(result, { ok: false, code: 'provider_error' });
  assert.equal(calls.length, 1);
});

test('a network error is retried once, and a second network error returns provider_error', async () => {
  const twice = await call([THROW, THROW]);
  assert.deepEqual(twice.result, { ok: false, code: 'provider_error' });
  assert.equal(twice.calls.length, 2);

  const recovered = await call([THROW, reply(REPLY)]);
  assert.deepEqual(recovered.result, { ok: true, text: REPLY });
  assert.equal(recovered.calls.length, 2);
});

test('a final 429 returns rate_limited after exactly two attempts', async () => {
  const { result, calls } = await call([respond(429, 'slow'), respond(429, 'slow')]);

  assert.deepEqual(result, { ok: false, code: 'rate_limited' });
  assert.equal(calls.length, 2);
});

test('a response body that is not JSON is bad_response and is not retried', async () => {
  const { result, calls } = await call([respond(200, '<html>not json</html>')]);

  assert.deepEqual(result, { ok: false, code: 'bad_response' });
  assert.equal(calls.length, 1);
});

test('a response with an unexpected shape is bad_response', async () => {
  const shapes: unknown[] = [
    {},
    { choices: [] },
    { choices: [{}] },
    { choices: [{ message: {} }] },
    { choices: 'nope' },
    null,
    ['array'],
  ];
  for (const body of shapes) {
    const { result } = await call([respond(200, body)]);
    assert.deepEqual(result, { ok: false, code: 'bad_response' }, `shape ${JSON.stringify(body)}`);
  }
});

test('a completion without a string finish_reason is bad_response and is not retried', async () => {
  const bodies: unknown[] = [
    { choices: [{ message: { role: 'assistant', content: REPLY } }] },
    { choices: [{ finish_reason: null, message: { role: 'assistant', content: REPLY } }] },
    { choices: [{ finish_reason: 42, message: { role: 'assistant', content: REPLY } }] },
  ];
  for (const body of bodies) {
    const { result, calls } = await call([respond(200, body)]);
    assert.deepEqual(result, { ok: false, code: 'bad_response' }, JSON.stringify(body));
    assert.equal(calls.length, 1);
  }
});

test('an empty refusal string does not block a stop completion', async () => {
  const { result } = await call([
    respond(200, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: REPLY, refusal: '' } }] }),
  ]);
  assert.deepEqual(result, { ok: true, text: REPLY });
});

// Each case is a completion the provider did not finish, filtered, or refused. None may be returned as success, and
// none may be retried, because a second attempt would produce the same incomplete answer.
const INCOMPLETE_CASES: Array<{ name: string; body: unknown }> = [
  {
    name: 'length',
    body: { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{"approved": true' } }] },
  },
  {
    name: 'content_filter with text',
    body: { choices: [{ finish_reason: 'content_filter', message: { role: 'assistant', content: REPLY } }] },
  },
  {
    name: 'tool_calls with text',
    body: { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: REPLY } }] },
  },
  {
    name: 'function_call with text',
    body: { choices: [{ finish_reason: 'function_call', message: { role: 'assistant', content: REPLY } }] },
  },
  {
    name: 'an unrecognised finish_reason',
    body: { choices: [{ finish_reason: 'some_new_reason', message: { role: 'assistant', content: REPLY } }] },
  },
  {
    name: 'a populated refusal alongside text',
    body: {
      choices: [
        { finish_reason: 'stop', message: { role: 'assistant', content: REPLY, refusal: `REFUSAL ${PROMPT}` } },
      ],
    },
  },
  {
    name: 'a populated refusal with null content',
    body: {
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null, refusal: `REFUSAL ${PROMPT}` } }],
    },
  },
];

test('a length, filtered, tool-call, or refused completion is incomplete with exactly one provider attempt', async () => {
  for (const { name, body } of INCOMPLETE_CASES) {
    const { result, calls } = await call([respond(200, body)]);
    assert.deepEqual(result, { ok: false, code: 'incomplete' }, name);
    assert.equal(calls.length, 1, `${name} must not be retried`);
  }
});

test('incomplete results and their logs never contain provider text', async (t) => {
  const spy = t.mock.method(console, 'error', () => undefined);
  const results: unknown[] = [];
  for (const { body } of INCOMPLETE_CASES) {
    results.push((await call([respond(200, body)])).result);
  }

  const returned = JSON.stringify(results);
  const logged = JSON.stringify(spy.mock.calls.map((entry) => entry.arguments));
  for (const marker of [REPLY, PROMPT, '{"approved": true', 'REFUSAL']) {
    assert.equal(returned.includes(marker), false, `${marker} must not be returned`);
    assert.equal(logged.includes(marker), false, `${marker} must not be logged`);
  }
  assert.equal(logged.includes('incomplete'), true, 'the safe code is still logged');
});

test('an empty, blank, or non-string reply is bad_response', async () => {
  for (const content of ['', '   \n', null, 42, { text: REPLY }, ['x']]) {
    const { result } = await call([reply(content)]);
    assert.deepEqual(result, { ok: false, code: 'bad_response' }, `content ${JSON.stringify(content)}`);
  }
});

test('an image part with an unsupported data URL is invalid_request and nothing is sent', async () => {
  const { fetchImpl, calls } = fakeFetch([reply(REPLY)]);
  const result = await callChatModel({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: 'data:text/html;base64,PGgxPg==' } },
        ],
      },
    ],
    env: ENV,
    fetchImpl,
  });

  assert.deepEqual(result, { ok: false, code: 'invalid_request' });
  assert.equal(calls.length, 0);
});

test('a supported image part is sent as a data URL', async () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const { fetchImpl, calls } = fakeFetch([reply(REPLY)]);
  const result = await callChatModel({
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }] }],
    env: ENV,
    fetchImpl,
  });

  assert.deepEqual(result, { ok: true, text: REPLY });
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(sentField(calls[0], 'messages')).includes(dataUrl), true);
});

test('prompts, reply text, and the key never reach console.error on any failure path', async (t) => {
  const spy = t.mock.method(console, 'error', () => undefined);
  const { fetchImpl } = fakeFetch([respond(500, `${PROMPT} ${KEY}`), respond(500, `${REPLY} ${KEY}`)]);
  const failed = await callChatModel({ messages: MESSAGES, env: ENV, fetchImpl, timeoutMs: 20 });
  const parse = await call([respond(200, `${REPLY} ${KEY}`)]);

  assert.deepEqual(failed, { ok: false, code: 'provider_error' });
  assert.deepEqual(parse.result, { ok: false, code: 'bad_response' });
  const logged = JSON.stringify(spy.mock.calls.map((entry) => entry.arguments));
  for (const secret of [PROMPT, REPLY, KEY]) {
    assert.equal(logged.includes(secret), false, `${secret} must not be logged`);
  }
});

test('describeAiConfiguration reports configured only when a non-blank key is present', () => {
  assert.deepEqual(describeAiConfiguration({}), { configured: false, model: 'gpt-4o-mini' });
  assert.deepEqual(describeAiConfiguration({ OPENAI_API_KEY: '  ' }), { configured: false, model: 'gpt-4o-mini' });
  assert.deepEqual(describeAiConfiguration({ OPENAI_API_KEY: KEY }), { configured: true, model: 'gpt-4o-mini' });
  assert.deepEqual(describeAiConfiguration({ OPENAI_API_KEY: KEY, OPENAI_MODEL: ' gpt-4o ' }), {
    configured: true,
    model: 'gpt-4o',
  });
  assert.deepEqual(describeAiConfiguration({ OPENAI_API_KEY: KEY, OPENAI_MODEL: '' }), {
    configured: true,
    model: 'gpt-4o-mini',
  });
});

test('describeAiConfiguration returns only the configured flag and model', () => {
  const result = describeAiConfiguration({ OPENAI_API_KEY: KEY });
  assert.deepEqual(Object.keys(result).sort(), ['configured', 'model']);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

const PREFIX = 'data:image/png;base64,';

test('isSupportedImageDataUrl accepts png, jpeg, webp, and gif base64 data URLs', () => {
  for (const mime of ['png', 'jpeg', 'webp', 'gif']) {
    assert.equal(isSupportedImageDataUrl(`data:image/${mime};base64,iVBORw0KGgo=`), true, mime);
  }
  assert.equal(isSupportedImageDataUrl('data:image/jpeg;base64,/9j/4AAQSkZJRg=='), true);
});

// A valid base64 payload has a length divisible by 4, and the prefix is 22 characters for png, so a valid png data
// URL's total length is always 2 modulo 4. The largest valid png URL within the limit is therefore 499,998 characters.
function pngDataUrlOfLength(totalLength: number): string {
  return PREFIX + 'A'.repeat(totalLength - PREFIX.length);
}

test('isSupportedImageDataUrl accepts the largest valid png data URL within the 500,000-character limit', () => {
  assert.equal(MAX_IMAGE_DATA_URL_LENGTH, 500_000);
  const largest = pngDataUrlOfLength(499_998);
  assert.equal(largest.length, 499_998);
  assert.equal(isSupportedImageDataUrl(largest), true);
});

test('isSupportedImageDataUrl rejects a valid-shaped data URL over the limit', () => {
  // 500,002 is the next length a valid png data URL can have after 499,998; 500,001 is not a valid shape at all.
  const oversize = pngDataUrlOfLength(500_002);
  assert.equal(oversize.length, 500_002);
  assert.equal(isSupportedImageDataUrl(oversize), false);
});

test('isSupportedImageDataUrl accepts valid base64 payloads of every padding length', () => {
  for (const payload of ['AAAA', 'AAA=', 'AA==', 'iVBORw0KGgo=', '/+8=', 'AB+/AAAA']) {
    assert.equal(isSupportedImageDataUrl(PREFIX + payload), true, payload);
  }
});

test('isSupportedImageDataUrl rejects base64 payloads with an impossible length or padding shape', () => {
  for (const payload of ['A', 'AA', 'AAA', 'AA=', 'AAAA=', 'AAAAA', '=AAA', 'AA==A', 'A===', '====', 'AA=A', 'A=AA']) {
    assert.equal(isSupportedImageDataUrl(PREFIX + payload), false, payload);
  }
});

test('isSupportedImageDataUrl rejects whitespace and newlines inside the payload', () => {
  for (const payload of ['AA AA===', 'AAAA\nAAAA', 'AAAA AAAA', 'AAAA\n', ' AAAA', 'AAA\r=']) {
    assert.equal(isSupportedImageDataUrl(PREFIX + payload), false, JSON.stringify(payload));
  }
});

// atob also accepts unpadded input and strips whitespace, which the length and whitespace rules deliberately reject, so
// this list covers only the shapes where the structural rules and native decoding are meant to agree.
test('isSupportedImageDataUrl agrees with native atob on the padded shapes it checks', () => {
  const payloads = [
    'A',
    'AAAA',
    'AA=',
    'AA==',
    'AAA=',
    'AAAA=',
    'AAAA==',
    '=AAA',
    'AA==A',
    'A===',
    '====',
    'AA=A',
    'AB+/',
    'AB==',
    'AB+/AA==',
  ];
  for (const payload of payloads) {
    let decodes = true;
    try {
      atob(payload);
    } catch {
      decodes = false;
    }
    assert.equal(isSupportedImageDataUrl(PREFIX + payload), decodes, JSON.stringify(payload));
  }
});

test('an image part with malformed base64 is invalid_request and nothing is sent', async () => {
  for (const url of ['data:image/png;base64,A', 'data:image/png;base64,AA=', 'data:image/png;base64,AAAA=']) {
    const { fetchImpl, calls } = fakeFetch([reply(REPLY)]);
    const result = await callChatModel({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }],
      env: ENV,
      fetchImpl,
    });
    assert.deepEqual(result, { ok: false, code: 'invalid_request' }, url);
    assert.equal(calls.length, 0, url);
  }
});

test('isSupportedImageDataUrl rejects non-image and unsupported image types', () => {
  for (const value of [
    'data:text/html;base64,PGgxPg==',
    'data:application/octet-stream;base64,AAAA',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/bmp;base64,Qk0=',
    'data:image/heic;base64,AAAA',
    'data:video/mp4;base64,AAAA',
  ]) {
    assert.equal(isSupportedImageDataUrl(value), false, value);
  }
});

test('isSupportedImageDataUrl rejects non-base64 and malformed payloads', () => {
  for (const value of [
    'data:image/png,AAAA',
    'data:image/png;base64,not base64!',
    'data:image/png;base64,AA=A',
    'data:image/png;base64,AAA==A',
    'data:image/png;base64,AB\nCD',
    'data:image/png;base64,AAAA<script>',
    'image/png;base64,AAAA',
  ]) {
    assert.equal(isSupportedImageDataUrl(value), false, value);
  }
});

test('isSupportedImageDataUrl rejects empty values and non-string values', () => {
  for (const value of ['', 'data:image/png;base64,', PREFIX, undefined, null, 42, {}, ['data:image/png;base64,AAAA']]) {
    assert.equal(isSupportedImageDataUrl(value), false, JSON.stringify(value));
  }
});
