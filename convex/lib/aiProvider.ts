// Pinkie's OpenAI chat-completions adapter. It is the only place that talks to the provider, so the key, prompts,
// images, and provider bodies stay inside it. Callers receive a reply or a safe code, never raw provider data.

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

export const DEFAULT_AI_MODEL = "gpt-4o-mini";
export const AI_PROVIDER_TIMEOUT_MS = 30_000;
export const MAX_IMAGE_DATA_URL_LENGTH = 500_000;

// One initial attempt plus at most one retry, and only for transient failures.
const MAX_ATTEMPTS = 2;

const MAX_API_KEY_LENGTH = 512;
const MAX_MODEL_LENGTH = 100;

const IMAGE_DATA_URL_PREFIX = /^data:image\/(?:png|jpeg|webp|gif);base64,/;
const BASE64_BODY = /^[A-Za-z0-9+/]+$/;

export type AiProviderErrorCode =
  | "not_configured"
  | "invalid_request"
  | "timeout"
  | "provider_error"
  | "rate_limited"
  | "bad_response"
  | "incomplete";

export type AiChatResult = { ok: true; text: string } | { ok: false; code: AiProviderErrorCode };

export type AiEnv = Readonly<Record<string, string | undefined>>;

export type AiConfiguration = { configured: boolean; model: string };

export type AiTextPart = { type: "text"; text: string };
export type AiImagePart = { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };
export type AiMessage = {
  role: "system" | "user" | "assistant";
  content: string | ReadonlyArray<AiTextPart | AiImagePart>;
};

export type AiFetchInit = { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal };
export type AiFetch = (url: string, init: AiFetchInit) => Promise<Response>;

export type CallChatModelInput = {
  messages: ReadonlyArray<AiMessage>;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  env: AiEnv;
  fetchImpl?: AiFetch;
  timeoutMs?: number;
};

type AttemptOutcome = { ok: true; text: string } | { ok: false; code: AiProviderErrorCode; retryable: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a non-empty value of at most maxLength printable ASCII characters (0x21-0x7E). Such a value is safe to send in a header or JSON body unescaped. */
export function isHeaderSafeToken(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && /^[!-~]+$/.test(value);
}

// A blank or header-unsafe key is treated as absent, so it fails closed before any provider attempt.
function readApiKey(env: AiEnv): string | null {
  const key = env.OPENAI_API_KEY?.trim();
  return key !== undefined && isHeaderSafeToken(key, MAX_API_KEY_LENGTH) ? key : null;
}

// A blank or unsafe override falls back to the default model.
function readModel(env: AiEnv): string {
  const model = env.OPENAI_MODEL?.trim();
  return model !== undefined && isHeaderSafeToken(model, MAX_MODEL_LENGTH) ? model : DEFAULT_AI_MODEL;
}

/** Reports configuration from environment presence alone. It never calls the provider and never returns the key. */
export function describeAiConfiguration(env: AiEnv): AiConfiguration {
  return { configured: readApiKey(env) !== null, model: readModel(env) };
}

// Structural check of a standard base64 payload: non-empty, a multiple of 4, '=' only as up to two trailing characters,
// and no other characters. Native atob decodes exactly these payloads. The check is linear and never decodes.
function isValidBase64Payload(payload: string): boolean {
  if (payload.length === 0 || payload.length % 4 !== 0) {
    return false;
  }
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const body = payload.slice(0, payload.length - padding);
  return body.length > 0 && BASE64_BODY.test(body);
}

/** Accepts only a base64 data URL for a supported image type, within the same limit as the legacy visual search. */
export function isSupportedImageDataUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_IMAGE_DATA_URL_LENGTH) {
    return false;
  }
  const prefix = IMAGE_DATA_URL_PREFIX.exec(value);
  return prefix !== null && isValidBase64Payload(value.slice(prefix[0].length));
}

function messagesAreSupported(messages: ReadonlyArray<AiMessage>): boolean {
  return messages.every(
    (message) =>
      typeof message.content === "string" ||
      message.content.every((part) => part.type === "text" || isSupportedImageDataUrl(part.image_url.url))
  );
}

function buildRequestBody(model: string, input: CallChatModelInput): string {
  return JSON.stringify({
    model,
    messages: input.messages,
    max_tokens: input.maxTokens ?? 1000,
    temperature: input.temperature ?? 0.7,
    ...(input.jsonMode ? { response_format: { type: "json_object" } } : {}),
  });
}

function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

type Completion = { ok: true; text: string } | { ok: false; code: "bad_response" | "incomplete" };

// Accepts only a reply the model finished normally. A cut-off, filtered, tool-call, or refused completion is incomplete,
// and a body without a string finish_reason has an unknown shape. Provider text is never placed in the failure.
function extractCompletion(body: unknown): Completion {
  const choices: unknown = isRecord(body) ? body.choices : undefined;
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const finishReason: unknown = isRecord(first) ? first.finish_reason : undefined;
  const message: unknown = isRecord(first) ? first.message : undefined;
  if (typeof finishReason !== "string") {
    return { ok: false, code: "bad_response" };
  }
  if (finishReason !== "stop") {
    return { ok: false, code: "incomplete" };
  }
  const refusal: unknown = isRecord(message) ? message.refusal : undefined;
  if (refusal !== undefined && refusal !== null && refusal !== "") {
    return { ok: false, code: "incomplete" };
  }
  const content: unknown = isRecord(message) ? message.content : undefined;
  if (typeof content !== "string") {
    return { ok: false, code: "bad_response" };
  }
  const text = content.trim();
  return text ? { ok: true, text } : { ok: false, code: "bad_response" };
}

async function readResponse(response: Response): Promise<AttemptOutcome> {
  if (response.status === 429) {
    return { ok: false, code: "rate_limited", retryable: true };
  }
  if (response.status >= 500) {
    return { ok: false, code: "provider_error", retryable: true };
  }
  if (!response.ok) {
    return { ok: false, code: "provider_error", retryable: false };
  }
  const completion = extractCompletion(parseJson(await response.text()));
  if (!completion.ok) {
    return { ok: false, code: completion.code, retryable: false };
  }
  return { ok: true, text: completion.text };
}

async function attempt(
  fetchImpl: AiFetch,
  request: { apiKey: string; body: string; timeoutMs: number }
): Promise<AttemptOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetchImpl(OPENAI_CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${request.apiKey}` },
      body: request.body,
      signal: controller.signal,
    });
    return await readResponse(response);
  } catch {
    return controller.signal.aborted
      ? { ok: false, code: "timeout", retryable: true }
      : { ok: false, code: "provider_error", retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls the chat model. Returns a discriminated result and never throws for provider or configuration failures.
 * Logs only the safe error code.
 */
export async function callChatModel(input: CallChatModelInput): Promise<AiChatResult> {
  const apiKey = readApiKey(input.env);
  if (apiKey === null) {
    return { ok: false, code: "not_configured" };
  }
  if (!messagesAreSupported(input.messages)) {
    return { ok: false, code: "invalid_request" };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const request = {
    apiKey,
    body: buildRequestBody(readModel(input.env), input),
    timeoutMs: input.timeoutMs ?? AI_PROVIDER_TIMEOUT_MS,
  };

  let outcome = await attempt(fetchImpl, request);
  for (let attempts = 1; !outcome.ok && outcome.retryable && attempts < MAX_ATTEMPTS; attempts++) {
    outcome = await attempt(fetchImpl, request);
  }

  if (outcome.ok) {
    return { ok: true, text: outcome.text };
  }
  console.error("[ai] provider call failed", outcome.code);
  return { ok: false, code: outcome.code };
}
