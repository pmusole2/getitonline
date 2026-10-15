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
  AdminEscrowCounts,
  AdminEscrowListItem,
  EscrowStatus,
  RootStackParamList,
} from '../../types';

type Props = NativeStackScreenProps<RootStackParamList, 'AdminEscrow'>;
type StatusFilter = 'all' | EscrowStatus;

const escrowStatusCopy: Record<EscrowStatus, string> = {
  held: 'Held',
  released: 'Released',
  refunded: 'Refunded',
  partially_refunded: 'Partially Refunded',
  disputed: 'Disputed',
};

const emptyCounts: AdminEscrowCounts = {
  all: 0,
  held: 0,
  released: 0,
  refunded: 0,
  partially_refunded: 0,
  disputed: 0,
};

function getEscrowStatusColor(status: EscrowStatus) {
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

export default function AdminEscrowScreen(props: Props) {
  // Admin data is read only for a ready account, so no admin query runs while the account is loading or unavailable.
  const access = useAccountAccess();
  if (access.status !== 'ready') {
    return <AccountAccessNotice access={access} title="Escrow Oversight" />;
  }
  return <AdminEscrowContent {...props} />;
}

function AdminEscrowContent({ navigation }: Props) {
  const theme = useTheme();
  const { user } = useAppAuth();
  const isAdmin = user?.role === 'admin';
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<StatusFilter>('all');

  const escrowResult = useQuery(
    api.escrow.listEscrowsForAdmin,
    user?._id && isAdmin ? { adminId: user._id } : 'skip'
  );

  const filteredEscrows = useMemo(() => {
    const items = escrowResult?.items ?? [];
    const normalizedQuery = searchQuery.trim().toLowerCase();

    return items.filter((escrow) => {
      if (selectedStatus !== 'all' && escrow.status !== selectedStatus) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      return [
        escrow.orderNumber,
        escrow.buyerName,
        escrow.buyerEmail,
        escrow.sellerDisplayName,
        escrow.sellerEmail,
        escrow.shippingLocation ?? '',
      ].some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [escrowResult, searchQuery, selectedStatus]);

  const counts = escrowResult?.counts ?? emptyCounts;
  const totalHeld = filteredEscrows
    .filter((escrow) => escrow.status === 'held' || escrow.status === 'disputed')
    .reduce((sum, escrow) => sum + escrow.grossAmount, 0);
  const totalRefunded = filteredEscrows.reduce(
    (sum, escrow) => sum + (escrow.refundAmount ?? 0),
    0
  );
  const platformFees = filteredEscrows.reduce(
    (sum, escrow) => sum + escrow.platformFee,
    0
  );

  if (!user) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Escrow Oversight"
          subtitle="Admin funds in transit"
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
          title="Escrow Oversight"
          subtitle="Admin funds in transit"
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
            Only Super Admins can review marketplace escrow balances.
          </Text>
        </View>
      </View>
    );
  }

  if (escrowResult === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Escrow Oversight"
          subtitle="Admin funds in transit"
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
        title="Escrow Oversight"
        subtitle="Held, released, and refunded funds"
        onBackPress={() => navigation.goBack()}
        variant="gradient"
      />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Surface style={[styles.summaryCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            Escrow position
          </Text>
          <Text
            variant="bodySmall"
            style={{ color: theme.colors.onSurfaceVariant, marginTop: 6, lineHeight: 20 }}
          >
            Monitor gross funds held in escrow, released seller payouts, and refund exposure from
            the mobile admin surface.
          </Text>

          <View style={styles.summaryGrid}>
            <Surface style={[styles.statCard, { backgroundColor: theme.colors.primaryContainer }]} elevation={0}>
              <Text variant="headlineSmall" style={{ color: theme.colors.onPrimaryContainer, fontWeight: '700' }}>
                {counts.held + counts.disputed}
              </Text>
              <Text variant="labelSmall" style={{ color: theme.colors.onPrimaryContainer }}>
                Held / Disputed
              </Text>
            </Surface>
            <Surface style={[styles.statCard, { backgroundColor: theme.colors.secondaryContainer }]} elevation={0}>
              <Text variant="headlineSmall" style={{ color: theme.colors.onSecondaryContainer, fontWeight: '700' }}>
                {formatPrice(totalHeld)}
              </Text>
              <Text variant="labelSmall" style={{ color: theme.colors.onSecondaryContainer }}>
                Held Value
              </Text>
            </Surface>
            <Surface style={[styles.statCard, { backgroundColor: theme.colors.tertiaryContainer }]} elevation={0}>
              <Text variant="headlineSmall" style={{ color: theme.colors.onTertiaryContainer, fontWeight: '700' }}>
                {formatPrice(totalRefunded)}
              </Text>
              <Text variant="labelSmall" style={{ color: theme.colors.onTertiaryContainer }}>
                Refunds
              </Text>
            </Surface>
            <Surface style={[styles.statCard, { backgroundColor: theme.colors.errorContainer }]} elevation={0}>
              <Text variant="headlineSmall" style={{ color: theme.colors.onErrorContainer, fontWeight: '700' }}>
                {formatPrice(platformFees)}
              </Text>
              <Text variant="labelSmall" style={{ color: theme.colors.onErrorContainer }}>
                Platform Fees
              </Text>
            </Surface>
          </View>
        </Surface>

        <Searchbar
          placeholder="Search order, buyer, seller, or city..."
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
            'held',
            'released',
            'refunded',
            'partially_refunded',
            'disputed',
          ] as StatusFilter[]).map((status) => {
            const count = status === 'all' ? counts.all : counts[status];
            const label = status === 'all' ? 'All' : escrowStatusCopy[status];

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

        {filteredEscrows.length === 0 ? (
          <View style={styles.emptyState}>
            <Icon name="shield-search-outline" size={44} color={theme.colors.primary} />
            <Text variant="titleSmall" style={{ color: theme.colors.onSurface, marginTop: 12 }}>
              No escrow records match this filter
            </Text>
            <Text
              variant="bodySmall"
              style={{ color: theme.colors.onSurfaceVariant, marginTop: 6, textAlign: 'center' }}
            >
              Adjust the search or status filter to inspect another escrow record.
            </Text>
          </View>
        ) : (
          filteredEscrows.map((escrow) => {
            const tone = getEscrowStatusColor(escrow.status);

            return (
              <Surface
                key={escrow._id}
                style={[styles.escrowCard, { backgroundColor: theme.colors.surface }]}
                elevation={1}
              >
                <View style={styles.cardHeader}>
                  <View style={{ flex: 1 }}>
                    <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                      Order #{escrow.orderNumber}
                    </Text>
                    <Text
                      variant="bodySmall"
                      style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}
                    >
                      {new Date(escrow.createdAt).toLocaleDateString()}
                    </Text>
                  </View>
                  <Chip
                    compact
                    style={{ backgroundColor: `${tone}20` }}
                    textStyle={{ color: tone }}
                  >
                    {escrowStatusCopy[escrow.status]}
                  </Chip>
                </View>

                <View style={styles.metaSection}>
                  <View style={styles.metaRow}>
                    <Icon name="account-outline" size={16} color={theme.colors.onSurfaceVariant} />
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1 }}>
                      Buyer: {escrow.buyerName}
                    </Text>
                  </View>
                  <View style={styles.metaRow}>
                    <Icon
                      name={escrow.isCompanyStore ? 'office-building-outline' : 'store-outline'}
                      size={16}
                      color={theme.colors.onSurfaceVariant}
                    />
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1 }}>
                      Seller: {escrow.sellerDisplayName}
                    </Text>
                  </View>
                  {escrow.shippingLocation ? (
                    <View style={styles.metaRow}>
                      <Icon name="map-marker-outline" size={16} color={theme.colors.onSurfaceVariant} />
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1 }}>
                        {escrow.shippingLocation}
                      </Text>
                    </View>
                  ) : null}
                </View>

                <Surface style={[styles.amountCard, { backgroundColor: theme.colors.surfaceVariant }]} elevation={0}>
                  <View style={styles.amountRow}>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      Gross held
                    </Text>
                    <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                      {formatPrice(escrow.grossAmount)}
                    </Text>
                  </View>
                  <View style={styles.amountRow}>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      Seller payout
                    </Text>
                    <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                      {formatPrice(escrow.sellerAmount)}
                    </Text>
                  </View>
                  <View style={styles.amountRow}>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      Platform fee
                    </Text>
                    <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                      {formatPrice(escrow.platformFee)}
                    </Text>
                  </View>
                  {escrow.refundAmount ? (
                    <View style={styles.amountRow}>
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                        Refund amount
                      </Text>
                      <Text variant="bodyMedium" style={{ color: theme.colors.error }}>
                        {formatPrice(escrow.refundAmount)}
                      </Text>
                    </View>
                  ) : null}
                </Surface>

                <View style={styles.actionsRow}>
                  {escrow.disputeId ? (
                    <Button
                      mode="outlined"
                      compact
                      onPress={() =>
                        navigation.navigate('DisputeDetail', {
                          disputeId: escrow.disputeId!,
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
                      navigation.navigate('OrderDetail', { orderId: escrow.orderId })
                    }
                  >
                    Open Order
                  </Button>
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
  escrowCard: {
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
