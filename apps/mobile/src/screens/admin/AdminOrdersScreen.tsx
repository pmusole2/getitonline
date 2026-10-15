import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useQuery } from 'convex/react';
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import {
  Button,
  Chip,
  Searchbar,
  Surface,
  Text,
  useTheme,
} from 'react-native-paper';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { StackHeader } from '../../components/ui/Header';
import { AccountAccessNotice } from '../../components/auth/AccountAccessNotice';
import { useAccountAccess } from '../../components/auth/useAccountAccess';
import { useAppAuth } from '../../context/AuthProvider';
import { formatPrice } from '../../theme';
import type {
  AdminOrderCounts,
  AdminOrderListItem,
  OrderStatus,
  RootStackParamList,
} from '../../types';

type Props = NativeStackScreenProps<RootStackParamList, 'AdminOrders'>;
type StatusFilter = 'all' | OrderStatus;

const orderStatusCopy: Record<OrderStatus, string> = {
  pending_payment: 'Pending Payment',
  paid: 'Paid',
  processing: 'Processing',
  shipped: 'Shipped',
  delivered: 'Delivered',
  completed: 'Completed',
  cancelled: 'Cancelled',
  disputed: 'Disputed',
};

const emptyCounts: AdminOrderCounts = {
  all: 0,
  pending_payment: 0,
  paid: 0,
  processing: 0,
  shipped: 0,
  delivered: 0,
  completed: 0,
  cancelled: 0,
  disputed: 0,
};

function getOrderStatusColor(status: OrderStatus) {
  switch (status) {
    case 'pending_payment':
      return '#D97706';
    case 'paid':
      return '#2563EB';
    case 'processing':
      return '#7C3AED';
    case 'shipped':
      return '#0891B2';
    case 'delivered':
      return '#0D9488';
    case 'completed':
      return '#059669';
    case 'cancelled':
      return '#6B7280';
    case 'disputed':
      return '#DC2626';
    default:
      return '#6B7280';
  }
}

function getEscrowTone(status?: AdminOrderListItem['escrowStatus']) {
  switch (status) {
    case 'held':
      return '#7C3AED';
    case 'released':
      return '#059669';
    case 'refunded':
      return '#DC2626';
    case 'partially_refunded':
      return '#B45309';
    case 'disputed':
      return '#DC2626';
    default:
      return '#6B7280';
  }
}

function formatEscrowLabel(status?: AdminOrderListItem['escrowStatus']) {
  if (!status) {
    return 'No Escrow';
  }

  if (status === 'partially_refunded') {
    return 'Partial Refund';
  }

  return status.charAt(0).toUpperCase() + status.slice(1);
}

export default function AdminOrdersScreen(props: Props) {
  // Admin data is read only for a ready account, so no admin query runs while the account is loading or unavailable.
  const access = useAccountAccess();
  if (access.status !== 'ready') {
    return <AccountAccessNotice access={access} title="Order Management" />;
  }
  return <AdminOrdersContent {...props} />;
}

function AdminOrdersContent({ navigation }: Props) {
  const theme = useTheme();
  const { user } = useAppAuth();
  const isAdmin = user?.role === 'admin';
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<StatusFilter>('all');

  const ordersResult = useQuery(
    api.orders.listOrdersForAdmin,
    user?._id && isAdmin ? { adminId: user._id } : 'skip'
  );

  const filteredOrders = useMemo(() => {
    const items = ordersResult?.items ?? [];
    const normalizedQuery = searchQuery.trim().toLowerCase();

    return items.filter((order) => {
      if (selectedStatus !== 'all' && order.status !== selectedStatus) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      return [
        order.orderNumber,
        order.buyerName,
        order.buyerEmail,
        order.sellerDisplayName,
        order.sellerEmail,
        order.shippingLocation,
        order.itemPreview,
      ].some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [ordersResult, searchQuery, selectedStatus]);

  const counts = ordersResult?.counts ?? emptyCounts;
  const activeOrders =
    counts.paid + counts.processing + counts.shipped + counts.delivered;
  const totalVolume = filteredOrders.reduce(
    (sum, order) => sum + order.totalAmount,
    0
  );

  if (!user) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Order Management"
          subtitle="Admin marketplace orders"
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
          title="Order Management"
          subtitle="Admin marketplace orders"
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
            Only Super Admins can manage marketplace orders.
          </Text>
        </View>
      </View>
    );
  }

  if (ordersResult === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Order Management"
          subtitle="Admin marketplace orders"
          onBackPress={() => navigation.goBack()}
          variant="gradient"
        />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader
        title="Order Management"
        subtitle="Marketplace-wide order queue"
        onBackPress={() => navigation.goBack()}
        variant="gradient"
      />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Surface style={[styles.summaryCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            Order oversight
          </Text>
          <Text
            variant="bodySmall"
            style={{ color: theme.colors.onSurfaceVariant, marginTop: 6, lineHeight: 20 }}
          >
            Review every marketplace order, jump into disputes, and cancel pre-shipping orders from
            the admin mobile workflow.
          </Text>

          <View style={styles.summaryGrid}>
            <Surface style={[styles.statCard, { backgroundColor: theme.colors.primaryContainer }]} elevation={0}>
              <Text variant="headlineSmall" style={{ color: theme.colors.onPrimaryContainer, fontWeight: '700' }}>
                {counts.all}
              </Text>
              <Text variant="labelSmall" style={{ color: theme.colors.onPrimaryContainer }}>
                Total Orders
              </Text>
            </Surface>
            <Surface style={[styles.statCard, { backgroundColor: theme.colors.secondaryContainer }]} elevation={0}>
              <Text variant="headlineSmall" style={{ color: theme.colors.onSecondaryContainer, fontWeight: '700' }}>
                {activeOrders}
              </Text>
              <Text variant="labelSmall" style={{ color: theme.colors.onSecondaryContainer }}>
                Active
              </Text>
            </Surface>
            <Surface style={[styles.statCard, { backgroundColor: theme.colors.tertiaryContainer }]} elevation={0}>
              <Text variant="headlineSmall" style={{ color: theme.colors.onTertiaryContainer, fontWeight: '700' }}>
                {counts.disputed}
              </Text>
              <Text variant="labelSmall" style={{ color: theme.colors.onTertiaryContainer }}>
                Disputed
              </Text>
            </Surface>
            <Surface style={[styles.statCard, { backgroundColor: theme.colors.errorContainer }]} elevation={0}>
              <Text variant="headlineSmall" style={{ color: theme.colors.onErrorContainer, fontWeight: '700' }}>
                {formatPrice(totalVolume)}
              </Text>
              <Text variant="labelSmall" style={{ color: theme.colors.onErrorContainer }}>
                Filtered Volume
              </Text>
            </Surface>
          </View>
        </Surface>

        <Searchbar
          placeholder="Search order number, buyer, seller, or city..."
          value={searchQuery}
          onChangeText={setSearchQuery}
          style={[styles.searchBar, { backgroundColor: theme.colors.surface }]}
        />

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          {([
            'all',
            'pending_payment',
            'paid',
            'processing',
            'shipped',
            'delivered',
            'completed',
            'cancelled',
            'disputed',
          ] as StatusFilter[]).map((status) => {
            const count = status === 'all' ? counts.all : counts[status];
            const label = status === 'all' ? 'All' : orderStatusCopy[status];

            return (
              <Chip
                key={status}
                selected={selectedStatus === status}
                mode={selectedStatus === status ? 'flat' : 'outlined'}
                onPress={() => setSelectedStatus(status)}
                style={styles.filterChip}
              >
                {label} ({count})
              </Chip>
            );
          })}
        </ScrollView>

        {filteredOrders.length === 0 ? (
          <View style={styles.emptyState}>
            <Icon name="shopping-search" size={44} color={theme.colors.primary} />
            <Text variant="titleSmall" style={{ color: theme.colors.onSurface, marginTop: 12 }}>
              No orders match this filter
            </Text>
            <Text
              variant="bodySmall"
              style={{ color: theme.colors.onSurfaceVariant, marginTop: 6, textAlign: 'center' }}
            >
              Adjust the status filter or search terms to find the order you need.
            </Text>
          </View>
        ) : (
          filteredOrders.map((order) => {
            const orderTone = getOrderStatusColor(order.status);
            const escrowTone = getEscrowTone(order.escrowStatus);

            return (
              <Surface
                key={order._id}
                style={[styles.orderCard, { backgroundColor: theme.colors.surface }]}
                elevation={1}
              >
                <View style={styles.cardHeader}>
                  <View style={{ flex: 1 }}>
                    <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                      #{order.orderNumber}
                    </Text>
                    <Text
                      variant="bodySmall"
                      style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}
                    >
                      {new Date(order.createdAt).toLocaleDateString()} • {order.itemCount} item
                      {order.itemCount === 1 ? '' : 's'}
                    </Text>
                  </View>
                  <Chip
                    compact
                    style={{ backgroundColor: `${orderTone}20` }}
                    textStyle={{ color: orderTone }}
                  >
                    {orderStatusCopy[order.status]}
                  </Chip>
                </View>

                <View style={styles.metaSection}>
                  <View style={styles.metaRow}>
                    <Icon name="account-outline" size={16} color={theme.colors.onSurfaceVariant} />
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1 }}>
                      Buyer: {order.buyerName}
                    </Text>
                  </View>
                  <View style={styles.metaRow}>
                    <Icon name={order.isCompanyStore ? 'office-building-outline' : 'store-outline'} size={16} color={theme.colors.onSurfaceVariant} />
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1 }}>
                      Seller: {order.sellerDisplayName}
                    </Text>
                  </View>
                  <View style={styles.metaRow}>
                    <Icon name="map-marker-outline" size={16} color={theme.colors.onSurfaceVariant} />
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1 }}>
                      {order.shippingLocation}
                    </Text>
                  </View>
                </View>

                <Surface style={[styles.previewCard, { backgroundColor: theme.colors.surfaceVariant }]} elevation={0}>
                  <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    Order preview
                  </Text>
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, marginTop: 4 }}>
                    {order.itemPreview}
                  </Text>
                </Surface>

                <View style={styles.tagRow}>
                  <Chip compact style={{ backgroundColor: `${escrowTone}20` }} textStyle={{ color: escrowTone }}>
                    {formatEscrowLabel(order.escrowStatus)}
                  </Chip>
                  {order.disputeId ? (
                    <Chip compact style={{ backgroundColor: '#FEE2E2' }} textStyle={{ color: '#B91C1C' }}>
                      Dispute {order.disputeStatus ? order.disputeStatus.replace(/_/g, ' ') : 'open'}
                    </Chip>
                  ) : null}
                </View>

                <View style={styles.footerRow}>
                  <View>
                    <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      Total
                    </Text>
                    <Text variant="titleMedium" style={{ color: theme.colors.primary, fontWeight: '700' }}>
                      {formatPrice(order.totalAmount)}
                    </Text>
                  </View>
                  <View style={styles.actionsRow}>
                    {order.disputeId ? (
                      <Button
                        mode="outlined"
                        compact
                        onPress={() =>
                          navigation.navigate('DisputeDetail', {
                            disputeId: order.disputeId!,
                          })
                        }
                      >
                        Dispute
                      </Button>
                    ) : null}
                    <Button
                      mode="contained"
                      compact
                      onPress={() =>
                        navigation.navigate('OrderDetail', { orderId: order._id })
                      }
                    >
                      Open Order
                    </Button>
                  </View>
                </View>
              </Surface>
            );
          })
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
    gap: 16,
  },
  summaryCard: {
    borderRadius: 18,
    padding: 16,
  },
  summaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 16,
  },
  statCard: {
    flexBasis: '47%',
    borderRadius: 16,
    padding: 14,
  },
  searchBar: {
    borderRadius: 16,
  },
  filterRow: {
    gap: 8,
    paddingRight: 16,
  },
  filterChip: {
    marginRight: 4,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    paddingHorizontal: 24,
  },
  orderCard: {
    borderRadius: 18,
    padding: 16,
    gap: 14,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  metaSection: {
    gap: 8,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  previewCard: {
    borderRadius: 14,
    padding: 12,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 8,
  },
});
