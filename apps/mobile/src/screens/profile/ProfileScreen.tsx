import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from 'convex/react';
import { MotiView } from 'moti';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Avatar, Divider, Surface, Text, useTheme } from 'react-native-paper';
import Animated, {
  FadeIn,
  FadeInDown,
} from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { TabHeader } from '../../components/ui/Header';
import { AccountAccessNotice } from '../../components/auth/AccountAccessNotice';
import { useAccountAccess } from '../../components/auth/useAccountAccess';
import { useAppAuth } from '../../context/AuthProvider';
import type { RootStackParamList } from '../../types';
import { canManageCatalog, getRoleDescription, getRoleLabel, isReviewerRole, isStaffRole } from '../../utils/roles';

interface MenuItemProps {
  icon: string;
  label: string;
  description?: string;
  value?: number;
  badge?: boolean;
  onPress: () => void;
  index: number;
}

function AnimatedMenuItem({ icon, label, description, value, badge, onPress }: MenuItemProps) {
  const theme = useTheme();

  return (
    <View>
      <Pressable
        style={styles.menuItem}
        onPress={onPress}
      >
        <View style={[styles.menuIcon, { backgroundColor: theme.colors.primaryContainer }]}>
          <Icon name={icon} size={22} color={theme.colors.primary} />
        </View>
        <View style={styles.menuTextContainer}>
          <Text variant="bodyLarge" style={{ color: theme.colors.onSurface, fontWeight: '500' }}>
            {label}
          </Text>
          {description && (
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
              {description}
            </Text>
          )}
        </View>
        {value !== undefined && (
          <View
            style={[
              styles.badge,
              { backgroundColor: badge ? theme.colors.error : theme.colors.surfaceVariant },
            ]}
          >
            <Text
              variant="labelSmall"
              style={{ color: badge ? theme.colors.onError : theme.colors.onSurfaceVariant, fontWeight: '600' }}
            >
              {value}
            </Text>
          </View>
        )}
        <Icon name="chevron-right" size={20} color={theme.colors.onSurfaceVariant} />
      </Pressable>
    </View>
  );
}

export default function ProfileScreen() {
  // The profile and its counts are read only for a ready account, so no protected query runs while the account is loading or unavailable.
  const access = useAccountAccess();
  if (access.status !== 'ready') {
    return <AccountAccessNotice access={access} title="Profile" />;
  }
  return <ProfileContent />;
}

function ProfileContent() {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { user, signOut } = useAppAuth();
  const hasCatalogAccess = canManageCatalog(user?.role);
  const hasReviewAccess = isReviewerRole(user?.role);
  const isStaff = isStaffRole(user?.role);

  const favorites = useQuery(
    api.favorites.getUserFavorites,
    user ? {} : 'skip'
  );

  const notifications = useQuery(
    api.notifications.getUserNotifications,
    user ? {} : 'skip'
  );

  const unreadConversations = useQuery(
    api.conversations.getUnreadConversationCount,
    user ? { userId: user._id } : 'skip'
  );

  interface Notification {
    isRead: boolean;
  }
  const unreadCount = notifications?.filter((n: Notification) => !n.isRead).length || 0;

  // Get wallet balance for display
  const walletBalance = useQuery(
    api.wallet.getWalletBalance,
    user ? {} : 'skip'
  );

  const menuItems = [
    {
      icon: 'wallet-outline',
      label: 'Wallet',
      description: walletBalance?.hasWallet
        ? `Balance: K${walletBalance.balance.toLocaleString()}`
        : 'View earnings & withdraw funds',
      onPress: () => navigation.navigate('Wallet'),
    },
    {
      icon: 'briefcase-outline',
      label: 'Workspace',
      description: 'Open your role tools and operations',
      onPress: () => navigation.navigate('Workspace'),
    },
    {
      icon: 'message-text-outline',
      label: 'Messages',
      description: 'Conversations with sellers/buyers',
      value: unreadConversations && unreadConversations > 0 ? unreadConversations : undefined,
      badge: unreadConversations && unreadConversations > 0,
      onPress: () => navigation.navigate('Conversations'),
    },
    {
      icon: 'gavel',
      label: 'Disputes',
      description: isStaff ? 'Buyer, seller, and staff dispute queues' : 'Manage order disputes',
      onPress: () => navigation.navigate('Disputes'),
    },
    {
      icon: 'heart-outline',
      label: 'Favorites',
      description: 'Products you saved',
      value: favorites?.length || 0,
      onPress: () => navigation.navigate('Favorites'),
    },
    {
      icon: 'bell-outline',
      label: 'Notifications',
      description: 'Updates and alerts',
      value: unreadCount > 0 ? unreadCount : undefined,
      badge: unreadCount > 0,
      onPress: () => navigation.navigate('Notifications'),
    },
    ...(user?.role === 'admin'
      ? [
          {
            icon: 'view-dashboard-outline',
            label: 'Admin Dashboard',
            description: 'Marketplace stats and admin shortcuts',
            onPress: () => navigation.navigate('AdminDashboard'),
          },
          {
            icon: 'account-cog-outline',
            label: 'User Management',
            description: 'Manage roles, bans, and internal accounts',
            onPress: () => navigation.navigate('AdminUsers'),
          },
          {
            icon: 'store-cog-outline',
            label: 'Store Management',
            description: 'Manage storefronts and vendor approvals',
            onPress: () => navigation.navigate('AdminStores'),
          },
          {
            icon: 'shopping-outline',
            label: 'Order Management',
            description: 'Review and manage marketplace orders',
            onPress: () => navigation.navigate('AdminOrders'),
          },
          {
            icon: 'shield-lock-outline',
            label: 'Escrow Oversight',
            description: 'Track held funds, releases, and refunds',
            onPress: () => navigation.navigate('AdminEscrow'),
          },
          {
            icon: 'credit-card-multiple-outline',
            label: 'Transactions',
            description: 'Monitor collections, refunds, and top-ups',
            onPress: () => navigation.navigate('AdminTransactions'),
          },
          {
            icon: 'shape-outline',
            label: 'Category Management',
            description: 'Create and organize marketplace categories',
            onPress: () => navigation.navigate('AdminCategories'),
          },
        ]
      : []),
    ...(hasReviewAccess
      ? [
          {
            icon: 'clipboard-check-outline',
            label: 'Approve Listings',
            description: 'Publish pending products to the store',
            onPress: () => navigation.navigate('ListingReview'),
          },
        ]
      : []),
    {
      icon: 'account-edit-outline',
      label: 'Edit Profile',
      description: 'Update your information',
      onPress: () => navigation.navigate('EditProfile'),
    },
    {
      icon: 'cog-outline',
      label: 'Settings',
      description: 'App preferences',
      onPress: () => navigation.navigate('Settings'),
    },
    {
      icon: 'help-circle-outline',
      label: 'Help & Support',
      description: 'Get assistance',
      onPress: () => {},
    },
  ];

  if (!user) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.colors.background }]}>
        <MotiView
          from={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ opacity: { type: 'timing', duration: 400 }, scale: { type: 'timing', duration: 400 } }}
        >
          <Icon name="account-circle-outline" size={64} color={theme.colors.onSurfaceVariant} />
        </MotiView>
        <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant, marginTop: 16 }}>
          Please sign in to view your profile
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Custom Futuristic Header */}
      <TabHeader
        title="Profile"
        subtitle="Manage your account"
      />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        {/* Profile Header */}
        <Animated.View entering={FadeIn.duration(500)} style={styles.header}>
          <View style={styles.avatarContainer}>
            <Avatar.Text
              size={90}
              label={`${user.firstName[0]}${user.lastName[0]}`}
              style={{ backgroundColor: theme.colors.primary }}
              labelStyle={{ fontWeight: '600' }}
            />
            {user.isVerified && (
              <View style={[styles.verifiedIcon, { backgroundColor: theme.colors.surface }]}>
                <Icon name="check-decagram" size={24} color={theme.colors.primary} />
              </View>
            )}
          </View>

          <Text variant="headlineSmall" style={{ color: theme.colors.onSurface, marginTop: 16, fontWeight: '700' }}>
            {user.firstName} {user.lastName}
          </Text>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
            {user.email}
          </Text>

          {user.isVerified && (
            <View style={[styles.verifiedBadge, { backgroundColor: theme.colors.primaryContainer }]}>
              <Icon name="shield-check" size={14} color={theme.colors.primary} />
              <Text variant="labelSmall" style={{ color: theme.colors.primary, marginLeft: 4, fontWeight: '600' }}>
                Verified Account
              </Text>
            </View>
          )}
          {isStaff && (
            <View style={[styles.verifiedBadge, { backgroundColor: theme.colors.secondaryContainer, marginTop: 8 }]}>
              <Icon
                name={
                  user.role === 'admin'
                    ? 'shield-crown-outline'
                    : user.role === 'catalog_manager'
                      ? 'store-cog-outline'
                      : 'gavel'
                }
                size={14}
                color={theme.colors.secondary}
              />
              <Text variant="labelSmall" style={{ color: theme.colors.secondary, marginLeft: 4, fontWeight: '600' }}>
                {getRoleLabel(user.role)}
              </Text>
            </View>
          )}
        </Animated.View>

        {/* Stats */}
        <Animated.View entering={FadeInDown.delay(100).duration(400)} style={styles.statsContainer}>
          <Surface style={[styles.statCard, { backgroundColor: theme.colors.surface }]} elevation={2}>
            <MotiView
              from={{ opacity: 0, translateY: 10 }}
              animate={{ opacity: 1, translateY: 0 }}
              transition={{ opacity: { type: 'timing', duration: 400, delay: 200 }, translateY: { type: 'timing', duration: 400, delay: 200 } }}
            >
              <Text variant="headlineMedium" style={{ color: theme.colors.primary, fontWeight: '700' }}>
                {user.totalSales}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Sales
              </Text>
            </MotiView>
          </Surface>

          <Surface style={[styles.statCard, { backgroundColor: theme.colors.surface }]} elevation={2}>
            <MotiView
              from={{ opacity: 0, translateY: 10 }}
              animate={{ opacity: 1, translateY: 0 }}
              transition={{ opacity: { type: 'timing', duration: 400, delay: 300 }, translateY: { type: 'timing', duration: 400, delay: 300 } }}
            >
              <Text variant="headlineMedium" style={{ color: theme.colors.primary, fontWeight: '700' }}>
                {user.totalPurchases}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Purchases
              </Text>
            </MotiView>
          </Surface>

          <Surface style={[styles.statCard, { backgroundColor: theme.colors.surface }]} elevation={2}>
            <MotiView
              from={{ opacity: 0, translateY: 10 }}
              animate={{ opacity: 1, translateY: 0 }}
              transition={{ opacity: { type: 'timing', duration: 400, delay: 400 }, translateY: { type: 'timing', duration: 400, delay: 400 } }}
            >
              <View style={styles.ratingRow}>
                <Icon name="star" size={20} color="#F59E0B" />
                <Text variant="headlineMedium" style={{ color: theme.colors.primary, marginLeft: 4, fontWeight: '700' }}>
                  {user.rating?.toFixed(1) || '-'}
                </Text>
              </View>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Rating
              </Text>
            </MotiView>
          </Surface>
        </Animated.View>

        {/* Menu Items */}
        <Animated.View entering={FadeInDown.delay(200).duration(400)}>
          <Surface style={[styles.menuCard, { backgroundColor: theme.colors.surface }]} elevation={2}>
            {menuItems.map((item, index) => (
              <React.Fragment key={item.label}>
                <AnimatedMenuItem
                  icon={item.icon}
                  label={item.label}
                  description={item.description}
                  value={item.value}
                  badge={item.badge || undefined}
                  onPress={item.onPress}
                  index={index}
                />
                {index < menuItems.length - 1 && (
                  <Divider style={{ marginLeft: 60 }} />
                )}
              </React.Fragment>
            ))}
          </Surface>
        </Animated.View>

        {/* Role Badge */}
        {user.role !== 'user' && (
          <Animated.View entering={FadeInDown.delay(250).duration(400)}>
            <Surface style={[styles.roleCard, { backgroundColor: theme.colors.secondaryContainer }]} elevation={0}>
              <View style={styles.roleContent}>
                <View style={[styles.roleIcon, { backgroundColor: theme.colors.secondary + '30' }]}>
                  <Icon
                    name={
                      user.role === 'admin'
                        ? 'shield-crown'
                        : user.role === 'catalog_manager'
                          ? 'store-cog-outline'
                          : 'shield-account'
                    }
                    size={24}
                    color={theme.colors.secondary}
                  />
                </View>
                <View style={styles.roleText}>
                  <Text variant="titleMedium" style={{ color: theme.colors.onSecondaryContainer, fontWeight: '600' }}>
                    {getRoleLabel(user.role)}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSecondaryContainer, opacity: 0.8 }}>
                    {getRoleDescription(user.role)}
                  </Text>
                </View>
              </View>
            </Surface>
          </Animated.View>
        )}

        {/* Sign Out */}
        <Animated.View entering={FadeInDown.delay(300).duration(400)} style={styles.signOutContainer}>
          <Pressable
            style={[styles.signOutButton, { borderColor: theme.colors.outline }]}
            onPress={signOut}
          >
            <Icon name="logout" size={20} color={theme.colors.error} />
            <Text style={{ color: theme.colors.error, marginLeft: 8, fontWeight: '500' }}>
              Sign Out
            </Text>
          </Pressable>

          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 16, textAlign: 'center' }}>
            Gettitonline v1.0.0
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
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  scrollContent: {
    paddingBottom: 100,
  },
  header: {
    alignItems: 'center',
    padding: 24,
    paddingBottom: 16,
  },
  avatarContainer: {
    position: 'relative',
  },
  verifiedIcon: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    borderRadius: 12,
    padding: 2,
  },
  verifiedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  statsContainer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 12,
    marginBottom: 16,
  },
  statCard: {
    flex: 1,
    alignItems: 'center',
    padding: 16,
    borderRadius: 16,
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  aiCard: {
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  aiSurface: {
    borderRadius: 16,
    padding: 16,
  },
  aiHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  aiIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  menuCard: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 16,
    overflow: 'hidden',
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
  },
  menuIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  menuTextContainer: {
    flex: 1,
    marginLeft: 12,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    marginRight: 8,
  },
  roleCard: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 16,
    padding: 16,
  },
  roleContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  roleIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  roleText: {
    marginLeft: 12,
  },
  signOutContainer: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  signOutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
});
