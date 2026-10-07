import type { ExpoConfig } from "expo/config";

type RequiredProductionPublicEnvVar =
  | "EXPO_PUBLIC_APP_ENV"
  | "EXPO_PUBLIC_API_URL"
  | "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY"
  | "EXPO_PUBLIC_CONVEX_URL";

const appVersion = "1.0.0";
const developmentApiUrl = "http://localhost:3001";
const productionBuildProfiles = new Set([
  "production",
  "internal-test",
  "internal-test-ios",
  "organization-ios",
]);
const requiredProductionPublicEnvVars: RequiredProductionPublicEnvVar[] = [
  "EXPO_PUBLIC_APP_ENV",
  "EXPO_PUBLIC_API_URL",
  "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "EXPO_PUBLIC_CONVEX_URL",
];

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
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

function isProductionBuild(appEnvValue: string): boolean {
  const buildProfile = readEnv("EAS_BUILD_PROFILE");
  return (
    appEnvValue === "production" ||
    (buildProfile ? productionBuildProfiles.has(buildProfile) : false)
  );
}

function validateProductionPublicEnv(): void {
  const missingEnvVars = requiredProductionPublicEnvVars.filter(
    (name) => !readEnv(name),
  );

  if (missingEnvVars.length > 0) {
    throw new Error(
      `Production mobile builds require ${missingEnvVars.join(", ")}.`,
    );
  }

  const productionApiUrl = readEnv("EXPO_PUBLIC_API_URL");
  if (productionApiUrl && isLocalApiUrl(productionApiUrl)) {
    throw new Error(
      "Production mobile builds require EXPO_PUBLIC_API_URL to be a non-local URL.",
    );
  }
}

const appEnv = readEnv("EXPO_PUBLIC_APP_ENV") ?? "development";
if (isProductionBuild(appEnv)) {
  validateProductionPublicEnv();
}

const apiUrl = readEnv("EXPO_PUBLIC_API_URL") ?? developmentApiUrl;
const easProjectId =
  readEnv("EAS_PROJECT_ID") ??
  readEnv("EXPO_PUBLIC_EAS_PROJECT_ID") ??
  "d0150a59-7bd4-4344-96e4-7efefa7563cc";
const updatesUrl = easProjectId
  ? `https://u.expo.dev/${easProjectId}`
  : undefined;

const config: ExpoConfig = {
  name: "Getitonline",
  slug: "gettitonline",
  version: appVersion,
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  newArchEnabled: true,
  runtimeVersion: appVersion,
  ...(updatesUrl
    ? {
        updates: {
          url: updatesUrl,
        },
      }
    : {}),
  splash: {
    image: "./assets/splash-icon.png",
    resizeMode: "contain",
    backgroundColor: "#0795F9",
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: "com.getitonline.app",
    appleTeamId: "5THHD5US74",
    scheme: "getitonline",
    runtimeVersion: "getitonline-org-1",
    usesAppleSignIn: true,
    infoPlist: {
      CFBundleAllowMixedLocalizations: true,
    },
    config: {
      usesNonExemptEncryption: false,
    },
  },
  android: {
    scheme: "gettitonline",
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#0795F9",
    },
    edgeToEdgeEnabled: true,
    package: "com.gettitonline.app",
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  plugins: [
    "expo-secure-store",
    "expo-apple-authentication",
    "expo-web-browser",
    [
      "expo-image-picker",
      {
        photosPermission:
          "Allow Getitonline to access your photos to upload product images.",
      },
    ],
  ],
  extra: {
    appEnv,
    apiUrl,
    ...(easProjectId
      ? {
          eas: {
            projectId: easProjectId,
          },
        }
      : {}),
  },
};

export default config;
