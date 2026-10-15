import { ClerkLoaded, ClerkProvider } from '@clerk/clerk-expo';
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { Text, View } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ClientGate } from './src/components/ClientGate';
import { getRuntimeConfig, type MissingPublicEnvVar } from './src/config/runtime';
import { AuthProvider } from './src/context/AuthProvider';
import { ConvexClientProvider } from './src/context/ConvexClientProvider';
import { GuestCartProvider, useGuestCart } from './src/context/GuestCartProvider';
import { ThemeProvider, useAppTheme } from './src/context/ThemeProvider';
import { RootNavigator } from './src/navigation/RootNavigator';
import { brandColors, darkTheme, lightTheme } from './src/theme';
import type { RootStackParamList } from './src/types';
import { tokenCache } from './src/utils/tokenCache';
import { useAppAuth } from './src/context/AuthProvider';

const navigationRef = createNavigationContainerRef<RootStackParamList>();

// Simple error boundary to catch and display errors
class ErrorBoundary extends React.Component<{children: React.ReactNode}, {hasError: boolean; error: Error | null}> {
  constructor(props: {children: React.ReactNode}) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('App Error Boundary caught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20, backgroundColor: brandColors.background }}>
          <Text style={{ fontSize: 18, fontWeight: 'bold', color: brandColors.error, textAlign: 'center' }}>
            Error Loading App
          </Text>
          <Text style={{ marginTop: 10, color: brandColors.mutedText, textAlign: 'center' }}>
            {this.state.error?.message}
          </Text>
        </View>
      );
    }

    return this.props.children;
  }
}

function formatMissingVariableName(variableName: MissingPublicEnvVar): string {
  return variableName.replace('EXPO_PUBLIC_', '').replaceAll('_', ' ');
}

function ConfigurationErrorScreen({
  appEnv,
  missingPublicEnvVars,
}: {
  appEnv: string;
  missingPublicEnvVars: MissingPublicEnvVar[];
}) {
  return (
    <View
      style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
        backgroundColor: brandColors.darkBackground,
      }}
    >
      <Text
        style={{
          fontSize: 22,
          fontWeight: '700',
          color: brandColors.darkText,
          textAlign: 'center',
        }}
      >
        App configuration is incomplete
      </Text>
      <Text
        style={{
          marginTop: 12,
          color: brandColors.darkMutedText,
          textAlign: 'center',
          lineHeight: 22,
        }}
      >
        This build is missing required public environment variables for the{' '}
        {appEnv} environment.
      </Text>
      <View style={{ marginTop: 20, alignSelf: 'stretch', gap: 8 }}>
        {missingPublicEnvVars.map((variableName) => (
          <Text
            key={variableName}
            style={{
              color: brandColors.darkText,
              backgroundColor: brandColors.darkCard,
              borderRadius: 12,
              paddingHorizontal: 14,
              paddingVertical: 12,
              textAlign: 'center',
            }}
          >
            {formatMissingVariableName(variableName)}
          </Text>
        ))}
      </View>
      <Text
        style={{
          marginTop: 20,
          color: brandColors.darkMutedText,
          textAlign: 'center',
          lineHeight: 20,
        }}
      >
        Rebuild the app after setting the missing Expo EAS production variables.
      </Text>
    </View>
  );
}

function PostAuthNavigationHandler() {
  const {
    authSyncError,
    isSignedIn,
    postAuthDestination,
    setPostAuthDestination,
    user,
  } = useAppAuth();
  const { hasPendingMerge, isHydrated, isMerging, mergeFailed } =
    useGuestCart();

  useEffect(() => {
    if (
      !navigationRef.isReady() ||
      !isSignedIn ||
      !user ||
      authSyncError ||
      !isHydrated ||
      isMerging ||
      hasPendingMerge
    ) {
      return;
    }

    const currentRouteName = navigationRef.getCurrentRoute()?.name;
    const isOnAuthScreen = ['Auth', 'Welcome', 'SignIn', 'SignUp'].includes(
      String(currentRouteName)
    );
    const destination = mergeFailed
      ? 'Main'
      : postAuthDestination ?? (isOnAuthScreen ? 'Main' : null);

    if (!destination) {
      return;
    }

    navigationRef.navigate(destination);

    if (postAuthDestination) {
      setPostAuthDestination(null);
    }
  }, [
    authSyncError,
    hasPendingMerge,
    isHydrated,
    isMerging,
    isSignedIn,
    mergeFailed,
    postAuthDestination,
    setPostAuthDestination,
    user,
  ]);

  return null;
}

// Inner app component that uses the theme context
function AppContent() {
  const { isDark } = useAppTheme();
  const theme = isDark ? darkTheme : lightTheme;

  // Custom navigation theme that matches our Paper theme
  const navigationTheme = isDark ? {
    ...DarkTheme,
    colors: {
      ...DarkTheme.colors,
      primary: theme.colors.primary,
      background: theme.colors.background,
      card: theme.colors.surface,
      text: theme.colors.onSurface,
      border: theme.colors.outline,
      notification: theme.colors.error,
    },
  } : {
    ...DefaultTheme,
    colors: {
      ...DefaultTheme.colors,
      primary: theme.colors.primary,
      background: theme.colors.background,
      card: theme.colors.surface,
      text: theme.colors.onSurface,
      border: theme.colors.outline,
      notification: theme.colors.error,
    },
  };

  return (
    <PaperProvider theme={theme}>
      <ClientGate>
        <NavigationContainer ref={navigationRef} theme={navigationTheme}>
          <PostAuthNavigationHandler />
          <RootNavigator />
          <StatusBar style={isDark ? 'light' : 'dark'} />
        </NavigationContainer>
      </ClientGate>
    </PaperProvider>
  );
}

export default function App() {
  const runtimeConfig = getRuntimeConfig();

  if (
    !runtimeConfig.clerkPublishableKey ||
    !runtimeConfig.convexUrl ||
    runtimeConfig.missingPublicEnvVars.length > 0
  ) {
    return (
      <ConfigurationErrorScreen
        appEnv={runtimeConfig.appEnv}
        missingPublicEnvVars={runtimeConfig.missingPublicEnvVars}
      />
    );
  }

  return (
    <ErrorBoundary>
      <ClerkProvider
        publishableKey={runtimeConfig.clerkPublishableKey}
        tokenCache={tokenCache}
      >
        <ClerkLoaded>
          <ConvexClientProvider url={runtimeConfig.convexUrl}>
            <AuthProvider>
              <GuestCartProvider>
                <SafeAreaProvider>
                  <ThemeProvider>
                    <AppContent />
                  </ThemeProvider>
                </SafeAreaProvider>
              </GuestCartProvider>
            </AuthProvider>
          </ConvexClientProvider>
        </ClerkLoaded>
      </ClerkProvider>
    </ErrorBoundary>
  );
}
