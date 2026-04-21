import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery } from 'convex/react';
import { LinearGradient } from 'expo-linear-gradient';
import { MotiView } from 'moti';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import {
  Button,
  Divider,
  Modal,
  Portal,
  Surface,
  Text,
  TextInput,
  useTheme
} from 'react-native-paper';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { StackHeader } from '../../components/ui/Header';
import { useAppAuth } from '../../context/AuthProvider';
import { useGuestCart } from '../../context/GuestCartProvider';
import { calculateDisplayPrice, getPlatformFeeExplanation, useOrderTotal } from '../../hooks/useOrderTotal';
import { detectProvider, formatZambianPhoneNumber, getProviderColor, usePayment } from '../../hooks/usePayment';
import { useWallet } from '../../hooks/useWallet';
import { MobileMoneyProvider } from '../../services/payments';
import { formatWalletAmount } from '../../services/wallet';
import { formatPrice } from '../../theme';
import type { Id, RootStackParamList } from '../../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Checkout'>;

interface CartItem {
  _id: Id<'cartItems'>;
  quantity: number;
  selectedShipping: { name: string; price: number };
  product: {
    _id: Id<'products'>;
    title: string;
    price: number;
    images: string[];
    quantity: number;
    status: string;
    sellerId: Id<'users'>;
    sellerName: string;
  };
}

type PaymentMethodType = 'wallet' | 'mobile_money' | 'card';

export default function CheckoutScreen({ navigation }: Props) {
  const theme = useTheme();
  const { user } = useAppAuth();
  const { hasPendingMerge, isMerging } = useGuestCart();
  const [loading, setLoading] = useState(false);

  // Shipping address form
  const [address, setAddress] = useState({
    street: user?.address?.street || '',
    city: user?.address?.city || '',
    province: user?.address?.province || '',
    country: 'Zambia',
    phone: user?.phone || '',
  });

  // Wallet hook
  const {
    balance: walletBalance,
    payWithWallet,
    isLoading: walletLoading,
  } = useWallet();

  // Cart data
  const cart = useQuery(
    api.cart.getCart,
    user ? { userId: user._id } : 'skip'
  );

  const createOrder = useMutation(api.orders.createOrder);
  const clearCart = useMutation(api.cart.clearCart);

  const cartItems = cart?.items as CartItem[] | undefined;

  // Apply 5% markup to subtotal (service fee is included in displayed prices)
  const baseSubtotal = cart?.subtotal || 0;
  const subtotal = calculateDisplayPrice(baseSubtotal);
  const shipping = cart?.shippingTotal || 0;

  // Calculate order total (subtotal already includes the 5% fee)
  const orderTotal = useOrderTotal(subtotal, shipping);

  // Payment method - default to wallet if sufficient balance
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodType>('mobile_money');
  const [mobileNumber, setMobileNumber] = useState(user?.phone || '');
  const [mobileProvider, setMobileProvider] = useState<MobileMoneyProvider | null>(null);
  const [showProviderModal, setShowProviderModal] = useState(false);
  const [showFeeInfo, setShowFeeInfo] = useState(false);

  // Check if wallet has sufficient balance
  const canUseWallet = walletBalance?.hasWallet &&
    !walletBalance?.isFrozen &&
    walletBalance.balance >= (orderTotal?.totalAmount || 0);

  // Payment hook
  const {
    isLoading: paymentLoading,
    isPending: paymentPending,
    status: paymentStatus,
    error: paymentError,
    payWithMobileMoney,
    payWithCard,
  } = usePayment({
    onSuccess: () => {
      Alert.alert(
        'Payment Successful!',
        'Your payment has been processed. The funds are now held in escrow until delivery.',
        [
          {
            text: 'View Orders',
            onPress: () => navigation.replace('Main', { screen: 'Orders' } as never),
          },
        ]
      );
    },
    onError: (error) => {
      Alert.alert('Payment Failed', error.message);
    },
  });

  // Auto-detect provider from phone number
  const handlePhoneChange = (text: string) => {
    setMobileNumber(text);
    const detected = detectProvider(text);
    if (detected) {
      setMobileProvider(detected);
    }
  };

  const validateAddress = () => {
    if (!address.street.trim()) return 'Please enter your street address';
    if (!address.city.trim()) return 'Please enter your city';
    if (!address.province.trim()) return 'Please enter your province';
    if (!address.phone.trim()) return 'Please enter your phone number';
    return null;
  };

  const validatePayment = () => {
    if (paymentMethod === 'wallet') {
      if (!walletBalance?.hasWallet) return 'You need a wallet to use this payment method';
      if (walletBalance?.isFrozen) return 'Your wallet is frozen. Please contact support.';
      if (walletBalance.balance < orderTotal.totalAmount) {
        return `Insufficient wallet balance. You have ${formatWalletAmount(walletBalance.balance)} but need ${formatWalletAmount(orderTotal.totalAmount)}`;
      }
    } else if (paymentMethod === 'mobile_money') {
      if (!mobileNumber.trim()) return 'Please enter your mobile money number';
      if (!mobileProvider) return 'Please select your mobile money provider';
    }
    return null;
  };

  const handlePlaceOrder = async () => {
    if (!user || !cartItems || cartItems.length === 0) return;

    const addressError = validateAddress();
    if (addressError) {
      Alert.alert('Missing Information', addressError);
      return;
    }

    const paymentError = validatePayment();
    if (paymentError) {
      Alert.alert('Payment Information', paymentError);
      return;
    }

    setLoading(true);

    try {
      // Group items by seller
      const itemsBySeller = new Map<string, CartItem[]>();
      cartItems.forEach((item: CartItem) => {
        if (item.product) {
          const sellerId = item.product.sellerId;
          if (!itemsBySeller.has(sellerId)) {
            itemsBySeller.set(sellerId, []);
          }
          itemsBySeller.get(sellerId)!.push(item);
        }
      });

      // Create orders for each seller
      const orderIds: string[] = [];
      for (const [sellerId, items] of itemsBySeller) {
        const orderItems = items.map((item) => ({
          productId: item.product!._id,
          title: item.product!.title,
          price: item.product!.price,
          quantity: item.quantity,
          image: item.product!.images[0] || '',
        }));

        const orderSubtotal = items.reduce(
          (sum, item) => sum + item.product!.price * item.quantity,
          0
        );
        const orderShipping = items.reduce(
          (sum, item) => sum + (item.selectedShipping?.price || 0),
          0
        );

        // Backend calculates platformFee and totalAmount
        const orderId = await createOrder({
          buyerId: user._id,
          sellerId: sellerId as Id<'users'>,
          items: orderItems,
          subtotal: orderSubtotal,
          shippingCost: orderShipping,
          shippingAddress: address,
        });

        orderIds.push(orderId);
      }

      // Clear cart
      await clearCart({ userId: user._id });

      // Process payment for first order (simplified - in real app, handle multiple orders)
      const primaryOrderId = orderIds[0];

      if (paymentMethod === 'wallet') {
        // Pay with wallet
        const result = await payWithWallet(primaryOrderId, orderTotal.totalAmount);
        Alert.alert(
          'Payment Successful!',
          `Paid ${formatWalletAmount(orderTotal.totalAmount)} from your wallet. New balance: ${formatWalletAmount(result.newBalance)}`,
          [
            {
              text: 'View Orders',
              onPress: () => navigation.replace('Main', { screen: 'Orders' } as never),
            },
          ]
        );
      } else if (paymentMethod === 'mobile_money' && mobileProvider) {
        await payWithMobileMoney({
          orderId: primaryOrderId,
          userId: user._id,
          amount: orderTotal.totalAmount,
          provider: mobileProvider,
          mobileNumber: formatZambianPhoneNumber(mobileNumber),
          description: `Payment for order`,
        });
      } else if (paymentMethod === 'card') {
        await payWithCard({
          orderId: primaryOrderId,
          userId: user._id,
          amount: orderTotal.totalAmount,
          email: user.email,
          description: `Payment for order`,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to place order';
      Alert.alert('Error', errorMessage);
    } finally {
      setLoading(false);
    }
  };

  if (!user) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Checkout" onBackPress={() => navigation.goBack()} />
        <View style={styles.centered}>
          <Icon name="account-alert" size={64} color={theme.colors.onSurfaceVariant} />
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 16 }}>
            Please sign in to checkout
          </Text>
        </View>
      </View>
    );
  }

  if (hasPendingMerge || isMerging || cart === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Checkout" onBackPress={() => navigation.goBack()} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </View>
    );
  }

  const isProcessing = loading || paymentLoading || paymentPending || walletLoading;

  return (
    <>
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Checkout" onBackPress={() => navigation.goBack()} />

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.container}
        >
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Shipping Address */}
            <Animated.View entering={FadeInDown.delay(100).duration(400)}>
              <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
                <View style={styles.sectionHeader}>
                  <View style={[styles.sectionIcon, { backgroundColor: theme.colors.primaryContainer }]}>
                    <Icon name="map-marker" size={20} color={theme.colors.primary} />
                  </View>
                  <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                    Shipping Address
                  </Text>
                </View>

                <TextInput
                  mode="outlined"
                  label="Street Address"
                  value={address.street}
                  onChangeText={(text) => setAddress({ ...address, street: text })}
                  style={styles.input}
                  outlineStyle={styles.inputOutline}
                  left={<TextInput.Icon icon="home" />}
                />
                <View style={styles.row}>
                  <TextInput
                    mode="outlined"
                    label="City"
                    value={address.city}
                    onChangeText={(text) => setAddress({ ...address, city: text })}
                    style={[styles.input, styles.halfInput]}
                    outlineStyle={styles.inputOutline}
                  />
                  <TextInput
                    mode="outlined"
                    label="Province"
                    value={address.province}
                    onChangeText={(text) => setAddress({ ...address, province: text })}
                    style={[styles.input, styles.halfInput]}
                    outlineStyle={styles.inputOutline}
                  />
                </View>
                <TextInput
                  mode="outlined"
                  label="Phone Number"
                  value={address.phone}
                  onChangeText={(text) => setAddress({ ...address, phone: text })}
                  keyboardType="phone-pad"
                  placeholder="+260..."
                  style={styles.input}
                  outlineStyle={styles.inputOutline}
                  left={<TextInput.Icon icon="phone" />}
                />
              </Surface>
            </Animated.View>

            {/* Payment Method */}
            <Animated.View entering={FadeInDown.delay(200).duration(400)}>
              <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
                <View style={styles.sectionHeader}>
                  <View style={[styles.sectionIcon, { backgroundColor: theme.colors.primaryContainer }]}>
                    <Icon name="credit-card" size={20} color={theme.colors.primary} />
                  </View>
                  <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                    Payment Method
                  </Text>
                </View>

                {/* Wallet Option (shown first if available) */}
                {walletBalance?.hasWallet && (
                  <Pressable
                    onPress={() => setPaymentMethod('wallet')}
                    style={[
                      styles.paymentOption,
                      {
                        backgroundColor: paymentMethod === 'wallet'
                          ? theme.colors.tertiaryContainer
                          : theme.colors.surfaceVariant,
                        borderColor: paymentMethod === 'wallet'
                          ? theme.colors.tertiary
                          : 'transparent',
                      },
                    ]}
                  >
                    <View style={[styles.radioOuter, { borderColor: theme.colors.tertiary }]}>
                      {paymentMethod === 'wallet' && (
                        <View style={[styles.radioInner, { backgroundColor: theme.colors.tertiary }]} />
                      )}
                    </View>
                    <View style={styles.paymentInfo}>
                      <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                        Wallet Balance
                      </Text>
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                        Available: {formatWalletAmount(walletBalance.balance)}
                      </Text>
                    </View>
                    <View style={styles.walletBadge}>
                      <Icon name="wallet" size={24} color={theme.colors.tertiary} />
                      {canUseWallet && (
                        <Icon name="check-circle" size={16} color="#10B981" style={{ marginLeft: 4 }} />
                      )}
                    </View>
                  </Pressable>
                )}

                {/* Insufficient Wallet Balance Warning */}
                {paymentMethod === 'wallet' && !canUseWallet && walletBalance?.hasWallet && (
                  <MotiView
                    from={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    transition={{
                      opacity: { type: 'timing', duration: 200 },
                      height: { type: 'timing', duration: 200 },
                    }}
                  >
                    <Surface style={[styles.walletWarning, { backgroundColor: theme.colors.errorContainer }]} elevation={0}>
                      <Icon name="alert-circle" size={20} color={theme.colors.error} />
                      <View style={{ marginLeft: 12, flex: 1 }}>
                        <Text variant="labelMedium" style={{ color: theme.colors.onErrorContainer }}>
                          Insufficient Balance
                        </Text>
                        <Text variant="bodySmall" style={{ color: theme.colors.onErrorContainer }}>
                          You need {formatWalletAmount(orderTotal.totalAmount - walletBalance.balance)} more.
                          Top up your wallet or use another payment method.
                        </Text>
                      </View>
                    </Surface>
                  </MotiView>
                )}

                {/* Mobile Money Option */}
                <Pressable
                  onPress={() => setPaymentMethod('mobile_money')}
                  style={[
                    styles.paymentOption,
                    {
                      backgroundColor: paymentMethod === 'mobile_money'
                        ? theme.colors.primaryContainer
                        : theme.colors.surfaceVariant,
                      borderColor: paymentMethod === 'mobile_money'
                        ? theme.colors.primary
                        : 'transparent',
                    },
                  ]}
                >
                  <View style={[styles.radioOuter, { borderColor: theme.colors.primary }]}>
                    {paymentMethod === 'mobile_money' && (
                      <View style={[styles.radioInner, { backgroundColor: theme.colors.primary }]} />
                    )}
                  </View>
                  <View style={styles.paymentInfo}>
                    <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                      Mobile Money
                    </Text>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      MTN, Airtel, or Zamtel
                    </Text>
                  </View>
                  <Icon name="cellphone" size={28} color={theme.colors.primary} />
                </Pressable>

                {/* Mobile Money Details */}
                {paymentMethod === 'mobile_money' && (
                  <MotiView
                    from={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    transition={{
                      opacity: { type: 'timing', duration: 200 },
                      height: { type: 'timing', duration: 200 },
                    }}
                    style={styles.mobileMoneyDetails}
                  >
                    <TextInput
                      mode="outlined"
                      label="Mobile Money Number"
                      value={mobileNumber}
                      onChangeText={handlePhoneChange}
                      keyboardType="phone-pad"
                      placeholder="097XXXXXXX"
                      style={styles.input}
                      outlineStyle={styles.inputOutline}
                      left={<TextInput.Icon icon="phone" />}
                    />

                    <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 8 }}>
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
                              backgroundColor: mobileProvider === provider
                                ? getProviderColor(provider)
                                : theme.colors.surfaceVariant,
                              borderColor: mobileProvider === provider
                                ? getProviderColor(provider)
                                : theme.colors.outline,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.providerText,
                              {
                                color: mobileProvider === provider ? '#FFFFFF' : theme.colors.onSurface,
                              },
                            ]}
                          >
                            {provider.toUpperCase()}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </MotiView>
                )}

                {/* Card Option */}
                <Pressable
                  onPress={() => setPaymentMethod('card')}
                  style={[
                    styles.paymentOption,
                    {
                      backgroundColor: paymentMethod === 'card'
                        ? theme.colors.primaryContainer
                        : theme.colors.surfaceVariant,
                      borderColor: paymentMethod === 'card'
                        ? theme.colors.primary
                        : 'transparent',
                    },
                  ]}
                >
                  <View style={[styles.radioOuter, { borderColor: theme.colors.primary }]}>
                    {paymentMethod === 'card' && (
                      <View style={[styles.radioInner, { backgroundColor: theme.colors.primary }]} />
                    )}
                  </View>
                  <View style={styles.paymentInfo}>
                    <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                      Card Payment
                    </Text>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      Visa or Mastercard
                    </Text>
                  </View>
                  <View style={styles.cardIcons}>
                    <Icon name="credit-card" size={24} color="#1A1F71" />
                    <Icon name="credit-card" size={24} color="#EB001B" style={{ marginLeft: 4 }} />
                  </View>
                </Pressable>
              </Surface>
            </Animated.View>

            {/* Order Summary */}
            <Animated.View entering={FadeInDown.delay(300).duration(400)}>
              <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
                <View style={styles.sectionHeader}>
                  <View style={[styles.sectionIcon, { backgroundColor: theme.colors.primaryContainer }]}>
                    <Icon name="receipt" size={20} color={theme.colors.primary} />
                  </View>
                  <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                    Order Summary
                  </Text>
                </View>

                {/* Items */}
                {cartItems && cartItems.map((item) => (
                  <View key={item._id} style={styles.orderItem}>
                    <Text
                      variant="bodyMedium"
                      style={{ color: theme.colors.onSurface, flex: 1 }}
                      numberOfLines={1}
                    >
                      {item.product?.title || 'Product'}
                    </Text>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      ×{item.quantity}
                    </Text>
                    <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, marginLeft: 16, fontWeight: '600' }}>
                      {item.product ? formatPrice(calculateDisplayPrice(item.product.price) * item.quantity) : 'N/A'}
                    </Text>
                  </View>
                ))}

                <Divider style={styles.divider} />

                {/* Breakdown */}
                <View style={styles.summaryRow}>
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                    Subtotal
                  </Text>
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                    {formatPrice(orderTotal.subtotal)}
                  </Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                    Shipping
                  </Text>
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                    {orderTotal.shippingCost > 0 ? formatPrice(orderTotal.shippingCost) : 'Free'}
                  </Text>
                </View>

                {/* Total */}
                <View style={[styles.summaryRow, styles.totalRow]}>
                  <View>
                    <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                      Total
                    </Text>
                    <Pressable onPress={() => setShowFeeInfo(true)} style={styles.feeNote}>
                      <Text variant="labelSmall" style={{ color: theme.colors.primary }}>
                        Includes service fee
                      </Text>
                      <Icon name="information-outline" size={12} color={theme.colors.primary} style={{ marginLeft: 2 }} />
                    </Pressable>
                  </View>
                  <Text variant="headlineSmall" style={{ color: theme.colors.primary, fontWeight: '800' }}>
                    {formatPrice(orderTotal.totalAmount)}
                  </Text>
                </View>
              </Surface>
            </Animated.View>

            {/* Escrow Info */}
            <Animated.View entering={FadeInDown.delay(400).duration(400)}>
              <LinearGradient
                colors={[theme.colors.secondaryContainer, theme.colors.tertiaryContainer]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.escrowCard}
              >
                <Icon name="shield-check" size={36} color={theme.colors.secondary} />
                <View style={styles.escrowText}>
                  <Text variant="titleSmall" style={{ color: theme.colors.onSecondaryContainer, fontWeight: '700' }}>
                    Secure Escrow Payment
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSecondaryContainer, marginTop: 4, opacity: 0.9 }}>
                    Your payment is held securely until you confirm delivery. This protects both buyers and the store.
                  </Text>
                </View>
              </LinearGradient>
            </Animated.View>

            {/* Payment Status */}
            {(paymentPending || paymentStatus) && (
              <Animated.View entering={FadeInDown.duration(300)}>
                <Surface style={[styles.statusCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
                  <View style={styles.statusContent}>
                    {paymentPending && (
                      <ActivityIndicator size="small" color={theme.colors.primary} style={{ marginRight: 12 }} />
                    )}
                    <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                      {paymentPending
                        ? 'Waiting for payment confirmation...'
                        : paymentStatus === 'successful'
                        ? 'Payment successful!'
                        : paymentStatus === 'failed'
                        ? 'Payment failed. Please try again.'
                        : `Status: ${paymentStatus}`}
                    </Text>
                  </View>
                </Surface>
              </Animated.View>
            )}

            {/* Place Order Button */}
            <Animated.View entering={FadeInUp.delay(500).duration(400)}>
              <Pressable
                onPress={handlePlaceOrder}
                disabled={isProcessing || !cartItems || cartItems.length === 0}
                style={({ pressed }) => [
                  { opacity: pressed ? 0.9 : 1 },
                  (isProcessing || !cartItems || cartItems.length === 0) && { opacity: 0.5 },
                ]}
              >
                <LinearGradient
                  colors={[theme.colors.primary, theme.colors.tertiary]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.placeOrderButton}
                >
                  {isProcessing ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <>
                      <Icon name="lock" size={22} color="#FFFFFF" />
                      <Text style={styles.placeOrderText}>
                        Pay {formatPrice(orderTotal.totalAmount)}
                      </Text>
                    </>
                  )}
                </LinearGradient>
              </Pressable>
            </Animated.View>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>

      {/* Fee Info Modal */}
      <Portal>
        <Modal
          visible={showFeeInfo}
          onDismiss={() => setShowFeeInfo(false)}
          contentContainerStyle={[styles.modal, { backgroundColor: theme.colors.surface }]}
        >
          <Icon name="information" size={48} color={theme.colors.primary} />
          <Text variant="titleLarge" style={{ color: theme.colors.onSurface, marginTop: 16, fontWeight: '700' }}>
            Service Fee
          </Text>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 12, textAlign: 'center', lineHeight: 22 }}>
            {getPlatformFeeExplanation()}
          </Text>
          <View style={styles.feeBreakdown}>
            <View style={styles.feeItem}>
              <Icon name="check-circle" size={20} color={theme.colors.secondary} />
              <Text variant="bodySmall" style={{ color: theme.colors.onSurface, marginLeft: 8 }}>
                Secure payment processing
              </Text>
            </View>
            <View style={styles.feeItem}>
              <Icon name="check-circle" size={20} color={theme.colors.secondary} />
              <Text variant="bodySmall" style={{ color: theme.colors.onSurface, marginLeft: 8 }}>
                Escrow protection
              </Text>
            </View>
            <View style={styles.feeItem}>
              <Icon name="check-circle" size={20} color={theme.colors.secondary} />
              <Text variant="bodySmall" style={{ color: theme.colors.onSurface, marginLeft: 8 }}>
                Dispute resolution support
              </Text>
            </View>
          </View>
          <Button mode="contained" onPress={() => setShowFeeInfo(false)} style={{ marginTop: 20 }}>
            Got it
          </Button>
        </Modal>
      </Portal>
    </>
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
  card: {
    marginBottom: 16,
    borderRadius: 16,
    padding: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  sectionIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sectionTitle: {
    marginLeft: 12,
    fontWeight: '700',
  },
  input: {
    marginBottom: 12,
    backgroundColor: 'transparent',
  },
  inputOutline: {
    borderRadius: 12,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
  },
  halfInput: {
    flex: 1,
  },
  paymentOption: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    marginBottom: 10,
    borderWidth: 2,
  },
  radioOuter: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  radioInner: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  paymentInfo: {
    flex: 1,
    marginLeft: 12,
  },
  cardIcons: {
    flexDirection: 'row',
  },
  mobileMoneyDetails: {
    paddingHorizontal: 4,
    paddingTop: 8,
    paddingBottom: 16,
    marginBottom: 8,
    overflow: 'hidden',
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
  orderItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  divider: {
    marginVertical: 12,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  feeNote: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  totalRow: {
    marginTop: 8,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.1)',
  },
  escrowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 16,
    marginBottom: 16,
  },
  escrowText: {
    flex: 1,
    marginLeft: 14,
  },
  statusCard: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  statusContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  placeOrderButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 18,
    borderRadius: 16,
    marginBottom: 16,
    gap: 10,
  },
  placeOrderText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  modal: {
    margin: 20,
    padding: 24,
    borderRadius: 20,
    alignItems: 'center',
  },
  feeBreakdown: {
    marginTop: 16,
    alignSelf: 'stretch',
  },
  feeItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 6,
  },
  walletBadge: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  walletWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    marginBottom: 12,
  },
});
