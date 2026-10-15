// Pinkie usage allowances. Defaults are used unless the singleton appConfig row carries a valid override.
// Guest traffic also counts against the global scope, so the all-guests caps keep guests from using more than
// their share of the global allowance.

export const AI_LIMIT_SCOPES = ["global", "account", "allGuests", "guest"] as const;
export type AiLimitScope = (typeof AI_LIMIT_SCOPES)[number];

export const AI_WINDOWS = ["minute", "day"] as const;
export type AiWindow = (typeof AI_WINDOWS)[number];

export type AiLimit = { perDay: number; perMinute: number };
export type AiLimits = Record<AiLimitScope, AiLimit>;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export const DEFAULT_AI_LIMITS: Readonly<AiLimits> = {
  global: { perDay: 1000, perMinute: 100 },
  account: { perDay: 100, perMinute: 10 },
  allGuests: { perDay: 200, perMinute: 20 },
  guest: { perDay: 20, perMinute: 5 },
};

/** Start of the UTC-aligned minute or day that contains `now`. */
export function aiWindowStart(window: AiWindow, now: number): number {
  const size = window === "minute" ? MINUTE_MS : DAY_MS;
  return Math.floor(now / size) * size;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function resolveScope(defaults: AiLimit, override: unknown): AiLimit {
  if (!isRecord(override)) {
    return { ...defaults };
  }
  return {
    perDay: positiveInteger(override.perDay) ?? defaults.perDay,
    perMinute: positiveInteger(override.perMinute) ?? defaults.perMinute,
  };
}

/**
 * Builds the complete limits from an untrusted override object. Each field is taken only when it is a positive
 * safe integer; anything else keeps its default, so malformed config can never disable a limit.
 */
export function resolveAiLimits(overrides: unknown): AiLimits {
  const source = isRecord(overrides) ? overrides : {};
  return {
    global: resolveScope(DEFAULT_AI_LIMITS.global, source.global),
    account: resolveScope(DEFAULT_AI_LIMITS.account, source.account),
    allGuests: resolveScope(DEFAULT_AI_LIMITS.allGuests, source.allGuests),
    guest: resolveScope(DEFAULT_AI_LIMITS.guest, source.guest),
  };
}
