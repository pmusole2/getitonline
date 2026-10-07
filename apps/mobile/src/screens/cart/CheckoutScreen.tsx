import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery } from 'convex/react';
import React, { useMemo, useState } from 'react';
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
  Chip,
  Divider,
  Surface,
  Text,
  TextInput,
  useTheme,
} from 'react-native-paper';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { StackHeader } from '../../components/ui/Header';
import { useAppAuth } from '../../context/AuthProvider';
import { useGuestCart } from '../../context/GuestCartProvider';
import {
  detectProvider,
  formatZambianPhoneNumber,
  getProviderColor,
  usePayment,
} from '../../hooks/usePayment';
import { useWallet } from '../../hooks/useWallet';
import type { MobileMoneyProvider } from '../../services/payments';
import { formatWalletAmount } from '../../services/wallet';
import { formatPrice } from '../../theme';
import type { Id, RootStackParamList } from '../../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Checkout'>;
type PaymentMethodType = 'wallet' | 'mobile_money' | 'card' | 'bank_transfer';

type SellerCartGroup = {
  sellerId: string;
  sellerName: string;
  items: Array<{
    _id: string;
    productId: string;
    quantity: number;
    selectedShipping: { name: string; price: number };
    selectedVariant?: {
      variantId: string;
      sku: string;
      attributes: Array<{ name: string; value: string }>;
      price: number;
      image?: string;
    };
    selectedVariantOptions?: Array<{ name: string; value: string; sku?: string; priceDelta?: number }>;
    selectedAddOns?: Array<{ name: string; description?: string; price: number }>;
    customizationKey?: string;
    lineUnitPrice: number;
    product: {
      _id: string;
      title: string;
      price: number;
      images: string[];
      quantity: number;
      categoryId: string;
      subcategoryId?: string;
      classificationId?: string;
      weightKg?: number;
    };
  }>;
  subtotal: number;
  shippingTotal: number;
};

type DeliveryQuote = {
  methodId: Id<'deliveryMethods'>;
  name: string;
  code: string;
  type: 'standard' | 'express' | 'same_day' | 'pickup';
  fee: number;
  minDays: number;
  maxDays: number;
  courierName?: string;
};

const PLATFORM_FEE_PERCENTAGE = 0.05;
const LOYALTY_POINT_VALUE = 0.1;

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function platformFee(subtotalAfterDiscount: number) {
  return Math.ceil(subtotalAfterDiscount * PLATFORM_FEE_PERCENTAGE * 100) / 100;
}

function allocateAmount(amount: number, groupSubtotal: number, totalSubtotal: number) {
  if (amount <= 0 || totalSubtotal <= 0) return 0;
  return roundMoney(amount * (groupSubtotal / totalSubtotal));
}

export default function CheckoutScreen({ navigation }: Props) {
  const theme = useTheme();
  const { user } = useAppAuth();
  const { hasPendingMerge, isMerging } = useGuestCart();
  const [loading, setLoading] = useState(false);
  const [address, setAddress] = useState({
    street: user?.address?.street || '',
    city: user?.address?.city || '',
    province: user?.address?.province || '',
    country: 'Zambia',
    phone: user?.phone || '',
  });
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodType>('mobile_money');
  const [mobileNumber, setMobileNumber] = useState(user?.phone || '');
  const [mobileProvider, setMobileProvider] = useState<MobileMoneyProvider | null>(
    user?.phone ? detectProvider(user.phone) : null,
  );
  const [promoInput, setPromoInput] = useState('');
  const [promoCode, setPromoCode] = useState('');
  const [loyaltyPointsToUse, setLoyaltyPointsToUse] = useState('');
  const [selectedDeliveryMethodId, setSelectedDeliveryMethodId] = useState<string | null>(null);

  const sellerGroups = useQuery(
    api.cart.getCartBySeller,
    user ? { userId: user._id } : 'skip',
  ) as SellerCartGroup[] | undefined;
  const loyaltyAccount = useQuery(
    api.loyalty.getMyLoyaltyAccount,
    user ? { userId: user._id } : 'skip',
  );
  const deliveryQuote = useQuery(api.delivery.calculateDeliveryQuote, {
    city: address.city.trim() || undefined,
    province: address.province.trim() || undefined,
    subtotal: sellerGroups?.reduce((sum, group) => sum + group.subtotal, 0) ?? 0,
    weightKg:
      sellerGroups?.reduce(
        (sum, group) =>
          sum +
          group.items.reduce(
            (itemSum, item) => itemSum + (item.product.weightKg ?? 0) * item.quantity,
            0,
          ),
        0,
      ) ?? 0,
  }) as DeliveryQuote[] | undefined;

  const promoValidation = useQuery(
    api.promotions.validatePromoCode,
    user && promoCode.trim() && sellerGroups
      ? {
          code: promoCode.trim(),
          userId: user._id,
          subtotal: sellerGroups.reduce((sum, group) => sum + group.subtotal, 0),
          categoryIds: sellerGroups.flatMap((group) =>
            group.items.flatMap((item) =>
              [item.product.categoryId, item.product.subcategoryId, item.product.classificationId]
                .filter((id): id is string => Boolean(id))
                .map((id) => id as Id<'categories'>),
            ),
          ),
          productIds: sellerGroups.flatMap((group) =>
            group.items.map((item) => item.product._id as Id<'products'>),
          ),
        }
      : 'skip',
  );

  const createOrder = useMutation(api.orders.createOrder);
  const clearCart = useMutation(api.cart.clearCart);
  const recordPromoCodeRedemption = useMutation(api.promotions.recordPromoCodeRedemption);
  const redeemPoints = useMutation(api.loyalty.redeemPoints);
  const { balance: walletBalance, payWithWallet, isLoading: walletLoading } = useWallet();
  const {
    isLoading: paymentLoading,
    isPending: paymentPending,
    payWithMobileMoney,
    payWithCard,
    payCheckoutWithMobileMoney,
    payCheckoutWithCard,
  } = usePayment();

  const selectedDeliveryQuote = useMemo(() => {
    if (!deliveryQuote?.length) return null;
    return (
      deliveryQuote.find((quote) => quote.methodId === selectedDeliveryMethodId) ??
      deliveryQuote[0]
    );
  }, [deliveryQuote, selectedDeliveryMethodId]);

  const checkoutTotals = useMemo(() => {
    const groups = sellerGroups ?? [];
    const subtotal = groups.reduce((sum, group) => sum + group.subtotal, 0);
    const baseShipping = groups.reduce((sum, group) => sum + group.shippingTotal, 0);
    const shipping = selectedDeliveryQuote ? selectedDeliveryQuote.fee : baseShipping;
    const promoDiscount =
      promoValidation?.valid === true ? promoValidation.discountAmount ?? 0 : 0;
    const requestedPoints = Number.parseInt(loyaltyPointsToUse, 10);
    const usablePoints = Math.max(
      0,
      Math.min(
        Number.isFinite(requestedPoints) ? requestedPoints : 0,
        loyaltyAccount?.pointsBalance ?? 0,
      ),
    );
    const loyaltyDiscount = Math.min(subtotal - promoDiscount, usablePoints * LOYALTY_POINT_VALUE);
    const subtotalAfterDiscount = Math.max(0, subtotal - promoDiscount - loyaltyDiscount);
    const fee = platformFee(subtotalAfterDiscount);
    const total = subtotalAfterDiscount + shipping + fee;

    return {
      subtotal,
      shipping,
      baseShipping,
      promoDiscount,
      loyaltyDiscount,
      usablePoints,
      platformFee: fee,
      total,
    };
  }, [
    loyaltyAccount?.pointsBalance,
    loyaltyPointsToUse,
    promoValidation,
    selectedDeliveryQuote,
    sellerGroups,
  ]);

  const canUseWallet = Boolean(
    walletBalance?.hasWallet &&
      !walletBalance.isFrozen &&
      walletBalance.balance >= checkoutTotals.total,
  );
  const isProcessing = loading || walletLoading || paymentLoading || paymentPending;

  const handlePhoneChange = (value: string) => {
    setMobileNumber(value);
    const detected = detectProvider(value);
    if (detected) setMobileProvider(detected);
  };

  const validateCheckout = () => {
    if (!sellerGroups || sellerGroups.length === 0) return 'Your cart is empty.';
    if (!address.street.trim()) return 'Enter your street address.';
    if (!address.city.trim()) return 'Enter your city.';
    if (!address.province.trim()) return 'Enter your province.';
    if (!address.phone.trim()) return 'Enter your phone number.';
    if (paymentMethod === 'wallet' && !canUseWallet) return 'Your wallet balance is insufficient.';
    if (paymentMethod === 'mobile_money' && (!mobileNumber.trim() || !mobileProvider)) {
      return 'Enter a mobile money number and provider.';
    }
    return null;
  };

  const buildOrderBreakdown = (group: SellerCartGroup, index: number, totalGroups: number) => {
    const subtotal = group.subtotal;
    const shipping = selectedDeliveryQuote
      ? index === totalGroups - 1
        ? roundMoney(checkoutTotals.shipping - sellerGroups!.slice(0, index).reduce(
            (sum, previous) =>
              sum + allocateAmount(checkoutTotals.shipping, previous.subtotal, checkoutTotals.subtotal),
            0,
          ))
        : allocateAmount(checkoutTotals.shipping, subtotal, checkoutTotals.subtotal)
      : group.shippingTotal;
    const promoDiscount = allocateAmount(checkoutTotals.promoDiscount, subtotal, checkoutTotals.subtotal);
    const loyaltyDiscount = allocateAmount(checkoutTotals.loyaltyDiscount, subtotal, checkoutTotals.subtotal);
    const discount = Math.min(subtotal, promoDiscount + loyaltyDiscount);
    const subtotalAfterDiscount = Math.max(0, subtotal - discount);
    const fee = platformFee(subtotalAfterDiscount);

    return {
      subtotal,
      shipping,
      discount,
      fee,
      total: subtotalAfterDiscount + shipping + fee,
    };
  };

  const handlePlaceOrder = async () => {
    if (!user || !sellerGroups) return;

    const validationMessage = validateCheckout();
    if (validationMessage) {
      Alert.alert('Checkout incomplete', validationMessage);
      return;
    }

    setLoading(true);

    try {
      const createdOrders: Array<{ orderId: string; amount: number }> = [];
      const firstPromoOrderIds: string[] = [];

      for (const [index, group] of sellerGroups.entries()) {
        const breakdown = buildOrderBreakdown(group, index, sellerGroups.length);
        const orderId = await createOrder({
          buyerId: user._id,
          sellerId: group.sellerId as Id<'users'>,
          items: group.items.map((item) => ({
            productId: item.product._id as Id<'products'>,
            title: item.product.title,
            price: item.lineUnitPrice,
            quantity: item.quantity,
            image: item.selectedVariant?.image || item.product.images[0] || '',
            selectedVariant: item.selectedVariant,
            selectedVariantOptions: item.selectedVariantOptions,
            selectedAddOns: item.selectedAddOns,
            customizationKey: item.customizationKey,
          })),
          subtotal: breakdown.subtotal,
          discountAmount: breakdown.discount,
          promoCodeId:
            promoValidation?.valid === true ? promoValidation.promoCodeId : undefined,
          promoCode: promoValidation?.valid === true ? promoValidation.code : undefined,
          shippingCost: breakdown.shipping,
          deliveryMethodId: selectedDeliveryQuote?.methodId,
          deliveryMethodName: selectedDeliveryQuote?.name,
          deliveryEta: selectedDeliveryQuote
            ? {
                minDays: selectedDeliveryQuote.minDays,
                maxDays: selectedDeliveryQuote.maxDays,
              }
            : undefined,
          shippingAddress: address,
        });

        createdOrders.push({ orderId, amount: breakdown.total });
        if (index === 0) firstPromoOrderIds.push(orderId);
      }

      if (
        promoValidation?.valid === true &&
        promoValidation.promoCodeId &&
        firstPromoOrderIds[0]
      ) {
        await recordPromoCodeRedemption({
          promoCodeId: promoValidation.promoCodeId,
          userId: user._id,
          orderId: firstPromoOrderIds[0] as Id<'orders'>,
          discountAmount: checkoutTotals.promoDiscount,
        });
      }

      if (checkoutTotals.usablePoints > 0) {
        await redeemPoints({
          userId: user._id,
          points: checkoutTotals.usablePoints,
          reason: 'Checkout loyalty redemption',
          orderId: createdOrders[0]?.orderId as Id<'orders'> | undefined,
        });
      }

      if (paymentMethod === 'wallet') {
        for (const order of createdOrders) {
          await payWithWallet(order.orderId, order.amount);
        }
      } else if (paymentMethod === 'mobile_money' && mobileProvider) {
        if (createdOrders.length > 1) {
          await payCheckoutWithMobileMoney({
            orderIds: createdOrders.map((order) => order.orderId),
            userId: user._id,
            amount: checkoutTotals.total,
            provider: mobileProvider,
            mobileNumber: formatZambianPhoneNumber(mobileNumber),
            description: `Getitonline checkout payment for ${createdOrders.length} seller orders`,
          });
        } else {
          const [order] = createdOrders;
          await payWithMobileMoney({
            orderId: order.orderId,
            userId: user._id,
            amount: order.amount,
            provider: mobileProvider,
            mobileNumber: formatZambianPhoneNumber(mobileNumber),
            description: 'Getitonline order payment',
          });
        }
      } else if (paymentMethod === 'card') {
        if (createdOrders.length > 1) {
          await payCheckoutWithCard({
            orderIds: createdOrders.map((order) => order.orderId),
            userId: user._id,
            amount: checkoutTotals.total,
            email: user.email,
            description: `Getitonline checkout payment for ${createdOrders.length} seller orders`,
          });
        } else {
          const [order] = createdOrders;
          await payWithCard({
            orderId: order.orderId,
            userId: user._id,
            amount: order.amount,
            email: user.email,
            description: 'Getitonline card payment',
          });
        }
      } else {
        Alert.alert(
          'Bank transfer order created',
          'Your orders are pending payment. Bank transfer instructions will be sent by support.',
        );
      }

      await clearCart({ userId: user._id });
      Alert.alert('Checkout created', 'Your seller orders were created with separate delivery and payment tracking.', [
        { text: 'View Orders', onPress: () => navigation.replace('Main', { screen: 'Orders' } as never) },
      ]);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to place order';
      Alert.alert('Checkout failed', message);
    } finally {
      setLoading(false);
    }
  };

  if (!user) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Checkout" onBackPress={() => navigation.goBack()} />
        <View style={styles.centered}>
          <Icon name="account-alert" size={56} color={theme.colors.onSurfaceVariant} />
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 16 }}>
            Please sign in to checkout
          </Text>
        </View>
      </View>
    );
  }

  if (hasPendingMerge || isMerging || sellerGroups === undefined || deliveryQuote === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Checkout" onBackPress={() => navigation.goBack()} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader title="Checkout" subtitle="Delivery, promo, payment" onBackPress={() => navigation.goBack()} variant="gradient" />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.container}
      >
        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
            <SectionTitle icon="map-marker-outline" title="Delivery Address" />
            <TextInput label="Street address" mode="outlined" value={address.street} onChangeText={(street) => setAddress((current) => ({ ...current, street }))} style={styles.input} />
            <View style={styles.row}>
              <TextInput label="City" mode="outlined" value={address.city} onChangeText={(city) => setAddress((current) => ({ ...current, city }))} style={styles.flexInput} />
              <TextInput label="Province" mode="outlined" value={address.province} onChangeText={(province) => setAddress((current) => ({ ...current, province }))} style={styles.flexInput} />
            </View>
            <TextInput label="Phone" mode="outlined" value={address.phone} onChangeText={(phone) => setAddress((current) => ({ ...current, phone }))} keyboardType="phone-pad" style={styles.input} />
          </Surface>

          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
            <SectionTitle icon="truck-fast-outline" title="Delivery Option" />
            <View style={styles.chipWrap}>
              {deliveryQuote.length > 0 ? (
                deliveryQuote.map((quote) => (
                  <Chip
                    key={quote.methodId}
                    selected={selectedDeliveryQuote?.methodId === quote.methodId}
                    onPress={() => setSelectedDeliveryMethodId(quote.methodId)}
                  >
                    {quote.name} • {quote.fee > 0 ? formatPrice(quote.fee) : 'Free'}
                  </Chip>
                ))
              ) : (
                <Chip selected>Seller delivery defaults</Chip>
              )}
            </View>
            {selectedDeliveryQuote ? (
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                ETA {selectedDeliveryQuote.minDays}-{selectedDeliveryQuote.maxDays} days
                {selectedDeliveryQuote.courierName ? ` via ${selectedDeliveryQuote.courierName}` : ''}
              </Text>
            ) : null}
          </Surface>

          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
            <SectionTitle icon="ticket-percent-outline" title="Promos and Loyalty" />
            <View style={styles.row}>
              <TextInput
                label="Promo code"
                mode="outlined"
                value={promoInput}
                onChangeText={setPromoInput}
                autoCapitalize="characters"
                style={styles.flexInput}
              />
              <Button mode="contained-tonal" onPress={() => setPromoCode(promoInput.trim().toUpperCase())} style={styles.applyButton}>
                Apply
              </Button>
            </View>
            {promoCode ? (
              <Text
                variant="bodySmall"
                style={{ color: promoValidation?.valid ? theme.colors.secondary : theme.colors.error }}
              >
                {promoValidation === undefined
                  ? 'Checking promo code...'
                  : promoValidation.valid
                    ? `${promoValidation.title}: ${formatPrice(promoValidation.discountAmount ?? 0)} off`
                    : promoValidation.reason}
              </Text>
            ) : null}
            <View style={styles.row}>
              <TextInput
                label={`Loyalty points (${loyaltyAccount?.pointsBalance ?? 0} available)`}
                mode="outlined"
                value={loyaltyPointsToUse}
                onChangeText={setLoyaltyPointsToUse}
                keyboardType="number-pad"
                style={styles.flexInput}
              />
            </View>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Loyalty value: {formatPrice(LOYALTY_POINT_VALUE)} per point.
            </Text>
          </Surface>

          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
            <SectionTitle icon="storefront-outline" title="Seller Orders" />
            <View style={styles.groupList}>
              {sellerGroups.map((group, index) => {
                const breakdown = buildOrderBreakdown(group, index, sellerGroups.length);
                return (
                  <Surface key={group.sellerId} style={[styles.sellerGroup, { backgroundColor: theme.colors.surfaceVariant }]} elevation={0}>
                    <View style={styles.groupHeader}>
                      <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                        {group.sellerName}
                      </Text>
                      <Text variant="titleSmall" style={{ color: theme.colors.primary }}>
                        {formatPrice(breakdown.total)}
                      </Text>
                    </View>
                    {group.items.map((item) => (
                      <View key={item._id} style={styles.itemRow}>
                        <View style={{ flex: 1 }}>
                          <Text variant="bodySmall" style={{ color: theme.colors.onSurface }} numberOfLines={1}>
                            {item.product.title}
                          </Text>
                          {item.selectedVariantOptions && item.selectedVariantOptions.length > 0 ? (
                            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }} numberOfLines={1}>
                              {item.selectedVariantOptions.map((option) => `${option.name}: ${option.value}`).join(' • ')}
                            </Text>
                          ) : null}
                          {item.selectedVariant?.attributes && item.selectedVariant.attributes.length > 0 ? (
                            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }} numberOfLines={1}>
                              {item.selectedVariant.attributes.map((attribute) => `${attribute.name}: ${attribute.value}`).join(' • ')}
                            </Text>
                          ) : null}
                          {item.selectedVariant?.sku ? (
                            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }} numberOfLines={1}>
                              SKU: {item.selectedVariant.sku}
                            </Text>
                          ) : null}
                          {item.selectedAddOns && item.selectedAddOns.length > 0 ? (
                            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }} numberOfLines={1}>
                              Add-ons: {item.selectedAddOns.map((addOn) => addOn.name).join(', ')}
                            </Text>
                          ) : null}
                        </View>
                        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                          x{item.quantity}
                        </Text>
                        <Text variant="bodySmall" style={{ color: theme.colors.onSurface }}>
                          {formatPrice(item.lineUnitPrice * item.quantity)}
                        </Text>
                      </View>
                    ))}
                    <Divider style={styles.divider} />
                    <SummaryRow label="Delivery" value={formatPrice(breakdown.shipping)} />
                    <SummaryRow label="Discount" value={breakdown.discount > 0 ? `-${formatPrice(breakdown.discount)}` : formatPrice(0)} />
                    <SummaryRow label="Platform fee" value={formatPrice(breakdown.fee)} />
                  </Surface>
                );
              })}
            </View>
          </Surface>

          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
            <SectionTitle icon="credit-card-outline" title="Payment Method" />
            <View style={styles.paymentGrid}>
              {(['mobile_money', 'wallet', 'card', 'bank_transfer'] as PaymentMethodType[]).map((method) => (
                <Pressable
                  key={method}
                  onPress={() => setPaymentMethod(method)}
                  style={[
                    styles.paymentOption,
                    {
                      backgroundColor: paymentMethod === method ? theme.colors.primaryContainer : theme.colors.surfaceVariant,
                      borderColor: paymentMethod === method ? theme.colors.primary : 'transparent',
                    },
                  ]}
                >
                  <Icon name={getPaymentIcon(method)} size={24} color={paymentMethod === method ? theme.colors.primary : theme.colors.onSurfaceVariant} />
                  <Text variant="labelMedium" style={{ color: paymentMethod === method ? theme.colors.primary : theme.colors.onSurface, marginTop: 6, textAlign: 'center' }}>
                    {method.replace(/_/g, ' ')}
                  </Text>
                </Pressable>
              ))}
            </View>
            {paymentMethod === 'wallet' && walletBalance?.hasWallet ? (
              <Text variant="bodySmall" style={{ color: canUseWallet ? theme.colors.secondary : theme.colors.error }}>
                Wallet balance: {formatWalletAmount(walletBalance.balance)}
              </Text>
            ) : null}
            {paymentMethod === 'mobile_money' ? (
              <>
                <TextInput label="Mobile money number" mode="outlined" value={mobileNumber} onChangeText={handlePhoneChange} keyboardType="phone-pad" style={styles.input} />
                <View style={styles.chipWrap}>
                  {(['mtn', 'airtel', 'zamtel'] as MobileMoneyProvider[]).map((provider) => (
                    <Chip
                      key={provider}
                      selected={mobileProvider === provider}
                      onPress={() => setMobileProvider(provider)}
                      style={mobileProvider === provider ? { backgroundColor: getProviderColor(provider) } : undefined}
                      textStyle={mobileProvider === provider ? { color: '#FFFFFF' } : undefined}
                    >
                      {provider.toUpperCase()}
                    </Chip>
                  ))}
                </View>
              </>
            ) : null}
          </Surface>

          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
            <SectionTitle icon="receipt-text-outline" title="Checkout Summary" />
            <SummaryRow label="Subtotal" value={formatPrice(checkoutTotals.subtotal)} />
            <SummaryRow label="Delivery" value={formatPrice(checkoutTotals.shipping)} />
            <SummaryRow label="Promo discount" value={`-${formatPrice(checkoutTotals.promoDiscount)}`} />
            <SummaryRow label="Loyalty discount" value={`-${formatPrice(checkoutTotals.loyaltyDiscount)}`} />
            <SummaryRow label="Platform fee" value={formatPrice(checkoutTotals.platformFee)} />
            <Divider style={styles.divider} />
            <SummaryRow label="Total" value={formatPrice(checkoutTotals.total)} emphatic />
            {sellerGroups.length > 1 ? (
              <Surface style={[styles.noticeCard, { backgroundColor: theme.colors.secondaryContainer }]} elevation={0}>
                <Icon name="information-outline" size={20} color={theme.colors.secondary} />
                <Text variant="bodySmall" style={{ color: theme.colors.onSecondaryContainer, flex: 1 }}>
                  This cart contains {sellerGroups.length} sellers. Mobile creates one tracked order per seller and uses one aggregate MTN/Airtel/card payment reference for the full checkout.
                </Text>
              </Surface>
            ) : null}
          </Surface>

          <Button
            mode="contained"
            disabled={isProcessing || sellerGroups.length === 0}
            loading={isProcessing}
            onPress={() => void handlePlaceOrder()}
            icon="lock-check-outline"
            style={styles.payButton}
            contentStyle={styles.payButtonContent}
          >
            Pay {formatPrice(checkoutTotals.total)}
          </Button>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function SectionTitle({ icon, title }: { icon: string; title: string }) {
  const theme = useTheme();
  return (
    <View style={styles.sectionTitleRow}>
      <Icon name={icon} size={22} color={theme.colors.primary} />
      <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
        {title}
      </Text>
    </View>
  );
}

function SummaryRow({ label, value, emphatic }: { label: string; value: string; emphatic?: boolean }) {
  const theme = useTheme();
  return (
    <View style={styles.summaryRow}>
      <Text variant={emphatic ? 'titleMedium' : 'bodyMedium'} style={{ color: emphatic ? theme.colors.onSurface : theme.colors.onSurfaceVariant }}>
        {label}
      </Text>
      <Text variant={emphatic ? 'titleLarge' : 'bodyMedium'} style={{ color: emphatic ? theme.colors.primary : theme.colors.onSurface, fontWeight: emphatic ? '800' : '500' }}>
        {value}
      </Text>
    </View>
  );
}

function getPaymentIcon(method: PaymentMethodType) {
  switch (method) {
    case 'wallet':
      return 'wallet-outline';
    case 'mobile_money':
      return 'cellphone';
    case 'card':
      return 'credit-card-outline';
    case 'bank_transfer':
      return 'bank-transfer';
    default:
      return 'cash';
  }
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
    paddingBottom: 40,
    gap: 16,
  },
  card: {
    borderRadius: 18,
    padding: 16,
    gap: 14,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  input: {
    width: '100%',
  },
  row: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  flexInput: {
    flex: 1,
  },
  applyButton: {
    alignSelf: 'stretch',
    justifyContent: 'center',
    marginTop: 6,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  groupList: {
    gap: 12,
  },
  sellerGroup: {
    borderRadius: 16,
    padding: 14,
    gap: 8,
  },
  groupHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  divider: {
    marginVertical: 4,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 16,
    alignItems: 'center',
  },
  paymentGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  paymentOption: {
    width: '47%',
    minHeight: 92,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
  },
  noticeCard: {
    borderRadius: 14,
    padding: 12,
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
  },
  payButton: {
    borderRadius: 14,
  },
  payButtonContent: {
    paddingVertical: 8,
  },
});
