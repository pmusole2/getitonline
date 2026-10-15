import type { GuestCartItem } from '@gettitonline/shared';
import React from 'react';
import { View, StyleSheet, ScrollView, Alert, Pressable, Image } from 'react-native';
import { Text, useTheme, Button, IconButton, Divider, Surface } from 'react-native-paper';
import Animated, { FadeInDown, FadeOutLeft, Layout, SlideInRight } from 'react-native-reanimated';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList, Id, Product } from '../../types';
import { useAccountAccess } from '../../components/auth/useAccountAccess';
import { useAppAuth } from '../../context/AuthProvider';
import { useGuestCart } from '../../context/GuestCartProvider';
import { formatPrice } from '../../theme';
import { calculateDisplayPrice } from '../../hooks/useOrderTotal';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { MotiView } from 'moti';
import { Skeleton } from '../../components/ui/Skeleton';
import { StackHeader } from '../../components/ui/Header';
import { ASSISTANT_NAME } from '../../config/assistant';
import { useCartRecommendations } from '../../hooks/useCartRecommendations';

type Props = NativeStackScreenProps<RootStackParamList, 'Cart'>;

interface CartItem {
  _id: Id<'cartItems'>;
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
  lineUnitPrice?: number;
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

interface CartLineItem {
  key: string;
  cartItemId?: Id<'cartItems'>;
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
  lineUnitPrice: number;
  product: {
    _id: string;
    title: string;
    price: number;
    images: string[];
    quantity: number;
    status: string;
    sellerId: string;
    sellerName: string;
  };
}

function formatRecommendationPrice(product: Pick<Product, 'price' | 'variantCombinations'>): string {
  const prices = (product.variantCombinations ?? [])
    .filter((variant) => variant.status === 'active' && Number.isSafeInteger(variant.stock) && variant.stock > 0)
    .map((variant) => variant.price);
  const minimum = prices.length > 0 ? Math.min(...prices) : product.price;
  const hasRange = prices.length > 0 && minimum !== Math.max(...prices);

  return `${hasRange ? 'From ' : ''}${formatPrice(calculateDisplayPrice(minimum))}`;
}

export default function CartScreen({ navigation }: Props): React.JSX.Element {
  const theme = useTheme();
  const { user, setPostAuthDestination } = useAppAuth();
  // The signed-in cart is read only for a ready account; guests keep their local cart.
  const accountReady = useAccountAccess().status === 'ready';
  const {
    items: guestCartItems,
    summary: guestCartSummary,
    isHydrated: guestCartHydrated,
    updateQuantity: updateGuestQuantity,
    removeItem: removeGuestItem,
    clear: clearGuestCart,
    hasPendingMerge,
  } = useGuestCart();

  const cart = useQuery(api.cart.getCart, accountReady ? {} : 'skip');

  const updateQuantity = useMutation(api.cart.updateCartQuantity);
  const removeFromCart = useMutation(api.cart.removeFromCart);
  const clearCart = useMutation(api.cart.clearCart);

  const activeItems: CartLineItem[] = user
    ? ((cart?.items as CartItem[] | undefined) ?? []).map((item) => ({
        key: item._id,
        cartItemId: item._id,
        productId: item.product._id,
        quantity: item.quantity,
        selectedShipping: item.selectedShipping,
        selectedVariant: item.selectedVariant,
        selectedVariantOptions: item.selectedVariantOptions,
        selectedAddOns: item.selectedAddOns,
        lineUnitPrice: item.lineUnitPrice ?? item.product.price,
        product: {
          _id: item.product._id,
          title: item.product.title,
          price: item.product.price,
          images: item.product.images,
          quantity: item.product.quantity,
          status: item.product.status,
          sellerId: item.product.sellerId,
          sellerName: item.product.sellerName,
        },
      }))
    : guestCartItems.map((item: GuestCartItem) => ({
        key: item.customizationKey ?? item.productId,
        productId: item.productId,
        quantity: item.quantity,
        selectedShipping: item.selectedShipping,
        selectedVariant: item.selectedVariant,
        selectedVariantOptions: item.selectedVariantOptions,
        selectedAddOns: item.selectedAddOns,
        lineUnitPrice: item.product.price,
        product: item.product,
      }));

  const recommendations = useCartRecommendations({
    items: activeItems,
    enabled: guestCartHydrated && !hasPendingMerge && (!user || (accountReady && cart !== undefined)),
  });

  const itemCount = user ? cart?.items?.length || 0 : guestCartSummary.itemCount;
  const subtotal = calculateDisplayPrice(user ? cart?.subtotal || 0 : guestCartSummary.subtotal);
  const shippingTotal = user ? cart?.shippingTotal || 0 : guestCartSummary.shippingTotal;
  const total = subtotal + shippingTotal;

  const handleQuantityChange = async (item: CartLineItem, newQuantity: number) => {
    if (newQuantity < 1) return;

    if (!user) {
      updateGuestQuantity(item.key, newQuantity);
      return;
    }

    if (!item.cartItemId) {
      return;
    }

    try {
      await updateQuantity({
        cartItemId: item.cartItemId,
        quantity: newQuantity,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to update quantity';
      Alert.alert('Error', errorMessage);
    }
  };

  const handleRemoveItem = async (item: CartLineItem) => {
    if (!user) {
      removeGuestItem(item.key);
      return;
    }

    if (!item.cartItemId) {
      return;
    }

    try {
      await removeFromCart({ cartItemId: item.cartItemId });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to remove item';
      Alert.alert('Error', errorMessage);
    }
  };

  const handleClearCart = () => {
    if (!user) {
      clearGuestCart();
      return;
    }

    Alert.alert('Clear Cart', 'Are you sure you want to remove all items from your cart?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          if (!user) return;
          try {
            await clearCart({});
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Failed to clear cart';
            Alert.alert('Error', errorMessage);
          }
        },
      },
    ]);
  };

  const handleCheckout = () => {
    if (!user) {
      setPostAuthDestination('Checkout');
      navigation.navigate('Auth');
      return;
    }

    navigation.navigate('Checkout');
  };

  // Loading state
  if (!guestCartHydrated || hasPendingMerge || (user && cart === undefined)) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        {/* Header shown even during loading */}
        <StackHeader
          title="Shopping Cart"
          subtitle="Loading..."
          onBackPress={() => navigation.goBack()}
          variant="gradient"
        />
        <View style={styles.loadingContainer}>
          {[1, 2, 3].map((i) => (
            <View key={i} style={styles.skeletonCard}>
              <Skeleton width={80} height={80} borderRadius={12} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Skeleton width="80%" height={18} />
                <Skeleton width="50%" height={16} style={{ marginTop: 8 }} />
                <Skeleton width="30%" height={20} style={{ marginTop: 8 }} />
              </View>
            </View>
          ))}
        </View>
      </View>
    );
  }

  // Empty cart state
  if (activeItems.length === 0) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        {/* Header shown even when empty */}
        <StackHeader
          title="Shopping Cart"
          subtitle="0 items"
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
              <Icon name="cart-outline" size={64} color={theme.colors.onSurfaceVariant} />
            </View>
          </MotiView>
          <Text variant="titleLarge" style={{ color: theme.colors.onSurface, marginTop: 24 }}>
            Your cart is empty
          </Text>
          <Text
            variant="bodyMedium"
            style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, textAlign: 'center' }}
          >
            Add products to your cart to get started
          </Text>
          <Button
            mode="contained"
            onPress={() => navigation.navigate('Browse' as never)}
            style={styles.browseButton}
            icon="shopping"
          >
            Browse Products
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Custom Futuristic Header */}
      <StackHeader
        title="Shopping Cart"
        subtitle={`${itemCount} ${itemCount === 1 ? 'item' : 'items'}`}
        onBackPress={() => navigation.goBack()}
        rightActions={[{ icon: 'delete-outline', onPress: handleClearCart }]}
        variant="gradient"
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Cart Items */}
        <View style={styles.itemsContainer}>
          {activeItems.map((item: CartLineItem, index: number) => (
            <Animated.View
              key={item.key}
              entering={FadeInDown.delay(index * 80).duration(400)}
              exiting={FadeOutLeft.duration(300)}
              layout={Layout.springify()}
            >
              <Surface style={[styles.cartItem, { backgroundColor: theme.colors.surface }]} elevation={2}>
                <View style={styles.itemContent}>
                  {/* Product Image */}
                  {item.selectedVariant?.image || item.product.images[0] ? (
                    <Image
                      source={{ uri: item.selectedVariant?.image || item.product.images[0] }}
                      style={styles.itemImage}
                      resizeMode="contain"
                    />
                  ) : (
                    <View
                      style={[
                        styles.itemImage,
                        styles.imagePlaceholder,
                        { backgroundColor: theme.colors.surfaceVariant },
                      ]}
                    >
                      <Icon name="image" size={24} color={theme.colors.onSurfaceVariant} />
                    </View>
                  )}

                  {/* Product Info */}
                  <View style={styles.itemInfo}>
                    <Text
                      variant="titleSmall"
                      numberOfLines={2}
                      style={{ color: theme.colors.onSurface, fontWeight: '600' }}
                    >
                      {item.product.title}
                    </Text>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                      Store: {item.product.sellerName}
                    </Text>
                    <Text
                      variant="titleMedium"
                      style={{ color: theme.colors.primary, marginTop: 4, fontWeight: '700' }}
                    >
                      {formatPrice(calculateDisplayPrice(item.lineUnitPrice))}
                    </Text>
                    {item.selectedVariantOptions && item.selectedVariantOptions.length > 0 ? (
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                        {item.selectedVariantOptions.map((option) => `${option.name}: ${option.value}`).join(' • ')}
                      </Text>
                    ) : null}
                    {item.selectedVariant?.attributes && item.selectedVariant.attributes.length > 0 ? (
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                        {item.selectedVariant.attributes
                          .map((attribute) => `${attribute.name}: ${attribute.value}`)
                          .join(' • ')}
                      </Text>
                    ) : null}
                    {item.selectedVariant?.sku ? (
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                        SKU: {item.selectedVariant.sku}
                      </Text>
                    ) : null}
                    {item.selectedAddOns && item.selectedAddOns.length > 0 ? (
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                        Add-ons: {item.selectedAddOns.map((addOn) => addOn.name).join(', ')}
                      </Text>
                    ) : null}

                    {/* Quantity Controls */}
                    <View style={styles.quantityRow}>
                      <View style={[styles.quantityControls, { backgroundColor: theme.colors.surfaceVariant }]}>
                        <IconButton
                          icon="minus"
                          size={18}
                          onPress={() => handleQuantityChange(item, item.quantity - 1)}
                          disabled={item.quantity <= 1}
                        />
                        <Text
                          variant="titleMedium"
                          style={{ color: theme.colors.onSurface, minWidth: 24, textAlign: 'center' }}
                        >
                          {item.quantity}
                        </Text>
                        <IconButton
                          icon="plus"
                          size={18}
                          onPress={() => handleQuantityChange(item, item.quantity + 1)}
                          disabled={item.quantity >= item.product.quantity}
                        />
                      </View>
                      <IconButton
                        icon="delete-outline"
                        size={22}
                        iconColor={theme.colors.error}
                        onPress={() => handleRemoveItem(item)}
                      />
                    </View>
                  </View>
                </View>

                {/* Shipping Info */}
                <View style={[styles.shippingInfo, { backgroundColor: theme.colors.surfaceVariant }]}>
                  <Icon name="truck-delivery" size={16} color={theme.colors.onSurfaceVariant} />
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginLeft: 6 }}>
                    {item.selectedShipping.name} - {formatPrice(item.selectedShipping.price)}
                  </Text>
                </View>
              </Surface>
            </Animated.View>
          ))}
        </View>

        {/* AI Recommendation */}
        <Animated.View entering={FadeInDown.delay(activeItems.length * 80 + 100).duration(400)}>
          <Surface style={[styles.aiCard, { backgroundColor: theme.colors.tertiaryContainer }]} elevation={0}>
            <View style={styles.aiContent}>
              <Icon name="creation" size={24} color={theme.colors.tertiary} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text variant="labelLarge" style={{ color: theme.colors.onTertiaryContainer, fontWeight: '600' }}>
                  {ASSISTANT_NAME}'s Recommendation
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onTertiaryContainer, opacity: 0.8 }}>
                  {recommendations.status === 'guest'
                    ? 'Sign in for cart recommendations'
                    : recommendations.status === 'loading' || recommendations.status === 'idle'
                      ? 'Finding suggestions for your cart...'
                      : recommendations.status === 'consent_required'
                        ? 'Ask Pinkie for suggestions based on your cart.'
                        : recommendations.status === 'error'
                          ? recommendations.error
                          : recommendations.status === 'ready'
                            ? 'Suggested for your cart'
                            : 'No suitable recommendations for this cart right now.'}
                </Text>
              </View>
            </View>
            {recommendations.status === 'guest' ? (
              <Button onPress={() => navigation.navigate('Auth')}>Sign In</Button>
            ) : recommendations.status === 'consent_required' ? (
              <Button onPress={() => void recommendations.askPinkie()}>Ask Pinkie</Button>
            ) : recommendations.status === 'error' ? (
              <Button onPress={recommendations.refresh}>Try Again</Button>
            ) : null}
            {recommendations.products
              .filter((product) => !activeItems.some((item) => item.productId === product._id))
              .map((product) => (
                <Pressable
                  key={product._id}
                  accessibilityRole="button"
                  accessibilityLabel={`View ${product.title}`}
                  onPress={() => navigation.navigate('ProductDetail', { productId: product._id })}
                  style={styles.recommendationRow}
                >
                  <View style={{ flex: 1 }}>
                    <Text variant="titleSmall" style={{ color: theme.colors.onTertiaryContainer }}>
                      {product.title}
                    </Text>
                    <Text variant="bodyMedium" style={{ color: theme.colors.onTertiaryContainer }}>
                      {formatRecommendationPrice(product)}
                    </Text>
                  </View>
                  <Icon name="chevron-right" size={20} color={theme.colors.tertiary} />
                </Pressable>
              ))}
          </Surface>
        </Animated.View>

        {/* Order Summary */}
        <Animated.View entering={FadeInDown.delay(activeItems.length * 80 + 200).duration(400)}>
          <Surface style={[styles.summaryCard, { backgroundColor: theme.colors.surface }]} elevation={2}>
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600', marginBottom: 16 }}>
              Order Summary
            </Text>
            <View style={styles.summaryRow}>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                Subtotal
              </Text>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                {formatPrice(subtotal)}
              </Text>
            </View>
            <View style={styles.summaryRow}>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                Shipping
              </Text>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                {formatPrice(shippingTotal)}
              </Text>
            </View>
            <Divider style={{ marginVertical: 12 }} />
            <View style={styles.summaryRow}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                Total
              </Text>
              <Text variant="titleLarge" style={{ color: theme.colors.primary, fontWeight: '700' }}>
                {formatPrice(total)}
              </Text>
            </View>
          </Surface>
        </Animated.View>

        {/* Secure Checkout Info */}
        <Animated.View
          entering={FadeInDown.delay(activeItems.length * 80 + 300).duration(400)}
          style={styles.securityInfo}
        >
          <Icon name="shield-check" size={16} color={theme.colors.primary} />
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginLeft: 6 }}>
            Secure escrow payment protection
          </Text>
        </Animated.View>

        <View style={{ height: 120 }} />
      </ScrollView>

      {/* Checkout Button */}
      <Animated.View
        entering={SlideInRight.delay(200).duration(400)}
        style={[styles.checkoutBar, { backgroundColor: theme.colors.surface }]}
      >
        <View>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Total
          </Text>
          <Text variant="headlineSmall" style={{ color: theme.colors.primary, fontWeight: '700' }}>
            {formatPrice(total)}
          </Text>
        </View>
        <Button
          mode="contained"
          onPress={handleCheckout}
          style={styles.checkoutButton}
          contentStyle={styles.checkoutContent}
          icon="lock"
        >
          {user ? 'Secure Checkout' : 'Sign In to Checkout'}
        </Button>
      </Animated.View>
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
  skeletonCard: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0,0,0,0.05)',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  emptyIcon: {
    width: 120,
    height: 120,
    borderRadius: 60,
    justifyContent: 'center',
    alignItems: 'center',
  },
  browseButton: {
    marginTop: 24,
    borderRadius: 12,
  },
  itemsContainer: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  cartItem: {
    borderRadius: 16,
    marginBottom: 12,
    overflow: 'hidden',
  },
  itemContent: {
    flexDirection: 'row',
    padding: 12,
  },
  itemImage: {
    width: 80,
    height: 80,
    borderRadius: 12,
  },
  imagePlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  itemInfo: {
    flex: 1,
    marginLeft: 12,
  },
  quantityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  quantityControls: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
  },
  shippingInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  aiCard: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 16,
    padding: 16,
  },
  aiContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  recommendationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    paddingVertical: 8,
  },
  summaryCard: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 16,
    padding: 16,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  securityInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  checkoutBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.1)',
  },
  checkoutButton: {
    borderRadius: 12,
    minWidth: 180,
  },
  checkoutContent: {
    paddingVertical: 6,
  },
});
