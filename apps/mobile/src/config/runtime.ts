import Constants from 'expo-constants';

export type MissingPublicEnvVar =
  | 'EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY'
  | 'EXPO_PUBLIC_CONVEX_URL';

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

function readExtraConfig(): RuntimeExtraConfig {
  const extra = Constants.expoConfig?.extra;

  if (!extra || typeof extra !== 'object') {
    return {};
  }

  const runtimeExtra = extra as Record<string, unknown>;

  return {
    apiUrl: typeof runtimeExtra.apiUrl === 'string' ? runtimeExtra.apiUrl : undefined,
    appEnv: typeof runtimeExtra.appEnv === 'string' ? runtimeExtra.appEnv : undefined,
  };
}

export function getRuntimeConfig(): RuntimeConfig {
  const extra = readExtraConfig();
  const clerkPublishableKey = readString(process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const convexUrl = readString(process.env.EXPO_PUBLIC_CONVEX_URL);
  const apiUrl =
    readString(process.env.EXPO_PUBLIC_API_URL) ??
    readString(extra.apiUrl) ??
    'http://localhost:3001';
  const appEnv =
    readString(process.env.EXPO_PUBLIC_APP_ENV) ??
    readString(extra.appEnv) ??
    'development';

  const missingPublicEnvVars: MissingPublicEnvVar[] = [];

  if (!clerkPublishableKey) {
    missingPublicEnvVars.push('EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY');
  }

  if (!convexUrl) {
    missingPublicEnvVars.push('EXPO_PUBLIC_CONVEX_URL');
  }

  return {
    apiUrl,
    appEnv,
    clerkPublishableKey,
    convexUrl,
    missingPublicEnvVars,
  };
}
