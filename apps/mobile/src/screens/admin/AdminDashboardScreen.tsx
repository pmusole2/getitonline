import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useQuery } from 'convex/react';
import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Chip, Surface, Text, useTheme } from 'react-native-paper';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { StackHeader } from '../../components/ui/Header';
import { AccountAccessNotice } from '../../components/auth/AccountAccessNotice';
import { useAccountAccess } from '../../components/auth/useAccountAccess';
import { useAppAuth } from '../../context/AuthProvider';
import { formatPrice } from '../../theme';
import type { DisputeCategory, DisputeStatus, RootStackParamList } from '../../types';

type Props = NativeStackScreenProps<RootStackParamList, 'AdminDashboard'>;
type QuickActionRoute =
  | 'AdminUsers'
  | 'AdminStores'
  | 'AdminOrders'
  | 'AdminEscrow'
  | 'AdminTransactions'
  | 'AdminCategories'
  | 'AdminDelivery'
  | 'AdminPromotions'
  | 'ListingReview'
  | 'Disputes';

const disputeCategoryCopy: Record<DisputeCategory, string> = {
  not_received: 'Item Not Received',
  not_as_described: 'Not As Described',
  defective: 'Defective',
  other: 'Other',
};

const disputeStatusCopy: Record<DisputeStatus, string> = {
  open: 'Open',
  in_discussion: 'In Discussion',
  moderator_review: 'Under Review',
  resolved: 'Resolved',
  closed: 'Closed',
};

function getDisputeStatusColor(status: DisputeStatus) {
  switch (status) {
    case 'open':
      return '#DC2626';
    case 'in_discussion':
      return '#2563EB';
    case 'moderator_review':
      return '#7C3AED';
    case 'resolved':
      return '#059669';
    case 'closed':
      return '#6B7280';
    default:
      return '#6B7280';
  }
}

function formatFinanceValue(value: number | null): string {
  return value === null ? 'Unavailable' : formatPrice(value);
}

export default function AdminDashboardScreen(props: Props) {
  // Admin data is read only for a ready account, so no admin query runs while the account is loading or unavailable.
  const access = useAccountAccess();
  if (access.status !== 'ready') {
    return <AccountAccessNotice access={access} title="Admin Dashboard" />;
  }
  return <AdminDashboardContent {...props} />;
}

function AdminDashboardContent({ navigation }: Props) {
  const theme = useTheme();
  const { user } = useAppAuth();
  const isAdmin = user?.role === 'admin';

  const orderStats = useQuery(api.orders.getOrderStats, user?._id && isAdmin ? { adminId: user._id } : 'skip');
  const escrowStats = useQuery(api.escrow.getEscrowStats, user?._id && isAdmin ? { adminId: user._id } : 'skip');
  const disputeStats = useQuery(api.disputes.getDisputeStats, user?._id && isAdmin ? { adminId: user._id } : 'skip');
  const transactionStats = useQuery(
    api.transactions.getTransactionStats,
    user?._id && isAdmin ? { adminId: user._id } : 'skip',
  );
  const financialSummary = useQuery(
    api.transactions.getPlatformFinancialSummary,
    user?._id && isAdmin ? { adminId: user._id } : 'skip',
  );
  const openDisputes = useQuery(
    api.disputes.getOpenDisputes,
    user?._id && isAdmin ? { moderatorId: user._id } : 'skip',
  );
  const pendingListings = useQuery(
    api.products.getPendingReviewListings,
    user?._id && isAdmin ? { reviewerId: user._id, status: 'pending_review' } : 'skip',
  );

  if (!user) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Admin Dashboard"
          subtitle="Marketplace oversight"
          onBackPress={() => navigation.goBack()}
          variant="gradient"
        />
        <View style={styles.centered}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            Sign in required
          </Text>
        </View>
      </View>
    );
  }

  if (!isAdmin) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Admin Dashboard"
          subtitle="Marketplace oversight"
          onBackPress={() => navigation.goBack()}
          variant="gradient"
        />
        <View style={styles.centered}>
          <Icon name="shield-lock-outline" size={48} color={theme.colors.primary} />
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 16 }}>
            Access Restricted
          </Text>
          <Text
            variant="bodyMedium"
            style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, textAlign: 'center' }}
          >
            Only Super Admins can access marketplace management tools.
          </Text>
        </View>
      </View>
    );
  }

  if (
    orderStats === undefined ||
    escrowStats === undefined ||
    disputeStats === undefined ||
    transactionStats === undefined ||
    financialSummary === undefined ||
    openDisputes === undefined ||
    pendingListings === undefined
  ) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Admin Dashboard"
          subtitle="Marketplace oversight"
          onBackPress={() => navigation.goBack()}
          variant="gradient"
        />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </View>
    );
  }

  const stats = [
    {
      label: 'Total Orders',
      value: orderStats.total.toLocaleString(),
      detail: `${orderStats.processing} processing`,
      icon: 'shopping-outline',
      tone: theme.colors.primary,
    },
    {
      label: 'Revenue',
      value: formatPrice(orderStats.totalRevenue),
      detail: `${orderStats.completed} completed`,
      icon: 'cash-multiple',
      tone: '#059669',
    },
    {
      label: 'Open Disputes',
      value: disputeStats.open.toLocaleString(),
      detail: `${disputeStats.moderatorReview} under review`,
      icon: 'gavel',
      tone: '#DC2626',
    },
    {
      label: 'Pending Listings',
      value: pendingListings.length.toLocaleString(),
      detail: pendingListings.length > 0 ? 'tap Approve Listings' : 'all clear',
      icon: 'clipboard-check-outline',
      tone: pendingListings.length > 0 ? '#F59E0B' : '#059669',
    },
    {
      label: 'Escrow Held',
      value: formatPrice(escrowStats.totalGrossHeld),
      detail: `${escrowStats.heldCount} held`,
      icon: 'shield-lock-outline',
      tone: '#7C3AED',
    },
  ];

  const quickActions: Array<{
    title: string;
    description: string;
    icon: string;
    route: QuickActionRoute;
    badge?: string;
  }> = [
    {
      title: 'Approve Listings',
      description: 'Publish pending products to the store',
      icon: 'clipboard-check-outline',
      route: 'ListingReview',
      badge: String(pendingListings.length),
    },
    {
      title: 'User Management',
      description: 'Roles, bans, and company seller visibility',
      icon: 'account-cog-outline',
      route: 'AdminUsers',
    },
    {
      title: 'Store Management',
      description: 'Official storefront settings and vendor approvals',
      icon: 'store-cog-outline',
      route: 'AdminStores',
    },
    {
      title: 'Order Management',
      description: 'Review every order and jump into disputes or cancellations',
      icon: 'shopping-outline',
      route: 'AdminOrders',
      badge: String(orderStats.total),
    },
    {
      title: 'Escrow Oversight',
      description: 'Inspect held funds, refunds, and payout exposure',
      icon: 'shield-lock-outline',
      route: 'AdminEscrow',
      badge: String(escrowStats.heldCount + escrowStats.disputedCount),
    },
    {
      title: 'Transactions',
      description: 'Monitor collections, top-ups, refunds, and payment failures',
      icon: 'credit-card-multiple-outline',
      route: 'AdminTransactions',
      badge: String(transactionStats.pending + transactionStats.processing),
    },
    {
      title: 'Categories',
      description: 'Create, organize, and deactivate marketplace categories',
      icon: 'shape-outline',
      route: 'AdminCategories',
    },
    {
      title: 'Delivery',
      description: 'Zones, delivery tiers, pickup points, and courier setup',
      icon: 'truck-delivery-outline',
      route: 'AdminDelivery',
    },
    {
      title: 'Promotions',
      description: 'Banners, deals, flash sales, and promo codes',
      icon: 'ticket-percent-outline',
      route: 'AdminPromotions',
    },
    {
      title: 'Dispute Queue',
      description: 'Watch active disputes and jump into staff review',
      icon: 'scale-balance',
      route: 'Disputes',
      badge: String(openDisputes.length),
    },
  ];

  const navigateTo = (route: QuickActionRoute) => {
    navigation.navigate(route);
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader
        title="Admin Dashboard"
        subtitle="Marketplace oversight"
        onBackPress={() => navigation.goBack()}
        variant="gradient"
      />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <Surface style={[styles.heroCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <View style={styles.heroHeader}>
            <View style={styles.heroText}>
              <Text variant="titleLarge" style={{ color: theme.colors.onSurface }}>
                Marketplace pulse
              </Text>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 6 }}>
                Track orders, escrow exposure, and disputes from the mobile admin surface.
              </Text>
            </View>
            <View style={[styles.heroIcon, { backgroundColor: theme.colors.primaryContainer }]}>
              <Icon name="view-dashboard-outline" size={28} color={theme.colors.primary} />
            </View>
          </View>

          <View style={styles.statsGrid}>
            {stats.map((stat) => (
              <Surface
                key={stat.label}
                style={[styles.statCard, { backgroundColor: theme.colors.surfaceVariant }]}
                elevation={0}
              >
                <View style={[styles.statIcon, { backgroundColor: `${stat.tone}20` }]}>
                  <Icon name={stat.icon} size={18} color={stat.tone} />
                </View>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 12 }}>
                  {stat.label}
                </Text>
                <Text variant="titleLarge" style={{ color: theme.colors.onSurface, marginTop: 4 }}>
                  {stat.value}
                </Text>
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                  {stat.detail}
                </Text>
              </Surface>
            ))}
          </View>
        </Surface>

        <View style={styles.sectionHeader}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            Quick Actions
          </Text>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Jump straight into mobile admin tasks.
          </Text>
        </View>

        <View style={styles.actionsGrid}>
          {quickActions.map((action) => (
            <Pressable
              key={action.title}
              onPress={() => navigateTo(action.route)}
              style={({ pressed }) => [
                styles.actionCard,
                {
                  backgroundColor: theme.colors.surface,
                  opacity: pressed ? 0.86 : 1,
                },
              ]}
            >
              <View style={styles.actionHeader}>
                <View style={[styles.actionIcon, { backgroundColor: theme.colors.primaryContainer }]}>
                  <Icon name={action.icon} size={20} color={theme.colors.primary} />
                </View>
                {action.badge ? <Chip compact>{action.badge}</Chip> : null}
              </View>
              <Text variant="titleSmall" style={{ color: theme.colors.onSurface, marginTop: 16 }}>
                {action.title}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 6, lineHeight: 20 }}>
                {action.description}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.sectionHeader}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            Platform Finance
          </Text>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Gross collections, platform margin, and payment performance.
          </Text>
        </View>

        {!financialSummary.completeness.complete && (
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Financial summary needs review. Unavailable values are not zero.
          </Text>
        )}
        {!financialSummary.completeness.fees && (
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Provider fees are unknown; net platform profit is unavailable.
          </Text>
        )}
        {financialSummary.review.pendingEscrows > 0 && (
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Financial approval is pending; funds remain in custody until applied.
          </Text>
        )}

        <View style={styles.financeGrid}>
          <Surface style={[styles.financeCard, { backgroundColor: theme.colors.surface }]} elevation={0}>
            <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              Gross Received
            </Text>
            <Text variant="titleLarge" style={{ color: theme.colors.onSurface, marginTop: 6 }}>
              {formatFinanceValue(financialSummary.totalGrossReceived)}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
              Proven marketplace escrow funding
            </Text>
          </Surface>

          <Surface style={[styles.financeCard, { backgroundColor: theme.colors.surface }]} elevation={0}>
            <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              Net Platform Profit
            </Text>
            <Text variant="titleLarge" style={{ color: theme.colors.onSurface, marginTop: 6 }}>
              {formatFinanceValue(financialSummary.netPlatformProfit)}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
              Earned fees after provider costs
            </Text>
          </Surface>

          <Surface style={[styles.financeCard, { backgroundColor: theme.colors.surface }]} elevation={0}>
            <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              Held In Escrow
            </Text>
            <Text variant="titleLarge" style={{ color: theme.colors.onSurface, marginTop: 6 }}>
              {formatFinanceValue(financialSummary.heldInEscrow)}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
              Gross buyer funds in custody
            </Text>
          </Surface>

          <Surface style={[styles.financeCard, { backgroundColor: theme.colors.surface }]} elevation={0}>
            <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              Refunded To Buyers
            </Text>
            <Text variant="titleLarge" style={{ color: theme.colors.onSurface, marginTop: 6 }}>
              {formatFinanceValue(financialSummary.refundedToBuyers)}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
              Buyer refunds already processed
            </Text>
          </Surface>
        </View>

        <Surface style={[styles.transactionCard, { backgroundColor: theme.colors.surface }]} elevation={0}>
          <View style={styles.transactionHeader}>
            <View style={{ flex: 1 }}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                Transaction Health
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                {transactionStats.total.toLocaleString()} total transactions •{' '}
                {formatPrice(transactionStats.totalVolume)} successful volume
              </Text>
            </View>
            <View style={[styles.transactionIcon, { backgroundColor: theme.colors.primaryContainer }]}>
              <Icon name="chart-timeline-variant" size={20} color={theme.colors.primary} />
            </View>
          </View>

          <View style={styles.transactionChipRow}>
            <Chip compact>{transactionStats.successful} successful</Chip>
            <Chip compact>{transactionStats.pending} pending</Chip>
            <Chip compact>{transactionStats.processing} processing</Chip>
            <Chip compact>{transactionStats.failed} failed</Chip>
          </View>

          <View style={styles.paymentMethodGrid}>
            <Surface style={[styles.paymentMethodCard, { backgroundColor: theme.colors.surfaceVariant }]} elevation={0}>
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                Mobile Money
              </Text>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 4 }}>
                {transactionStats.byPaymentMethod.mobile_money.count}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                {formatPrice(transactionStats.byPaymentMethod.mobile_money.volume)}
              </Text>
            </Surface>
            <Surface style={[styles.paymentMethodCard, { backgroundColor: theme.colors.surfaceVariant }]} elevation={0}>
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                Card
              </Text>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 4 }}>
                {transactionStats.byPaymentMethod.card.count}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                {formatPrice(transactionStats.byPaymentMethod.card.volume)}
              </Text>
            </Surface>
            <Surface style={[styles.paymentMethodCard, { backgroundColor: theme.colors.surfaceVariant }]} elevation={0}>
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                Bank Transfer
              </Text>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 4 }}>
                {transactionStats.byPaymentMethod.bank_transfer.count}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                {formatPrice(transactionStats.byPaymentMethod.bank_transfer.volume)}
              </Text>
            </Surface>
          </View>
        </Surface>

        <View style={styles.sectionHeader}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            Active Disputes
          </Text>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {openDisputes.length === 0
              ? 'No disputes currently need staff attention.'
              : 'Open or in-progress disputes needing review.'}
          </Text>
        </View>

        {openDisputes.length === 0 ? (
          <Surface style={[styles.emptyCard, { backgroundColor: theme.colors.surface }]} elevation={0}>
            <Icon name="check-circle-outline" size={42} color={theme.colors.primary} />
            <Text variant="titleSmall" style={{ color: theme.colors.onSurface, marginTop: 12 }}>
              All clear
            </Text>
            <Text
              variant="bodySmall"
              style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, textAlign: 'center' }}
            >
              There are no open, in-discussion, or under-review disputes right now.
            </Text>
          </Surface>
        ) : (
          <View style={styles.disputesList}>
            {openDisputes.slice(0, 5).map((dispute) => {
              const statusColor = getDisputeStatusColor(dispute.status);
              const buyerName = dispute.buyer
                ? `${dispute.buyer.firstName} ${dispute.buyer.lastName}`
                : 'Unknown buyer';
              const sellerName = dispute.seller
                ? `${dispute.seller.firstName} ${dispute.seller.lastName}`
                : 'Unknown seller';

              return (
                <Pressable
                  key={dispute._id}
                  onPress={() => navigation.navigate('DisputeDetail', { disputeId: dispute._id })}
                  style={({ pressed }) => [
                    styles.disputeCard,
                    {
                      backgroundColor: theme.colors.surface,
                      opacity: pressed ? 0.88 : 1,
                    },
                  ]}
                >
                  <View style={styles.disputeHeader}>
                    <View style={{ flex: 1 }}>
                      <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                        {dispute.title}
                      </Text>
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                        {buyerName} vs {sellerName}
                      </Text>
                    </View>
                    <Chip compact style={{ backgroundColor: `${statusColor}20` }} textStyle={{ color: statusColor }}>
                      {disputeStatusCopy[dispute.status]}
                    </Chip>
                  </View>

                  <View style={styles.disputeMeta}>
                    <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      {disputeCategoryCopy[dispute.category]}
                    </Text>
                    <Text variant="labelSmall" style={{ color: theme.colors.primary }}>
                      {dispute.order ? `Order #${dispute.order.orderNumber}` : 'Order unavailable'}
                    </Text>
                  </View>

                  {dispute.order ? (
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 8 }}>
                      Amount in question: {formatPrice(dispute.order.totalAmount)}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
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
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  content: {
    padding: 16,
    paddingBottom: 32,
  },
  heroCard: {
    borderRadius: 20,
    padding: 18,
  },
  heroHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  heroText: {
    flex: 1,
  },
  heroIcon: {
    width: 56,
    height: 56,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 18,
  },
  statCard: {
    width: '48%',
    borderRadius: 16,
    padding: 14,
  },
  statIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sectionHeader: {
    marginTop: 24,
    marginBottom: 12,
    gap: 4,
  },
  actionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  financeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  actionCard: {
    width: '48%',
    borderRadius: 18,
    padding: 16,
  },
  financeCard: {
    width: '48%',
    borderRadius: 18,
    padding: 16,
  },
  actionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  actionIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  transactionCard: {
    marginTop: 12,
    borderRadius: 18,
    padding: 16,
  },
  transactionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  transactionIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  transactionChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 16,
  },
  paymentMethodGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 16,
  },
  paymentMethodCard: {
    width: '31%',
    borderRadius: 14,
    padding: 12,
  },
  emptyCard: {
    borderRadius: 18,
    padding: 24,
    alignItems: 'center',
  },
  disputesList: {
    gap: 12,
  },
  disputeCard: {
    borderRadius: 18,
    padding: 16,
  },
  disputeHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  disputeMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 10,
    gap: 12,
  },
});
