import React from 'react';
import { View, StyleSheet, FlatList, Pressable } from 'react-native';
import { Text, useTheme, Surface } from 'react-native-paper';
import Animated, {
  FadeIn,
  FadeInDown,
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList, Notification, Id } from '../../types';
import { useAppAuth } from '../../context/AuthProvider';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { MotiView } from 'moti';
import { StackHeader } from '../../components/ui/Header';
import { Skeleton } from '../../components/ui/Skeleton';

type Props = NativeStackScreenProps<RootStackParamList, 'Notifications'>;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface NotificationItemProps {
  notification: Notification;
  index: number;
  onPress: () => void;
}

function getNotificationIcon(type: string): { name: string; color: string; bgColor: string } {
  switch (type) {
    case 'order_placed':
    case 'order_status_update':
    case 'product_sold':
      return { name: 'package-variant', color: '#3B82F6', bgColor: '#DBEAFE' };
    case 'delivery_update':
      return { name: 'truck-delivery', color: '#8B5CF6', bgColor: '#EDE9FE' };
    case 'return_update':
      return { name: 'keyboard-return', color: '#0EA5E9', bgColor: '#E0F2FE' };
    case 'listing_approved':
      return { name: 'check-circle', color: '#10B981', bgColor: '#D1FAE5' };
    case 'listing_rejected':
    case 'listing_changes_requested':
      return { name: 'clipboard-alert-outline', color: '#F59E0B', bgColor: '#FEF3C7' };
    case 'product_submitted':
      return { name: 'clipboard-clock-outline', color: '#3B82F6', bgColor: '#DBEAFE' };
    case 'payment_received':
    case 'funds_released':
    case 'wallet_credit':
      return { name: 'credit-card-check', color: '#10B981', bgColor: '#D1FAE5' };
    case 'payment_failed':
    case 'withdrawal_failed':
      return { name: 'credit-card-remove-outline', color: '#DC2626', bgColor: '#FEE2E2' };
    case 'withdrawal_initiated':
    case 'withdrawal_completed':
    case 'wallet_debit':
      return { name: 'bank-transfer', color: '#10B981', bgColor: '#D1FAE5' };
    case 'dispute_update':
      return { name: 'alert-circle', color: '#F59E0B', bgColor: '#FEF3C7' };
    case 'new_review':
      return { name: 'star', color: '#F59E0B', bgColor: '#FEF3C7' };
    case 'new_message':
      return { name: 'message-text', color: '#0EA5E9', bgColor: '#E0F2FE' };
    case 'low_stock':
      return { name: 'warehouse', color: '#DC2626', bgColor: '#FEE2E2' };
    case 'promo_code':
    case 'flash_sale':
      return { name: 'ticket-percent', color: '#8B5CF6', bgColor: '#EDE9FE' };
    default:
      return { name: 'bell', color: '#64748B', bgColor: '#F1F5F9' };
  }
}

function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function NotificationItem({ notification, index, onPress }: NotificationItemProps) {
  const theme = useTheme();
  const scale = useSharedValue(1);
  const iconConfig = getNotificationIcon(notification.type);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.98, { damping: 15 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15 });
  };

  return (
    <Animated.View entering={FadeInDown.delay(index * 50).duration(300)}>
      <AnimatedPressable
        style={animatedStyle}
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
      >
        <Surface
          style={[
            styles.notificationItem,
            { backgroundColor: theme.colors.surface },
            !notification.isRead && styles.unreadItem,
          ]}
          elevation={notification.isRead ? 1 : 2}
        >
          <View style={styles.cardContent}>
            <View style={styles.notificationContent}>
              <View style={[styles.iconContainer, { backgroundColor: iconConfig.bgColor }]}>
                <Icon name={iconConfig.name} size={24} color={iconConfig.color} />
              </View>
              <View style={styles.textContent}>
                <Text
                  variant="titleSmall"
                  style={[
                    { color: theme.colors.onSurface },
                    !notification.isRead && { fontWeight: '700' },
                  ]}
                  numberOfLines={1}
                >
                  {notification.title}
                </Text>
                <Text
                  variant="bodySmall"
                  style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}
                  numberOfLines={2}
                >
                  {notification.message}
                </Text>
                <Text
                  variant="labelSmall"
                  style={{ color: theme.colors.onSurfaceVariant, marginTop: 6, opacity: 0.7 }}
                >
                  {formatTimeAgo(notification.createdAt)}
                </Text>
              </View>
              {!notification.isRead && (
                <View style={[styles.unreadDot, { backgroundColor: theme.colors.primary }]} />
              )}
            </View>
          </View>
        </Surface>
      </AnimatedPressable>
    </Animated.View>
  );
}

export default function NotificationsScreen({ navigation }: Props) {
  const theme = useTheme();
  const { user } = useAppAuth();

  const notifications = useQuery(
    api.notifications.getUserNotifications,
    user ? { userId: user._id } : 'skip'
  );

  const markAsRead = useMutation(api.notifications.markAsRead);
  const markAllAsRead = useMutation(api.notifications.markAllAsRead);

  const handleNotificationPress = async (notification: Notification) => {
    if (!notification.isRead && user) {
      try {
        await markAsRead({
          notificationId: notification._id,
          userId: user._id,
        });
      } catch (error) {
        // Silent fail - not critical
      }
    }

    // Navigate based on notification type
    if (notification.data?.orderId) {
      navigation.navigate('OrderDetail', { orderId: notification.data.orderId as string });
    } else if (notification.data?.disputeId) {
      navigation.navigate('DisputeDetail', { disputeId: notification.data.disputeId as string });
    } else if (notification.data?.productId) {
      navigation.navigate('ProductDetail', { productId: notification.data.productId as string });
    }
  };

  const handleMarkAllRead = async () => {
    if (!user) return;
    try {
      await markAllAsRead({ userId: user._id });
    } catch (error) {
      // Silent fail
    }
  };

  const unreadCount = notifications?.filter((n) => !n.isRead).length || 0;

  const renderNotification = ({ item, index }: { item: Notification; index: number }) => (
    <NotificationItem
      notification={item}
      index={index}
      onPress={() => handleNotificationPress(item)}
    />
  );

  // Loading state
  if (notifications === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Notifications"
          subtitle="Loading..."
          onBackPress={() => navigation.goBack()}
          variant="gradient"
        />
        <View style={styles.loadingContainer}>
          {[1, 2, 3, 4, 5].map((i) => (
            <View key={i} style={styles.skeletonItem}>
              <Skeleton width={48} height={48} borderRadius={12} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Skeleton width="60%" height={16} />
                <Skeleton width="90%" height={14} style={{ marginTop: 6 }} />
                <Skeleton width="30%" height={12} style={{ marginTop: 6 }} />
              </View>
            </View>
          ))}
        </View>
      </View>
    );
  }

  // Empty state
  if (!notifications || notifications.length === 0) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Notifications"
          subtitle="0 notifications"
          onBackPress={() => navigation.goBack()}
          variant="gradient"
        />
        <View style={[styles.centered, { flex: 1 }]}>
          <MotiView
            from={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ opacity: { type: 'timing', duration: 400 }, scale: { type: 'timing', duration: 400 } }}
          >
            <View style={[styles.emptyIcon, { backgroundColor: theme.colors.surfaceVariant }]}>
              <Icon name="bell-off-outline" size={64} color={theme.colors.onSurfaceVariant} />
            </View>
          </MotiView>
          <Text variant="titleLarge" style={{ color: theme.colors.onSurface, marginTop: 24 }}>
            No notifications
          </Text>
          <Text
            variant="bodyMedium"
            style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, textAlign: 'center' }}
          >
            You're all caught up! We'll notify you when something important happens.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Custom Futuristic Header */}
      <StackHeader
        title="Notifications"
        subtitle={unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'}
        onBackPress={() => navigation.goBack()}
        rightActions={
          unreadCount > 0
            ? [{ icon: 'check-all', onPress: handleMarkAllRead }]
            : []
        }
        variant="gradient"
      />

      <FlatList
        data={notifications}
        renderItem={renderNotification}
        keyExtractor={(item) => item._id}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        ListHeaderComponent={
          unreadCount > 0 ? (
            <Animated.View entering={FadeIn.duration(300)}>
              <Surface style={[styles.unreadBanner, { backgroundColor: theme.colors.primaryContainer }]} elevation={0}>
                <Icon name="bell-badge" size={20} color={theme.colors.primary} />
                <Text variant="labelMedium" style={{ color: theme.colors.primary, marginLeft: 8, flex: 1 }}>
                  {unreadCount} new {unreadCount === 1 ? 'notification' : 'notifications'}
                </Text>
                <Pressable onPress={handleMarkAllRead}>
                  <Text variant="labelMedium" style={{ color: theme.colors.primary, fontWeight: '600' }}>
                    Mark all read
                  </Text>
                </Pressable>
              </Surface>
            </Animated.View>
          ) : null
        }
      />
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
    padding: 24,
  },
  loadingContainer: {
    padding: 16,
  },
  skeletonItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 16,
    marginBottom: 8,
  },
  listContent: {
    padding: 16,
    paddingBottom: 100,
  },
  notificationItem: {
    borderRadius: 16,
  },
  cardContent: {
    overflow: 'hidden',
    borderRadius: 16,
  },
  unreadItem: {
    borderLeftWidth: 3,
    borderLeftColor: '#0EA5E9',
  },
  notificationContent: {
    flexDirection: 'row',
    padding: 16,
    alignItems: 'flex-start',
  },
  iconContainer: {
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  textContent: {
    flex: 1,
    marginLeft: 12,
    marginRight: 8,
  },
  unreadDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 4,
  },
  unreadBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    marginBottom: 16,
  },
  emptyIcon: {
    width: 120,
    height: 120,
    borderRadius: 60,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
