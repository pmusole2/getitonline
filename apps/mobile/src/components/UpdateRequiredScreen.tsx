import { isHttpsStoreUrl } from '@gettitonline/shared';
import React from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { Button, Text, useTheme } from 'react-native-paper';

interface UpdateRequiredScreenProps {
  readonly storeUrl: string | null;
}

// Blocks the whole app until the user installs a supported build. It shows the store link only for a valid https URL.
export function UpdateRequiredScreen({ storeUrl }: UpdateRequiredScreenProps) {
  const theme = useTheme();
  const storeLink = isHttpsStoreUrl(storeUrl) ? storeUrl : null;

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Text variant="headlineSmall" style={[styles.title, { color: theme.colors.onSurface }]}>
        Update required
      </Text>
      <Text variant="bodyMedium" style={[styles.message, { color: theme.colors.onSurfaceVariant }]}>
        This version of the app is no longer supported. Install the latest version to continue.
      </Text>
      {storeLink !== null ? (
        <Button mode="contained" onPress={() => void Linking.openURL(storeLink)} style={styles.button}>
          Update now
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  title: {
    textAlign: 'center',
    fontWeight: '700',
  },
  message: {
    marginTop: 12,
    textAlign: 'center',
    lineHeight: 22,
  },
  button: {
    marginTop: 24,
  },
});
