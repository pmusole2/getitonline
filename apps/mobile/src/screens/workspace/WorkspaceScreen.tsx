import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from 'convex/react';
import React, { useMemo } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Chip, Surface, Text, useTheme } from 'react-native-paper';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { AccountAccessNotice } from '../../components/auth/AccountAccessNotice';
import { useAccountAccess } from '../../components/auth/useAccountAccess';
import { TabHeader } from '../../components/ui/Header';
import { useAppAuth } from '../../context/AuthProvider';
import { formatPrice } from '../../theme';
import type { MainTabParamList, RootStackParamList } from '../../types';
import {
  canAccessSellerSurface,
  canManageCatalog,
  canManageListings,
  isAdminRole,
  isReviewerRole,
} from '../../utils/roles';
import { getPrimarySellerRoute } from './workspaceNavigationPolicy';

type Navigation = NativeStackNavigationProp<RootStackParamList>;
type RouteName = keyof RootStackParamList;
type TabName = keyof MainTabParamList;

type WorkspaceModule = {
  title: string;
  description: string;
  icon: string;
  route?: RouteName;
  tab?: TabName;
  accent: 'primary' | 'secondary' | 'tertiary' | 'error';
  disabled?: boolean;
};

const productStatusCopy: Record<string, string> = {
  draft: 'Draft',
  pending_review: 'Pending',
  changes_requested: 'Changes',
  rejected: 'Rejected',
  active: 'Active',
  sold: 'Sold',
  suspended: 'Suspended',
};

function countByStatus<T extends { status: string }>(items: T[]) {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {});
}

function ModuleCard({ item, onPress }: { item: WorkspaceModule; onPress: () => void }) {
  const theme = useTheme();
  const accentColor =
    item.accent === 'primary'
      ? theme.colors.primary
      : item.accent === 'secondary'
        ? theme.colors.secondary
        : item.accent === 'tertiary'
          ? theme.colors.tertiary
          : theme.colors.error;
  const containerColor =
    item.accent === 'primary'
      ? theme.colors.primaryContainer
      : item.accent === 'secondary'
        ? theme.colors.secondaryContainer
        : item.accent === 'tertiary'
          ? theme.colors.tertiaryContainer
          : theme.colors.errorContainer;

  return (
    <Pressable
      onPress={onPress}
      disabled={item.disabled}
      style={({ pressed }) => [styles.modulePressable, { opacity: item.disabled ? 0.5 : pressed ? 0.86 : 1 }]}
    >
      <Surface style={[styles.moduleCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
        <View style={[styles.moduleIcon, { backgroundColor: containerColor }]}>
          <Icon name={item.icon} size={24} color={accentColor} />
        </View>
        <View style={styles.moduleBody}>
          <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
            {item.title}
          </Text>
          <Text
            variant="bodySmall"
            numberOfLines={2}
            style={{ color: theme.colors.onSurfaceVariant, marginTop: 4, lineHeight: 18 }}
          >
            {item.description}
          </Text>
        </View>
        <Icon name="chevron-right" size={22} color={theme.colors.onSurfaceVariant} />
      </Surface>
    </Pressable>
  );
}

export default function WorkspaceScreen() {
  const access = useAccountAccess();
  if (access.status !== 'ready') {
    return <AccountAccessNotice access={access} title="Workspace" />;
  }
  return <WorkspaceContent />;
}

function WorkspaceContent() {
  const theme = useTheme();
  const navigation = useNavigation<Navigation>();
  const { user } = useAppAuth();
  const vendorProfile = useQuery(api.vendors.getMyVendorProfile, user?._id && !user.isBanned ? {} : 'skip');
  const storefront = useQuery(api.platform.getStorefront);

  const isAdmin = isAdminRole(user?.role);
  const isCatalogManager = canManageCatalog(user?.role);
  const isReviewer = isReviewerRole(user?.role);
  const hasSellerSurface = canAccessSellerSurface(user?.role);
  const hasListingAccess = canManageListings(user?.role, vendorProfile?.status ?? null);

  const companyListings = useQuery(api.products.getManagedCatalogProducts, user?._id && isCatalogManager ? {} : 'skip');
  const vendorListings = useQuery(
    api.products.getMyListings,
    user?._id && !isCatalogManager && hasListingAccess ? {} : 'skip',
  );
  const pendingReviewListings = useQuery(
    api.products.getPendingReviewListings,
    user?._id && isReviewer ? { reviewerId: user._id, status: 'pending_review' } : 'skip',
  );

  const listings = useMemo(
    () => (isCatalogManager ? (companyListings ?? []) : (vendorListings ?? [])),
    [companyListings, isCatalogManager, vendorListings],
  );
  const listingCounts = useMemo(() => countByStatus(listings), [listings]);
  const inventoryValue = useMemo(
    () => listings.reduce((sum, product) => sum + product.price * product.quantity, 0),
    [listings],
  );

  const sellerModules: WorkspaceModule[] = hasSellerSurface
    ? [
        {
          title: hasListingAccess ? 'Create Listing' : 'Apply to Sell',
          description: hasListingAccess
            ? 'Launch the PRD-compliant product wizard.'
            : 'Submit or update your vendor application.',
          icon: hasListingAccess ? 'plus-circle-outline' : 'store-plus-outline',
          route: getPrimarySellerRoute(hasListingAccess),
          accent: 'primary',
        },
        {
          title: 'Operations',
          description: 'Analytics, fulfillment, reviews, packing slips, and CSV handoff.',
          icon: 'briefcase-variant-outline',
          route: 'SellerOperations',
          accent: 'secondary',
        },
        {
          title: 'Orders',
          description: 'Review customer orders and fulfillment work.',
          icon: 'package-variant-closed',
          tab: 'Orders',
          accent: 'secondary',
        },
        {
          title: 'Payouts',
          description: 'Check wallet balance, withdrawals, and payout history.',
          icon: 'wallet-outline',
          route: 'Wallet',
          accent: 'tertiary',
        },
        {
          title: 'Messages',
          description: 'Respond to buyer questions before purchase.',
          icon: 'message-text-outline',
          route: 'Conversations',
          accent: 'primary',
        },
        {
          title: 'Support',
          description: 'Track disputes, returns, and buyer protection cases.',
          icon: 'lifebuoy',
          route: 'Disputes',
          accent: 'error',
        },
      ]
    : [];

  const reviewerModules: WorkspaceModule[] = isReviewer
    ? [
        {
          title: 'Approve Listings',
          description: `${pendingReviewListings?.length ?? 0} pending product(s) waiting to go live.`,
          icon: 'clipboard-check-outline',
          route: 'ListingReview',
          accent: 'primary',
        },
        {
          title: 'Dispute Queue',
          description: 'Review escalations and buyer protection cases.',
          icon: 'shield-alert-outline',
          route: 'Disputes',
          accent: 'error',
        },
      ]
    : [];

  const adminModules: WorkspaceModule[] = isAdmin
    ? [
        {
          title: 'Admin Dashboard',
          description: 'Revenue, orders, disputes, and marketplace health.',
          icon: 'view-dashboard-outline',
          route: 'AdminDashboard',
          accent: 'primary',
        },
        {
          title: 'Users & Sellers',
          description: 'Manage buyers, staff, vendors, and company stores.',
          icon: 'account-group-outline',
          route: 'AdminUsers',
          accent: 'secondary',
        },
        {
          title: 'Categories',
          description: 'Manage L1/L2/L3 taxonomy and category status.',
          icon: 'shape-outline',
          route: 'AdminCategories',
          accent: 'tertiary',
        },
        {
          title: 'Delivery',
          description: 'Zones, delivery tiers, pickup points, and courier rules.',
          icon: 'truck-delivery-outline',
          route: 'AdminDelivery',
          accent: 'primary',
        },
        {
          title: 'Promotions',
          description: 'Banners, deals, flash sales, and promo codes.',
          icon: 'ticket-percent-outline',
          route: 'AdminPromotions',
          accent: 'secondary',
        },
        {
          title: 'Orders & Escrow',
          description: 'Orders, payments, refunds, escrow, and transactions.',
          icon: 'bank-transfer',
          route: 'AdminOrders',
          accent: 'tertiary',
        },
      ]
    : [];

  const openModule = (module: WorkspaceModule) => {
    if (module.route) {
      navigation.navigate(module.route as never);
      return;
    }

    if (module.tab) {
      navigation.navigate('Main', { screen: module.tab } as never);
      return;
    }

    navigation.navigate('Main', { screen: 'Profile' } as never);
  };

  if (!user || vendorProfile === undefined || storefront === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <TabHeader title="Workspace" subtitle="Role tools" showAIAssistant />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <TabHeader title="Workspace" subtitle="Seller, staff, and admin operations" showAIAssistant />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <Surface style={[styles.heroCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <View style={styles.heroHeader}>
            <View style={[styles.heroIcon, { backgroundColor: theme.colors.primaryContainer }]}>
              <Icon name="briefcase-check-outline" size={28} color={theme.colors.primary} />
            </View>
            <View style={styles.heroText}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                {isAdmin
                  ? 'Marketplace command center'
                  : isReviewer
                    ? 'Moderation workspace'
                    : hasListingAccess
                      ? 'Seller workspace'
                      : 'Vendor onboarding'}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4, lineHeight: 18 }}>
                Mobile operations are grouped here so each role can move from listing to order, support, payout, and
                admin tasks without digging through Profile.
              </Text>
            </View>
          </View>

          <View style={styles.statusRow}>
            <Chip compact icon="account-key-outline">
              {user.role}
            </Chip>
            {vendorProfile ? (
              <Chip compact icon="storefront-outline">
                Seller {vendorProfile.status}
              </Chip>
            ) : null}
            {isCatalogManager && (
              <Chip compact icon={storefront.isConfigured ? 'check-decagram' : 'alert-outline'}>
                Storefront {storefront.isConfigured ? 'ready' : 'setup needed'}
              </Chip>
            )}
          </View>
        </Surface>

        {hasListingAccess ? (
          <View style={styles.statsGrid}>
            <Surface style={[styles.statCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <Text variant="headlineSmall" style={{ color: theme.colors.primary }}>
                {listings.length}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Listings
              </Text>
            </Surface>
            <Surface style={[styles.statCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <Text variant="headlineSmall" style={{ color: theme.colors.primary }}>
                {listingCounts.active ?? 0}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Active
              </Text>
            </Surface>
            <Surface style={[styles.statCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <Text variant="headlineSmall" style={{ color: theme.colors.primary }}>
                {(listingCounts.pending_review ?? 0) + (listingCounts.changes_requested ?? 0)}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Review
              </Text>
            </Surface>
            <Surface style={[styles.statCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <Text variant="headlineSmall" style={{ color: theme.colors.primary }}>
                {formatPrice(inventoryValue)}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Inventory
              </Text>
            </Surface>
          </View>
        ) : (
          <Surface style={[styles.noticeCard, { backgroundColor: theme.colors.secondaryContainer }]} elevation={0}>
            <Icon name="store-clock-outline" size={24} color={theme.colors.secondary} />
            <View style={styles.noticeText}>
              <Text variant="titleSmall" style={{ color: theme.colors.onSecondaryContainer }}>
                Seller approval required
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSecondaryContainer, marginTop: 4 }}>
                Complete vendor onboarding from the workspace to unlock PRD-compliant listings, orders, payouts, and
                promotions.
              </Text>
            </View>
          </Surface>
        )}

        {sellerModules.length > 0 && (
          <View style={styles.section}>
            <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
              Seller Operations
            </Text>
            <View style={styles.modulesGrid}>
              {sellerModules.map((module) => (
                <ModuleCard key={module.title} item={module} onPress={() => openModule(module)} />
              ))}
            </View>
          </View>
        )}

        {reviewerModules.length > 0 && (
          <View style={styles.section}>
            <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
              Moderation
            </Text>
            <View style={styles.modulesGrid}>
              {reviewerModules.map((module) => (
                <ModuleCard key={module.title} item={module} onPress={() => openModule(module)} />
              ))}
            </View>
          </View>
        )}

        {adminModules.length > 0 && (
          <View style={styles.section}>
            <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
              Admin Operations
            </Text>
            <View style={styles.modulesGrid}>
              {adminModules.map((module) => (
                <ModuleCard key={module.title} item={module} onPress={() => openModule(module)} />
              ))}
            </View>
          </View>
        )}

        {hasListingAccess && listings.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                Recent Listings
              </Text>
              <Button mode="text" onPress={() => navigation.navigate('CreateProduct')}>
                Add
              </Button>
            </View>
            <View style={styles.listingList}>
              {listings.slice(0, 5).map((product) => (
                <Pressable
                  key={product._id}
                  onPress={() => navigation.navigate('EditProduct', { productId: product._id })}
                >
                  <Surface style={[styles.listingCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
                    <View style={styles.listingInfo}>
                      <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                        {product.title}
                      </Text>
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                        {formatPrice(product.price)} • {product.quantity} in stock
                      </Text>
                    </View>
                    <Chip compact>{productStatusCopy[product.status] ?? product.status}</Chip>
                  </Surface>
                </Pressable>
              ))}
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  content: {
    padding: 16,
    paddingBottom: 120,
    gap: 18,
  },
  heroCard: {
    borderRadius: 18,
    padding: 16,
  },
  heroHeader: {
    flexDirection: 'row',
    gap: 14,
  },
  heroIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroText: {
    flex: 1,
  },
  statusRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 16,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  statCard: {
    flexBasis: '47%',
    borderRadius: 16,
    padding: 16,
    minHeight: 92,
    justifyContent: 'center',
  },
  noticeCard: {
    borderRadius: 16,
    padding: 16,
    flexDirection: 'row',
    gap: 12,
  },
  noticeText: {
    flex: 1,
  },
  section: {
    gap: 12,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    fontWeight: '700',
  },
  modulesGrid: {
    gap: 10,
  },
  modulePressable: {
    width: '100%',
  },
  moduleCard: {
    borderRadius: 16,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  moduleIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moduleBody: {
    flex: 1,
  },
  listingList: {
    gap: 10,
  },
  listingCard: {
    borderRadius: 16,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  listingInfo: {
    flex: 1,
  },
});
