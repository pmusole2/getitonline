import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Button, Text, useTheme } from 'react-native-paper';

import { StackHeader } from '../ui/Header';
import type { AccountAccessControl } from './useAccountAccess';

interface AccountAccessNoticeProps {
  readonly access: AccountAccessControl;
  readonly title: string;
}

// Stands in for a protected screen whose account is not ready. Renders nothing for a ready account.
export function AccountAccessNotice({ access, title }: AccountAccessNoticeProps) {
  const theme = useTheme();

  if (access.status === 'ready') {
    return null;
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader title={title} onBackPress={access.goBack} />
      <View style={styles.content}>
        {access.status === 'loading' ? <ActivityIndicator size="large" color={theme.colors.primary} /> : null}

        {access.status === 'signed-out' ? (
          <>
            <Text variant="headlineSmall" style={[styles.title, { color: theme.colors.onSurface }]}>
              Sign in to continue
            </Text>
            <Text variant="bodyMedium" style={[styles.message, { color: theme.colors.onSurfaceVariant }]}>
              Sign in to view this screen.
            </Text>
            <Button mode="contained" onPress={access.signIn} style={styles.button}>
              Sign In
            </Button>
          </>
        ) : null}

        {access.status === 'recovery' ? (
          <>
            <Text variant="headlineSmall" style={[styles.title, { color: theme.colors.onSurface }]}>
              Account setup did not finish
            </Text>
            <Text variant="bodyMedium" style={[styles.message, { color: theme.colors.onSurfaceVariant }]}>
              We could not finish setting up your account. Check your connection and try again.
            </Text>
            <Button mode="contained" onPress={access.retry} style={styles.button}>
              Try Again
            </Button>
            <Button mode="text" onPress={() => void access.signOut()}>
              Sign Out
            </Button>
          </>
        ) : null}

        {access.status === 'unavailable' ? (
          <>
            <Text variant="headlineSmall" style={[styles.title, { color: theme.colors.onSurface }]}>
              Account unavailable
            </Text>
            <Text variant="bodyMedium" style={[styles.message, { color: theme.colors.onSurfaceVariant }]}>
              This account cannot use this area. If you think this is a mistake, contact support.
            </Text>
            <Button mode="contained" onPress={() => void access.signOut()} style={styles.button}>
              Sign Out
            </Button>
          </>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontWeight: '700',
    marginBottom: 12,
    textAlign: 'center',
  },
  message: {
    lineHeight: 22,
    marginBottom: 24,
    textAlign: 'center',
  },
  button: {
    borderRadius: 12,
    marginBottom: 8,
  },
});
