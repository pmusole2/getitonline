import type { ExpoConfig } from 'expo/config';

const appVersion = '1.0.0';
const appEnv = process.env.EXPO_PUBLIC_APP_ENV ?? 'development';
const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001';
const easProjectId =
  process.env.EAS_PROJECT_ID ??
  process.env.EXPO_PUBLIC_EAS_PROJECT_ID ??
  'd0150a59-7bd4-4344-96e4-7efefa7563cc';
const updatesUrl = easProjectId ? `https://u.expo.dev/${easProjectId}` : undefined;

const config: ExpoConfig = {
  name: 'Gettitonline',
  slug: 'gettitonline',
  version: appVersion,
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  scheme: 'gettitonline',
  runtimeVersion: appVersion,
  ...(updatesUrl
    ? {
        updates: {
          url: updatesUrl,
        },
      }
    : {}),
  splash: {
    image: './assets/splash-icon.png',
    resizeMode: 'contain',
    backgroundColor: '#0795F9',
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.gettitonline.app',
    config: {
      usesNonExemptEncryption: false,
    },
  },
  android: {
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#0795F9',
    },
    edgeToEdgeEnabled: true,
    package: 'com.gettitonline.app',
  },
  web: {
    favicon: './assets/favicon.png',
  },
  plugins: [
    'expo-secure-store',
    [
      'expo-image-picker',
      {
        photosPermission:
          'Allow Gettitonline to access your photos to upload product images.',
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
