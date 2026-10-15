import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useQuery } from 'convex/react';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { Chip, SegmentedButtons, Surface, Text, useTheme } from 'react-native-paper';
import Animated, { FadeInDown } from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { AccountAccessNotice } from '../../components/auth/AccountAccessNotice';
import { useAccountAccess } from '../../components/auth/useAccountAccess';
import { StackHeader } from '../../components/ui/Header';
import { useAppAuth } from '../../context/AuthProvider';
import { formatPrice } from '../../theme';
import type { DisputeCategory, DisputeStatus, Id, RootStackParamList } from '../../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Disputes'>;
type DisputeViewMode = 'buyer' | 'seller' | 'staff';

interface Dispute {
  _id: Id<'disputes'>;
  orderId: Id<'orders'>;
  buyerId: Id<'users'>;
  sellerId: Id<'users'>;
  title: string;
  category: DisputeCategory;
  status: DisputeStatus;
  createdAt: number;
  order: {
    orderNumber: string;
    totalAmount: number;
  } | null;
  buyer?: {
    _id: Id<'users'>;
    firstName: string;
    lastName: string;
  } | null;
  seller?: {
    _id: Id<'users'>;
    firstName: string;
    lastName: string;
  } | null;
}

const statusLabels: Record<DisputeStatus, string> = {
  open: 'Open',
  in_discussion: 'In Discussion',
  moderator_review: 'Under Review',
  resolved: 'Resolved',
  closed: 'Closed',
};

const categoryIcons: Record<DisputeCategory, string> = {
  not_received: 'package-variant-closed-remove',
  not_as_described: 'file-document-alert-outline',
  defective: 'alert-circle-outline',
  other: 'help-circle-outline',
};

function DisputeItem({
  dispute,
  index,
  onPress,
  viewAs,
}: {
  dispute: Dispute;
  index: number;
  onPress: () => void;
  viewAs: DisputeViewMode;
}) {
  const theme = useTheme();

  const getStatusColor = (status: DisputeStatus): string => {
    const colors: Record<DisputeStatus, string> = {
      open: '#F59E0B',
      in_discussion: '#3B82F6',
      moderator_review: '#8B5CF6',
      resolved: '#10B981',
      closed: '#6B7280',
    };
    return colors[status];
  };

  const buyerName = dispute.buyer ? `${dispute.buyer.firstName} ${dispute.buyer.lastName}` : 'Unknown buyer';
  const sellerName = dispute.seller ? `${dispute.seller.firstName} ${dispute.seller.lastName}` : 'Unknown seller';
  const counterpartyLabel =
    viewAs === 'buyer'
      ? `Seller: ${sellerName}`
      : viewAs === 'seller'
        ? `Buyer: ${buyerName}`
        : `Buyer: ${buyerName} • Seller: ${sellerName}`;

  return (
    <Animated.View entering={FadeInDown.delay(index * 50).duration(300)}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [
          styles.disputeItem,
          { backgroundColor: theme.colors.surface, opacity: pressed ? 0.8 : 1 },
        ]}
      >
        {/* Icon */}
        <View style={[styles.iconContainer, { backgroundColor: getStatusColor(dispute.status) + '20' }]}>
          <Icon name={categoryIcons[dispute.category]} size={24} color={getStatusColor(dispute.status)} />
        </View>

        {/* Content */}
        <View style={styles.content}>
          <View style={styles.header}>
            <Text variant="titleSmall" style={{ color: theme.colors.onSurface, flex: 1 }} numberOfLines={1}>
              {dispute.title}
            </Text>
            <Chip
              compact
              style={{
                backgroundColor: getStatusColor(dispute.status) + '20',
              }}
              textStyle={{
                color: getStatusColor(dispute.status),
                fontSize: 10,
              }}
            >
              {statusLabels[dispute.status]}
            </Chip>
          </View>

          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
            {counterpartyLabel}
          </Text>

          <View style={styles.footer}>
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Order #{dispute.order?.orderNumber || 'N/A'}
            </Text>
            {dispute.order && (
              <Text variant="labelSmall" style={{ color: theme.colors.primary }}>
                {formatPrice(dispute.order.totalAmount)}
              </Text>
            )}
          </View>

          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
            {new Date(dispute.createdAt).toLocaleDateString()}
          </Text>
        </View>

        <Icon name="chevron-right" size={24} color={theme.colors.onSurfaceVariant} />
      </Pressable>
    </Animated.View>
  );
}

export default function DisputesListScreen(props: Props) {
  const access = useAccountAccess();
  if (access.status !== 'ready') {
    return <AccountAccessNotice access={access} title="Disputes" />;
  }
  return <DisputesListContent {...props} />;
}

function DisputesListContent({ navigation }: Props) {
  const theme = useTheme();
  const { user } = useAppAuth();
  const isStaffViewer = user?.role === 'moderator' || user?.role === 'admin';
  const [viewAs, setViewAs] = useState<DisputeViewMode>(isStaffViewer ? 'staff' : 'buyer');

  // The verified account is the only buyer the list asks for; the server takes the buyer from the Clerk token.
  const buyerDisputes = useQuery(api.disputes.getBuyerDisputes, user ? {} : 'skip') as Dispute[] | undefined;

  const sellerDisputes = useQuery(api.disputes.getSellerDisputes, user ? { sellerId: user._id } : 'skip') as
    | Dispute[]
    | undefined;
  const staffDisputes = useQuery(
    api.disputes.getOpenDisputes,
    user?._id && isStaffViewer ? { moderatorId: user._id } : 'skip',
  ) as Dispute[] | undefined;

  useEffect(() => {
    if (isStaffViewer) {
      setViewAs('staff');
      return;
    }

    setViewAs('buyer');
  }, [isStaffViewer]);

  const disputes = viewAs === 'buyer' ? buyerDisputes : viewAs === 'seller' ? sellerDisputes : staffDisputes;

  const handleDisputePress = (dispute: Dispute) => {
    navigation.navigate('DisputeDetail', { disputeId: dispute._id });
  };

  // Count badges
  const buyerActiveCount = buyerDisputes?.filter((d) => !['resolved', 'closed'].includes(d.status)).length || 0;
  const sellerActiveCount = sellerDisputes?.filter((d) => !['resolved', 'closed'].includes(d.status)).length || 0;
  const staffActiveCount = staffDisputes?.length || 0;

  // Loading
  if (disputes === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Disputes" onBackPress={() => navigation.goBack()} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader title="Disputes" onBackPress={() => navigation.goBack()} />

      {/* View Toggle */}
      <View style={styles.toggleContainer}>
        <SegmentedButtons
          value={viewAs}
          onValueChange={(value) => setViewAs(value as DisputeViewMode)}
          buttons={[
            {
              value: 'buyer',
              label: `As Buyer${buyerActiveCount > 0 ? ` (${buyerActiveCount})` : ''}`,
              icon: 'account-arrow-right',
            },
            {
              value: 'seller',
              label: `As Seller${sellerActiveCount > 0 ? ` (${sellerActiveCount})` : ''}`,
              icon: 'store',
            },
            ...(isStaffViewer
              ? [
                  {
                    value: 'staff',
                    label: `Staff${staffActiveCount > 0 ? ` (${staffActiveCount})` : ''}`,
                    icon: 'shield-account-outline',
                  },
                ]
              : []),
          ]}
        />
      </View>

      {/* Empty State */}
      {disputes.length === 0 ? (
        <View style={styles.centered}>
          <Surface style={[styles.emptyState, { backgroundColor: theme.colors.surfaceVariant }]} elevation={0}>
            <Icon name="gavel" size={64} color={theme.colors.onSurfaceVariant} />
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 16 }}>
              No disputes
            </Text>
            <Text
              variant="bodyMedium"
              style={{
                color: theme.colors.onSurfaceVariant,
                textAlign: 'center',
                marginTop: 8,
              }}
            >
              {viewAs === 'buyer'
                ? "You haven't opened any disputes"
                : viewAs === 'seller'
                  ? 'No disputes have been opened against your orders'
                  : 'No active disputes currently need staff attention'}
            </Text>
          </Surface>
        </View>
      ) : (
        <FlatList
          data={disputes}
          keyExtractor={(item) => item._id}
          renderItem={({ item, index }) => (
            <DisputeItem dispute={item} index={index} onPress={() => handleDisputePress(item)} viewAs={viewAs} />
          )}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}
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
  toggleContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  emptyState: {
    padding: 32,
    borderRadius: 16,
    alignItems: 'center',
    maxWidth: 300,
  },
  list: {
    padding: 16,
    paddingBottom: 32,
  },
  separator: {
    height: 12,
  },
  disputeItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 16,
  },
  iconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    flex: 1,
    marginHorizontal: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
});
