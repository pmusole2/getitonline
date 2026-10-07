import React, { useState, useCallback } from 'react';
import { View, StyleSheet, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { Button, Text, TextInput, useTheme, Divider } from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSignUp, useOAuth, useSignInWithApple } from '@clerk/clerk-expo';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../../types';
import { useWarmUpBrowser } from '../../hooks/useWarmUpBrowser';
import { AppleSignInButton } from '../../components/auth/AppleSignInButton';

WebBrowser.maybeCompleteAuthSession();

type Props = NativeStackScreenProps<AuthStackParamList, 'SignUp'>;

export default function SignUpScreen({ navigation }: Props) {
  useWarmUpBrowser();
  const theme = useTheme();
  const { signUp, setActive, isLoaded } = useSignUp();
  const { startOAuthFlow } = useOAuth({ strategy: 'oauth_google' });
  const { startAppleAuthenticationFlow } = useSignInWithApple();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<'apple' | 'google' | null>(null);
  const [error, setError] = useState('');
  const [pendingVerification, setPendingVerification] = useState(false);
  const [code, setCode] = useState('');

  const handleEmailSignUp = async () => {
    if (!isLoaded) return;

    setLoading(true);
    setError('');

    try {
      await signUp.create({
        firstName,
        lastName,
        emailAddress: email,
        password,
      });

      // Send email verification code
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      setPendingVerification(true);
    } catch (err: unknown) {
      console.error('Sign up error:', err);
      const clerkError = err as { errors?: Array<{ message: string }> };
      setError(clerkError.errors?.[0]?.message || 'Failed to sign up. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyEmail = async () => {
    if (!isLoaded) return;

    setLoading(true);
    setError('');

    try {
      const result = await signUp.attemptEmailAddressVerification({
        code,
      });

      if (result.status === 'complete') {
        await setActive({ session: result.createdSessionId });
      } else {
        setError('Verification could not be completed. Please try again.');
      }
    } catch (err: unknown) {
      console.error('Verification error:', err);
      const clerkError = err as { errors?: Array<{ message: string }> };
      setError(clerkError.errors?.[0]?.message || 'Invalid verification code.');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignUp = useCallback(async () => {
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
      console.error('Google sign up error:', err);
      setError('Failed to sign up with Google. Please try again.');
    } finally {
      setOauthLoading(null);
    }
  }, [startOAuthFlow]);

  const handleAppleSignUp = useCallback(async () => {
    if (Platform.OS !== 'ios') return;

    setOauthLoading('apple');
    setError('');

    try {
      const { createdSessionId, setActive: setActiveSession } =
        await startAppleAuthenticationFlow({
          unsafeMetadata: {
            source: 'ios_sign_up',
          },
        });

      if (createdSessionId && setActiveSession) {
        await setActiveSession({ session: createdSessionId });
      }
    } catch (err: unknown) {
      const maybeCancelled = err as { code?: string };
      if (maybeCancelled.code === 'ERR_REQUEST_CANCELED') {
        return;
      }

      console.error('Apple sign up error:', err);
      setError('Failed to sign up with Apple. Please try again.');
    } finally {
      setOauthLoading(null);
    }
  }, [startAppleAuthenticationFlow]);

  if (pendingVerification) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <View style={styles.verificationContainer}>
          <Text variant="headlineMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
            Verify your email
          </Text>
          <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 24 }}>
            We sent a verification code to {email}
          </Text>

          <TextInput
            mode="outlined"
            label="Verification Code"
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            style={styles.input}
          />

          {error ? (
            <Text variant="bodySmall" style={[styles.error, { color: theme.colors.error }]}>
              {error}
            </Text>
          ) : null}

          <Button
            mode="contained"
            onPress={handleVerifyEmail}
            loading={loading}
            disabled={loading || !code}
            style={styles.button}
            contentStyle={styles.buttonContent}
          >
            Verify Email
          </Button>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.header}>
            <Text variant="headlineMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
              Create account
            </Text>
            <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant }}>
              Join the marketplace community
            </Text>
          </View>

          <View style={styles.form}>
            <AppleSignInButton
              disabled={oauthLoading !== null || loading}
              isDark={theme.dark}
              loading={oauthLoading === 'apple'}
              onPress={handleAppleSignUp}
            />

            <Button
              mode="outlined"
              onPress={handleGoogleSignUp}
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

            <View style={styles.nameRow}>
              <TextInput
                mode="outlined"
                label="First Name"
                value={firstName}
                onChangeText={setFirstName}
                autoCapitalize="words"
                style={[styles.input, styles.nameInput]}
              />
              <TextInput
                mode="outlined"
                label="Last Name"
                value={lastName}
                onChangeText={setLastName}
                autoCapitalize="words"
                style={[styles.input, styles.nameInput]}
              />
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
              onPress={handleEmailSignUp}
              loading={loading}
              disabled={loading || !firstName || !lastName || !email || !password}
              style={styles.button}
              contentStyle={styles.buttonContent}
            >
              Create Account
            </Button>

            <View style={styles.footer}>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                Already have an account?{' '}
              </Text>
              <Button
                mode="text"
                onPress={() => navigation.navigate('SignIn')}
                compact
              >
                Sign In
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
  verificationContainer: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
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
  nameRow: {
    flexDirection: 'row',
    gap: 12,
  },
  nameInput: {
    flex: 1,
  },
  input: {
    marginBottom: 16,
  },
  error: {
    marginBottom: 16,
  },
  button: {
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
