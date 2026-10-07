import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { createCartCustomizationKey } from '@gettitonline/shared';
import { useMutation, useQuery } from 'convex/react';
import { formatDistanceToNow } from 'date-fns';
import { MotiView } from 'moti';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Dimensions, Image, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Avatar, Button, Chip, Snackbar, Surface, Text, useTheme } from 'react-native-paper';
import Animated, {
  FadeIn,
  FadeInUp,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { StackHeader } from '../../components/ui/Header';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAppAuth } from '../../context/AuthProvider';
import { useGuestCart } from '../../context/GuestCartProvider';
import { calculateDisplayPrice } from '../../hooks/useOrderTotal';
import { formatPrice } from '../../theme';
import type { Id, Product, ProductCondition, RootStackParamList } from '../../types';
import { canManageCatalog, canViewProductStats } from '../../utils/roles';
import {
  isVariantValueAvailable,
  resolveExactVariant,
  resolveVariantPreviewImages,
  type VariantAttribute,
  type VariantCombination,
} from './productVariantDomain';

const { width } = Dimensions.get('window');
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type Props = NativeStackScreenProps<RootStackParamList, 'ProductDetail'>;
type ProductVariantSelection = {
  name: string;
  value: string;
  sku?: string;
  priceDelta?: number;
};
type ProductAddOnSelection = {
  name: string;
  description?: string;
  price: number;
};
type SelectedVariantSnapshot = {
  variantId: string;
  sku: string;
  attributes: Array<{ name: string; value: string }>;
  price: number;
  image?: string;
};

function getSelectedVariantDetails(
  product: Pick<Product, 'variants'>,
  selectedVariantOptions: Record<string, string>,
): ProductVariantSelection[] {
  return (product.variants ?? [])
    .map((variant) => {
      const selectedValue = selectedVariantOptions[variant.name];
      const selectedOption = variant.options.find((option) => option.value === selectedValue);

      if (!selectedOption) return null;

      const selection: ProductVariantSelection = {
        name: variant.name,
        value: selectedOption.value,
      };

      if (selectedOption.sku) selection.sku = selectedOption.sku;
      if (typeof selectedOption.priceDelta === 'number') {
        selection.priceDelta = selectedOption.priceDelta;
      }

      return selection;
    })
    .filter((option): option is ProductVariantSelection => option !== null);
}

function getSelectedAddOnDetails(
  product: Pick<Product, 'addOns'>,
  selectedAddOns: Record<string, boolean>,
): ProductAddOnSelection[] {
  return (product.addOns ?? [])
    .filter((addOn) => addOn.isRequired || selectedAddOns[addOn.name])
    .map((addOn) => {
      const selection: ProductAddOnSelection = {
        name: addOn.name,
        price: addOn.price,
      };

      if (addOn.description) selection.description = addOn.description;
      return selection;
    });
}

function getSelectedSellerUnitPrice(
  product: Pick<Product, 'price' | 'variants' | 'addOns'>,
  selectedVariantOptions: Record<string, string>,
  selectedAddOns: Record<string, boolean>,
) {
  const variantTotal = getSelectedVariantDetails(product, selectedVariantOptions).reduce(
    (sum, option) => sum + (option.priceDelta ?? 0),
    0,
  );
  const addOnTotal = getSelectedAddOnDetails(product, selectedAddOns).reduce(
    (sum, addOn) => sum + addOn.price,
    0,
  );

  return Math.max(0, product.price + variantTotal + addOnTotal);
}

export default function ProductDetailScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { productId } = route.params;
  const { user } = useAppAuth();
  const { addItem: addGuestCartItem } = useGuestCart();
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [snackbarVisible, setSnackbarVisible] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState('');
  const [selectedVariantOptions, setSelectedVariantOptions] = useState<Record<string, string>>({});
  const [selectedAddOns, setSelectedAddOns] = useState<Record<string, boolean>>({});
  const [imagePreviewVisible, setImagePreviewVisible] = useState(false);
  const [previewImageIndex, setPreviewImageIndex] = useState(0);
  const [cartPromptVisible, setCartPromptVisible] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(true);
  const imagePreviewScrollRef = useRef<ScrollView>(null);
  const scrollY = useSharedValue(0);
  const favoriteScale = useSharedValue(1);

  const product = useQuery(api.products.getProduct, {
    productId: productId as Id<'products'>,
    viewerUserId: user?._id,
  });
  const deliveryQuote = useQuery(
    api.delivery.calculateDeliveryQuote,
    product
      ? {
          city: user?.address?.city ?? product.location?.city,
          province: user?.address?.province ?? product.location?.province,
          subtotal: product.price,
          weightKg: product.weightKg,
        }
      : 'skip',
  );
  const productReviews = useQuery(
    api.reviews.getProductReviews,
    product ? { productId: product._id, limit: 6 } : 'skip',
  );
  const managesCurrentStoreProduct = Boolean(
    canManageCatalog(user?.role) && product?.seller?.isCompanyStore
  );
  const isFavorited = useQuery(
    api.favorites.isFavorited,
    user && product ? { userId: user._id, productId: product._id } : 'skip'
  );

  const addToCart = useMutation(api.cart.addToCart);
  const toggleFavorite = useMutation(api.favorites.toggleFavorite);
  const incrementViews = useMutation(api.products.incrementViews);
  const recordBehaviorEvent = useMutation(api.notifications.recordBehaviorEvent);
  const startConversation = useMutation(api.conversations.startConversation);
  const variantCombinations = useMemo<VariantCombination[]>(
    () => ((product?.variantCombinations ?? []) as VariantCombination[]),
    [product?.variantCombinations],
  );
  const variantAttributes = useMemo<VariantAttribute[]>(() => {
    if (!product) return [];
    if (product.variantAttributes?.length) {
      return product.variantAttributes.map((attribute) => ({
        name: attribute.name,
        values: [...attribute.values],
      }));
    }

    const attributes = new Map<string, Set<string>>();
    for (const combination of variantCombinations) {
      for (const attribute of combination.attributes) {
        const values = attributes.get(attribute.name) ?? new Set<string>();
        values.add(attribute.value);
        attributes.set(attribute.name, values);
      }
    }

    return Array.from(attributes.entries()).map(([name, values]) => ({
      name,
      values: Array.from(values),
    }));
  }, [product, variantCombinations]);
  const selectedVariant = useMemo(
    () =>
      resolveExactVariant(
        variantCombinations,
        variantAttributes,
        selectedVariantOptions,
      ),
    [selectedVariantOptions, variantAttributes, variantCombinations],
  );
  const displayImages = useMemo(
    () =>
      product
        ? resolveVariantPreviewImages({
            baseImages: product.images,
            combinations: variantCombinations,
            attributes: variantAttributes,
            selection: selectedVariantOptions,
          })
        : [],
    [
      product,
      selectedVariantOptions,
      variantAttributes,
      variantCombinations,
    ],
  );
  const selectedVariantSnapshot = useMemo<SelectedVariantSnapshot | undefined>(() => {
    if (!selectedVariant) return undefined;
    return {
      variantId: selectedVariant.id,
      sku: selectedVariant.sku,
      attributes: selectedVariant.attributes,
      price: selectedVariant.price,
      image: selectedVariant.primaryImage,
    };
  }, [selectedVariant]);

  // Check for existing conversation
  const existingConversation = useQuery(
    api.conversations.getExistingConversation,
    user && product && !managesCurrentStoreProduct && user._id !== product.sellerId
      ? { productId: product._id, buyerId: user._id, viewerId: user._id }
      : 'skip'
  );

  // Track if we've already incremented the view for this product
  const hasIncrementedView = useRef(false);

  // Increment view count when product is loaded (only for other users' products)
  useEffect(() => {
    const isOwnProduct = user?._id === product?.sellerId || managesCurrentStoreProduct;

    if (product && !hasIncrementedView.current && !isOwnProduct) {
      hasIncrementedView.current = true;
      incrementViews({ productId: product._id }).catch((err) => {
        console.log('Failed to increment view count:', err);
      });
      recordBehaviorEvent({
        userId: user?._id,
        eventType: 'product_view',
        productId: product._id,
        categoryId: product.categoryId,
      }).catch((err) => {
        console.log('Failed to record product view:', err);
      });
    }
  }, [incrementViews, managesCurrentStoreProduct, product, recordBehaviorEvent, user]);

  useEffect(() => {
    setCurrentImageIndex(0);
    setPreviewImageIndex(0);
  }, [displayImages[0], product?._id]);

  useEffect(() => {
    setSelectedVariantOptions({});
    setSelectedAddOns({});
  }, [product?._id]);

  useEffect(() => {
    if (!imagePreviewVisible) return;

    requestAnimationFrame(() => {
      imagePreviewScrollRef.current?.scrollTo({
        x: previewImageIndex * width,
        animated: false,
      });
    });
  }, [imagePreviewVisible, previewImageIndex]);

  useEffect(() => {
    const isOwnProduct = user?._id === product?.sellerId || managesCurrentStoreProduct;
    if (!product || isOwnProduct) return undefined;

    const startedAt = Date.now();
    return () => {
      const durationMs = Date.now() - startedAt;
      if (durationMs < 1000) return;
      recordBehaviorEvent({
        userId: user?._id,
        eventType: 'product_time_spent',
        productId: product._id,
        categoryId: product.categoryId,
        durationMs,
      }).catch((err) => {
        console.log('Failed to record product time spent:', err);
      });
    };
  }, [managesCurrentStoreProduct, product, recordBehaviorEvent, user?._id]);

  const favoriteAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: favoriteScale.value }],
  }));

  const handleAddToCart = async () => {
    if (!product) return;

    try {
      const hasCanonicalVariants = variantCombinations.length > 0;
      const missingVariantNames = (hasCanonicalVariants ? variantAttributes : product.variants ?? [])
        .filter((variant) => !selectedVariantOptions[variant.name])
        .map((variant) => variant.name);

      if (missingVariantNames.length > 0) {
        Alert.alert(
          'Choose options',
          `Select ${missingVariantNames.join(', ')} before adding this item to cart.`,
        );
        return;
      }

      if (
        hasCanonicalVariants &&
        (!selectedVariant || selectedVariant.status !== 'active' || selectedVariant.stock <= 0)
      ) {
        Alert.alert('Unavailable option', 'This product option is currently out of stock.');
        return;
      }

      // Use product's shipping option, default to free delivery
      const shippingOption = product.shippingOptions?.[0] || { name: 'Free Delivery', price: 0 };
      const selectedVariantDetails = hasCanonicalVariants
        ? []
        : getSelectedVariantDetails(product, selectedVariantOptions);
      const selectedAddOnDetails = getSelectedAddOnDetails(product, selectedAddOns);
      const addOnTotal = selectedAddOnDetails.reduce((sum, addOn) => sum + addOn.price, 0);
      const selectedSellerUnitPrice = hasCanonicalVariants
        ? Math.max(0, (selectedVariant?.price ?? product.price) + addOnTotal)
        : getSelectedSellerUnitPrice(
            product,
            selectedVariantOptions,
            selectedAddOns,
          );
      const customizationKey = createCartCustomizationKey({
        productId: product._id,
        selectedVariant: selectedVariantSnapshot,
        selectedVariantOptions: selectedVariantDetails,
        selectedAddOns: selectedAddOnDetails,
      });

      if (user) {
        await addToCart({
          userId: user._id,
          productId: product._id,
          quantity: 1,
          selectedShipping: { name: shippingOption.name, price: shippingOption.price },
          selectedVariant: selectedVariantSnapshot,
          selectedVariantOptions: selectedVariantDetails,
          selectedAddOns: selectedAddOnDetails,
        });
      } else {
        addGuestCartItem({
          productId: product._id,
          quantity: 1,
          selectedShipping: { name: shippingOption.name, price: shippingOption.price },
          selectedVariant: selectedVariantSnapshot,
          selectedVariantOptions: selectedVariantDetails,
          selectedAddOns: selectedAddOnDetails,
          customizationKey,
          product: {
            _id: product._id,
            sellerId: product.sellerId,
            sellerName: product.seller?.displayName || 'Gettitonline',
            title: product.title,
            price: selectedSellerUnitPrice,
            images: displayImages,
            quantity: selectedVariant?.stock ?? product.quantity,
            status: product.status,
            shippingOptions: product.shippingOptions ?? [],
          },
          addedAt: Date.now(),
        });
      }

      setSnackbarMessage('Added to cart!');
      setSnackbarVisible(true);
      setCartPromptVisible(true);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to add to cart';
      Alert.alert('Error', errorMessage);
    }
  };


  const handleToggleFavorite = async () => {
    if (!product) return;

    if (!user) {
      navigation.navigate('Auth');
      return;
    }

    favoriteScale.value = withSpring(0.8, { damping: 10 }, () => {
      favoriteScale.value = withSpring(1, { damping: 10 });
    });

    try {
      await toggleFavorite({
        userId: user._id,
        productId: product._id,
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to update favorite';
      Alert.alert('Error', errorMessage);
    }
  };

  const handleSellerPress = () => {
    if (product?.seller) {
      navigation.navigate('SellerProfile', { sellerId: product.seller._id });
    }
  };

  const handleBrandPress = () => {
    if (!product?.brand) return;
    navigation.navigate('Search', { brand: product.brand });
  };

  const handleContactSeller = async () => {
    if (!product) return;

    if (!user) {
      navigation.navigate('Auth');
      return;
    }

    try {
      // Check if conversation already exists
      if (existingConversation) {
        navigation.navigate('ConversationChat', {
          conversationId: existingConversation._id,
          productId: product._id,
        });
      } else {
        // Start new conversation
        const conversationId = await startConversation({
          productId: product._id,
          buyerId: user._id,
        });
        navigation.navigate('ConversationChat', {
          conversationId: conversationId as string,
          productId: product._id,
        });
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to start conversation';
      Alert.alert('Error', errorMessage);
    }
  };

  // Loading state
  if (product === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <ScrollView showsVerticalScrollIndicator={false}>
          <Skeleton width={width} height={350} borderRadius={0} />
          <View style={styles.content}>
            <Skeleton width="80%" height={28} style={{ marginBottom: 12 }} />
            <Skeleton width="40%" height={32} style={{ marginBottom: 16 }} />
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 24 }}>
              <Skeleton width={80} height={28} borderRadius={14} />
              <Skeleton width={100} height={28} borderRadius={14} />
            </View>
            <Skeleton width="100%" height={100} borderRadius={12} />
          </View>
        </ScrollView>
      </View>
    );
  }

  if (product === null) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.colors.background }]}>
        <MotiView
          from={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ opacity: { type: 'timing', duration: 400 }, scale: { type: 'timing', duration: 400 } }}
        >
          <Icon name="package-variant-remove" size={64} color={theme.colors.onSurfaceVariant} />
        </MotiView>
        <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant, marginTop: 16 }}>
          Product not found
        </Text>
        <Button mode="outlined" onPress={() => navigation.goBack()} style={{ marginTop: 16 }}>
          Go Back
        </Button>
      </View>
    );
  }

  const isOwnProduct = user?._id === product.sellerId || managesCurrentStoreProduct;
  const conditionConfig: Record<ProductCondition, { label: string; color: string }> = {
    new: { label: 'New', color: '#10B981' },
    like_new: { label: 'Like New', color: '#3B82F6' },
    good: { label: 'Good', color: '#8B5CF6' },
    fair: { label: 'Fair', color: '#F59E0B' },
  };

  const currentCondition = conditionConfig[product.condition];
  const hasCanonicalVariants = variantCombinations.length > 0;
  const selectedAddOnDetails = getSelectedAddOnDetails(product, selectedAddOns);
  const addOnTotal = selectedAddOnDetails.reduce((sum, addOn) => sum + addOn.price, 0);
  const selectedSellerUnitPrice = hasCanonicalVariants
    ? Math.max(0, (selectedVariant?.price ?? product.price) + addOnTotal)
    : getSelectedSellerUnitPrice(
        product,
        selectedVariantOptions,
        selectedAddOns,
      );
  const selectedStock = selectedVariant?.stock ?? product.quantity;
  const canSelectVariantValue = (attributeName: string, value: string) => {
    if (!hasCanonicalVariants) return true;

    return isVariantValueAvailable({
      combinations: variantCombinations,
      attributes: variantAttributes,
      selection: selectedVariantOptions,
      attributeName,
      value,
    });
  };
  const displayPrice = calculateDisplayPrice(selectedSellerUnitPrice);
  const compareAtDisplay = product.compareAtPrice
    ? calculateDisplayPrice(product.compareAtPrice)
    : undefined;
  const discountPercent =
    compareAtDisplay && compareAtDisplay > displayPrice
      ? Math.round(((compareAtDisplay - displayPrice) / compareAtDisplay) * 100)
      : null;
  const canShowProductStats = canViewProductStats(user, product);
  const sellerDisplayName = product.seller?.displayName || 'Gettitonline';
  const warrantySummary = product.warranty
    ? [
        product.warranty.type === 'none' ? 'No warranty' : product.warranty.type,
        product.warranty.durationDays ? `${product.warranty.durationDays} days` : undefined,
        product.warranty.provider,
      ]
        .filter(Boolean)
        .join(' • ')
    : undefined;
  const productDetailRows = [
    product.brand ? { label: 'Brand', value: product.brand } : null,
    product.modelNumber ? { label: 'Model', value: product.modelNumber } : null,
    product.sku ? { label: 'SKU', value: product.sku } : null,
    product.color ? { label: 'Color', value: product.color } : null,
    product.material ? { label: 'Material', value: product.material } : null,
    product.countryOfOrigin ? { label: 'Country of origin', value: product.countryOfOrigin } : null,
    { label: 'Condition', value: currentCondition.label },
    product.availabilityStatus
      ? { label: 'Availability', value: product.availabilityStatus.replace(/_/g, ' ') }
      : null,
    { label: 'Stock', value: `${selectedStock} available` },
    warrantySummary ? { label: 'Warranty', value: warrantySummary } : null,
    ...(product.specifications ?? []).map((spec) => ({ label: spec.key, value: spec.value })),
  ].filter((row): row is { label: string; value: string } => Boolean(row?.label && row.value));

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Custom Futuristic Header */}
      <StackHeader
        title="Product Details"
        onBackPress={() => navigation.goBack()}
        rightActions={[
          {
            icon: 'share-variant',
            onPress: () => {},
          },
        ]}
        variant="gradient"
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Image Gallery */}
        <Animated.View entering={FadeIn.duration(400)}>
          <View style={styles.imageContainer}>
            <ScrollView
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              onScroll={(e) => {
                const index = Math.round(e.nativeEvent.contentOffset.x / width);
                setCurrentImageIndex(index);
              }}
              scrollEventThrottle={16}
            >
              {displayImages.length > 0 ? (
                displayImages.map((image, index) => (
                  <Pressable
                    key={index}
                    style={styles.imageWrapper}
                    onPress={() => {
                      setPreviewImageIndex(index);
                      setImagePreviewVisible(true);
                    }}
                  >
                    <Image
                      source={{ uri: image }}
                      style={styles.image}
                      resizeMode="contain"
                    />
                  </Pressable>
                ))
              ) : (
                <View style={[styles.imageWrapper, styles.imagePlaceholder, { backgroundColor: theme.colors.surfaceVariant }]}>
                  <Icon name="image-off" size={64} color={theme.colors.onSurfaceVariant} />
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 8 }}>
                    No images available
                  </Text>
                </View>
              )}
            </ScrollView>

            {/* Image Indicators */}
            {displayImages.length > 1 && (
              <View style={styles.imageIndicators}>
                {displayImages.map((_, index) => (
                  <MotiView
                    key={index}
                    animate={{
                      width: index === currentImageIndex ? 24 : 8,
                      backgroundColor: index === currentImageIndex ? theme.colors.primary : 'rgba(255,255,255,0.5)',
                    }}
                    transition={{ width: { type: 'timing', duration: 200 }, backgroundColor: { type: 'timing', duration: 200 } }}
                    style={styles.indicator}
                  />
                ))}
              </View>
            )}

            {/* Image Counter */}
            {displayImages.length > 0 && (
              <View style={[styles.imageCounter, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
                <Text style={{ color: '#fff', fontSize: 12 }}>
                  {currentImageIndex + 1}/{displayImages.length}
                </Text>
              </View>
            )}

            {discountPercent ? (
              <View style={[styles.saleBadge, { backgroundColor: theme.colors.error }]}>
                <Text style={styles.saleBadgeText}>{discountPercent}% OFF</Text>
              </View>
            ) : null}

            {/* Favorite Button */}
            {!isOwnProduct && (
              <AnimatedPressable
                style={[
                  styles.favoriteButton,
                  discountPercent ? styles.favoriteButtonWithDiscount : null,
                  favoriteAnimatedStyle,
                ]}
                onPress={handleToggleFavorite}
              >
                <Surface style={[styles.favoriteCircle, { backgroundColor: theme.colors.surface }]} elevation={3}>
                  <Icon
                    name={isFavorited ? 'heart' : 'heart-outline'}
                    size={24}
                    color={isFavorited ? theme.colors.error : theme.colors.onSurface}
                  />
                </Surface>
              </AnimatedPressable>
            )}
          </View>
        </Animated.View>

        {/* Product Info */}
        <View style={styles.content}>
          <Animated.View entering={FadeInUp.delay(100).duration(400)}>
            <Text variant="headlineSmall" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
              {product.title}
            </Text>

            <View style={styles.brandSellerBlock}>
              {product.brand ? (
                <Pressable onPress={handleBrandPress}>
                  <Text variant="labelLarge" style={{ color: theme.colors.primary }}>
                    {product.brand}
                  </Text>
                </Pressable>
              ) : null}
              <Pressable onPress={handleSellerPress} style={styles.soldByRow}>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  Sold by{' '}
                </Text>
                <Text variant="bodyMedium" style={{ color: theme.colors.primary, fontWeight: '700' }}>
                  {sellerDisplayName}
                </Text>
                <Icon name="chevron-right" size={18} color={theme.colors.primary} />
              </Pressable>
            </View>

            <View style={styles.priceRow}>
              <Text variant="headlineMedium" style={{ color: theme.colors.primary, fontWeight: '700' }}>
                {formatPrice(displayPrice)}
              </Text>
              {compareAtDisplay ? (
                <Text variant="bodyMedium" style={[styles.compareAtPrice, { color: theme.colors.onSurfaceVariant }]}>
                  {formatPrice(compareAtDisplay)}
                </Text>
              ) : null}
            </View>
            {product.shortDescription ? (
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, lineHeight: 21 }}>
                {product.shortDescription}
              </Text>
            ) : null}
          </Animated.View>

          <Animated.View entering={FadeInUp.delay(150).duration(400)} style={styles.tagsRow}>
            <Surface style={[styles.conditionTag, { backgroundColor: currentCondition.color }]} elevation={0}>
              <Text style={{ color: '#fff', fontWeight: '600', fontSize: 12 }}>
                {currentCondition.label}
              </Text>
            </Surface>
            {product.location && (
              <Chip mode="flat" compact icon="map-marker" style={styles.tag}>
                {typeof product.location === 'string' ? product.location : product.location.city}
              </Chip>
            )}
            {/* Shipping Info */}
            <Chip
              mode="flat"
              compact
              icon={product.shippingOptions?.[0]?.price === 0 ? 'truck-check' : 'truck-delivery'}
              style={[
                styles.tag,
                product.shippingOptions?.[0]?.price === 0 && { backgroundColor: theme.colors.secondaryContainer }
              ]}
              textStyle={product.shippingOptions?.[0]?.price === 0 ? { color: theme.colors.secondary } : undefined}
            >
              {product.shippingOptions?.[0]?.price === 0
                ? 'Free Delivery'
                : `Delivery: K${product.shippingOptions?.[0]?.price?.toFixed(2) || '0.00'}`
              }
            </Chip>
            {product.availabilityStatus ? (
              <Chip mode="flat" compact icon="warehouse" style={styles.tag}>
                {product.availabilityStatus.replace(/_/g, ' ')}
              </Chip>
            ) : null}
          </Animated.View>

          {product.keyFeatures && product.keyFeatures.length > 0 ? (
            <Animated.View entering={FadeInUp.delay(225).duration(400)} style={styles.section}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginBottom: 8, fontWeight: '600' }}>
                Key Features
              </Text>
              <Surface style={[styles.detailCard, { backgroundColor: theme.colors.surfaceVariant }]} elevation={0}>
                {product.keyFeatures.slice(0, 10).map((feature) => (
                  <View key={feature} style={styles.featureRow}>
                    <Icon name="check-circle-outline" size={18} color={theme.colors.secondary} />
                    <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, flex: 1 }}>
                      {feature}
                    </Text>
                  </View>
                ))}
              </Surface>
            </Animated.View>
          ) : null}

          {hasCanonicalVariants && variantAttributes.length > 0 ? (
            <Animated.View entering={FadeInUp.delay(235).duration(400)} style={styles.section}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginBottom: 8, fontWeight: '600' }}>
                Options
              </Text>
              <Surface style={[styles.detailCard, { backgroundColor: theme.colors.surfaceVariant }]} elevation={0}>
                {variantAttributes.map((attribute) => (
                  <View key={attribute.name} style={styles.variantBlock}>
                    <Text variant="labelLarge" style={{ color: theme.colors.onSurface }}>
                      {attribute.name}
                    </Text>
                    <View style={styles.chipWrap}>
                      {attribute.values.map((value) => {
                        const isAvailable = canSelectVariantValue(attribute.name, value);
                        return (
                          <Chip
                            key={`${attribute.name}-${value}`}
                            accessibilityLabel={`Select ${attribute.name} ${value}`}
                            selected={selectedVariantOptions[attribute.name] === value}
                            disabled={!isAvailable}
                            onPress={() =>
                              setSelectedVariantOptions((current) => {
                                const next = { ...current };
                                if (next[attribute.name] === value) {
                                  delete next[attribute.name];
                                } else {
                                  next[attribute.name] = value;
                                }
                                return next;
                              })
                            }
                          >
                            {value}
                          </Chip>
                        );
                      })}
                    </View>
                  </View>
                ))}
                {!selectedVariant ? (
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                    Select all options to confirm stock and SKU.
                  </Text>
                ) : (
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                    SKU {selectedVariant.sku} • {selectedStock} available
                  </Text>
                )}
              </Surface>
            </Animated.View>
          ) : null}

          {!hasCanonicalVariants && product.variants && product.variants.length > 0 ? (
            <Animated.View entering={FadeInUp.delay(235).duration(400)} style={styles.section}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginBottom: 8, fontWeight: '600' }}>
                Variants
              </Text>
              <Surface style={[styles.detailCard, { backgroundColor: theme.colors.surfaceVariant }]} elevation={0}>
                {product.variants.map((variant) => (
                  <View key={variant.name} style={styles.variantBlock}>
                    <Text variant="labelLarge" style={{ color: theme.colors.onSurface }}>
                      {variant.name}
                    </Text>
                    <View style={styles.chipWrap}>
                      {variant.options.map((option) => (
                        <Chip
                          key={`${variant.name}-${option.value}`}
                          selected={selectedVariantOptions[variant.name] === option.value}
                          onPress={() =>
                            setSelectedVariantOptions((current) => ({
                              ...current,
                              [variant.name]: option.value,
                            }))
                          }
                        >
                          {option.priceDelta
                            ? `${option.value} ${option.priceDelta > 0 ? '+' : ''}${formatPrice(calculateDisplayPrice(option.priceDelta))}`
                            : option.value}
                        </Chip>
                      ))}
                    </View>
                  </View>
                ))}
              </Surface>
            </Animated.View>
          ) : null}

          {product.addOns && product.addOns.length > 0 ? (
            <Animated.View entering={FadeInUp.delay(240).duration(400)} style={styles.section}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginBottom: 8, fontWeight: '600' }}>
                Add-ons
              </Text>
              <Surface style={[styles.detailCard, { backgroundColor: theme.colors.surfaceVariant }]} elevation={0}>
                {product.addOns.map((addOn) => (
                  <Pressable
                    key={addOn.name}
                    style={styles.addOnRow}
                    onPress={() => {
                      if (addOn.isRequired) return;
                      setSelectedAddOns((current) => ({
                        ...current,
                        [addOn.name]: !current[addOn.name],
                      }));
                    }}
                  >
                    <Icon
                      name={addOn.isRequired || selectedAddOns[addOn.name] ? 'checkbox-marked-circle' : 'checkbox-blank-circle-outline'}
                      size={22}
                      color={addOn.isRequired || selectedAddOns[addOn.name] ? theme.colors.primary : theme.colors.onSurfaceVariant}
                    />
                    <View style={{ flex: 1 }}>
                      <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                        {addOn.name}{addOn.isRequired ? ' • Required' : ''}
                      </Text>
                      {addOn.description ? (
                        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                          {addOn.description}
                        </Text>
                      ) : null}
                    </View>
                    <Text variant="bodyMedium" style={{ color: theme.colors.primary }}>
                      {formatPrice(addOn.price)}
                    </Text>
                  </Pressable>
                ))}
              </Surface>
            </Animated.View>
          ) : null}

          {/* Description */}
          <Animated.View entering={FadeInUp.delay(250).duration(400)} style={styles.section}>
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginBottom: 8, fontWeight: '600' }}>
              Description
            </Text>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, lineHeight: 22 }}>
              {product.description}
            </Text>
          </Animated.View>

          {productDetailRows.length > 0 ? (
            <Animated.View entering={FadeInUp.delay(275).duration(400)} style={styles.section}>
              <Pressable
                style={styles.detailsToggle}
                onPress={() => setDetailsExpanded((current) => !current)}
              >
                <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                  Product Details
                </Text>
                <Icon
                  name={detailsExpanded ? 'chevron-up' : 'chevron-down'}
                  size={22}
                  color={theme.colors.onSurfaceVariant}
                />
              </Pressable>
              {detailsExpanded ? (
                <Surface style={[styles.detailCard, { backgroundColor: theme.colors.surfaceVariant }]} elevation={0}>
                  {productDetailRows.map((row) => (
                    <View key={`${row.label}-${row.value}`} style={styles.detailTableRow}>
                      <Text variant="bodySmall" style={[styles.detailTableLabel, { color: theme.colors.onSurfaceVariant }]}>
                        {row.label}
                      </Text>
                      <Text variant="bodyMedium" style={[styles.detailTableValue, { color: theme.colors.onSurface }]}>
                        {row.value}
                      </Text>
                    </View>
                  ))}
                </Surface>
              ) : null}
            </Animated.View>
          ) : null}

          <Animated.View entering={FadeInUp.delay(285).duration(400)} style={styles.section}>
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginBottom: 8, fontWeight: '600' }}>
              Delivery Estimate
            </Text>
            <Surface style={[styles.detailCard, { backgroundColor: theme.colors.surfaceVariant }]} elevation={0}>
              {deliveryQuote && deliveryQuote.length > 0 ? (
                deliveryQuote.slice(0, 3).map((quote) => (
                  <View key={quote.methodId} style={styles.specRow}>
                    <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, flex: 1 }}>
                      {quote.name}
                    </Text>
                    <Text variant="bodyMedium" style={{ color: theme.colors.primary, flex: 1, textAlign: 'right' }}>
                      {quote.fee > 0 ? formatPrice(quote.fee) : 'Free'} • {quote.minDays}-{quote.maxDays} days
                    </Text>
                  </View>
                ))
              ) : (
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  Delivery quote will be confirmed at checkout.
                </Text>
              )}
            </Surface>
          </Animated.View>

          {/* Store Info */}
          <Animated.View entering={FadeInUp.delay(300).duration(400)}>
            <Pressable onPress={handleSellerPress}>
              <Surface style={[styles.sellerCard, { backgroundColor: theme.colors.surfaceVariant }]} elevation={0}>
                <Avatar.Text
                  size={52}
                  label={product.seller?.displayName?.[0] || product.seller?.firstName?.[0] || 'G'}
                  style={{ backgroundColor: theme.colors.primary }}
                />
                <View style={styles.sellerInfo}>
                  <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                    {product.seller?.displayName || 'Gettitonline'}
                  </Text>
                  <View style={styles.sellerStats}>
                    {product.seller?.rating && (
                      <View style={styles.ratingRow}>
                        <Icon name="star" size={16} color="#F59E0B" />
                        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginLeft: 4 }}>
                          {product.seller.rating.toFixed(1)} rating
                        </Text>
                      </View>
                    )}
                    <View style={styles.ratingRow}>
                      <Icon
                        name={product.seller?.isCompanyStore ? 'storefront-outline' : 'check-decagram'}
                        size={16}
                        color={theme.colors.primary}
                      />
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginLeft: 4 }}>
                        {product.seller?.isCompanyStore
                          ? 'Official Gettitonline store'
                          : 'Approved vendor storefront'}
                      </Text>
                    </View>
                  </View>
                </View>
                <Icon name="chevron-right" size={24} color={theme.colors.onSurfaceVariant} />
              </Surface>
            </Pressable>

            {/* Contact Store Button - only show if not own product */}
            {!isOwnProduct && (
              <Button
                mode="outlined"
                onPress={handleContactSeller}
                style={styles.contactSellerButton}
                icon="message-text-outline"
              >
                {existingConversation ? 'Continue Conversation' : 'Contact Store'}
              </Button>
            )}
          </Animated.View>

          {productReviews && productReviews.length > 0 ? (
            <Animated.View entering={FadeInUp.delay(325).duration(400)} style={styles.section}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginBottom: 8, fontWeight: '600' }}>
                Reviews
              </Text>
              <Surface style={[styles.detailCard, { backgroundColor: theme.colors.surfaceVariant }]} elevation={0}>
                {productReviews.slice(0, 3).map((review) => (
                  <View key={review._id} style={styles.reviewBlock}>
                    <View style={styles.reviewHeader}>
                      <View style={styles.ratingRow}>
                        {[1, 2, 3, 4, 5].map((star) => (
                          <Icon
                            key={star}
                            name={star <= review.rating ? 'star' : 'star-outline'}
                            size={15}
                            color="#F59E0B"
                          />
                        ))}
                      </View>
                      <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                        {review.reviewer?.firstName ?? 'Buyer'}
                      </Text>
                    </View>
                    {review.title ? (
                      <Text variant="labelLarge" style={{ color: theme.colors.onSurface, marginTop: 6 }}>
                        {review.title}
                      </Text>
                    ) : null}
                    {review.comment ? (
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                        {review.comment}
                      </Text>
                    ) : null}
                    {review.photoUrls && review.photoUrls.length > 0 ? (
                      <View style={styles.reviewPhotoRow}>
                        {review.photoUrls.slice(0, 4).map((url) => (
                          <Image key={url} source={{ uri: url }} style={styles.reviewPhoto} />
                        ))}
                      </View>
                    ) : null}
                  </View>
                ))}
              </Surface>
            </Animated.View>
          ) : null}

          {/* Product Stats */}
          <Animated.View entering={FadeInUp.delay(350).duration(400)} style={styles.statsRow}>
            {canShowProductStats && (
              <View style={[styles.statItem, { backgroundColor: theme.colors.surfaceVariant }]}>
                <Icon name="eye" size={20} color={theme.colors.onSurfaceVariant} />
                <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                  {product.views} views
                </Text>
              </View>
            )}
            <View style={[styles.statItem, { backgroundColor: theme.colors.surfaceVariant }]}>
              <Icon name="heart" size={20} color={theme.colors.error} />
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                {isFavorited ? 'Saved' : 'Save'}
              </Text>
            </View>
            <View style={[styles.statItem, { backgroundColor: theme.colors.surfaceVariant }]}>
              <Icon name="clock-outline" size={20} color={theme.colors.onSurfaceVariant} />
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                {getTimeAgo(product.createdAt)}
              </Text>
            </View>
          </Animated.View>

          {/* Safety Info */}
          <Animated.View entering={FadeInUp.delay(400).duration(400)}>
            <Surface style={[styles.safetyCard, { backgroundColor: theme.colors.primaryContainer }]} elevation={0}>
              <Icon name="shield-check" size={24} color={theme.colors.primary} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text variant="labelLarge" style={{ color: theme.colors.onPrimaryContainer, fontWeight: '600' }}>
                  Secure Escrow Payment
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onPrimaryContainer, marginTop: 2, opacity: 0.8 }}>
                  Your payment is protected until you confirm delivery
                </Text>
              </View>
            </Surface>
          </Animated.View>
        </View>
      </ScrollView>

      {/* Bottom Action Bar */}
      {!isOwnProduct && product.status === 'active' && (
        <Animated.View
          entering={FadeInUp.delay(450).duration(400)}
          style={[styles.bottomBar, { backgroundColor: theme.colors.surface }]}
        >
          <View style={styles.bottomBarContent}>
            <View>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Total Price
              </Text>
              <Text variant="titleLarge" style={{ color: theme.colors.primary, fontWeight: '700' }}>
                {formatPrice(displayPrice)}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {hasCanonicalVariants && !selectedVariant ? 'Choose options' : `${selectedStock} available`}
              </Text>
            </View>
            <Button
              mode="contained"
              onPress={handleAddToCart}
              style={styles.addToCartButton}
              contentStyle={styles.buttonContent}
              icon="cart-plus"
              disabled={selectedStock <= 0 || (hasCanonicalVariants && !selectedVariant)}
            >
              Add to Cart
            </Button>
          </View>
        </Animated.View>
      )}

      <Modal
        visible={imagePreviewVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setImagePreviewVisible(false)}
      >
        <View style={styles.imagePreviewBackdrop}>
          <Pressable
            style={styles.imagePreviewClose}
            onPress={() => setImagePreviewVisible(false)}
          >
            <Icon name="close" size={26} color="#FFFFFF" />
          </Pressable>

          {displayImages.length > 0 && (
            <ScrollView
              ref={imagePreviewScrollRef}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              contentOffset={{ x: previewImageIndex * width, y: 0 }}
              onMomentumScrollEnd={(event) => {
                const nextIndex = Math.round(event.nativeEvent.contentOffset.x / width);
                setPreviewImageIndex(nextIndex);
              }}
            >
              {displayImages.map((image, index) => (
                <View key={`${image}-${index}`} style={styles.imagePreviewSlide}>
                  <Image
                    source={{ uri: image }}
                    style={styles.imagePreviewImage}
                    resizeMode="contain"
                  />
                </View>
              ))}
            </ScrollView>
          )}

          {displayImages.length > 0 && (
            <View style={styles.imagePreviewCounter}>
              <Text style={styles.imagePreviewCounterText}>
                {previewImageIndex + 1}/{displayImages.length}
              </Text>
            </View>
          )}
        </View>
      </Modal>

      <Modal
        visible={cartPromptVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setCartPromptVisible(false)}
      >
        <View style={styles.cartModalBackdrop}>
          <Surface style={[styles.cartModalCard, { backgroundColor: theme.colors.surface }]} elevation={4}>
            <View style={styles.cartModalHeader}>
              <View>
                <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                  Added to cart
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                  Review your cart or continue shopping.
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close cart confirmation"
                onPress={() => setCartPromptVisible(false)}
                style={styles.cartModalClose}
              >
                <Icon name="close" size={22} color={theme.colors.onSurfaceVariant} />
              </Pressable>
            </View>
            <View style={styles.cartModalActions}>
              <Button mode="outlined" onPress={() => setCartPromptVisible(false)} style={styles.cartModalButton}>
                Continue
              </Button>
              <Button
                mode="contained"
                onPress={() => {
                  setCartPromptVisible(false);
                  navigation.navigate('Cart');
                }}
                style={styles.cartModalButton}
                icon="cart-outline"
              >
                Proceed to Cart
              </Button>
            </View>
          </Surface>
        </View>
      </Modal>

      <Snackbar
        visible={snackbarVisible}
        onDismiss={() => setSnackbarVisible(false)}
        duration={2000}
        action={{
          label: 'View Cart',
          onPress: () => navigation.navigate('Cart'),
        }}
      >
        {snackbarMessage}
      </Snackbar>
    </View>
  );
}

function getTimeAgo(timestamp: number): string {
  return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageContainer: {
    position: 'relative',
  },
  imageWrapper: {
    width,
    height: 350,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  imagePlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  imagePreviewBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.96)',
    justifyContent: 'center',
  },
  imagePreviewClose: {
    position: 'absolute',
    top: 52,
    right: 18,
    zIndex: 2,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.14)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  imagePreviewSlide: {
    width,
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 12,
  },
  imagePreviewImage: {
    width: '100%',
    height: '100%',
  },
  imagePreviewCounter: {
    position: 'absolute',
    bottom: 48,
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  imagePreviewCounterText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  cartModalBackdrop: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  cartModalCard: {
    borderRadius: 16,
    padding: 16,
  },
  cartModalHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
  },
  cartModalClose: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cartModalActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
  },
  cartModalButton: {
    flex: 1,
    borderRadius: 12,
  },
  imageIndicators: {
    position: 'absolute',
    bottom: 16,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  indicator: {
    height: 8,
    borderRadius: 4,
  },
  imageCounter: {
    position: 'absolute',
    top: 16,
    left: 16,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  favoriteButton: {
    position: 'absolute',
    top: 12,
    right: 12,
  },
  favoriteButtonWithDiscount: {
    top: 64,
  },
  favoriteCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    padding: 16,
    paddingBottom: 120,
  },
  saleBadge: {
    position: 'absolute',
    top: 16,
    right: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
  },
  saleBadgeText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
  },
  brandSellerBlock: {
    gap: 6,
    marginTop: 8,
  },
  soldByRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 8,
  },
  compareAtPrice: {
    textDecorationLine: 'line-through',
  },
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 12,
    gap: 8,
  },
  conditionTag: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  newBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: '#F59E0B',
  },
  tag: {
    height: 28,
  },
  section: {
    marginTop: 24,
  },
  detailsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  detailCard: {
    borderRadius: 16,
    padding: 14,
    gap: 10,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  variantBlock: {
    gap: 8,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  addOnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  specRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 4,
  },
  detailTableRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.06)',
  },
  detailTableLabel: {
    flex: 1,
  },
  detailTableValue: {
    flex: 1.35,
    textAlign: 'right',
  },
  sellerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 16,
    marginTop: 24,
  },
  sellerInfo: {
    flex: 1,
    marginLeft: 12,
  },
  sellerStats: {
    marginTop: 4,
    gap: 4,
  },
  contactSellerButton: {
    marginTop: 12,
    borderRadius: 12,
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  reviewBlock: {
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.06)',
  },
  reviewHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  reviewPhotoRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  reviewPhoto: {
    width: 56,
    height: 56,
    borderRadius: 10,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 24,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 16,
    borderRadius: 12,
  },
  safetyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 16,
    marginTop: 24,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.1)',
  },
  bottomBarContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  addToCartButton: {
    borderRadius: 12,
    minWidth: 160,
  },
  buttonContent: {
    paddingVertical: 6,
  },
});
