import Constants from "expo-constants";

export type MissingPublicEnvVar =
  | "EXPO_PUBLIC_API_URL"
  | "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY"
  | "EXPO_PUBLIC_CONVEX_URL";

interface RuntimeExtraConfig {
  apiUrl?: string;
  appEnv?: string;
}

export interface RuntimeConfig {
  apiUrl: string;
  appEnv: string;
  clerkPublishableKey: string | null;
  convexUrl: string | null;
  missingPublicEnvVars: MissingPublicEnvVar[];
}

function readString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

const developmentApiUrl = "http://localhost:3001";

function isProductionAppEnv(appEnv: string): boolean {
  return appEnv === "production";
}

function isLocalApiUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "10.0.2.2" ||
      hostname.endsWith(".localhost")
    );
  } catch {
    return true;
  }
}

function readExtraConfig(): RuntimeExtraConfig {
  const extra = Constants.expoConfig?.extra;

  if (!extra || typeof extra !== "object") {
    return {};
  }

  const runtimeExtra = extra as Record<string, unknown>;

  return {
    apiUrl:
      typeof runtimeExtra.apiUrl === "string" ? runtimeExtra.apiUrl : undefined,
    appEnv:
      typeof runtimeExtra.appEnv === "string" ? runtimeExtra.appEnv : undefined,
  };
}

export function getRuntimeConfig(): RuntimeConfig {
  const extra = readExtraConfig();
  const clerkPublishableKey = readString(
    process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
  );
  const convexUrl = readString(process.env.EXPO_PUBLIC_CONVEX_URL);
  const configuredApiUrl =
    readString(process.env.EXPO_PUBLIC_API_URL) ?? readString(extra.apiUrl);
  const appEnv =
    readString(process.env.EXPO_PUBLIC_APP_ENV) ??
    readString(extra.appEnv) ??
    "development";
  const apiUrl = configuredApiUrl ?? developmentApiUrl;

  const missingPublicEnvVars: MissingPublicEnvVar[] = [];

  if (!configuredApiUrl) {
    missingPublicEnvVars.push("EXPO_PUBLIC_API_URL");
  }

  if (!clerkPublishableKey) {
    missingPublicEnvVars.push("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY");
  }

  if (!convexUrl) {
    missingPublicEnvVars.push("EXPO_PUBLIC_CONVEX_URL");
  }

  if (isProductionAppEnv(appEnv)) {
    if (missingPublicEnvVars.length > 0) {
      throw new Error(
        `Production mobile runtime requires ${missingPublicEnvVars.join(", ")}.`,
      );
    }

    if (isLocalApiUrl(apiUrl)) {
      throw new Error(
        "Production mobile runtime requires EXPO_PUBLIC_API_URL to be a non-local URL.",
      );
    }
  }

  return {
    apiUrl,
    appEnv,
    clerkPublishableKey,
    convexUrl,
    missingPublicEnvVars,
  };
}
