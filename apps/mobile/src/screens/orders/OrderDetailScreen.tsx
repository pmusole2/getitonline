import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery } from 'convex/react';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Divider, Modal, Portal, Surface, Text, TextInput, useTheme } from 'react-native-paper';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { StackHeader } from '../../components/ui/Header';
import { useAppAuth } from '../../context/AuthProvider';
import { calculateDisplayPrice } from '../../hooks/useOrderTotal';
import { useImageUpload } from '../../hooks/useImageUpload';
import { detectProvider, formatZambianPhoneNumber, getProviderColor, usePayment } from '../../hooks/usePayment';
import { MobileMoneyProvider } from '../../services/payments';
import { formatPrice } from '../../theme';
import type { Id, OrderStatus, RootStackParamList } from '../../types';

type Props = NativeStackScreenProps<RootStackParamList, 'OrderDetail'>;
type ReturnReason =
  | 'wrong_item'
  | 'defective'
  | 'not_as_described'
  | 'damaged_in_transit'
  | 'changed_mind'
  | 'other';

const returnReasons: Array<{ value: ReturnReason; label: string }> = [
  { value: 'wrong_item', label: 'Wrong item' },
  { value: 'defective', label: 'Defective' },
  { value: 'not_as_described', label: 'Not as described' },
  { value: 'damaged_in_transit', label: 'Damaged in transit' },
  { value: 'changed_mind', label: 'Changed mind' },
  { value: 'other', label: 'Other' },
];

const statusConfig: Record<OrderStatus, { label: string; icon: string; color: string }> = {
  pending_payment: { label: 'Pending Payment', icon: 'clock-outline', color: '#F59E0B' },
  paid: { label: 'Paid', icon: 'credit-card-check', color: '#3B82F6' },
  processing: { label: 'Processing', icon: 'package-variant', color: '#8B5CF6' },
  shipped: { label: 'Shipped', icon: 'truck-delivery', color: '#06B6D4' },
  delivered: { label: 'Delivered', icon: 'package-variant-closed-check', color: '#10B981' },
  completed: { label: 'Completed', icon: 'check-circle', color: '#059669' },
  cancelled: { label: 'Cancelled', icon: 'close-circle', color: '#6B7280' },
  disputed: { label: 'Disputed', icon: 'alert-circle', color: '#DC2626' },
};

const statusSteps: OrderStatus[] = ['pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'completed'];

const getDisputeStatusColor = (status: string): string => {
  const colors: Record<string, string> = {
    open: '#F59E0B',
    in_discussion: '#3B82F6',
    moderator_review: '#8B5CF6',
    resolved: '#10B981',
    closed: '#6B7280',
  };
  return colors[status] || '#6B7280';
};

export default function OrderDetailScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { orderId } = route.params;
  const { user } = useAppAuth();
  const [loading, setLoading] = useState(false);
  const [showTrackingModal, setShowTrackingModal] = useState(false);
  const [trackingNumber, setTrackingNumber] = useState('');
  const [trackingCarrier, setTrackingCarrier] = useState('');
  const [showReturnModal, setShowReturnModal] = useState(false);
  const [returnReason, setReturnReason] = useState<ReturnReason>('not_as_described');
  const [returnDescription, setReturnDescription] = useState('');
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewTitle, setReviewTitle] = useState('');
  const [reviewComment, setReviewComment] = useState('');
  const reviewImages = useImageUpload();
  const returnImages = useImageUpload();

  // Payment state
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'mobile_money' | 'card'>('mobile_money');
  const [mobileNumber, setMobileNumber] = useState(user?.phone || '');
  const [mobileProvider, setMobileProvider] = useState<MobileMoneyProvider | null>(null);

  const order = useQuery(api.orders.getOrder, { orderId: orderId as Id<'orders'> });
  const escrow = useQuery(
    api.escrow.getEscrowByOrder,
    order ? { orderId: order._id } : 'skip'
  );
  const dispute = useQuery(
    api.disputes.getDisputeByOrder,
    order ? { orderId: order._id } : 'skip'
  );
  const trackingEvents = useQuery(
    api.delivery.getOrderTrackingEvents,
    user && order ? { orderId: order._id, viewerUserId: user._id } : 'skip',
  );
  const returnRequests = useQuery(
    api.delivery.getOrderReturnRequests,
    user && order ? { orderId: order._id, viewerUserId: user._id } : 'skip',
  );
  const canReviewOrder = useQuery(
    api.reviews.canReviewOrder,
    user && order ? { orderId: order._id, userId: user._id } : 'skip',
  );
  const existingReview = useQuery(
    api.reviews.getReviewByOrder,
    order ? { orderId: order._id } : 'skip',
  );

  const updateOrderStatus = useMutation(api.orders.updateOrderStatus);
  const cancelOrder = useMutation(api.orders.cancelOrder);
  const markAsShipped = useMutation(api.orders.markAsShipped);
  const addTrackingEvent = useMutation(api.delivery.addOrderTrackingEvent);
  const requestReturn = useMutation(api.delivery.requestReturn);
  const createReview = useMutation(api.reviews.createReview);

  // Payment hook
  const {
    isLoading: paymentLoading,
    isPending: paymentPending,
    payWithMobileMoney,
    payWithCard,
  } = usePayment({
    onSuccess: () => {
      setShowPaymentModal(false);
      Alert.alert(
        'Payment Successful!',
        'Your payment has been processed. The seller will now process your order.',
      );
    },
    onError: (error) => {
      Alert.alert('Payment Failed', error.message);
    },
  });

  const isBuyer = user?._id === order?.buyerId;
  const isSeller = user?._id === order?.sellerId;
  const isAdmin = user?.role === 'admin';

  // Auto-detect provider from phone number
  const handlePhoneChange = (text: string) => {
    setMobileNumber(text);
    const detected = detectProvider(text);
    if (detected) {
      setMobileProvider(detected);
    }
  };

  const handlePayNow = async () => {
    if (!order || !user) return;

    if (paymentMethod === 'mobile_money') {
      if (!mobileNumber.trim()) {
        Alert.alert('Missing Information', 'Please enter your mobile money number');
        return;
      }
      if (!mobileProvider) {
        Alert.alert('Missing Information', 'Please select your mobile money provider');
        return;
      }

      await payWithMobileMoney({
        orderId: order._id,
        userId: user._id,
        amount: order.totalAmount,
        provider: mobileProvider,
        mobileNumber: formatZambianPhoneNumber(mobileNumber),
        description: `Payment for order #${order.orderNumber}`,
      });
    } else {
      await payWithCard({
        orderId: order._id,
        userId: user._id,
        amount: order.totalAmount,
        email: user.email,
        description: `Payment for order #${order.orderNumber}`,
      });
    }
  };

  const handleStatusUpdate = async (newStatus: string) => {
    if (!order || !user) return;

    setLoading(true);
    try {
      await updateOrderStatus({
        orderId: order._id,
        status: newStatus as 'paid' | 'processing' | 'shipped' | 'delivered' | 'completed' | 'cancelled' | 'disputed',
        userId: user._id,
      });
      if ((isSeller || isAdmin) && newStatus === 'processing') {
        await addTrackingEvent({
          actorUserId: user._id,
          orderId: order._id,
          status: 'processing',
          message: `Order ${order.orderNumber} is being prepared by the seller.`,
        });
      }
      Alert.alert('Success', 'Order status updated');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to update order status';
      Alert.alert('Error', errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleMarkAsShipped = async () => {
    if (!order || !user) return;

    setLoading(true);
    try {
      await markAsShipped({
        orderId: order._id,
        sellerId: user._id,
        trackingNumber: trackingNumber.trim() || undefined,
        shippingCarrier: trackingCarrier.trim() || undefined,
      });
      await addTrackingEvent({
        actorUserId: user._id,
        orderId: order._id,
        status: 'in_transit',
        message: trackingCarrier.trim()
          ? `Order ${order.orderNumber} is in transit with ${trackingCarrier.trim()}.`
          : `Order ${order.orderNumber} has been shipped.`,
        carrier: trackingCarrier.trim() || undefined,
        trackingNumber: trackingNumber.trim() || undefined,
      });
      setShowTrackingModal(false);
      setTrackingNumber('');
      setTrackingCarrier('');
      Alert.alert('Order shipped', 'Tracking details were saved and the buyer was notified.');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to mark order as shipped';
      Alert.alert('Error', message);
    } finally {
      setLoading(false);
    }
  };

  const handleRequestReturn = async () => {
    if (!order || !user) return;
    if (returnDescription.trim().length < 15) {
      Alert.alert('More detail needed', 'Describe the return reason in at least 15 characters.');
      return;
    }

    setLoading(true);
    try {
      await requestReturn({
        buyerId: user._id,
        orderId: order._id,
        reason: returnReason,
        requestedItems: order.items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
        })),
        description: returnDescription.trim(),
        evidenceUrls: returnImages.getImageUrls(),
      });
      await addTrackingEvent({
        actorUserId: user._id,
        orderId: order._id,
        status: 'return_requested',
        message: `Return requested for order ${order.orderNumber}.`,
      }).catch(() => undefined);
      setShowReturnModal(false);
      setReturnDescription('');
      returnImages.clearImages();
      Alert.alert('Return requested', 'The seller will review your request.');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to request return';
      Alert.alert('Error', message);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitReview = async () => {
    if (!order || !user) return;
    if (reviewRating < 1 || reviewRating > 5) {
      Alert.alert('Rating required', 'Choose a rating from 1 to 5 stars.');
      return;
    }

    setLoading(true);
    try {
      await createReview({
        orderId: order._id,
        reviewerId: user._id,
        rating: reviewRating,
        title: reviewTitle.trim() || undefined,
        comment: reviewComment.trim() || undefined,
        photoUrls: reviewImages.getImageUrls(),
      });
      setShowReviewModal(false);
      setReviewTitle('');
      setReviewComment('');
      reviewImages.clearImages();
      Alert.alert('Review posted', 'Your review is now visible to shoppers.');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to post review';
      Alert.alert('Error', message);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenDispute = () => {
    if (order) {
      navigation.navigate('CreateDispute', { orderId: order._id });
    }
  };

  const handleAdminCancelOrder = () => {
    if (!order || !user || user.role !== 'admin') {
      return;
    }

    const requiresRefund = ['paid', 'processing'].includes(order.status);

    Alert.alert(
      requiresRefund ? 'Cancel and Refund Order' : 'Cancel Order',
      requiresRefund
        ? 'This will cancel the order, refund any escrowed funds, and mark linked transactions accordingly.'
        : 'This will cancel the order before payment is collected.',
      [
        { text: 'Keep Order', style: 'cancel' },
        {
          text: 'Cancel Order',
          style: 'destructive',
          onPress: async () => {
            setLoading(true);
            try {
              await cancelOrder({
                orderId: order._id,
                userId: user._id,
                reason: 'Cancelled by admin from the mobile order management flow.',
              });
              Alert.alert('Order cancelled', 'The order and related payment state were updated.');
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : 'Failed to cancel order';
              Alert.alert('Error', message);
            } finally {
              setLoading(false);
            }
          },
        },
      ]
    );
  };

  if (order === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Order Details" onBackPress={() => navigation.goBack()} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </View>
    );
  }

  if (order === null) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Order Details" onBackPress={() => navigation.goBack()} />
        <View style={styles.centered}>
          <Icon name="package-variant-closed-remove" size={64} color={theme.colors.onSurfaceVariant} />
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 16 }}>
            Order not found
          </Text>
        </View>
      </View>
    );
  }

  const currentStepIndex = statusSteps.indexOf(order.status);
  const currentStatus = statusConfig[order.status];
  const canAdminCancel = isAdmin && ['pending_payment', 'paid', 'processing'].includes(order.status);
  const activeReturnRequest = returnRequests?.find((request) =>
    ['requested', 'approved', 'in_transit', 'received'].includes(request.status),
  );
  const returnWindowEndsAt = ['delivered', 'completed'].includes(order.status)
    ? order.updatedAt + 7 * 24 * 60 * 60 * 1000
    : null;
  const canRequestReturn = Boolean(
    isBuyer &&
      returnWindowEndsAt &&
      Date.now() <= returnWindowEndsAt &&
      !activeReturnRequest,
  );
  const canWriteReview = Boolean(
    isBuyer && canReviewOrder?.canReview && !existingReview,
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader
        title={`Order #${order.orderNumber.slice(-8)}`}
        onBackPress={() => navigation.goBack()}
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Status Header Card */}
        <Animated.View entering={FadeInDown.delay(100).duration(400)}>
          <LinearGradient
            colors={[currentStatus.color + '30', currentStatus.color + '10']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.statusCard}
          >
            <View style={[styles.statusIconContainer, { backgroundColor: currentStatus.color + '30' }]}>
              <Icon name={currentStatus.icon} size={32} color={currentStatus.color} />
            </View>
            <View style={styles.statusInfo}>
              <Text variant="titleLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                {currentStatus.label}
              </Text>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                {new Date(order.createdAt).toLocaleDateString('en-US', {
                  weekday: 'short',
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </Text>
            </View>
          </LinearGradient>
        </Animated.View>

        {/* Order Progress Timeline */}
        {!['cancelled', 'disputed'].includes(order.status) && (
          <Animated.View entering={FadeInDown.delay(150).duration(400)}>
            <Surface style={[styles.section, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <View style={styles.sectionHeader}>
                <Icon name="timeline-clock-outline" size={20} color={theme.colors.primary} />
                <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                  Order Progress
                </Text>
              </View>

              <View style={styles.timeline}>
                {statusSteps.map((step, index) => {
                  const isCompleted = index <= currentStepIndex;
                  const isCurrent = index === currentStepIndex;
                  const stepConfig = statusConfig[step];

                  return (
                    <View key={step} style={styles.timelineStep}>
                      {/* Connector Line (before dot) */}
                      {index > 0 && (
                        <View
                          style={[
                            styles.timelineConnector,
                            {
                              backgroundColor: index <= currentStepIndex
                                ? theme.colors.primary
                                : theme.colors.outlineVariant,
                            },
                          ]}
                        />
                      )}

                      {/* Step Dot */}
                      <View
                        style={[
                          styles.timelineDot,
                          {
                            backgroundColor: isCompleted ? theme.colors.primary : theme.colors.surfaceVariant,
                            borderColor: isCurrent ? theme.colors.primary : 'transparent',
                            borderWidth: isCurrent ? 3 : 0,
                          },
                        ]}
                      >
                        {isCompleted && (
                          <Icon name="check" size={14} color="#FFFFFF" />
                        )}
                      </View>

                      {/* Step Label */}
                      <Text
                        variant="labelSmall"
                        style={[
                          styles.timelineLabel,
                          {
                            color: isCompleted ? theme.colors.onSurface : theme.colors.onSurfaceVariant,
                            fontWeight: isCurrent ? '700' : '400',
                          },
                        ]}
                        numberOfLines={1}
                      >
                        {stepConfig.label.split(' ')[0]}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </Surface>
          </Animated.View>
        )}

        {/* Order Items */}
        <Animated.View entering={FadeInDown.delay(200).duration(400)}>
          <Surface style={[styles.section, { backgroundColor: theme.colors.surface }]} elevation={1}>
            <View style={styles.sectionHeader}>
              <Icon name="package-variant" size={20} color={theme.colors.primary} />
              <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                Items ({order.items.length})
              </Text>
            </View>

            {order.items.map((item, index) => (
              <View key={index} style={styles.itemCard}>
                <View style={[styles.itemImage, { backgroundColor: theme.colors.surfaceVariant }]}>
                  {item.image ? (
                    <Image source={{ uri: item.image }} style={styles.itemImageContent} resizeMode="cover" />
                  ) : (
                    <Icon name="image" size={28} color={theme.colors.onSurfaceVariant} />
                  )}
                </View>
                <View style={styles.itemDetails}>
                  <Text
                    variant="titleSmall"
                    style={{ color: theme.colors.onSurface, fontWeight: '600' }}
                    numberOfLines={2}
                  >
                    {item.title}
                  </Text>
                  <View style={styles.itemMeta}>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      Qty: {item.quantity}
                    </Text>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      •
                    </Text>
                    <Text variant="bodySmall" style={{ color: theme.colors.primary, fontWeight: '600' }}>
                      {formatPrice(calculateDisplayPrice(item.price))} each
                    </Text>
                  </View>
                  {item.selectedVariantOptions && item.selectedVariantOptions.length > 0 ? (
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }} numberOfLines={1}>
                      {item.selectedVariantOptions.map((option) => `${option.name}: ${option.value}`).join(' • ')}
                    </Text>
                  ) : null}
                  {item.selectedAddOns && item.selectedAddOns.length > 0 ? (
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }} numberOfLines={1}>
                      Add-ons: {item.selectedAddOns.map((addOn) => addOn.name).join(', ')}
                    </Text>
                  ) : null}
                </View>
                <Text variant="titleMedium" style={{ color: theme.colors.primary, fontWeight: '700' }}>
                  {formatPrice(calculateDisplayPrice(item.price) * item.quantity)}
                </Text>
              </View>
            ))}

            <Divider style={styles.divider} />

            {/* Summary */}
            <View style={styles.summaryContainer}>
              <View style={styles.summaryRow}>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  Subtotal
                </Text>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                  {formatPrice(calculateDisplayPrice(order.subtotal))}
                </Text>
              </View>
              <View style={styles.summaryRow}>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  Shipping
                </Text>
                <Text variant="bodyMedium" style={{ color: order.shippingCost === 0 ? theme.colors.secondary : theme.colors.onSurface }}>
                  {order.shippingCost === 0 ? 'Free' : formatPrice(order.shippingCost)}
                </Text>
              </View>
              <View style={[styles.summaryRow, styles.totalRow]}>
                <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                  Total
                </Text>
                <Text variant="headlineSmall" style={{ color: theme.colors.primary, fontWeight: '800' }}>
                  {formatPrice(order.totalAmount)}
                </Text>
              </View>
            </View>
          </Surface>
        </Animated.View>

        {/* Escrow Protection */}
        {escrow && (
          <Animated.View entering={FadeInDown.delay(250).duration(400)}>
            <LinearGradient
              colors={[theme.colors.secondaryContainer, theme.colors.tertiaryContainer]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.escrowCard}
            >
              <View style={[styles.escrowIcon, { backgroundColor: theme.colors.secondary + '30' }]}>
                <Icon name="shield-check" size={24} color={theme.colors.secondary} />
              </View>
              <View style={styles.escrowContent}>
                <Text variant="titleSmall" style={{ color: theme.colors.onSecondaryContainer, fontWeight: '700' }}>
                  Escrow Protection
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSecondaryContainer, marginTop: 4, opacity: 0.9 }}>
                  {escrow.status === 'held'
                    ? 'Payment is securely held until delivery is confirmed.'
                    : escrow.status === 'released'
                    ? 'Payment has been released to the seller.'
                    : escrow.status === 'refunded'
                    ? 'Payment has been refunded to the buyer.'
                    : 'Payment is under dispute.'}
                </Text>
              </View>
            </LinearGradient>
          </Animated.View>
        )}

        <Animated.View entering={FadeInDown.delay(260).duration(400)}>
          <Surface style={[styles.section, { backgroundColor: theme.colors.surface }]} elevation={1}>
            <View style={styles.sectionHeader}>
              <Icon name="truck-fast-outline" size={20} color={theme.colors.primary} />
              <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                Delivery Tracking
              </Text>
            </View>
            {order.deliveryMethodName || order.deliveryEta ? (
              <View style={styles.deliverySummary}>
                <Icon name="map-clock-outline" size={18} color={theme.colors.primary} />
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1 }}>
                  {order.deliveryMethodName ?? 'Seller delivery'}
                  {order.deliveryEta ? ` • ETA ${order.deliveryEta.minDays}-${order.deliveryEta.maxDays} days` : ''}
                </Text>
              </View>
            ) : null}
            {order.trackingNumber || order.shippingCarrier ? (
              <View style={styles.deliverySummary}>
                <Icon name="barcode-scan" size={18} color={theme.colors.primary} />
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1 }}>
                  {order.shippingCarrier ? `${order.shippingCarrier} • ` : ''}
                  {order.trackingNumber ?? 'Tracking pending'}
                </Text>
              </View>
            ) : null}
            {trackingEvents && trackingEvents.length > 0 ? (
              <View style={styles.trackingList}>
                {trackingEvents.map((event) => (
                  <View key={event._id} style={styles.trackingEvent}>
                    <View style={[styles.trackingDot, { backgroundColor: theme.colors.primary }]} />
                    <View style={{ flex: 1 }}>
                      <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                        {event.status.replace(/_/g, ' ')}
                      </Text>
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                        {event.message}
                      </Text>
                      <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                        {new Date(event.occurredAt).toLocaleString()}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Tracking updates will appear as the seller and courier process the order.
              </Text>
            )}
          </Surface>
        </Animated.View>

        {(returnRequests && returnRequests.length > 0) || canRequestReturn ? (
          <Animated.View entering={FadeInDown.delay(265).duration(400)}>
            <Surface style={[styles.section, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <View style={styles.sectionHeader}>
                <Icon name="keyboard-return" size={20} color={theme.colors.primary} />
                <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                  Returns
                </Text>
              </View>
              {returnRequests?.map((request) => (
                <View key={request._id} style={styles.returnCard}>
                  <Text variant="labelLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                    {request.status.replace(/_/g, ' ').toUpperCase()}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                    {request.reason.replace(/_/g, ' ')} • {request.description}
                  </Text>
                  {request.evidenceUrls && request.evidenceUrls.length > 0 ? (
                    <View style={styles.photoRow}>
                      {request.evidenceUrls.slice(0, 4).map((url) => (
                        <Image key={url} source={{ uri: url }} style={styles.reviewPhoto} />
                      ))}
                    </View>
                  ) : null}
                </View>
              ))}
              {canRequestReturn ? (
                <Button mode="contained-tonal" icon="keyboard-return" onPress={() => setShowReturnModal(true)}>
                  Request Return
                </Button>
              ) : returnWindowEndsAt ? (
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  Return window closes {new Date(returnWindowEndsAt).toLocaleDateString()}.
                </Text>
              ) : null}
            </Surface>
          </Animated.View>
        ) : null}

        {(existingReview || canWriteReview) && (
          <Animated.View entering={FadeInDown.delay(270).duration(400)}>
            <Surface style={[styles.section, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <View style={styles.sectionHeader}>
                <Icon name="star-outline" size={20} color={theme.colors.primary} />
                <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                  Review
                </Text>
              </View>
              {existingReview ? (
                <View>
                  <View style={styles.starRow}>
                    {[1, 2, 3, 4, 5].map((star) => (
                      <Icon
                        key={star}
                        name={star <= existingReview.rating ? 'star' : 'star-outline'}
                        size={20}
                        color="#F59E0B"
                      />
                    ))}
                  </View>
                  {existingReview.title ? (
                    <Text variant="titleSmall" style={{ color: theme.colors.onSurface, marginTop: 8 }}>
                      {existingReview.title}
                    </Text>
                  ) : null}
                  {existingReview.comment ? (
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                      {existingReview.comment}
                    </Text>
                  ) : null}
                  {existingReview.photoUrls && existingReview.photoUrls.length > 0 ? (
                    <View style={styles.photoRow}>
                      {existingReview.photoUrls.slice(0, 4).map((url) => (
                        <Image key={url} source={{ uri: url }} style={styles.reviewPhoto} />
                      ))}
                    </View>
                  ) : null}
                </View>
              ) : (
                <Button mode="contained-tonal" icon="star-plus-outline" onPress={() => setShowReviewModal(true)}>
                  Leave Photo Review
                </Button>
              )}
            </Surface>
          </Animated.View>
        )}

        {/* Dispute Info Card - shown to both buyer and seller */}
        {dispute && (
          <Animated.View entering={FadeInDown.delay(275).duration(400)}>
            <Pressable
              onPress={() => navigation.navigate('DisputeDetail', { disputeId: dispute._id })}
              style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}
            >
              <Surface style={[styles.disputeCard, { backgroundColor: theme.colors.errorContainer }]} elevation={0}>
                <View style={styles.disputeHeader}>
                  <View style={[styles.disputeIcon, { backgroundColor: theme.colors.error + '20' }]}>
                    <Icon name="alert-circle" size={24} color={theme.colors.error} />
                  </View>
                  <View style={styles.disputeHeaderText}>
                    <Text variant="titleSmall" style={{ color: theme.colors.onErrorContainer, fontWeight: '700' }}>
                      Dispute Opened
                    </Text>
                    <View style={[styles.disputeStatusBadge, { backgroundColor: getDisputeStatusColor(dispute.status) + '20' }]}>
                      <Text variant="labelSmall" style={{ color: getDisputeStatusColor(dispute.status), fontWeight: '600' }}>
                        {dispute.status.replace('_', ' ').toUpperCase()}
                      </Text>
                    </View>
                  </View>
                  <Icon name="chevron-right" size={24} color={theme.colors.onErrorContainer} />
                </View>

                <Text variant="titleSmall" style={{ color: theme.colors.onErrorContainer, marginTop: 12 }}>
                  {dispute.title}
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onErrorContainer, marginTop: 4, opacity: 0.8 }} numberOfLines={2}>
                  {dispute.description}
                </Text>

                <View style={styles.disputeFooter}>
                  <Text variant="labelSmall" style={{ color: theme.colors.onErrorContainer, opacity: 0.7 }}>
                    Opened by: {dispute.buyer?.firstName} {dispute.buyer?.lastName}
                  </Text>
                  <Text variant="labelSmall" style={{ color: theme.colors.onErrorContainer, opacity: 0.7 }}>
                    {new Date(dispute.createdAt).toLocaleDateString()}
                  </Text>
                </View>

                {dispute.resolution && (
                  <View style={[styles.resolutionBanner, { backgroundColor: theme.colors.secondary + '30' }]}>
                    <Icon name="check-decagram" size={16} color={theme.colors.secondary} />
                    <Text variant="labelMedium" style={{ color: theme.colors.secondary, marginLeft: 6 }}>
                      Resolved: {dispute.resolution.type.replace('_', ' ')}
                    </Text>
                  </View>
                )}
              </Surface>
            </Pressable>
          </Animated.View>
        )}

        {isAdmin && (canAdminCancel || Boolean(dispute)) && (
          <Animated.View entering={FadeInDown.delay(290).duration(400)}>
            <Surface style={[styles.section, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <View style={styles.sectionHeader}>
                <Icon name="shield-crown-outline" size={20} color={theme.colors.primary} />
                <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                  Admin Controls
                </Text>
              </View>

              <View style={styles.adminMetaRow}>
                <Icon name="account-outline" size={16} color={theme.colors.onSurfaceVariant} />
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1 }}>
                  Buyer: {order.buyer?.firstName} {order.buyer?.lastName}
                </Text>
              </View>

              <View style={styles.adminMetaRow}>
                <Icon name="store-outline" size={16} color={theme.colors.onSurfaceVariant} />
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1 }}>
                  Seller: {order.seller?.displayName ?? `${order.seller?.firstName ?? ''} ${order.seller?.lastName ?? ''}`.trim()}
                </Text>
              </View>

              <Text variant="bodySmall" style={[styles.adminNote, { color: theme.colors.onSurfaceVariant }]}>
                Marketplace actions here are administrative overrides. Use disputes for refund resolutions after delivery issues.
              </Text>

              <View style={styles.adminActionRow}>
                {dispute ? (
                  <Pressable
                    onPress={() => navigation.navigate('DisputeDetail', { disputeId: dispute._id })}
                    style={[styles.outlineButton, { borderColor: theme.colors.primary }]}
                  >
                    <Icon name="gavel" size={20} color={theme.colors.primary} />
                    <Text style={[styles.outlineButtonText, { color: theme.colors.primary }]}>
                      Open Dispute Case
                    </Text>
                  </Pressable>
                ) : null}

                {canAdminCancel ? (
                  <Pressable
                    onPress={handleAdminCancelOrder}
                    style={[styles.outlineButton, { borderColor: theme.colors.error }]}
                  >
                    <Icon name="cancel" size={20} color={theme.colors.error} />
                    <Text style={[styles.outlineButtonText, { color: theme.colors.error }]}>
                      Cancel Order
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </Surface>
          </Animated.View>
        )}

        {/* Shipping Address */}
        {order.shippingAddress && (
          <Animated.View entering={FadeInDown.delay(300).duration(400)}>
            <Surface style={[styles.section, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <View style={styles.sectionHeader}>
                <Icon name="map-marker" size={20} color={theme.colors.primary} />
                <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                  Shipping Address
                </Text>
              </View>

              <View style={styles.addressContent}>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, fontWeight: '500' }}>
                  {order.shippingAddress.street}
                </Text>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                  {order.shippingAddress.city}, {order.shippingAddress.province}
                </Text>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  {order.shippingAddress.country}
                </Text>
                <View style={styles.phoneRow}>
                  <Icon name="phone" size={16} color={theme.colors.primary} />
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, marginLeft: 8 }}>
                    {order.shippingAddress.phone}
                  </Text>
                </View>
              </View>
            </Surface>
          </Animated.View>
        )}

        {/* Action Buttons */}
        <Animated.View entering={FadeInUp.delay(350).duration(400)} style={styles.actions}>
          {/* Buyer Pay Now - for pending payment orders */}
          {isBuyer && order.status === 'pending_payment' && (
            <Pressable onPress={() => setShowPaymentModal(true)}>
              <LinearGradient
                colors={['#F59E0B', '#D97706']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.primaryButton}
              >
                <Icon name="credit-card-check-outline" size={22} color="#FFFFFF" />
                <Text style={styles.primaryButtonText}>Pay Now - {formatPrice(order.totalAmount)}</Text>
              </LinearGradient>
            </Pressable>
          )}

          {/* Payment Pending Status */}
          {paymentPending && (
            <Surface style={[styles.paymentStatusCard, { backgroundColor: theme.colors.primaryContainer }]} elevation={0}>
              <ActivityIndicator size="small" color={theme.colors.primary} />
              <Text variant="bodyMedium" style={{ color: theme.colors.onPrimaryContainer, marginLeft: 12 }}>
                Waiting for payment confirmation...
              </Text>
            </Surface>
          )}

          {/* Seller Actions */}
          {isSeller && order.status === 'paid' && (
            <Pressable onPress={() => handleStatusUpdate('processing')} disabled={loading}>
              <LinearGradient
                colors={[theme.colors.primary, theme.colors.tertiary]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.primaryButton}
              >
                {loading ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <>
                    <Icon name="package-variant" size={22} color="#FFFFFF" />
                    <Text style={styles.primaryButtonText}>Start Processing</Text>
                  </>
                )}
              </LinearGradient>
            </Pressable>
          )}

          {isSeller && order.status === 'processing' && (
            <Pressable onPress={() => setShowTrackingModal(true)} disabled={loading}>
              <LinearGradient
                colors={[theme.colors.primary, theme.colors.tertiary]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.primaryButton}
              >
                {loading ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <>
                    <Icon name="truck-delivery" size={22} color="#FFFFFF" />
                    <Text style={styles.primaryButtonText}>Mark as Shipped</Text>
                  </>
                )}
              </LinearGradient>
            </Pressable>
          )}

          {/* Buyer Actions */}
          {isBuyer && order.status === 'shipped' && (
            <Pressable onPress={() => handleStatusUpdate('delivered')} disabled={loading}>
              <LinearGradient
                colors={[theme.colors.primary, theme.colors.tertiary]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.primaryButton}
              >
                {loading ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <>
                    <Icon name="package-variant-closed-check" size={22} color="#FFFFFF" />
                    <Text style={styles.primaryButtonText}>Confirm Delivery</Text>
                  </>
                )}
              </LinearGradient>
            </Pressable>
          )}

          {isBuyer && order.status === 'delivered' && (
            <Pressable onPress={() => handleStatusUpdate('completed')} disabled={loading}>
              <LinearGradient
                colors={['#10B981', '#059669']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.primaryButton}
              >
                {loading ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <>
                    <Icon name="check-circle" size={22} color="#FFFFFF" />
                    <Text style={styles.primaryButtonText}>Complete Order</Text>
                  </>
                )}
              </LinearGradient>
            </Pressable>
          )}

          {/* Open Dispute */}
          {isBuyer && ['paid', 'processing', 'shipped', 'delivered'].includes(order.status) && (
            <Pressable
              onPress={handleOpenDispute}
              style={[styles.outlineButton, { borderColor: theme.colors.error }]}
            >
              <Icon name="alert-circle-outline" size={20} color={theme.colors.error} />
              <Text style={[styles.outlineButtonText, { color: theme.colors.error }]}>
                Open Dispute
              </Text>
            </Pressable>
          )}
        </Animated.View>
      </ScrollView>

      {/* Payment Modal */}
      <Portal>
        <Modal
          visible={showTrackingModal}
          onDismiss={() => setShowTrackingModal(false)}
          contentContainerStyle={[styles.simpleModal, { backgroundColor: theme.colors.surface }]}
        >
          <Text variant="titleLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
            Shipping Details
          </Text>
          <TextInput
            mode="outlined"
            label="Courier"
            value={trackingCarrier}
            onChangeText={setTrackingCarrier}
            style={styles.modalInput}
          />
          <TextInput
            mode="outlined"
            label="Tracking number"
            value={trackingNumber}
            onChangeText={setTrackingNumber}
            style={styles.modalInput}
          />
          <View style={styles.modalActionRow}>
            <Button mode="text" onPress={() => setShowTrackingModal(false)}>
              Cancel
            </Button>
            <Button mode="contained" onPress={handleMarkAsShipped} loading={loading}>
              Mark Shipped
            </Button>
          </View>
        </Modal>

        <Modal
          visible={showReturnModal}
          onDismiss={() => setShowReturnModal(false)}
          contentContainerStyle={[styles.paymentModal, { backgroundColor: theme.colors.surface }]}
        >
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.paymentModalContent}>
            <Text variant="titleLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
              Request Return
            </Text>
            <View style={styles.reasonGrid}>
              {returnReasons.map((reason) => (
                <Pressable
                  key={reason.value}
                  onPress={() => setReturnReason(reason.value)}
                  style={[
                    styles.reasonChip,
                    {
                      backgroundColor: returnReason === reason.value ? theme.colors.primaryContainer : theme.colors.surfaceVariant,
                      borderColor: returnReason === reason.value ? theme.colors.primary : 'transparent',
                    },
                  ]}
                >
                  <Text variant="labelMedium" style={{ color: returnReason === reason.value ? theme.colors.primary : theme.colors.onSurface }}>
                    {reason.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              mode="outlined"
              label="Describe the issue"
              value={returnDescription}
              onChangeText={setReturnDescription}
              multiline
              numberOfLines={4}
            />
            <Button
              mode="contained-tonal"
              icon="camera-plus-outline"
              onPress={() => returnImages.pickImages(5)}
              loading={returnImages.isUploading}
            >
              Add Evidence Photos ({returnImages.images.length}/5)
            </Button>
            {returnImages.images.length > 0 ? (
              <View style={styles.photoRow}>
                {returnImages.images.map((image, index) => (
                  <Pressable key={image.url} onPress={() => returnImages.removeImage(index)}>
                    <Image source={{ uri: image.url }} style={styles.reviewPhoto} />
                  </Pressable>
                ))}
              </View>
            ) : null}
            <View style={styles.modalActionRow}>
              <Button mode="text" onPress={() => setShowReturnModal(false)}>
                Cancel
              </Button>
              <Button mode="contained" onPress={handleRequestReturn} loading={loading}>
                Submit Return
              </Button>
            </View>
          </ScrollView>
        </Modal>

        <Modal
          visible={showReviewModal}
          onDismiss={() => setShowReviewModal(false)}
          contentContainerStyle={[styles.paymentModal, { backgroundColor: theme.colors.surface }]}
        >
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.paymentModalContent}>
            <Text variant="titleLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
              Leave Review
            </Text>
            <View style={styles.starRow}>
              {[1, 2, 3, 4, 5].map((star) => (
                <Pressable key={star} onPress={() => setReviewRating(star)} hitSlop={8}>
                  <Icon
                    name={star <= reviewRating ? 'star' : 'star-outline'}
                    size={34}
                    color="#F59E0B"
                  />
                </Pressable>
              ))}
            </View>
            <TextInput
              mode="outlined"
              label="Review title"
              value={reviewTitle}
              onChangeText={setReviewTitle}
            />
            <TextInput
              mode="outlined"
              label="Comment"
              value={reviewComment}
              onChangeText={setReviewComment}
              multiline
              numberOfLines={4}
            />
            <Button
              mode="contained-tonal"
              icon="camera-plus-outline"
              onPress={() => reviewImages.pickImages(5)}
              loading={reviewImages.isUploading}
            >
              Add Photos ({reviewImages.images.length}/5)
            </Button>
            {reviewImages.images.length > 0 ? (
              <View style={styles.photoRow}>
                {reviewImages.images.map((image, index) => (
                  <Pressable key={image.url} onPress={() => reviewImages.removeImage(index)}>
                    <Image source={{ uri: image.url }} style={styles.reviewPhoto} />
                  </Pressable>
                ))}
              </View>
            ) : null}
            <View style={styles.modalActionRow}>
              <Button mode="text" onPress={() => setShowReviewModal(false)}>
                Cancel
              </Button>
              <Button mode="contained" onPress={handleSubmitReview} loading={loading}>
                Post Review
              </Button>
            </View>
          </ScrollView>
        </Modal>

        <Modal
          visible={showPaymentModal}
          onDismiss={() => setShowPaymentModal(false)}
          contentContainerStyle={[styles.paymentModal, { backgroundColor: theme.colors.surface }]}
        >
          <ScrollView
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.paymentModalContent}
          >
              <View style={styles.paymentModalHeader}>
                <Text variant="headlineSmall" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                  Complete Payment
                </Text>
                <Pressable onPress={() => setShowPaymentModal(false)}>
                  <Icon name="close" size={24} color={theme.colors.onSurfaceVariant} />
                </Pressable>
              </View>

              <View style={styles.paymentAmountBox}>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  Amount to pay
                </Text>
                <Text variant="headlineMedium" style={{ color: theme.colors.primary, fontWeight: '800' }}>
                  {order ? formatPrice(order.totalAmount) : ''}
                </Text>
              </View>

              {/* Payment Method Selection */}
              <Text variant="titleSmall" style={{ color: theme.colors.onSurface, marginBottom: 12, fontWeight: '600' }}>
                Select Payment Method
              </Text>

              <View style={styles.paymentMethodsRow}>
                <Pressable
                  onPress={() => setPaymentMethod('mobile_money')}
                  style={[
                    styles.paymentMethodCard,
                    {
                      backgroundColor: paymentMethod === 'mobile_money' ? theme.colors.primaryContainer : theme.colors.surfaceVariant,
                      borderColor: paymentMethod === 'mobile_money' ? theme.colors.primary : 'transparent',
                    },
                  ]}
                >
                  <Icon
                    name="cellphone"
                    size={28}
                    color={paymentMethod === 'mobile_money' ? theme.colors.primary : theme.colors.onSurfaceVariant}
                  />
                  <Text
                    variant="labelMedium"
                    style={{
                      color: paymentMethod === 'mobile_money' ? theme.colors.primary : theme.colors.onSurface,
                      marginTop: 6,
                      fontWeight: paymentMethod === 'mobile_money' ? '700' : '400',
                    }}
                  >
                    Mobile Money
                  </Text>
                </Pressable>

                <Pressable
                  onPress={() => setPaymentMethod('card')}
                  style={[
                    styles.paymentMethodCard,
                    {
                      backgroundColor: paymentMethod === 'card' ? theme.colors.primaryContainer : theme.colors.surfaceVariant,
                      borderColor: paymentMethod === 'card' ? theme.colors.primary : 'transparent',
                    },
                  ]}
                >
                  <Icon
                    name="credit-card"
                    size={28}
                    color={paymentMethod === 'card' ? theme.colors.primary : theme.colors.onSurfaceVariant}
                  />
                  <Text
                    variant="labelMedium"
                    style={{
                      color: paymentMethod === 'card' ? theme.colors.primary : theme.colors.onSurface,
                      marginTop: 6,
                      fontWeight: paymentMethod === 'card' ? '700' : '400',
                    }}
                  >
                    Card
                  </Text>
                </Pressable>
              </View>

              {/* Mobile Money Details */}
              {paymentMethod === 'mobile_money' && (
                <View style={styles.mobileMoneySection}>
                  <TextInput
                    mode="outlined"
                    label="Mobile Money Number"
                    value={mobileNumber}
                    onChangeText={handlePhoneChange}
                    keyboardType="phone-pad"
                    placeholder="097XXXXXXX"
                    style={styles.phoneInput}
                    outlineStyle={{ borderRadius: 12 }}
                    left={<TextInput.Icon icon="phone" />}
                  />

                  <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 8, marginTop: 12 }}>
                    Select Provider
                  </Text>
                  <View style={styles.providerRow}>
                    {(['mtn', 'airtel', 'zamtel'] as MobileMoneyProvider[]).map((provider) => (
                      <Pressable
                        key={provider}
                        onPress={() => setMobileProvider(provider)}
                        style={[
                          styles.providerButton,
                          {
                            backgroundColor: mobileProvider === provider ? getProviderColor(provider) : theme.colors.surfaceVariant,
                            borderColor: mobileProvider === provider ? getProviderColor(provider) : theme.colors.outline,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.providerText,
                            { color: mobileProvider === provider ? '#FFFFFF' : theme.colors.onSurface },
                          ]}
                        >
                          {provider.toUpperCase()}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              )}

              {/* Card Info */}
              {paymentMethod === 'card' && (
                <View style={styles.cardSection}>
                  <View style={[styles.cardInfoBox, { backgroundColor: theme.colors.surfaceVariant }]}>
                    <Icon name="information-outline" size={20} color={theme.colors.primary} />
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginLeft: 10, flex: 1 }}>
                      You'll be redirected to a secure payment page to complete your card payment.
                    </Text>
                  </View>
                </View>
              )}

              {/* Pay Button */}
              <Pressable
                onPress={handlePayNow}
                disabled={paymentLoading || paymentPending}
                style={({ pressed }) => [{ opacity: pressed ? 0.9 : 1, marginTop: 8 }]}
              >
                <LinearGradient
                  colors={[theme.colors.primary, theme.colors.tertiary]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={[styles.payNowButton, (paymentLoading || paymentPending) && { opacity: 0.6 }]}
                >
                  {paymentLoading || paymentPending ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <>
                      <Icon name="lock" size={20} color="#FFFFFF" />
                      <Text style={styles.payNowButtonText}>
                        Pay {order ? formatPrice(order.totalAmount) : ''}
                      </Text>
                    </>
                  )}
                </LinearGradient>
              </Pressable>

              {/* Security Note */}
              <View style={styles.securityNote}>
                <Icon name="shield-check" size={16} color={theme.colors.secondary} />
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, marginLeft: 6 }}>
                  Secured by Escrow Protection
                </Text>
              </View>
          </ScrollView>
        </Modal>
      </Portal>
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
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 32,
  },
  statusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 20,
    borderRadius: 20,
    marginBottom: 16,
  },
  statusIconContainer: {
    width: 64,
    height: 64,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  statusInfo: {
    flex: 1,
    marginLeft: 16,
  },
  section: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  sectionTitle: {
    marginLeft: 10,
    fontWeight: '700',
  },
  timeline: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  timelineStep: {
    flex: 1,
    alignItems: 'center',
    position: 'relative',
  },
  timelineConnector: {
    position: 'absolute',
    top: 13,
    left: 0,
    right: '50%',
    height: 3,
    borderRadius: 1.5,
    zIndex: -1,
  },
  timelineDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1,
  },
  timelineLabel: {
    marginTop: 8,
    textAlign: 'center',
    fontSize: 10,
  },
  itemCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.05)',
  },
  itemImage: {
    width: 60,
    height: 60,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  itemImageContent: {
    width: '100%',
    height: '100%',
  },
  itemDetails: {
    flex: 1,
    marginLeft: 12,
    marginRight: 8,
  },
  itemMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  divider: {
    marginVertical: 16,
  },
  summaryContainer: {
    gap: 10,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  totalRow: {
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.1)',
    marginTop: 4,
  },
  escrowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 16,
    marginBottom: 16,
  },
  escrowIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  escrowContent: {
    flex: 1,
    marginLeft: 14,
  },
  deliverySummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  trackingList: {
    gap: 12,
  },
  trackingEvent: {
    flexDirection: 'row',
    gap: 10,
  },
  trackingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 5,
  },
  returnCard: {
    padding: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.04)',
    marginBottom: 10,
  },
  starRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  photoRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  reviewPhoto: {
    width: 58,
    height: 58,
    borderRadius: 10,
  },
  disputeCard: {
    padding: 16,
    borderRadius: 16,
    marginBottom: 16,
  },
  disputeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  disputeIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  disputeHeaderText: {
    flex: 1,
    marginLeft: 12,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  disputeStatusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  disputeFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.1)',
  },
  resolutionBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderRadius: 8,
    marginTop: 12,
  },
  addressContent: {
    paddingLeft: 4,
  },
  phoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.05)',
  },
  adminMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  adminNote: {
    marginTop: 8,
    lineHeight: 20,
  },
  adminActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 16,
  },
  actions: {
    gap: 12,
    marginTop: 8,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 14,
    gap: 10,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  outlineButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 2,
    gap: 8,
  },
  outlineButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  paymentStatusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
  },
  paymentModal: {
    margin: 20,
    borderRadius: 24,
    maxHeight: '85%',
  },
  simpleModal: {
    margin: 20,
    borderRadius: 20,
    padding: 18,
  },
  paymentModalContent: {
    padding: 24,
    paddingBottom: 24,
  },
  modalInput: {
    marginTop: 12,
  },
  modalActionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 10,
    marginTop: 16,
  },
  reasonGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginVertical: 12,
  },
  reasonChip: {
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  paymentModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  paymentAmountBox: {
    alignItems: 'center',
    paddingVertical: 20,
    marginBottom: 20,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.03)',
  },
  paymentMethodsRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 20,
  },
  paymentMethodCard: {
    flex: 1,
    alignItems: 'center',
    padding: 16,
    borderRadius: 14,
    borderWidth: 2,
  },
  mobileMoneySection: {
    marginBottom: 20,
    overflow: 'hidden',
  },
  phoneInput: {
    backgroundColor: 'transparent',
  },
  providerRow: {
    flexDirection: 'row',
    gap: 10,
  },
  providerButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
  },
  providerText: {
    fontWeight: '700',
    fontSize: 13,
  },
  cardSection: {
    marginBottom: 20,
    overflow: 'hidden',
  },
  cardInfoBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 14,
    borderRadius: 12,
  },
  payNowButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 14,
    gap: 10,
  },
  payNowButtonText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
  },
  securityNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
    paddingBottom: 8,
  },
});
