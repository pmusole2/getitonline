// Decides what a client build does with the minimum-version gate and the payment switch. Pure: the caller passes
// the raw query result, which arrives over the network, so it is validated here before any field is trusted.
// The version gate fails open (anything unknown lets the app run). Payment availability fails closed.
export type ClientGateStatus = "update-required" | "ok";
export type PaymentAvailability = "available" | "unavailable";

export interface ClientGateResolution {
  readonly status: ClientGateStatus;
  readonly storeUrl: string | null;
}

// Printable ASCII without whitespace or backslashes. Store links are returned to every client, so whitespace,
// control characters, backslashes, and non-ASCII hosts are refused before URL parsing.
const PRINTABLE_ASCII_URL = /^[\x21-\x5b\x5d-\x7e]+$/;

export function isHttpsStoreUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("https://") ||
    !PRINTABLE_ASCII_URL.test(value)
  ) {
    return false;
  }
  try {
    // Mirrors the server's credential check. An out-of-range port makes the URL parser throw, which is refused below.
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.username === "" && url.password === ""
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMinimumBuild(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

interface ClientGateFields {
  readonly updateRequired: boolean;
  readonly minimumBuild: number;
  readonly paymentsEnabled: boolean;
  readonly storeUrl: string | null;
}

// Every field of the public gate contract must be well-formed, so a partial or corrupted response never blocks launch.
function isClientGateContract(
  result: Record<string, unknown>,
): result is Record<string, unknown> & ClientGateFields {
  return (
    typeof result.updateRequired === "boolean" &&
    isMinimumBuild(result.minimumBuild) &&
    typeof result.paymentsEnabled === "boolean" &&
    (typeof result.storeUrl === "string" || result.storeUrl === null)
  );
}

export interface ClientGateContract {
  readonly updateRequired: boolean;
  readonly minimumBuild: number;
  readonly storeUrl: string | null;
}

// Returns the validated gate contract, or null when the result is malformed. A caller that must tell "malformed"
// apart from "current build" (such as a gate that keeps a prior block) uses this instead of resolveClientGate.
export function readClientGateContract(
  result: unknown,
): ClientGateContract | null {
  if (!isRecord(result) || !isClientGateContract(result)) {
    return null;
  }
  return {
    updateRequired: result.updateRequired === true,
    minimumBuild: result.minimumBuild,
    storeUrl: isHttpsStoreUrl(result.storeUrl) ? result.storeUrl : null,
  };
}

export function resolveClientGate(result: unknown): ClientGateResolution {
  const contract = readClientGateContract(result);

  // A store link only matters when the build is blocked, so it is returned only with "update-required".
  if (contract === null || !contract.updateRequired) {
    return { status: "ok", storeUrl: null };
  }

  return { status: "update-required", storeUrl: contract.storeUrl };
}

export function resolvePaymentAvailability(
  result: unknown,
): PaymentAvailability {
  return isRecord(result) && result.paymentsEnabled === true
    ? "available"
    : "unavailable";
}
