import React from 'react';
import { View, StyleSheet, ScrollView, Linking, Pressable } from 'react-native';
import { Text, useTheme, Switch, Divider, Surface } from 'react-native-paper';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../types';
import { useAppAuth } from '../../context/AuthProvider';
import { useAppTheme } from '../../context/ThemeProvider';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { MotiView } from 'moti';
import { StackHeader } from '../../components/ui/Header';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

type ThemeMode = 'light' | 'dark' | 'system';

export default function SettingsScreen({ navigation }: Props) {
  const theme = useTheme();
  const { user } = useAppAuth();
  const { themeMode, setThemeMode, isDark, isSyncing } = useAppTheme();

  const [notifications, setNotifications] = React.useState(true);

  const handlePrivacyPolicy = () => {
    Linking.openURL('https://example.com/privacy');
  };

  const handleTermsOfService = () => {
    Linking.openURL('https://example.com/terms');
  };

  const handleSupport = () => {
    Linking.openURL('mailto:support@gettitonline.com');
  };

  const getThemeModeLabel = (mode: ThemeMode): string => {
    switch (mode) {
      case 'light':
        return 'Light';
      case 'dark':
        return 'Dark';
      case 'system':
        return 'System';
      default:
        return 'System';
    }
  };

  const getThemeModeIcon = (mode: ThemeMode): string => {
    switch (mode) {
      case 'light':
        return 'white-balance-sunny';
      case 'dark':
        return 'moon-waning-crescent';
      case 'system':
        return 'cellphone-cog';
      default:
        return 'cellphone-cog';
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader
        title="Settings"
        subtitle="Customize your Gettitonline experience"
        onBackPress={() => navigation.goBack()}
        variant="gradient"
      />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        {/* Appearance Section */}
        <Animated.View entering={FadeInDown.delay(100).duration(400)}>
          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={2}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionIcon, { backgroundColor: theme.colors.tertiaryContainer }]}>
                <Icon name="palette" size={20} color={theme.colors.tertiary} />
              </View>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                Appearance
              </Text>
            </View>

            {/* Theme Mode Selector */}
            <View style={styles.themeSelector}>
              <View style={styles.themeLabelRow}>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                  Theme Mode
                </Text>
                {isSyncing && (
                  <View style={styles.syncBadge}>
                    <MotiView
                      from={{ rotate: '0deg' }}
                      animate={{ rotate: '360deg' }}
                      transition={{
                        rotate: { type: 'timing', duration: 1000, loop: true },
                      }}
                    >
                      <Icon name="sync" size={14} color={theme.colors.primary} />
                    </MotiView>
                    <Text variant="labelSmall" style={{ color: theme.colors.primary, marginLeft: 4 }}>
                      Syncing...
                    </Text>
                  </View>
                )}
                {!isSyncing && user && (
                  <View style={[styles.syncBadge, { backgroundColor: theme.colors.secondaryContainer }]}>
                    <Icon name="cloud-check" size={14} color={theme.colors.secondary} />
                    <Text variant="labelSmall" style={{ color: theme.colors.secondary, marginLeft: 4 }}>
                      Synced
                    </Text>
                  </View>
                )}
              </View>
              <View style={styles.themeOptions}>
                {(['light', 'dark', 'system'] as ThemeMode[]).map((mode) => (
                  <Pressable
                    key={mode}
                    style={[
                      styles.themeOption,
                      {
                        backgroundColor: themeMode === mode
                          ? theme.colors.primaryContainer
                          : theme.colors.surfaceVariant,
                        borderColor: themeMode === mode
                          ? theme.colors.primary
                          : 'transparent',
                      },
                    ]}
                    onPress={() => setThemeMode(mode)}
                  >
                    <MotiView
                      animate={{
                        scale: themeMode === mode ? 1.1 : 1,
                      }}
                      transition={{
                        scale: { type: 'spring', damping: 15 },
                      }}
                    >
                      <Icon
                        name={getThemeModeIcon(mode)}
                        size={24}
                        color={themeMode === mode ? theme.colors.primary : theme.colors.onSurfaceVariant}
                      />
                    </MotiView>
                    <Text
                      variant="labelMedium"
                      style={{
                        color: themeMode === mode ? theme.colors.primary : theme.colors.onSurfaceVariant,
                        marginTop: 6,
                        fontWeight: themeMode === mode ? '600' : '400',
                      }}
                    >
                      {getThemeModeLabel(mode)}
                    </Text>
                    {themeMode === mode && (
                      <View style={[styles.checkmark, { backgroundColor: theme.colors.primary }]}>
                        <Icon name="check" size={12} color="#fff" />
                      </View>
                    )}
                  </Pressable>
                ))}
              </View>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 12 }}>
                {themeMode === 'system'
                  ? `Currently using ${isDark ? 'dark' : 'light'} mode based on your device settings`
                  : `${getThemeModeLabel(themeMode)} mode is active`}
              </Text>
            </View>
          </Surface>
        </Animated.View>

        {/* Notifications Section */}
        <Animated.View entering={FadeInDown.delay(150).duration(400)}>
          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={2}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionIcon, { backgroundColor: theme.colors.primaryContainer }]}>
                <Icon name="bell" size={20} color={theme.colors.primary} />
              </View>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                Notifications
              </Text>
            </View>

            <View style={styles.settingRow}>
              <View style={styles.settingInfo}>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                  Push Notifications
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  Receive order updates and messages
                </Text>
              </View>
                <Switch
                  value={notifications}
                  onValueChange={setNotifications}
                color={theme.colors.primary}
            />
            </View>
          </Surface>
        </Animated.View>

        {/* Account Section */}
        <Animated.View entering={FadeInDown.delay(200).duration(400)}>
          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={2}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionIcon, { backgroundColor: theme.colors.secondaryContainer }]}>
                <Icon name="account" size={20} color={theme.colors.secondary} />
              </View>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                Account
              </Text>
            </View>

            <View style={styles.infoRow}>
              <Icon name="email-outline" size={20} color={theme.colors.onSurfaceVariant} />
              <View style={styles.infoContent}>
                <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  Email
                </Text>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                  {user?.email || 'Not set'}
                </Text>
              </View>
            </View>

            <Divider style={styles.divider} />

            <View style={styles.infoRow}>
              <Icon name="shield-account-outline" size={20} color={theme.colors.onSurfaceVariant} />
              <View style={styles.infoContent}>
                <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  Role
                </Text>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                  {user?.role?.charAt(0).toUpperCase() + (user?.role?.slice(1) || '')}
                </Text>
              </View>
            </View>

            <Divider style={styles.divider} />

            <View style={styles.infoRow}>
              <Icon name="calendar-outline" size={20} color={theme.colors.onSurfaceVariant} />
              <View style={styles.infoContent}>
                <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  Member Since
                </Text>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                  {user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'Unknown'}
                </Text>
              </View>
            </View>
          </Surface>
        </Animated.View>

        {/* Support Section */}
        <Animated.View entering={FadeInDown.delay(250).duration(400)}>
          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={2}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionIcon, { backgroundColor: theme.colors.errorContainer }]}>
                <Icon name="lifebuoy" size={20} color={theme.colors.error} />
              </View>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                Support
              </Text>
            </View>

            <Pressable style={styles.linkRow} onPress={handleSupport}>
              <View style={styles.linkContent}>
                <Icon name="help-circle-outline" size={20} color={theme.colors.onSurfaceVariant} />
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, marginLeft: 12 }}>
                  Help Center
                </Text>
              </View>
              <Icon name="chevron-right" size={20} color={theme.colors.onSurfaceVariant} />
            </Pressable>

            <Divider style={styles.divider} />

            <Pressable style={styles.linkRow} onPress={handleSupport}>
              <View style={styles.linkContent}>
                <Icon name="email-outline" size={20} color={theme.colors.onSurfaceVariant} />
                <View style={{ marginLeft: 12 }}>
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                    Contact Support
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    support@gettitonline.com
                  </Text>
                </View>
              </View>
              <Icon name="chevron-right" size={20} color={theme.colors.onSurfaceVariant} />
            </Pressable>
          </Surface>
        </Animated.View>

        {/* Legal Section */}
        <Animated.View entering={FadeInDown.delay(300).duration(400)}>
          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={2}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionIcon, { backgroundColor: theme.colors.surfaceVariant }]}>
                <Icon name="gavel" size={20} color={theme.colors.onSurfaceVariant} />
              </View>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                Legal
              </Text>
            </View>

            <Pressable style={styles.linkRow} onPress={handlePrivacyPolicy}>
              <View style={styles.linkContent}>
                <Icon name="shield-lock-outline" size={20} color={theme.colors.onSurfaceVariant} />
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, marginLeft: 12 }}>
                  Privacy Policy
                </Text>
              </View>
              <Icon name="chevron-right" size={20} color={theme.colors.onSurfaceVariant} />
            </Pressable>

            <Divider style={styles.divider} />

            <Pressable style={styles.linkRow} onPress={handleTermsOfService}>
              <View style={styles.linkContent}>
                <Icon name="file-document-outline" size={20} color={theme.colors.onSurfaceVariant} />
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, marginLeft: 12 }}>
                  Terms of Service
                </Text>
              </View>
              <Icon name="chevron-right" size={20} color={theme.colors.onSurfaceVariant} />
            </Pressable>
          </Surface>
        </Animated.View>

        {/* App Info */}
        <Animated.View entering={FadeInDown.delay(350).duration(400)} style={styles.appInfo}>
          <MotiView
            from={{ opacity: 0.5 }}
            animate={{ opacity: 1 }}
            transition={{
              opacity: { type: 'timing', duration: 1000, loop: true },
            }}
          >
            <Icon name="creation" size={24} color={theme.colors.primary} />
          </MotiView>
          <Text variant="titleSmall" style={{ color: theme.colors.onSurface, marginTop: 8 }}>
            Gettitonline
          </Text>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Version 1.0.0
          </Text>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
            Built for Zambia
          </Text>
        </Animated.View>
      </ScrollView>
      </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  card: {
    marginBottom: 16,
    borderRadius: 16,
    padding: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  sectionIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  themeSelector: {
    paddingTop: 8,
  },
  themeLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  syncBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: 'transparent',
  },
  themeOptions: {
    flexDirection: 'row',
    gap: 12,
  },
  themeOption: {
    flex: 1,
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: 2,
    position: 'relative',
  },
  checkmark: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 20,
    height: 20,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  settingInfo: {
    flex: 1,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 8,
  },
  infoContent: {
    marginLeft: 12,
    flex: 1,
  },
  divider: {
    marginVertical: 8,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  linkContent: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  appInfo: {
    alignItems: 'center',
    marginTop: 16,
    marginBottom: 32,
  },
});
