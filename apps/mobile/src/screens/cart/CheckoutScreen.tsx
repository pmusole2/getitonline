import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useConvexAuth, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
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
import { Button, Chip, Divider, Surface, Text, TextInput, useTheme } from 'react-native-paper';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { AccountAccessNotice } from '../../components/auth/AccountAccessNotice';
import { useAccountAccess } from '../../components/auth/useAccountAccess';
import { StackHeader } from '../../components/ui/Header';
import { useAppAuth } from '../../context/AuthProvider';
import { useGuestCart } from '../../context/GuestCartProvider';
import { detectProvider, getProviderColor, usePayment } from '../../hooks/usePayment';
import { usePaymentAvailability } from '../../hooks/usePaymentAvailability';
import { useWallet } from '../../hooks/useWallet';
import { checkoutPoints, type CheckoutSelectors } from '../../services/checkoutOperationState';
import type { MobileMoneyProvider } from '../../services/payments';
import { formatWalletAmount } from '../../services/wallet';
import { storedMajorAmountCents } from '../../services/walletOperationState';
import { formatPrice } from '../../theme';
import type { RootStackParamList } from '../../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Checkout'>;
type PaymentMethodType = 'wallet' | 'mobile_money';

export default function CheckoutScreen(props: Props) {
  const access = useAccountAccess();
  const { user, clerkUser } = useAppAuth();
  const convexAuth = useConvexAuth();
  const verified =
    convexAuth.isAuthenticated && !convexAuth.isLoading && clerkUser?.id === user?.clerkId && Boolean(clerkUser?.id);

  if (access.status !== 'ready' || !user || !verified) {
    return (
      <AccountAccessNotice
        access={
          access.status === 'ready' && !verified
            ? { ...access, status: convexAuth.isLoading ? 'loading' : 'recovery' }
            : access
        }
        title="Checkout"
      />
    );
  }

  return <CheckoutContent key={user._id} {...props} user={user} />;
}

function CheckoutContent({ navigation, user }: Props & { user: NonNullable<ReturnType<typeof useAppAuth>['user']> }) {
  const theme = useTheme();
  const { hasPendingMerge, isMerging, isHydrated, mergeFailed } = useGuestCart();
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
  const [selectedDeliveryMethodId, setSelectedDeliveryMethodId] = useState<
    FunctionReturnType<typeof api.delivery.listDeliveryMethods>[number]['_id'] | null
  >(null);

  const [pickupPointId, setPickupPointId] = useState<
    FunctionReturnType<typeof api.delivery.listPickupPoints>[number]['_id'] | null
  >(null);
  const sellerGroups = useQuery(api.cart.getCartBySeller, user ? {} : 'skip');
  const loyaltyAccount = useQuery(api.loyalty.getMyLoyaltyAccount, {});
  const deliveryQuote = useQuery(api.delivery.calculateDeliveryQuote, {
    city: address.city.trim() || undefined,
    province: address.province.trim() || undefined,
    subtotal: sellerGroups?.reduce((sum, group) => sum + group.subtotal, 0) ?? 0,
    weightKg:
      sellerGroups?.reduce(
        (sum, group) =>
          sum + group.items.reduce((itemSum, item) => itemSum + (item.product.weightKg ?? 0) * item.quantity, 0),
        0,
      ) ?? 0,
  });

  const methods = useQuery(api.delivery.listDeliveryMethods, {});
  const selectedMethod = methods?.find((method) => method._id === selectedDeliveryMethodId && method.isActive);
  const selectedDeliveryQuote = deliveryQuote?.find((entry) => entry.methodId === selectedDeliveryMethodId);
  const points = useQuery(
    api.delivery.listPickupPoints,
    selectedMethod?.type === 'pickup' ? (selectedMethod.zoneId ? { zoneId: selectedMethod.zoneId } : {}) : 'skip',
  );
  const selectedPoint = points?.find(
    (point) =>
      point._id === pickupPointId &&
      point.isActive &&
      (selectedMethod?.zoneId === undefined || point.zoneId === selectedMethod.zoneId),
  );
  const loyaltyPoints = checkoutPoints(loyaltyPointsToUse);
  const deliveryValid =
    methods !== undefined &&
    deliveryQuote !== undefined &&
    (selectedDeliveryMethodId
      ? Boolean(selectedMethod && selectedDeliveryQuote && (selectedMethod.type !== 'pickup' || selectedPoint))
      : deliveryQuote.length === 0);
  const selectors: CheckoutSelectors | null =
    deliveryValid && loyaltyPoints !== null && Object.values(address).every((value) => value.trim().length > 0)
      ? {
          source: 'cart',
          shippingAddress: {
            street: address.street.trim(),
            city: address.city.trim(),
            province: address.province.trim(),
            country: address.country.trim(),
            phone: address.phone.trim(),
          },
          ...(selectedMethod ? { deliveryMethodId: selectedMethod._id } : {}),
          ...(selectedMethod?.type === 'pickup' && selectedPoint ? { pickupPointId: selectedPoint._id } : {}),
          ...(promoCode ? { promoCode } : {}),
          loyaltyPoints,
        }
      : null;
  const { balance: walletBalance } = useWallet();
  const paymentsAvailable = usePaymentAvailability() === 'available';
  const payment = usePayment({
    selectors,
    kind: paymentMethod === 'wallet' ? 'wallet_purchase' : 'checkout_collection',
    phone: mobileNumber,
    operator: mobileProvider,
    enabled:
      isHydrated &&
      !mergeFailed &&
      !hasPendingMerge &&
      !isMerging &&
      sellerGroups !== undefined &&
      (paymentMethod === 'wallet' || Boolean(mobileNumber.trim() && mobileProvider)),
    contextKey: JSON.stringify(
      sellerGroups
        ?.flatMap((group) =>
          group.items.map((item) => ({
            rowId: item._id,
            productId: item.productId,
            quantity: item.quantity,
            variantId: item.selectedVariant?.variantId,
            sku: item.selectedVariant?.sku,
            options: item.selectedVariantOptions?.map((option) => ({ name: option.name, value: option.value })),
            addOns: item.selectedAddOns?.map((addon) => addon.name),
            shipping: item.selectedShipping?.name,
          })),
        )
        .sort((left, right) => left.rowId.localeCompare(right.rowId)),
    ),
  });
  const quote = payment.quote;
  const walletBalanceCents = walletBalance ? storedMajorAmountCents(walletBalance.balance) : null;
  const canUseWallet = Boolean(
    quote &&
    walletBalance?.hasWallet &&
    !walletBalance.isFrozen &&
    walletBalanceCents !== null &&
    walletBalanceCents >= quote.totalAmountCents,
  );
  const isProcessing = payment.working;
  const checkoutTotals = {
    subtotal: (quote?.subtotalCents ?? 0) / 100,
    shipping: (quote?.shippingCents ?? 0) / 100,
    promoDiscount: (quote?.promoCents ?? 0) / 100,
    loyaltyDiscount: (quote?.loyaltyCents ?? 0) / 100,
    platformFee: (quote?.platformFeeCents ?? 0) / 100,
    total: (quote?.totalAmountCents ?? 0) / 100,
  };
  const handlePhoneChange = (value: string): void => {
    setMobileNumber(value);
    setMobileProvider(detectProvider(value));
  };
  const handlePlaceOrder = async (): Promise<void> => {
    if (paymentMethod === 'wallet' && !canUseWallet) return;
    await payment.submit();
  };
  // Recovery has priority over cart cleanup/loading, and remains available with initiation disabled.
  if (payment.recovery) {
    const current = payment.isCompleted;
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Checkout recovery" onBackPress={() => navigation.goBack()} />
        <Text>
          {payment.outcome === 'completed'
            ? 'Payment confirmed'
            : payment.outcome === 'failed'
              ? 'Payment failed or cancelled'
              : payment.outcome === 'review'
                ? 'Payment needs review'
                : 'Payment confirmation pending'}
        </Text>
        <Text>
          {payment.status && !(payment.status instanceof Error) && payment.status.result === 'found'
            ? `Fee: ${payment.status.feeCents === null ? 'unknown' : formatPrice(payment.status.feeCents / 100)}`
            : 'Keep this request and check status before any new payment.'}
        </Text>
        {payment.error ? <Text>{payment.error}</Text> : null}
        <Button disabled={payment.working} onPress={() => void payment.checkStatus()}>
          Check status
        </Button>
        {payment.outcome === 'completed' ? (
          <Button
            onPress={() => {
              if (!current()) return;
              Alert.alert('Payment confirmed', 'Your owned checkout orders are available.', [
                {
                  text: 'View Orders',
                  onPress: () => {
                    if (current()) navigation.replace('Main', { screen: 'Orders' } as never);
                  },
                },
              ]);
            }}
          >
            View Orders
          </Button>
        ) : null}
        {payment.outcome === 'completed' || payment.outcome === 'failed' ? (
          <Button disabled={payment.working} onPress={() => void payment.newSubmission()}>
            Start new checkout
          </Button>
        ) : null}
      </View>
    );
  }

  if (!isHydrated || hasPendingMerge || isMerging || sellerGroups === undefined || deliveryQuote === undefined) {
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
      <StackHeader
        title="Checkout"
        subtitle="Delivery, promo, payment"
        onBackPress={() => navigation.goBack()}
        variant="gradient"
      />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.container}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
        >
          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
            <SectionTitle icon="map-marker-outline" title="Delivery Address" />
            <TextInput
              label="Street address"
              mode="outlined"
              value={address.street}
              onChangeText={(street) => setAddress((current) => ({ ...current, street }))}
              style={styles.input}
            />
            <View style={styles.row}>
              <TextInput
                label="City"
                mode="outlined"
                value={address.city}
                onChangeText={(city) => setAddress((current) => ({ ...current, city }))}
                style={styles.flexInput}
              />
              <TextInput
                label="Province"
                mode="outlined"
                value={address.province}
                onChangeText={(province) => setAddress((current) => ({ ...current, province }))}
                style={styles.flexInput}
              />
            </View>
            <TextInput
              label="Phone"
              mode="outlined"
              value={address.phone}
              onChangeText={(phone) => setAddress((current) => ({ ...current, phone }))}
              keyboardType="phone-pad"
              style={styles.input}
            />
          </Surface>

          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
            <SectionTitle icon="truck-fast-outline" title="Delivery Option" />
            <View style={styles.chipWrap}>
              {deliveryQuote.length > 0 ? (
                deliveryQuote.map((quote) => (
                  <Chip
                    key={quote.methodId}
                    selected={selectedDeliveryQuote?.methodId === quote.methodId}
                    onPress={() => {
                      setSelectedDeliveryMethodId(quote.methodId);
                      setPickupPointId(null);
                    }}
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
            {!deliveryValid ? (
              <Text>Select a current delivery method and an active pickup point when required.</Text>
            ) : null}
            {selectedMethod?.type === 'pickup' ? (
              <View style={styles.chipWrap}>
                {points
                  ?.filter(
                    (point) =>
                      point.isActive && (selectedMethod.zoneId === undefined || point.zoneId === selectedMethod.zoneId),
                  )
                  .map((point) => (
                    <Chip
                      key={point._id}
                      selected={pickupPointId === point._id}
                      onPress={() => setPickupPointId(point._id)}
                    >
                      {point.name} • {point.address.street}, {point.address.city}
                    </Chip>
                  ))}
              </View>
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
              <Button
                mode="contained-tonal"
                onPress={() => setPromoCode(promoInput.trim().toUpperCase())}
                style={styles.applyButton}
              >
                Apply
              </Button>
            </View>
            {promoCode ? (
              <>
                <Text>Selected code: {promoCode}. The current quote determines eligibility.</Text>
                <Button
                  onPress={() => {
                    setPromoCode('');
                    setPromoInput('');
                  }}
                >
                  Remove promo
                </Button>
              </>
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
              Loyalty value: {formatPrice(0.1)} per point.
            </Text>
          </Surface>

          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
            <SectionTitle icon="storefront-outline" title="Seller Orders" />
            <View style={styles.groupList}>
              {quote?.sellers.map((seller) => (
                <Surface key={seller.sellerId} style={styles.sellerGroup} elevation={0}>
                  <Text>
                    {sellerGroups?.find((group) => group.sellerId === seller.sellerId)?.sellerName?.trim() || 'Seller'}
                  </Text>
                  {quote.lines
                    .filter((line) => line.sellerId === seller.sellerId)
                    .map((line, index) => (
                      <View key={`${line.productId}-${index}`} style={styles.itemRow}>
                        <Text>
                          {line.title} ×{line.quantity}
                        </Text>
                        <Text>
                          {line.variant?.sku}{' '}
                          {line.variant?.attributes
                            .map((attribute) => `${attribute.name}: ${attribute.value}`)
                            .join(' • ')}
                        </Text>
                        <Text>{line.optionPairs?.map((option) => `${option.name}: ${option.value}`).join(' • ')}</Text>
                        <Text>{line.addOns?.map((addon) => addon.name).join(', ')}</Text>
                        <Text>{line.fallbackShipping?.name}</Text>
                        <Text>{formatPrice(line.lineTotalCents / 100)}</Text>
                      </View>
                    ))}
                  <SummaryRow label="Delivery" value={formatPrice(seller.shippingCents / 100)} />
                  <SummaryRow label="Discount" value={formatPrice(seller.discountCents / 100)} />
                  <SummaryRow label="Platform fee" value={formatPrice(seller.platformFeeCents / 100)} />
                  <SummaryRow label="Seller total" value={formatPrice(seller.totalAmountCents / 100)} />
                </Surface>
              ))}
            </View>
          </Surface>

          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
            <SectionTitle icon="credit-card-outline" title="Payment Method" />
            <View style={styles.paymentGrid}>
              {(['mobile_money', 'wallet'] as PaymentMethodType[]).map((method) => (
                <Pressable
                  key={method}
                  onPress={() => setPaymentMethod(method)}
                  style={[
                    styles.paymentOption,
                    {
                      backgroundColor:
                        paymentMethod === method ? theme.colors.primaryContainer : theme.colors.surfaceVariant,
                      borderColor: paymentMethod === method ? theme.colors.primary : 'transparent',
                    },
                  ]}
                >
                  <Icon
                    name={getPaymentIcon(method)}
                    size={24}
                    color={paymentMethod === method ? theme.colors.primary : theme.colors.onSurfaceVariant}
                  />
                  <Text
                    variant="labelMedium"
                    style={{
                      color: paymentMethod === method ? theme.colors.primary : theme.colors.onSurface,
                      marginTop: 6,
                      textAlign: 'center',
                    }}
                  >
                    {method.replace(/_/g, ' ')}
                  </Text>
                </Pressable>
              ))}
            </View>
            {paymentMethod === 'wallet' && walletBalance?.hasWallet ? (
              <Text variant="bodySmall" style={{ color: canUseWallet ? theme.colors.secondary : theme.colors.error }}>
                Wallet balance:{' '}
                {walletBalanceCents === null ? 'Unavailable' : formatWalletAmount(walletBalance.balance)}
              </Text>
            ) : null}
            {paymentMethod === 'mobile_money' ? (
              <>
                <TextInput
                  label="Mobile money number"
                  mode="outlined"
                  value={mobileNumber}
                  onChangeText={handlePhoneChange}
                  keyboardType="phone-pad"
                  style={styles.input}
                />
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
            <Text>Delivery: {quote?.delivery.name ?? 'Awaiting quote'}</Text>
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
                  This cart contains {sellerGroups.length} sellers. Mobile creates one tracked order per seller and uses
                  one aggregate mobile money collection or atomic wallet purchase for the full checkout.
                </Text>
              </Surface>
            ) : null}
          </Surface>

          {paymentsAvailable ? null : (
            <Text variant="bodySmall" style={{ color: theme.colors.error, textAlign: 'center', marginBottom: 8 }}>
              Payments are temporarily unavailable
            </Text>
          )}

          {mergeFailed ? (
            <Text>Guest cart sync failed. Return to the cart and resolve sync before payment.</Text>
          ) : null}
          {loyaltyPoints === null ? <Text>Enter a nonnegative whole safe number of loyalty points.</Text> : null}
          {payment.error ? <Text>{payment.error}</Text> : null}
          {payment.quoteResult instanceof Error ? (
            <Text>Quote unavailable. Check your account and selections.</Text>
          ) : payment.quoteResult && !payment.quoteResult.ok ? (
            <Text>Correct checkout: {payment.quoteResult.code}. Review delivery, pickup and promo selections.</Text>
          ) : null}
          <Button
            mode="contained"
            disabled={
              !paymentsAvailable ||
              !payment.ready ||
              !quote ||
              isProcessing ||
              (paymentMethod === 'wallet' && !canUseWallet)
            }
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
      <Text
        variant={emphatic ? 'titleMedium' : 'bodyMedium'}
        style={{ color: emphatic ? theme.colors.onSurface : theme.colors.onSurfaceVariant }}
      >
        {label}
      </Text>
      <Text
        variant={emphatic ? 'titleLarge' : 'bodyMedium'}
        style={{
          color: emphatic ? theme.colors.primary : theme.colors.onSurface,
          fontWeight: emphatic ? '800' : '500',
        }}
      >
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
