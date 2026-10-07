import React, { useState, useCallback } from 'react';
import { View, StyleSheet, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { Button, Text, TextInput, useTheme, Divider } from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSignIn, useOAuth, useSignInWithApple } from '@clerk/clerk-expo';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../../types';
import { useWarmUpBrowser } from '../../hooks/useWarmUpBrowser';
import { AppleSignInButton } from '../../components/auth/AppleSignInButton';

WebBrowser.maybeCompleteAuthSession();

type Props = NativeStackScreenProps<AuthStackParamList, 'SignIn'>;

export default function SignInScreen({ navigation }: Props) {
  useWarmUpBrowser();
  const theme = useTheme();
  const { signIn, setActive, isLoaded } = useSignIn();
  const { startOAuthFlow } = useOAuth({ strategy: 'oauth_google' });
  const { startAppleAuthenticationFlow } = useSignInWithApple();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<'apple' | 'google' | null>(null);
  const [error, setError] = useState('');

  const handleEmailSignIn = async () => {
    if (!isLoaded) return;

    setLoading(true);
    setError('');

    try {
      const result = await signIn.create({
        identifier: email,
        password,
      });

      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
      } else {
        setError('Sign in could not be completed. Please try again.');
      }
    } catch (err: unknown) {
      console.error('Sign in error:', err);
      const clerkError = err as { errors?: Array<{ message: string }> };
      setError(clerkError.errors?.[0]?.message || 'Failed to sign in. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = useCallback(async () => {
    setOauthLoading('google');
    setError('');

    try {
      const { createdSessionId, setActive: setActiveSession } = await startOAuthFlow({
        redirectUrl: Linking.createURL('/oauth-callback', {
          scheme: 'gettitonline',
        }),
      });

      if (createdSessionId && setActiveSession) {
        await setActiveSession({ session: createdSessionId });
      }
    } catch (err: unknown) {
      console.error('Google sign in error:', err);
      setError('Failed to sign in with Google. Please try again.');
    } finally {
      setOauthLoading(null);
    }
  }, [startOAuthFlow]);

  const handleAppleSignIn = useCallback(async () => {
    if (Platform.OS !== 'ios') return;

    setOauthLoading('apple');
    setError('');

    try {
      const { createdSessionId, setActive: setActiveSession } =
        await startAppleAuthenticationFlow();

      if (createdSessionId && setActiveSession) {
        await setActiveSession({ session: createdSessionId });
      }
    } catch (err: unknown) {
      const maybeCancelled = err as { code?: string };
      if (maybeCancelled.code === 'ERR_REQUEST_CANCELED') {
        return;
      }

      console.error('Apple sign in error:', err);
      setError('Failed to sign in with Apple. Please try again.');
    } finally {
      setOauthLoading(null);
    }
  }, [startAppleAuthenticationFlow]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.header}>
            <Text variant="headlineMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
              Welcome back
            </Text>
            <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant }}>
              Sign in to your account
            </Text>
          </View>

          <View style={styles.form}>
            <AppleSignInButton
              disabled={oauthLoading !== null || loading}
              isDark={theme.dark}
              loading={oauthLoading === 'apple'}
              onPress={handleAppleSignIn}
            />

            <Button
              mode="outlined"
              onPress={handleGoogleSignIn}
              style={styles.oauthButton}
              contentStyle={styles.oauthButtonContent}
              icon="google"
              loading={oauthLoading === 'google'}
              disabled={oauthLoading !== null || loading}
            >
              Continue with Google
            </Button>

            <View style={styles.dividerContainer}>
              <Divider style={styles.divider} />
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginHorizontal: 16 }}>
                or
              </Text>
              <Divider style={styles.divider} />
            </View>

            <TextInput
              mode="outlined"
              label="Email"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              style={styles.input}
            />

            <TextInput
              mode="outlined"
              label="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              style={styles.input}
              right={
                <TextInput.Icon
                  icon={showPassword ? 'eye-off' : 'eye'}
                  onPress={() => setShowPassword(!showPassword)}
                />
              }
            />

            {error ? (
              <Text variant="bodySmall" style={[styles.error, { color: theme.colors.error }]}>
                {error}
              </Text>
            ) : null}

            <Button
              mode="contained"
              onPress={handleEmailSignIn}
              loading={loading}
              disabled={loading || !email || !password}
              style={styles.signInButton}
              contentStyle={styles.buttonContent}
            >
              Sign In
            </Button>

            <View style={styles.footer}>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                Don't have an account?{' '}
              </Text>
              <Button
                mode="text"
                onPress={() => navigation.navigate('SignUp')}
                compact
              >
                Sign Up
              </Button>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    padding: 24,
  },
  header: {
    marginTop: 40,
    marginBottom: 32,
  },
  title: {
    fontWeight: 'bold',
    marginBottom: 8,
  },
  form: {
    flex: 1,
  },
  oauthButton: {
    borderRadius: 12,
    marginBottom: 12,
  },
  oauthButtonContent: {
    paddingVertical: 8,
  },
  dividerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    marginBottom: 24,
  },
  divider: {
    flex: 1,
  },
  input: {
    marginBottom: 16,
  },
  error: {
    marginBottom: 16,
  },
  signInButton: {
    borderRadius: 12,
    marginTop: 8,
  },
  buttonContent: {
    paddingVertical: 8,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 24,
  },
});
