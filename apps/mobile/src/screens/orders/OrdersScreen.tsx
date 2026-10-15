import React, { useState } from 'react';
import { View, StyleSheet, FlatList, Pressable } from 'react-native';
import { Text, useTheme, SegmentedButtons, Surface } from 'react-native-paper';
import Animated, {
  FadeIn,
  FadeInDown,
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  Layout,
} from 'react-native-reanimated';
import { useQuery } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import type { RootStackParamList, Order, OrderStatus } from '../../types';
import { AccountAccessNotice } from '../../components/auth/AccountAccessNotice';
import { useAccountAccess } from '../../components/auth/useAccountAccess';
import { useAppAuth } from '../../context/AuthProvider';
import { formatPrice } from '../../theme';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { OrderCardSkeleton } from '../../components/ui/Skeleton';
import { MotiView } from 'moti';
import { TabHeader } from '../../components/ui/Header';
import { canManageCatalog } from '../../utils/roles';

type ViewMode = 'buying' | 'selling';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface OrderCardProps {
  order: Order;
  index: number;
  onPress: () => void;
}

function AnimatedOrderCard({ order, index, onPress }: OrderCardProps) {
  const theme = useTheme();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.98, { damping: 15 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15 });
  };

  const statusConfig: Record<OrderStatus, { color: string; icon: string; label: string }> = {
    pending_payment: { color: '#F59E0B', icon: 'clock-outline', label: 'Pending Payment' },
    paid: { color: '#3B82F6', icon: 'credit-card-check', label: 'Paid' },
    processing: { color: '#8B5CF6', icon: 'package-variant', label: 'Processing' },
    shipped: { color: '#8B5CF6', icon: 'truck-delivery', label: 'Shipped' },
    delivered: { color: '#10B981', icon: 'package-variant-closed-check', label: 'Delivered' },
    completed: { color: '#059669', icon: 'check-circle', label: 'Completed' },
    cancelled: { color: '#6B7280', icon: 'close-circle', label: 'Cancelled' },
    disputed: { color: '#DC2626', icon: 'alert-circle', label: 'Disputed' },
  };

  const status = statusConfig[order.status];

  return (
    <Animated.View
      entering={FadeInDown.delay(index * 80)
        .duration(400)
        .springify()}
      layout={Layout.springify()}
    >
      <AnimatedPressable style={animatedStyle} onPressIn={handlePressIn} onPressOut={handlePressOut} onPress={onPress}>
        <Surface style={[styles.orderCard, { backgroundColor: theme.colors.surface }]} elevation={2}>
          {/* Header */}
          <View style={styles.orderHeader}>
            <View>
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Order
              </Text>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                #{order.orderNumber}
              </Text>
            </View>
            <Surface style={[styles.statusBadge, { backgroundColor: status.color + '15' }]} elevation={0}>
              <Icon name={status.icon} size={14} color={status.color} />
              <Text style={[styles.statusText, { color: status.color }]}>{status.label}</Text>
            </Surface>
          </View>

          {/* Items Preview */}
          <View style={styles.itemsPreview}>
            {order.items.slice(0, 2).map((item, idx) => (
              <View key={idx} style={styles.itemRow}>
                <View style={[styles.itemDot, { backgroundColor: theme.colors.primary }]} />
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, flex: 1 }} numberOfLines={1}>
                  {item.quantity}x {item.title}
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  {formatPrice(item.price * item.quantity)}
                </Text>
              </View>
            ))}
            {order.items.length > 2 && (
              <Text variant="bodySmall" style={{ color: theme.colors.primary, marginTop: 4 }}>
                +{order.items.length - 2} more items
              </Text>
            )}
          </View>

          {/* Footer */}
          <View style={[styles.orderFooter, { borderTopColor: theme.colors.outlineVariant }]}>
            <View>
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Total
              </Text>
              <Text variant="titleMedium" style={{ color: theme.colors.primary, fontWeight: '700' }}>
                {formatPrice(order.totalAmount)}
              </Text>
            </View>
            <View style={styles.footerRight}>
              <Icon name="calendar" size={14} color={theme.colors.onSurfaceVariant} />
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginLeft: 4 }}>
                {new Date(order.createdAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </Text>
              <Icon name="chevron-right" size={20} color={theme.colors.onSurfaceVariant} style={{ marginLeft: 8 }} />
            </View>
          </View>

          {/* Progress indicator for active orders */}
          {['paid', 'processing', 'shipped'].includes(order.status) && (
            <View style={styles.progressContainer}>
              <View style={[styles.progressBar, { backgroundColor: theme.colors.surfaceVariant }]}>
                <View
                  style={[
                    styles.progressFill,
                    {
                      backgroundColor: status.color,
                      width: order.status === 'paid' ? '33%' : order.status === 'processing' ? '66%' : '90%',
                    },
                  ]}
                />
              </View>
            </View>
          )}
        </Surface>
      </AnimatedPressable>
    </Animated.View>
  );
}

export default function OrdersScreen() {
  // Orders are read only for a ready account, so no order query runs while the account is loading or unavailable.
  const access = useAccountAccess();
  if (access.status !== 'ready') {
    return <AccountAccessNotice access={access} title="Orders" />;
  }
  return <OrdersContent />;
}

function OrdersContent() {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { user } = useAppAuth();
  const hasCatalogAccess = canManageCatalog(user?.role);
  const [viewMode, setViewMode] = useState<ViewMode>('buying');

  const buyerOrders = useQuery(api.orders.getBuyerOrders, user ? {} : 'skip');

  const sellerOrders = useQuery(api.orders.getManagedCatalogOrders, user && hasCatalogAccess ? {} : 'skip');

  const orders = viewMode === 'buying' ? buyerOrders : sellerOrders;

  const handleOrderPress = (orderId: string) => {
    navigation.navigate('OrderDetail', { orderId });
  };

  const renderOrder = ({ item, index }: { item: Order; index: number }) => (
    <AnimatedOrderCard order={item} index={index} onPress={() => handleOrderPress(item._id)} />
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Custom Futuristic Header */}
      <TabHeader
        title="Orders"
        subtitle={hasCatalogAccess ? 'Track purchases and company sales' : 'Track your purchases'}
        showAIAssistant
      />

      {/* Toggle */}
      <Animated.View entering={FadeInDown.delay(100).duration(400)} style={styles.toggleContainer}>
        <SegmentedButtons
          value={viewMode}
          onValueChange={(value) => setViewMode(value as ViewMode)}
          buttons={[
            {
              value: 'buying',
              label: 'Purchases',
              icon: 'shopping',
              checkedColor: theme.colors.primary,
            },
            ...(hasCatalogAccess
              ? [
                  {
                    value: 'selling',
                    label: 'Catalog Sales',
                    icon: 'store',
                    checkedColor: theme.colors.primary,
                  },
                ]
              : []),
          ]}
          style={styles.segmentedButtons}
        />
      </Animated.View>

      {/* Stats Summary */}
      {orders && orders.length > 0 && (
        <Animated.View entering={FadeInDown.delay(150).duration(400)} style={styles.statsRow}>
          <Surface style={[styles.statCard, { backgroundColor: theme.colors.primaryContainer }]} elevation={0}>
            <Text variant="headlineSmall" style={{ color: theme.colors.onPrimaryContainer, fontWeight: '700' }}>
              {orders.length}
            </Text>
            <Text variant="labelSmall" style={{ color: theme.colors.onPrimaryContainer }}>
              Total Orders
            </Text>
          </Surface>
          <Surface style={[styles.statCard, { backgroundColor: theme.colors.secondaryContainer }]} elevation={0}>
            <Text variant="headlineSmall" style={{ color: theme.colors.onSecondaryContainer, fontWeight: '700' }}>
              {orders.filter((o) => ['processing', 'shipped'].includes(o.status)).length}
            </Text>
            <Text variant="labelSmall" style={{ color: theme.colors.onSecondaryContainer }}>
              In Progress
            </Text>
          </Surface>
          <Surface style={[styles.statCard, { backgroundColor: theme.colors.tertiaryContainer }]} elevation={0}>
            <Text variant="headlineSmall" style={{ color: theme.colors.onTertiaryContainer, fontWeight: '700' }}>
              {orders.filter((o) => o.status === 'completed').length}
            </Text>
            <Text variant="labelSmall" style={{ color: theme.colors.onTertiaryContainer }}>
              Completed
            </Text>
          </Surface>
        </Animated.View>
      )}

      {/* Orders List */}
      {orders === undefined ? (
        <View style={styles.loadingContainer}>
          {[1, 2, 3].map((i) => (
            <OrderCardSkeleton key={i} />
          ))}
        </View>
      ) : orders.length === 0 ? (
        <Animated.View entering={FadeIn.duration(400)} style={styles.emptyState}>
          <MotiView
            from={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ opacity: { type: 'timing', duration: 400 }, scale: { type: 'timing', duration: 400 } }}
          >
            <View style={[styles.emptyIcon, { backgroundColor: theme.colors.surfaceVariant }]}>
              <Icon
                name={viewMode === 'buying' ? 'shopping-outline' : 'store-outline'}
                size={48}
                color={theme.colors.onSurfaceVariant}
              />
            </View>
          </MotiView>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 16 }}>
            No {viewMode === 'buying' ? 'purchases' : 'sales'} yet
          </Text>
          <Text
            variant="bodyMedium"
            style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, textAlign: 'center' }}
          >
            {viewMode === 'buying'
              ? 'Start shopping to see your orders here'
              : 'Catalog orders will appear here as customers buy from the storefront'}
          </Text>
          <Pressable
            style={[styles.emptyButton, { backgroundColor: theme.colors.primary }]}
            onPress={() =>
              viewMode === 'buying' ? navigation.navigate('Browse' as never) : navigation.navigate('CreateProduct')
            }
          >
            <Text style={{ color: theme.colors.onPrimary, fontWeight: '600' }}>
              {viewMode === 'buying' ? 'Browse Products' : 'Add Listing'}
            </Text>
          </Pressable>
        </Animated.View>
      ) : (
        <FlatList
          data={orders}
          renderItem={renderOrder}
          keyExtractor={(item) => item._id}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  toggleContainer: {
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  segmentedButtons: {
    borderRadius: 12,
  },
  statsRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 12,
    marginBottom: 16,
  },
  statCard: {
    flex: 1,
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
  },
  listContent: {
    padding: 16,
    paddingTop: 0,
    paddingBottom: 100,
  },
  orderCard: {
    borderRadius: 16,
    marginBottom: 12,
    overflow: 'hidden',
  },
  orderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: 16,
    paddingBottom: 12,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 4,
  },
  itemsPreview: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  itemDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 8,
  },
  orderFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderTopWidth: 1,
  },
  footerRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  progressContainer: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  progressBar: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  loadingContainer: {
    padding: 16,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  emptyIcon: {
    width: 100,
    height: 100,
    borderRadius: 50,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyButton: {
    marginTop: 24,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
  },
});
