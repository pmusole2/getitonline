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
  AdminTransactionCounts,
  AdminTransactionListItem,
  AdminTransactionTypeCounts,
  RootStackParamList,
  TransactionStatus,
  TransactionType,
} from '../../types';

type Props = NativeStackScreenProps<RootStackParamList, 'AdminTransactions'>;
type StatusFilter = 'all' | TransactionStatus;
type TypeFilter = 'all' | TransactionType;

const statusCopy: Record<TransactionStatus, string> = {
  pending: 'Pending',
  processing: 'Processing',
  successful: 'Successful',
  failed: 'Failed',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
};

const typeCopy: Record<TransactionType, string> = {
  collection: 'Collection',
  transfer: 'Transfer',
  refund: 'Refund',
};

const emptyCounts: AdminTransactionCounts = {
  all: 0,
  pending: 0,
  processing: 0,
  successful: 0,
  failed: 0,
  cancelled: 0,
  refunded: 0,
};

const emptyTypeCounts: AdminTransactionTypeCounts = {
  all: 0,
  collection: 0,
  transfer: 0,
  refund: 0,
};

function getTransactionStatusColor(status: TransactionStatus) {
  switch (status) {
    case 'pending':
      return '#D97706';
    case 'processing':
      return '#2563EB';
    case 'successful':
      return '#059669';
    case 'failed':
      return '#DC2626';
    case 'cancelled':
      return '#6B7280';
    case 'refunded':
      return '#B91C1C';
    default:
      return '#6B7280';
  }
}

function formatPaymentMethod(method: AdminTransactionListItem['paymentMethod']) {
  switch (method) {
    case 'mobile_money':
      return 'Mobile Money';
    case 'bank_transfer':
      return 'Bank Transfer';
    case 'card':
      return 'Card';
    default:
      return method;
  }
}

export default function AdminTransactionsScreen(props: Props) {
  // Admin data is read only for a ready account, so no admin query runs while the account is loading or unavailable.
  const access = useAccountAccess();
  if (access.status !== 'ready') {
    return <AccountAccessNotice access={access} title="Transactions" />;
  }
  return <AdminTransactionsContent {...props} />;
}

function AdminTransactionsContent({ navigation }: Props) {
  const theme = useTheme();
  const { user } = useAppAuth();
  const isAdmin = user?.role === 'admin';
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<StatusFilter>('all');
  const [selectedType, setSelectedType] = useState<TypeFilter>('all');

  const transactionsResult = useQuery(
    api.transactions.listTransactionsForAdmin,
    user?._id && isAdmin ? { adminId: user._id } : 'skip'
  );

  const filteredTransactions = useMemo(() => {
    const items = transactionsResult?.items ?? [];
    const normalizedQuery = searchQuery.trim().toLowerCase();

    return items.filter((transaction) => {
      if (selectedStatus !== 'all' && transaction.status !== selectedStatus) {
        return false;
      }

      if (selectedType !== 'all' && transaction.type !== selectedType) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      return [
        transaction.reference,
        transaction.userName,
        transaction.userEmail,
        transaction.orderNumber ?? '',
        transaction.description,
        transaction.mobileMoneyProvider ?? '',
      ].some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [searchQuery, selectedStatus, selectedType, transactionsResult]);

  const counts = transactionsResult?.counts ?? emptyCounts;
  const typeCounts = transactionsResult?.typeCounts ?? emptyTypeCounts;
  const successfulVolume = filteredTransactions
    .filter((transaction) => transaction.status === 'successful')
    .reduce((sum, transaction) => sum + transaction.amount, 0);
  const refundedVolume = filteredTransactions
    .filter((transaction) => transaction.status === 'refunded')
    .reduce((sum, transaction) => sum + transaction.amount, 0);
  const gatewayFees = filteredTransactions.reduce(
    (sum, transaction) => sum + (transaction.gatewayFee ?? 0),
    0
  );

  if (!user) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Transactions"
          subtitle="Admin payment operations"
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
          title="Transactions"
          subtitle="Admin payment operations"
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
            Only Super Admins can review payment transactions.
          </Text>
        </View>
      </View>
    );
  }

  if (transactionsResult === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Transactions"
          subtitle="Admin payment operations"
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
        title="Transactions"
        subtitle="Collections, refunds, and payouts"
        onBackPress={() => navigation.goBack()}
        variant="gradient"
      />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Surface style={[styles.summaryCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            Payment activity
          </Text>
          <Text
            variant="bodySmall"
            style={{ color: theme.colors.onSurfaceVariant, marginTop: 6, lineHeight: 20 }}
          >
            Inspect payment collections, top-ups, refunds, and payout transfers directly from the
            mobile admin workspace.
          </Text>

          <View style={styles.summaryGrid}>
            <Surface style={[styles.statCard, { backgroundColor: theme.colors.primaryContainer }]} elevation={0}>
              <Text variant="headlineSmall" style={{ color: theme.colors.onPrimaryContainer, fontWeight: '700' }}>
                {counts.all}
              </Text>
              <Text variant="labelSmall" style={{ color: theme.colors.onPrimaryContainer }}>
                Total Txns
              </Text>
            </Surface>
            <Surface style={[styles.statCard, { backgroundColor: theme.colors.secondaryContainer }]} elevation={0}>
              <Text variant="headlineSmall" style={{ color: theme.colors.onSecondaryContainer, fontWeight: '700' }}>
                {formatPrice(successfulVolume)}
              </Text>
              <Text variant="labelSmall" style={{ color: theme.colors.onSecondaryContainer }}>
                Successful Volume
              </Text>
            </Surface>
            <Surface style={[styles.statCard, { backgroundColor: theme.colors.tertiaryContainer }]} elevation={0}>
              <Text variant="headlineSmall" style={{ color: theme.colors.onTertiaryContainer, fontWeight: '700' }}>
                {formatPrice(refundedVolume)}
              </Text>
              <Text variant="labelSmall" style={{ color: theme.colors.onTertiaryContainer }}>
                Refunded Volume
              </Text>
            </Surface>
            <Surface style={[styles.statCard, { backgroundColor: theme.colors.errorContainer }]} elevation={0}>
              <Text variant="headlineSmall" style={{ color: theme.colors.onErrorContainer, fontWeight: '700' }}>
                {formatPrice(gatewayFees)}
              </Text>
              <Text variant="labelSmall" style={{ color: theme.colors.onErrorContainer }}>
                Gateway Fees
              </Text>
            </Surface>
          </View>
        </Surface>

        <Searchbar
          placeholder="Search reference, user, order, or provider..."
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
            'pending',
            'processing',
            'successful',
            'failed',
            'cancelled',
            'refunded',
          ] as StatusFilter[]).map((status) => {
            const count = status === 'all' ? counts.all : counts[status];
            const label = status === 'all' ? 'All' : statusCopy[status];

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

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          {(['all', 'collection', 'transfer', 'refund'] as TypeFilter[]).map((type) => {
            const count = type === 'all' ? typeCounts.all : typeCounts[type];
            const label = type === 'all' ? 'All Types' : typeCopy[type];

            return (
              <Chip
                key={type}
                selected={selectedType === type}
                mode={selectedType === type ? 'flat' : 'outlined'}
                onPress={() => setSelectedType(type)}
                style={styles.filterChip}
              >
                {label} ({count})
              </Chip>
            );
          })}
        </ScrollView>

        {filteredTransactions.length === 0 ? (
          <View style={styles.emptyState}>
            <Icon name="credit-card-search-outline" size={44} color={theme.colors.primary} />
            <Text variant="titleSmall" style={{ color: theme.colors.onSurface, marginTop: 12 }}>
              No transactions match this filter
            </Text>
            <Text
              variant="bodySmall"
              style={{ color: theme.colors.onSurfaceVariant, marginTop: 6, textAlign: 'center' }}
            >
              Try another status, transaction type, or search term.
            </Text>
          </View>
        ) : (
          filteredTransactions.map((transaction) => {
            const tone = getTransactionStatusColor(transaction.status);

            return (
              <Surface
                key={transaction._id}
                style={[styles.transactionCard, { backgroundColor: theme.colors.surface }]}
                elevation={1}
              >
                <View style={styles.cardHeader}>
                  <View style={{ flex: 1 }}>
                    <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                      {transaction.reference}
                    </Text>
                    <Text
                      variant="bodySmall"
                      style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}
                    >
                      {transaction.isTopUp
                        ? 'Wallet top-up'
                        : transaction.orderNumber
                          ? `Order #${transaction.orderNumber}`
                          : 'Standalone transaction'}
                    </Text>
                  </View>
                  <Chip
                    compact
                    style={{ backgroundColor: `${tone}20` }}
                    textStyle={{ color: tone }}
                  >
                    {statusCopy[transaction.status]}
                  </Chip>
                </View>

                <View style={styles.metaSection}>
                  <View style={styles.metaRow}>
                    <Icon name="account-outline" size={16} color={theme.colors.onSurfaceVariant} />
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1 }}>
                      {transaction.userName} • {transaction.userEmail}
                    </Text>
                  </View>
                  <View style={styles.metaRow}>
                    <Icon name="swap-horizontal" size={16} color={theme.colors.onSurfaceVariant} />
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1 }}>
                      {typeCopy[transaction.type]} • {formatPaymentMethod(transaction.paymentMethod)}
                      {transaction.mobileMoneyProvider
                        ? ` • ${transaction.mobileMoneyProvider.toUpperCase()}`
                        : ''}
                    </Text>
                  </View>
                  <View style={styles.metaRow}>
                    <Icon name="calendar-outline" size={16} color={theme.colors.onSurfaceVariant} />
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1 }}>
                      Initiated {new Date(transaction.initiatedAt).toLocaleDateString()}
                    </Text>
                  </View>
                </View>

                <Surface style={[styles.amountCard, { backgroundColor: theme.colors.surfaceVariant }]} elevation={0}>
                  <View style={styles.amountRow}>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      Amount
                    </Text>
                    <Text variant="titleMedium" style={{ color: theme.colors.primary, fontWeight: '700' }}>
                      {formatPrice(transaction.amount)}
                    </Text>
                  </View>
                  <View style={styles.amountRow}>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      Gateway fee
                    </Text>
                    <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                      {formatPrice(transaction.gatewayFee ?? 0)}
                    </Text>
                  </View>
                  {transaction.platformFee !== undefined ? (
                    <View style={styles.amountRow}>
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                        Platform fee
                      </Text>
                      <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                        {formatPrice(transaction.platformFee)}
                      </Text>
                    </View>
                  ) : null}
                  {transaction.sellerPayout !== undefined ? (
                    <View style={styles.amountRow}>
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                        Seller payout
                      </Text>
                      <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                        {formatPrice(transaction.sellerPayout)}
                      </Text>
                    </View>
                  ) : null}
                </Surface>

                <View style={styles.actionsRow}>
                  {transaction.orderId ? (
                    <Button
                      mode="contained"
                      compact
                      onPress={() =>
                        navigation.navigate('OrderDetail', {
                          orderId: transaction.orderId!,
                        })
                      }
                    >
                      Open Order
                    </Button>
                  ) : null}
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
  transactionCard: {
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
  amountCard: {
    borderRadius: 14,
    padding: 12,
    gap: 8,
  },
  amountRow: {
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
