import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Button, Text, useTheme } from 'react-native-paper';
import type { MD3Theme } from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../../types';

type Props = NativeStackScreenProps<AuthStackParamList, 'Welcome'>;

export default function WelcomeScreen({ navigation }: Props) {
  const theme = useTheme();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={styles.content}>
        <View style={styles.logoContainer}>
          <View style={[styles.logoPlaceholder, { backgroundColor: theme.colors.primaryContainer }]}>
            <Text style={[styles.logoText, { color: theme.colors.primary }]}>G</Text>
          </View>
          <Text variant="headlineLarge" style={[styles.title, { color: theme.colors.onSurface }]}>
            Gettitonline
          </Text>
          <Text variant="bodyLarge" style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
            Shop fashion, electronics, essentials, and trusted finds across Zambia
          </Text>
        </View>

        <View style={styles.features}>
          <FeatureItem
            icon="shield-check"
            title="Secure Escrow"
            description="Your payment is protected until delivery"
            theme={theme}
          />
          <FeatureItem
            icon="message-text"
            title="Trusted Storefront"
            description="Shop with the official Gettitonline store"
            theme={theme}
          />
          <FeatureItem
            icon="star"
            title="Easy Discovery"
            description="Find trending products and everyday essentials"
            theme={theme}
          />
        </View>

        <View style={styles.buttons}>
          <Button
            mode="contained"
            onPress={() => navigation.navigate('SignUp')}
            style={styles.button}
            contentStyle={styles.buttonContent}
          >
            Get Started
          </Button>
          <Button
            mode="outlined"
            onPress={() => navigation.navigate('SignIn')}
            style={styles.button}
            contentStyle={styles.buttonContent}
          >
            Sign In
          </Button>
        </View>
      </View>
    </SafeAreaView>
  );
}

interface FeatureItemProps {
  icon: string;
  title: string;
  description: string;
  theme: MD3Theme;
}

function FeatureItem({ icon, title, description, theme }: FeatureItemProps) {
  return (
    <View style={styles.featureItem}>
      <View style={[styles.featureIcon, { backgroundColor: theme.colors.primaryContainer }]}>
        <Text style={{ color: theme.colors.primary }}>{icon === 'shield-check' ? '\u2713' : icon === 'message-text' ? '\u2709' : '\u2605'}</Text>
      </View>
      <View style={styles.featureText}>
        <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>{title}</Text>
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>{description}</Text>
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
    padding: 24,
    justifyContent: 'space-between',
  },
  logoContainer: {
    alignItems: 'center',
    marginTop: 40,
  },
  logoPlaceholder: {
    width: 100,
    height: 100,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  logoText: {
    fontSize: 36,
    fontWeight: 'bold',
  },
  title: {
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  features: {
    marginVertical: 32,
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  featureIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  featureText: {
    flex: 1,
  },
  buttons: {
    marginBottom: 16,
  },
  button: {
    marginBottom: 12,
    borderRadius: 12,
  },
  buttonContent: {
    paddingVertical: 8,
  },
});
