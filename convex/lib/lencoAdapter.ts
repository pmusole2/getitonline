// Private Lenco v2 non-card provider boundary (collections and transfers only, no cards).
//
// This module is a private transport helper: it performs no Convex reads or writes and registers no
// action, mutation, query, or HTTP route. Callers persist a durable intent before invoking it and settle
// through the single internal settlement mutation. It never initiates card payments.
//
// Wire contract (current official Lenco v2 pages, inspected 2026-10-13; sandbox acceptance unverified):
// - Collections: POST {base}/collections/mobile-money with a numeric major-unit amount, a constrained
//   reference, phone, operator, explicit country "zm", and the merchant bearer token. Zambia operators are
//   airtel, mtn, and zamtel.
// - Transfers: POST {base}/transfers/mobile-money or {base}/transfers/bank-account with the debit
//   accountId, a major-unit amount, a reference, and destination fields. Bank selection and bank-account
//   resolution use the bankId from the GET {base}/banks?country=zm directory.
// - Receipts arrive in a boolean-status envelope with decimal-string amounts, nullable collection
//   fees/references, and ZMW currency. Only the documented "successful"/"failed" words are terminal;
//   every other status word (pending, pay-offline, otp-required, 3ds-auth-required, historical aliases
//   such as paid/completed/reversed/cancelled, or anything unknown) ingests as non-terminal "pending"
//   and never as success or failure. A "settled" settlement flag is preserved
//   as a fact and never treated as a second success.
// - Collection receipts follow data.type ("mobile-money" only; card/bank-account/null fail safe) with
//   merchant bearer and payer facts (country "zm", supported operator, valid phone) nested under
//   data.mobileMoneyDetails. Transfer receipts require a decimal fee string, a UUID debit accountId,
//   and a destination from data.creditAccount (mobile-money with country/operator/phone, or
//   bank-account with bank.id/accountNumber and bank country "zm"); anything missing or malformed is
//   bad_response/unknown, never a partial success. The published generic GET transfer shape omits
//   the mobile-money country, so GET status lookups retain it as an explicit null (never inferred);
//   initiation responses still require "zm". Resolved facts never copy accountName, card details,
//   customer objects, narration, or raw provider fields into normalized receipts.
// - Status lookups use GET {base}/collections/status/{reference} and {base}/transfers/status/{reference};
//   destination resolution uses POST {base}/resolve/mobile-money and {base}/resolve/bank-account.
//   The bank directory returns id/name/country records.
// - Money: integer minor units inside this repo; numeric major units on the provider wire, serialized so
//   the value round-trips through canonical decimal text with no cent loss. Cents are never sent as the
//   provider amount.
// - Webhook authenticity: HMAC-SHA512 over the exact raw body bytes, keyed with the UTF-8 bytes of the
//   SHA256 hex digest (lowercase) of the bearer token.
//
// Transport safety: a 20-second abortable timeout, redirect:"error" (a credential-bearing redirect fails
// instead of resending the bearer), no automatic POST retries, and at most one GET retry for transient
// network/timeout/429/5xx failures against the same URL. POST ambiguity (timeout, HTTP rejection, provider
// false, duplicate reference, malformed body) stays outcome "unknown" so reconciliation - not the caller -
// decides; it is never reported as a financial reversal. A GET 404 is outcome "not_found", which proves
// nothing about whether a transfer failed. Failures carry narrow codes only: no raw provider payloads,
// keys, or personal data appear in errors, and this module logs nothing.

export const LENCO_BASE_URL = "https://api.lenco.co/access/v2";
export const LENCO_TIMEOUT_MS = 20_000;
export const LENCO_CURRENCY = "ZMW";
export const LENCO_COUNTRY = "zm";

export const ZAMBIA_OPERATORS = ["airtel", "mtn", "zamtel"] as const;

export type ZambiaOperator = (typeof ZAMBIA_OPERATORS)[number];

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };

export type LencoFetchInit = {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  redirect: "error";
};

export type LencoFetch = (url: string, init: LencoFetchInit) => Promise<Response>;

export type LencoConfig = {
  apiKey: string;
  debitAccountId?: string;
  baseUrl?: string;
  timeoutMs?: number;
};

export type LencoOutcome = "not_started" | "unknown" | "not_found" | "failed";

export type LencoErrorCode =
  | "missing_config"
  | "invalid_config"
  | "invalid_input"
  | "timeout"
  | "http_error"
  | "provider_error"
  | "duplicate_reference"
  | "bad_response"
  | "not_found"
  | "redirect";

export type LencoFailure = { ok: false; code: LencoErrorCode; outcome: LencoOutcome; retryable: boolean };

export type LencoResult<T> = { ok: true; value: T } | LencoFailure;

export type LencoReceiptStatus = "successful" | "failed" | "pending";

export type CollectionReceipt = {
  kind: "collection";
  id: string;
  reference: string | null;
  amountMinor: number;
  feeMinor: number | null;
  currency: "ZMW";
  status: LencoReceiptStatus;
  collectionType: "mobile-money";
  country: "zm";
  bearer: "merchant";
  operator: ZambiaOperator;
  phone: string;
  reasonForFailure: string | null;
  settlementStatus: string | null;
};

export type TransferDestination =
  | { kind: "mobile-money"; phone: string; operator: ZambiaOperator; country: "zm" | null }
  | { kind: "bank-account"; bankId: string; accountNumber: string; country: "zm" };

export type TransferReceipt = {
  kind: "transfer";
  id: string;
  reference: string | null;
  amountMinor: number;
  feeMinor: number;
  currency: "ZMW";
  status: LencoReceiptStatus;
  transferType: "mobile-money" | "bank-account";
  debitAccountId: string;
  destination: TransferDestination;
  reasonForFailure: string | null;
  settlementStatus: string | null;
};

export type LencoReceipt = CollectionReceipt | TransferReceipt;

export type BankRecord = { id: string; name: string; country: "zm" };

export type ResolvedMobileMoneyAccount = {
  type: "mobile-money";
  phone: string;
  operator: ZambiaOperator;
  country: "zm";
  accountName: string | null;
};

export type ResolvedBankAccount = {
  type: "bank-account";
  accountNumber: string;
  bank: { id: string; name: string; country: "zm" };
  accountName: string | null;
};

export type MobileMoneyCollectionInput = {
  reference: string;
  phone: string;
  operator: string;
  amountMinor: number;
};

export type MobileMoneyTransferInput = {
  reference: string;
  phone: string;
  operator: string;
  amountMinor: number;
};

export type BankTransferInput = {
  reference: string;
  bankId: string;
  accountNumber: string;
  amountMinor: number;
};

export type MobileMoneyResolveInput = { phone: string; operator: string };

export type BankResolveInput = { accountNumber: string; bankId: string };

export type LencoAdapter = {
  readonly configured: boolean;
  initiateMobileMoneyCollection(input: MobileMoneyCollectionInput): Promise<LencoResult<CollectionReceipt>>;
  getCollectionById(id: string): Promise<LencoResult<CollectionReceipt>>;
  getCollectionByReference(reference: string): Promise<LencoResult<CollectionReceipt>>;
  initiateMobileMoneyTransfer(input: MobileMoneyTransferInput): Promise<LencoResult<TransferReceipt>>;
  initiateBankTransfer(input: BankTransferInput): Promise<LencoResult<TransferReceipt>>;
  getTransferById(id: string): Promise<LencoResult<TransferReceipt>>;
  getTransferByReference(reference: string): Promise<LencoResult<TransferReceipt>>;
  listBanks(): Promise<LencoResult<BankRecord[]>>;
  resolveMobileMoney(input: MobileMoneyResolveInput): Promise<LencoResult<ResolvedMobileMoneyAccount>>;
  resolveBankAccount(input: BankResolveInput): Promise<LencoResult<ResolvedBankAccount>>;
  verifyWebhookSignature(raw: Uint8Array, signature: string | null): Promise<boolean>;
};

const REFERENCE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const PHONE_PATTERN = /^[0-9+][0-9+ ]{4,31}$/;

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;

const HEX_128_PATTERN = /^[0-9a-fA-F]{128}$/;

const MAX_API_KEY_LENGTH = 1024;

const MAX_BASE_URL_LENGTH = 256;

const MAX_STRING_FIELD_LENGTH = 128;

/** Provider references are nonempty and limited to [-._A-Za-z0-9]. */
export function isValidReference(value: string): boolean {
  return REFERENCE_PATTERN.test(value);
}

/** Provider identifiers use UUID syntax. Bank identifiers are opaque strings and are not validated here. */
export function isValidProviderId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function isValidPhone(value: string): boolean {
  return PHONE_PATTERN.test(value);
}

export function isSupportedOperator(value: string): value is ZambiaOperator {
  return (ZAMBIA_OPERATORS as ReadonlyArray<string>).includes(value);
}

/** Internal money is a positive safe-integer cent amount. */
export function isPositiveSafeCents(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Serializes validated cents to the numeric major-unit provider amount. Returns null for invalid input
 * or when the value cannot round-trip through canonical decimal text with no cent loss, so callers can
 * never emit a lossy provider amount. The result is never the cents integer itself.
 */
export function centsToMajorUnits(cents: number): number | null {
  if (!isPositiveSafeCents(cents)) {
    return null;
  }
  const major = cents / 100;
  if (!Number.isFinite(major)) {
    return null;
  }
  return parseMajorDecimalToCents(String(major)) === cents ? major : null;
}

/** Canonical decimal text for validated cents (for example 1001 becomes "10.01"). */
export function formatCentsToDecimal(cents: number): string | null {
  if (!isPositiveSafeCents(cents)) {
    return null;
  }
  const whole = Math.floor(cents / 100);
  const remainder = cents % 100;
  const padded = remainder < 10 ? `0${remainder}` : `${remainder}`;
  return `${whole}.${padded}`;
}

/**
 * Strictly parses a provider decimal-string amount into cents: a non-negative decimal with at most two
 * fraction digits and a value inside the safe-integer cent range. Anything else (signs, exponents,
 * whitespace, empty text, non-strings, unsafe magnitudes) returns null.
 */
export function parseMajorDecimalToCents(value: string): number | null {
  if (value.length === 0 || value.length > 32) {
    return null;
  }
  const match = DECIMAL_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  let wholeCents = 0;
  for (const digit of whole) {
    wholeCents = wholeCents * 10 + (digit.charCodeAt(0) - 48);
    if (!Number.isSafeInteger(wholeCents)) {
      return null;
    }
  }
  if (wholeCents > Math.floor(Number.MAX_SAFE_INTEGER / 100)) {
    return null;
  }
  let cents = wholeCents * 100;
  if (fraction.length === 1) {
    cents += (fraction.charCodeAt(0) - 48) * 10;
  } else if (fraction.length === 2) {
    cents += (fraction.charCodeAt(0) - 48) * 10 + (fraction.charCodeAt(1) - 48);
  }
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * Normalizes a provider status word. Only the documented "successful" and "failed" words are terminal
 * (case-insensitive, surrounding whitespace allowed). Challenge words (pay-offline, otp-required,
 * 3ds-auth-required), pending words, historical aliases (paid, success, completed, complete, reversed,
 * cancelled, canceled, declined, failure), and anything unknown stay non-terminal "pending" so ingestion
 * fails closed instead of inferring success or failure.
 */
export function normalizeReceiptStatus(value: string): LencoReceiptStatus {
  const key = value.trim().toLowerCase();
  if (key === "successful") {
    return "successful";
  }
  if (key === "failed") {
    return "failed";
  }
  return "pending";
}

function asObject(value: JsonValue): JsonObject | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value;
  }
  return null;
}

function asObjectOrNull(value: JsonValue | undefined): JsonObject | null {
  return value === undefined ? null : asObject(value);
}

function field(obj: JsonObject, name: string): JsonValue | undefined {
  return Object.prototype.hasOwnProperty.call(obj, name) ? obj[name] : undefined;
}

function readNonEmptyString(value: JsonValue | undefined, maxLength: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return null;
  }
  return value;
}

function readCentsAmount(value: JsonValue | undefined): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const cents = parseMajorDecimalToCents(value);
  return cents !== null && cents > 0 ? cents : null;
}

function readNullableCentsFee(value: JsonValue | undefined): number | null | "invalid" {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return "invalid";
  }
  const cents = parseMajorDecimalToCents(value);
  return cents !== null && cents >= 0 ? cents : "invalid";
}

function readOptionalReference(value: JsonValue | undefined): string | null | "invalid" {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === "string" && isValidReference(value) ? value : "invalid";
}

function readNullableText(value: JsonValue | undefined): string | null | "invalid" {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === "string" ? value : "invalid";
}

type ResolvedConfig = { apiKey: string; debitAccountId: string | null; baseUrl: string; timeoutMs: number };

/** Header-unsafe bytes (CR/LF, other controls, DEL, non-ASCII) must never reach the bearer header. */
function isHeaderSafeBearer(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) {
      return false;
    }
  }
  return true;
}

function resolveBaseUrl(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_BASE_URL_LENGTH) {
    return null;
  }
  // The WHATWG parser silently drops empty query/fragment delimiters and trims surrounding
  // control/space characters, so screen the raw text first: a literal "?", "#", whitespace,
  // C0 control, or DEL would otherwise smuggle a query/fragment or a space into the request
  // path when the API route is appended.
  if (raw.includes("?") || raw.includes("#") || /\s/.test(raw)) {
    return null;
  }
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return null;
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") {
    return null;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return null;
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    return null;
  }
  if (parsed.hostname === "") {
    return null;
  }
  // Return the canonical parsed URL (origin plus path without trailing slashes) rather than
  // the raw text, so equivalent spellings cannot diverge when routes are appended.
  const path = parsed.pathname.replace(/\/+$/, "");
  const normalized = parsed.origin + path;
  return normalized.length > "https://".length ? normalized : null;
}

function resolveConfig(
  config: LencoConfig
): { ok: true; value: ResolvedConfig } | { ok: false; code: "missing_config" | "invalid_config" } {
  if (typeof config.apiKey !== "string" || config.apiKey.length === 0 || config.apiKey.trim().length === 0) {
    return { ok: false, code: "missing_config" };
  }
  if (
    config.apiKey.length > MAX_API_KEY_LENGTH ||
    !isHeaderSafeBearer(config.apiKey) ||
    config.apiKey !== config.apiKey.trim()
  ) {
    return { ok: false, code: "invalid_config" };
  }
  let baseUrl = LENCO_BASE_URL;
  if (config.baseUrl !== undefined) {
    if (typeof config.baseUrl !== "string") {
      return { ok: false, code: "invalid_config" };
    }
    const parsed = resolveBaseUrl(config.baseUrl);
    if (parsed === null) {
      return { ok: false, code: "invalid_config" };
    }
    baseUrl = parsed;
  }
  let debitAccountId: string | null = null;
  if (config.debitAccountId !== undefined) {
    if (typeof config.debitAccountId !== "string" || !isValidProviderId(config.debitAccountId)) {
      return { ok: false, code: "invalid_config" };
    }
    debitAccountId = config.debitAccountId;
  }
  let timeoutMs = LENCO_TIMEOUT_MS;
  if (config.timeoutMs !== undefined) {
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 120_000) {
      return { ok: false, code: "invalid_config" };
    }
    timeoutMs = config.timeoutMs;
  }
  return { ok: true, value: { apiKey: config.apiKey, debitAccountId, baseUrl, timeoutMs } };
}

function failure(code: LencoErrorCode, outcome: LencoOutcome, retryable = false): LencoFailure {
  return { ok: false, code, outcome, retryable };
}

type FetchOutcome = { status: number; text: string } | { error: "timeout" | "redirect" | "network" };

async function fetchOnce(
  fetcher: LencoFetch,
  url: string,
  method: "GET" | "POST",
  apiKey: string,
  body: string | null,
  timeoutMs: number
): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
    const init: LencoFetchInit = { method, headers, signal: controller.signal, redirect: "error" };
    if (body !== null) {
      headers["Content-Type"] = "application/json";
      init.body = body;
    }
    const response = await fetcher(url, init);
    const text = await response.text();
    return { status: response.status, text };
  } catch (error) {
    if (controller.signal.aborted) {
      return { error: "timeout" };
    }
    const message = error instanceof Error ? error.message : "";
    return /redirect/i.test(message) ? { error: "redirect" } : { error: "network" };
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonSafe(text: string): JsonValue | null {
  try {
    const parsed: JsonValue = JSON.parse(text);
    return parsed === undefined ? null : parsed;
  } catch {
    return null;
  }
}

type HttpResult =
  | { ok: true; status: number; body: JsonValue }
  | { ok: false; kind: "timeout" | "redirect" | "network" | "malformed" | { http: number; text: string } };

function toHttpResult(outcome: FetchOutcome): HttpResult {
  if ("error" in outcome) {
    return { ok: false, kind: outcome.error };
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    return { ok: false, kind: { http: outcome.status, text: outcome.text } };
  }
  const body = parseJsonSafe(outcome.text);
  return body === null ? { ok: false, kind: "malformed" } : { ok: true, status: outcome.status, body };
}

function isRetryableGetOutcome(outcome: FetchOutcome): boolean {
  if ("error" in outcome) {
    return outcome.error !== "redirect";
  }
  return outcome.status === 429 || outcome.status >= 500;
}

async function performPost(
  fetcher: LencoFetch,
  url: string,
  apiKey: string,
  body: JsonObject,
  timeoutMs: number
): Promise<HttpResult> {
  return toHttpResult(await fetchOnce(fetcher, url, "POST", apiKey, JSON.stringify(body), timeoutMs));
}

async function performGet(fetcher: LencoFetch, url: string, apiKey: string, timeoutMs: number): Promise<HttpResult> {
  const first = await fetchOnce(fetcher, url, "GET", apiKey, null, timeoutMs);
  if (!isRetryableGetOutcome(first)) {
    return toHttpResult(first);
  }
  return toHttpResult(await fetchOnce(fetcher, url, "GET", apiKey, null, timeoutMs));
}

function mentionsDuplicate(obj: JsonObject): boolean {
  const candidates: Array<JsonValue | undefined> = [field(obj, "message"), field(obj, "code"), field(obj, "error")];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /duplicat/i.test(candidate)) {
      return true;
    }
    const nested = asObjectOrNull(candidate);
    if (nested !== null) {
      const nestedMessage = field(nested, "message");
      if (typeof nestedMessage === "string" && /duplicat/i.test(nestedMessage)) {
        return true;
      }
    }
  }
  return false;
}

type Envelope = { ok: true; data: JsonValue } | { ok: false; duplicate: boolean } | null;

function readEnvelope(body: JsonValue): Envelope {
  const obj = asObject(body);
  if (obj === null) {
    return null;
  }
  const status = field(obj, "status");
  if (status === true) {
    const data = field(obj, "data");
    return data === undefined ? null : { ok: true, data };
  }
  if (status === false) {
    return { ok: false, duplicate: mentionsDuplicate(obj) };
  }
  return null;
}

function readCommonReceiptFields(obj: JsonObject): {
  id: string;
  reference: string | null;
  amountMinor: number;
  status: LencoReceiptStatus;
  reasonForFailure: string | null;
  settlementStatus: string | null;
} | null {
  const id = readNonEmptyString(field(obj, "id"), MAX_STRING_FIELD_LENGTH);
  if (id === null || !isValidProviderId(id)) {
    return null;
  }
  const reference = readOptionalReference(field(obj, "reference"));
  if (reference === "invalid") {
    return null;
  }
  const amountMinor = readCentsAmount(field(obj, "amount"));
  if (amountMinor === null) {
    return null;
  }
  const currency = field(obj, "currency");
  if (currency !== LENCO_CURRENCY) {
    return null;
  }
  const statusRaw = field(obj, "status");
  if (typeof statusRaw !== "string" || statusRaw.length === 0) {
    return null;
  }
  const reasonForFailure = readNullableText(field(obj, "reasonForFailure"));
  if (reasonForFailure === "invalid") {
    return null;
  }
  const settlementStatus = readNullableText(field(obj, "settlementStatus"));
  if (settlementStatus === "invalid") {
    return null;
  }
  return { id, reference, amountMinor, status: normalizeReceiptStatus(statusRaw), reasonForFailure, settlementStatus };
}

function toCollectionReceipt(data: JsonValue): CollectionReceipt | null {
  const obj = asObject(data);
  if (obj === null) {
    return null;
  }
  const common = readCommonReceiptFields(obj);
  if (common === null) {
    return null;
  }
  const fee = readNullableCentsFee(field(obj, "fee"));
  if (fee === "invalid") {
    return null;
  }
  // This non-card decoder handles mobile-money collections only. Any other type (card, bank-account,
  // null, or missing) fails safe so historical unsupported receipts stay reconciliation work, not new
  // card activity. The merchant bearer is the intended collection rule.
  if (field(obj, "type") !== "mobile-money" || field(obj, "bearer") !== "merchant") {
    return null;
  }
  const details = asObjectOrNull(field(obj, "mobileMoneyDetails"));
  if (details === null) {
    return null;
  }
  if (field(details, "country") !== LENCO_COUNTRY) {
    return null;
  }
  const operatorRaw = field(details, "operator");
  if (typeof operatorRaw !== "string" || !isSupportedOperator(operatorRaw)) {
    return null;
  }
  const phone = readNonEmptyString(field(details, "phone"), 64);
  if (phone === null || !isValidPhone(phone)) {
    return null;
  }
  return {
    kind: "collection",
    id: common.id,
    reference: common.reference,
    amountMinor: common.amountMinor,
    feeMinor: fee,
    currency: LENCO_CURRENCY,
    status: common.status,
    collectionType: "mobile-money",
    country: LENCO_COUNTRY,
    bearer: "merchant",
    operator: operatorRaw,
    phone,
    reasonForFailure: common.reasonForFailure,
    settlementStatus: common.settlementStatus,
  };
}

/**
 * Strictly parses a required provider decimal-string fee into cents: a non-negative decimal with at most
 * two fraction digits inside the safe-integer cent range. Zero is valid. Anything missing or malformed
 * returns null so transfer receipts without a validated fee fail safe.
 */
function readRequiredCentsFee(value: JsonValue | undefined): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const cents = parseMajorDecimalToCents(value);
  return cents !== null && cents >= 0 ? cents : null;
}

type TransferDestinationOptions = { allowMissingMobileCountry?: boolean };

function readTransferDestination(
  creditAccount: JsonObject,
  options: TransferDestinationOptions = {}
): TransferDestination | null {
  const creditType = field(creditAccount, "type");
  if (creditType === "mobile-money") {
    // Initiation responses always require an explicit "zm" country. The published generic
    // GET transfer shape omits creditAccount.country for mobile-money, so GET reconciliation
    // paths retain a missing (undefined) country as an explicit null instead of inferring it.
    // A null country is documented absence, not wildcard authority: settlement must still
    // match the immutable reference/providerID, the configured debit account, the exact
    // phone/operator, and ZMW. Any explicit country value (null, foreign, malformed) fails.
    const countryField = field(creditAccount, "country");
    let country: "zm" | null;
    if (countryField === undefined) {
      if (options.allowMissingMobileCountry !== true) {
        return null;
      }
      country = null;
    } else if (countryField === LENCO_COUNTRY) {
      country = LENCO_COUNTRY;
    } else {
      return null;
    }
    const operatorRaw = field(creditAccount, "operator");
    const phone = readNonEmptyString(field(creditAccount, "phone"), 64);
    if (typeof operatorRaw !== "string" || !isSupportedOperator(operatorRaw)) {
      return null;
    }
    if (phone === null || !isValidPhone(phone)) {
      return null;
    }
    return { kind: "mobile-money", phone, operator: operatorRaw, country };
  }
  if (creditType === "bank-account") {
    const accountNumber = readNonEmptyString(field(creditAccount, "accountNumber"), 64);
    const bank = asObjectOrNull(field(creditAccount, "bank"));
    if (accountNumber === null || bank === null) {
      return null;
    }
    const bankId = readNonEmptyString(field(bank, "id"), MAX_STRING_FIELD_LENGTH);
    if (bankId === null || field(bank, "country") !== LENCO_COUNTRY) {
      return null;
    }
    return { kind: "bank-account", bankId, accountNumber, country: LENCO_COUNTRY };
  }
  return null;
}

function toTransferReceipt(data: JsonValue, options: TransferDestinationOptions = {}): TransferReceipt | null {
  const obj = asObject(data);
  if (obj === null) {
    return null;
  }
  const common = readCommonReceiptFields(obj);
  if (common === null) {
    return null;
  }
  // The published transfer fee is a required decimal string (zero is valid). A missing or malformed
  // fee, debit account, or destination fails the whole receipt: no unknown/null success is allowed, and
  // accountName/extraData/narration are never copied into the normalized receipt.
  const feeMinor = readRequiredCentsFee(field(obj, "fee"));
  if (feeMinor === null) {
    return null;
  }
  const debitAccountId = readNonEmptyString(field(obj, "accountId"), MAX_STRING_FIELD_LENGTH);
  if (debitAccountId === null || !isValidProviderId(debitAccountId)) {
    return null;
  }
  const creditAccount = asObjectOrNull(field(obj, "creditAccount"));
  if (creditAccount === null) {
    return null;
  }
  const destination = readTransferDestination(creditAccount, options);
  if (destination === null) {
    return null;
  }
  const transferType = destination.kind;
  return {
    kind: "transfer",
    id: common.id,
    reference: common.reference,
    amountMinor: common.amountMinor,
    feeMinor,
    currency: LENCO_CURRENCY,
    status: common.status,
    transferType,
    debitAccountId,
    destination,
    reasonForFailure: common.reasonForFailure,
    settlementStatus: common.settlementStatus,
  };
}

/** Reuses the exact non-card decoders; signed transfers never accept missing country. */
export function decodeLencoWebhookReceipt(
  kind: "collection" | "transfer",
  data: JsonValue
): CollectionReceipt | TransferReceipt | null {
  return kind === "collection" ? toCollectionReceipt(data) : toTransferReceipt(data);
}

function toBankRecords(data: JsonValue): BankRecord[] | null {
  if (!Array.isArray(data)) {
    return null;
  }
  const banks: BankRecord[] = [];
  for (const entry of data) {
    const obj = asObject(entry);
    if (obj === null) {
      return null;
    }
    const id = readNonEmptyString(field(obj, "id"), MAX_STRING_FIELD_LENGTH);
    const name = readNonEmptyString(field(obj, "name"), MAX_STRING_FIELD_LENGTH);
    if (id === null || name === null || field(obj, "country") !== LENCO_COUNTRY) {
      return null;
    }
    banks.push({ id, name, country: LENCO_COUNTRY });
  }
  return banks;
}

function toResolvedMobileMoney(data: JsonValue): ResolvedMobileMoneyAccount | null {
  const obj = asObject(data);
  if (obj === null) {
    return null;
  }
  if (field(obj, "type") !== "mobile-money" || field(obj, "country") !== LENCO_COUNTRY) {
    return null;
  }
  const phone = readNonEmptyString(field(obj, "phone"), 64);
  const operatorRaw = field(obj, "operator");
  if (phone === null || !isValidPhone(phone) || typeof operatorRaw !== "string" || !isSupportedOperator(operatorRaw)) {
    return null;
  }
  const accountName = readNullableText(field(obj, "accountName"));
  if (accountName === "invalid") {
    return null;
  }
  return { type: "mobile-money", phone, operator: operatorRaw, country: LENCO_COUNTRY, accountName };
}

function toResolvedBankAccount(data: JsonValue): ResolvedBankAccount | null {
  const obj = asObject(data);
  if (obj === null) {
    return null;
  }
  if (field(obj, "type") !== "bank-account") {
    return null;
  }
  const accountNumber = readNonEmptyString(field(obj, "accountNumber"), 64);
  const bank = asObjectOrNull(field(obj, "bank"));
  if (accountNumber === null || bank === null) {
    return null;
  }
  const bankId = readNonEmptyString(field(bank, "id"), MAX_STRING_FIELD_LENGTH);
  const bankName = readNonEmptyString(field(bank, "name"), MAX_STRING_FIELD_LENGTH);
  if (bankId === null || bankName === null || field(bank, "country") !== LENCO_COUNTRY) {
    return null;
  }
  const accountName = readNullableText(field(obj, "accountName"));
  if (accountName === "invalid") {
    return null;
  }
  return {
    type: "bank-account",
    accountNumber,
    bank: { id: bankId, name: bankName, country: LENCO_COUNTRY },
    accountName,
  };
}

function httpStatusOf(result: HttpResult): number | null {
  if (!result.ok && typeof result.kind === "object") {
    return result.kind.http;
  }
  return null;
}

function postFailure(result: HttpResult): LencoFailure {
  if (result.ok) {
    return failure("bad_response", "unknown");
  }
  if (result.kind === "timeout") {
    return failure("timeout", "unknown");
  }
  if (result.kind === "redirect") {
    return failure("redirect", "unknown");
  }
  if (result.kind === "network") {
    return failure("provider_error", "unknown");
  }
  if (result.kind === "malformed") {
    return failure("bad_response", "unknown");
  }
  // The documented duplicate-reference rejection arrives as HTTP 400 with a boolean-false envelope.
  // Parse that narrow shape only to recover the duplicate code; the outcome stays unknown with no
  // retry or reversal, and raw messages/payloads are never surfaced. A plain 400 stays http_error.
  const parsed = parseJsonSafe(result.kind.text);
  const envelope = parsed === null ? null : readEnvelope(parsed);
  if (envelope !== null && !envelope.ok && envelope.duplicate) {
    return failure("duplicate_reference", "unknown");
  }
  return failure("http_error", "unknown");
}

function getFailure(result: HttpResult): LencoFailure {
  if (result.ok) {
    return failure("bad_response", "unknown");
  }
  if (result.kind === "timeout") {
    return failure("timeout", "unknown", true);
  }
  if (result.kind === "redirect") {
    return failure("redirect", "unknown");
  }
  if (result.kind === "network") {
    return failure("provider_error", "unknown", true);
  }
  if (result.kind === "malformed") {
    return failure("bad_response", "unknown");
  }
  const status = httpStatusOf(result);
  if (status === 404) {
    return failure("not_found", "not_found");
  }
  if (status === 429 || (status !== null && status >= 500)) {
    return failure("http_error", "unknown", true);
  }
  return failure("http_error", "unknown");
}

function receiptFailure(envelope: { ok: false; duplicate: boolean }): LencoFailure {
  return envelope.duplicate ? failure("duplicate_reference", "unknown") : failure("provider_error", "unknown");
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/**
 * Creates the private non-card Lenco client. The factory never throws and never calls the provider: a
 * missing or unsupported configuration surfaces as a "not_started" failure from each method instead.
 * Collections never require a debit account; transfers do.
 */
export function createLencoAdapter(config: LencoConfig, fetcher: LencoFetch = fetch): LencoAdapter {
  const resolved = resolveConfig(config);

  async function validated<T>(
    buildUrl: (value: ResolvedConfig) => string,
    checkInput: () => boolean,
    run: (value: ResolvedConfig, url: string) => Promise<LencoResult<T>>
  ): Promise<LencoResult<T>> {
    if (!resolved.ok) {
      return failure(resolved.code, "not_started");
    }
    if (!checkInput()) {
      return failure("invalid_input", "not_started");
    }
    return run(resolved.value, buildUrl(resolved.value));
  }

  function configDebitAccountId(): { ok: true; id: string } | { ok: false; code: "missing_config" } {
    if (!resolved.ok || resolved.value.debitAccountId === null) {
      return { ok: false, code: "missing_config" };
    }
    return { ok: true, id: resolved.value.debitAccountId };
  }

  function validCollectionInput(input: MobileMoneyCollectionInput): boolean {
    return (
      isValidReference(input.reference) &&
      isValidPhone(input.phone) &&
      isSupportedOperator(input.operator) &&
      centsToMajorUnits(input.amountMinor) !== null
    );
  }

  function validMobileTransferInput(input: MobileMoneyTransferInput): boolean {
    return (
      isValidReference(input.reference) &&
      isValidPhone(input.phone) &&
      isSupportedOperator(input.operator) &&
      centsToMajorUnits(input.amountMinor) !== null
    );
  }

  function validBankTransferInput(input: BankTransferInput): boolean {
    const bankId =
      typeof input.bankId === "string" && input.bankId.length > 0 && input.bankId.length <= MAX_STRING_FIELD_LENGTH;
    const accountNumber =
      typeof input.accountNumber === "string" && input.accountNumber.length > 0 && input.accountNumber.length <= 64;
    return (
      isValidReference(input.reference) && bankId && accountNumber && centsToMajorUnits(input.amountMinor) !== null
    );
  }

  return {
    get configured(): boolean {
      return resolved.ok;
    },

    async initiateMobileMoneyCollection(input) {
      return validated(
        (value) => `${value.baseUrl}/collections/mobile-money`,
        () => validCollectionInput(input),
        async (value, url) => {
          const amount = centsToMajorUnits(input.amountMinor);
          if (amount === null) {
            return failure("invalid_input", "not_started");
          }
          const body: JsonObject = {
            amount,
            reference: input.reference,
            phone: input.phone,
            operator: input.operator,
            country: LENCO_COUNTRY,
          };
          const result = await performPost(fetcher, url, value.apiKey, body, value.timeoutMs);
          if (!result.ok) {
            return postFailure(result);
          }
          const envelope = readEnvelope(result.body);
          if (envelope === null) {
            return failure("bad_response", "unknown");
          }
          if (!envelope.ok) {
            return receiptFailure(envelope);
          }
          const receipt = toCollectionReceipt(envelope.data);
          return receipt === null ? failure("bad_response", "unknown") : { ok: true, value: receipt };
        }
      );
    },

    async getCollectionById(id) {
      return validated(
        (value) => `${value.baseUrl}/collections/${id}`,
        () => isValidProviderId(id),
        async (value, url) => {
          const result = await performGet(fetcher, url, value.apiKey, value.timeoutMs);
          if (!result.ok) {
            return getFailure(result);
          }
          const envelope = readEnvelope(result.body);
          if (envelope === null) {
            return failure("bad_response", "unknown");
          }
          if (!envelope.ok) {
            return receiptFailure(envelope);
          }
          const receipt = toCollectionReceipt(envelope.data);
          return receipt === null ? failure("bad_response", "unknown") : { ok: true, value: receipt };
        }
      );
    },

    async getCollectionByReference(reference) {
      return validated(
        (value) => `${value.baseUrl}/collections/status/${encodeURIComponent(reference)}`,
        () => isValidReference(reference),
        async (value, url) => {
          const result = await performGet(fetcher, url, value.apiKey, value.timeoutMs);
          if (!result.ok) {
            return getFailure(result);
          }
          const envelope = readEnvelope(result.body);
          if (envelope === null) {
            return failure("bad_response", "unknown");
          }
          if (!envelope.ok) {
            return receiptFailure(envelope);
          }
          const receipt = toCollectionReceipt(envelope.data);
          return receipt === null ? failure("bad_response", "unknown") : { ok: true, value: receipt };
        }
      );
    },

    async initiateMobileMoneyTransfer(input) {
      return validated(
        (value) => `${value.baseUrl}/transfers/mobile-money`,
        () => validMobileTransferInput(input),
        async (value, url) => {
          const amount = centsToMajorUnits(input.amountMinor);
          const debit = configDebitAccountId();
          if (amount === null) {
            return failure("invalid_input", "not_started");
          }
          if (!debit.ok) {
            return failure(debit.code, "not_started");
          }
          const body: JsonObject = {
            accountId: debit.id,
            amount,
            reference: input.reference,
            phone: input.phone,
            operator: input.operator,
            country: LENCO_COUNTRY,
          };
          const result = await performPost(fetcher, url, value.apiKey, body, value.timeoutMs);
          if (!result.ok) {
            return postFailure(result);
          }
          const envelope = readEnvelope(result.body);
          if (envelope === null) {
            return failure("bad_response", "unknown");
          }
          if (!envelope.ok) {
            return receiptFailure(envelope);
          }
          const receipt = toTransferReceipt(envelope.data);
          return receipt === null ? failure("bad_response", "unknown") : { ok: true, value: receipt };
        }
      );
    },

    async initiateBankTransfer(input) {
      return validated(
        (value) => `${value.baseUrl}/transfers/bank-account`,
        () => validBankTransferInput(input),
        async (value, url) => {
          const amount = centsToMajorUnits(input.amountMinor);
          const debit = configDebitAccountId();
          if (amount === null) {
            return failure("invalid_input", "not_started");
          }
          if (!debit.ok) {
            return failure(debit.code, "not_started");
          }
          const body: JsonObject = {
            accountId: debit.id,
            amount,
            reference: input.reference,
            bankId: input.bankId,
            accountNumber: input.accountNumber,
          };
          const result = await performPost(fetcher, url, value.apiKey, body, value.timeoutMs);
          if (!result.ok) {
            return postFailure(result);
          }
          const envelope = readEnvelope(result.body);
          if (envelope === null) {
            return failure("bad_response", "unknown");
          }
          if (!envelope.ok) {
            return receiptFailure(envelope);
          }
          const receipt = toTransferReceipt(envelope.data);
          return receipt === null ? failure("bad_response", "unknown") : { ok: true, value: receipt };
        }
      );
    },

    async getTransferById(id) {
      return validated(
        (value) => `${value.baseUrl}/transfers/${id}`,
        () => isValidProviderId(id),
        async (value, url) => {
          const result = await performGet(fetcher, url, value.apiKey, value.timeoutMs);
          if (!result.ok) {
            return getFailure(result);
          }
          const envelope = readEnvelope(result.body);
          if (envelope === null) {
            return failure("bad_response", "unknown");
          }
          if (!envelope.ok) {
            return receiptFailure(envelope);
          }
          const receipt = toTransferReceipt(envelope.data, { allowMissingMobileCountry: true });
          return receipt === null ? failure("bad_response", "unknown") : { ok: true, value: receipt };
        }
      );
    },

    async getTransferByReference(reference) {
      return validated(
        (value) => `${value.baseUrl}/transfers/status/${encodeURIComponent(reference)}`,
        () => isValidReference(reference),
        async (value, url) => {
          const result = await performGet(fetcher, url, value.apiKey, value.timeoutMs);
          if (!result.ok) {
            return getFailure(result);
          }
          const envelope = readEnvelope(result.body);
          if (envelope === null) {
            return failure("bad_response", "unknown");
          }
          if (!envelope.ok) {
            return receiptFailure(envelope);
          }
          const receipt = toTransferReceipt(envelope.data, { allowMissingMobileCountry: true });
          return receipt === null ? failure("bad_response", "unknown") : { ok: true, value: receipt };
        }
      );
    },

    async listBanks() {
      if (!resolved.ok) {
        return failure(resolved.code, "not_started");
      }
      const value = resolved.value;
      const result = await performGet(fetcher, `${value.baseUrl}/banks?country=zm`, value.apiKey, value.timeoutMs);
      if (!result.ok) {
        return getFailure(result);
      }
      const envelope = readEnvelope(result.body);
      if (envelope === null || !envelope.ok) {
        return failure(envelope === null ? "bad_response" : "provider_error", "unknown");
      }
      const banks = toBankRecords(envelope.data);
      return banks === null ? failure("bad_response", "unknown") : { ok: true, value: banks };
    },

    async resolveMobileMoney(input) {
      return validated(
        (value) => `${value.baseUrl}/resolve/mobile-money`,
        () => isValidPhone(input.phone) && isSupportedOperator(input.operator),
        async (value, url) => {
          const body: JsonObject = { phone: input.phone, operator: input.operator };
          const result = await performPost(fetcher, url, value.apiKey, body, value.timeoutMs);
          if (!result.ok) {
            return postFailure(result);
          }
          const envelope = readEnvelope(result.body);
          if (envelope === null) {
            return failure("bad_response", "unknown");
          }
          if (!envelope.ok) {
            return receiptFailure(envelope);
          }
          const account = toResolvedMobileMoney(envelope.data);
          return account === null ? failure("bad_response", "unknown") : { ok: true, value: account };
        }
      );
    },

    async resolveBankAccount(input) {
      return validated(
        (value) => `${value.baseUrl}/resolve/bank-account`,
        () =>
          typeof input.accountNumber === "string" &&
          input.accountNumber.length > 0 &&
          input.accountNumber.length <= 64 &&
          typeof input.bankId === "string" &&
          input.bankId.length > 0 &&
          input.bankId.length <= MAX_STRING_FIELD_LENGTH,
        async (value, url) => {
          const body: JsonObject = { accountNumber: input.accountNumber, bankId: input.bankId };
          const result = await performPost(fetcher, url, value.apiKey, body, value.timeoutMs);
          if (!result.ok) {
            return postFailure(result);
          }
          const envelope = readEnvelope(result.body);
          if (envelope === null) {
            return failure("bad_response", "unknown");
          }
          if (!envelope.ok) {
            return receiptFailure(envelope);
          }
          const account = toResolvedBankAccount(envelope.data);
          return account === null ? failure("bad_response", "unknown") : { ok: true, value: account };
        }
      );
    },

    async verifyWebhookSignature(raw, signature) {
      try {
        if (!resolved.ok || signature === null || !HEX_128_PATTERN.test(signature)) {
          return false;
        }
        const subtle = globalThis.crypto?.subtle;
        if (subtle === undefined || subtle === null) {
          return false;
        }
        const tokenDigest = await subtle.digest("SHA-256", new TextEncoder().encode(resolved.value.apiKey));
        const hexKey = bytesToHex(new Uint8Array(tokenDigest));
        const key = await subtle.importKey(
          "raw",
          new TextEncoder().encode(hexKey),
          { name: "HMAC", hash: "SHA-512" },
          false,
          ["verify"]
        );
        const signatureBytes = hexToBytes(signature.toLowerCase());
        if (signatureBytes === null) {
          return false;
        }
        const signatureBuffer = new ArrayBuffer(signatureBytes.length);
        new Uint8Array(signatureBuffer).set(signatureBytes);
        const bodyBytes = new Uint8Array(raw.length);
        bodyBytes.set(raw);
        const bodyBuffer = bodyBytes.buffer as ArrayBuffer;
        return await subtle.verify({ name: "HMAC", hash: "SHA-512" }, key, signatureBuffer, bodyBuffer);
      } catch {
        return false;
      }
    },
  };
}
