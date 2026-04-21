import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery } from 'convex/react';
import { differenceInHours, formatDistanceToNow } from 'date-fns';
import { MotiView } from 'moti';
import React, { useEffect, useRef, useState } from 'react';
import { Alert, Dimensions, Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
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
import type { Id, ProductCondition, RootStackParamList } from '../../types';
import { canManageCatalog } from '../../utils/roles';

const { width } = Dimensions.get('window');
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type Props = NativeStackScreenProps<RootStackParamList, 'ProductDetail'>;

export default function ProductDetailScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { productId } = route.params;
  const { user } = useAppAuth();
  const { addItem: addGuestCartItem } = useGuestCart();
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [snackbarVisible, setSnackbarVisible] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState('');
  const scrollY = useSharedValue(0);
  const favoriteScale = useSharedValue(1);

  const product = useQuery(api.products.getProduct, {
    productId: productId as Id<'products'>,
    viewerUserId: user?._id,
  });
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
  const startConversation = useMutation(api.conversations.startConversation);

  // Check for existing conversation
  const existingConversation = useQuery(
    api.conversations.getExistingConversation,
    user && product && !managesCurrentStoreProduct && user._id !== product.sellerId
      ? { productId: product._id, buyerId: user._id }
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
    }
  }, [incrementViews, managesCurrentStoreProduct, product, user]);

  const favoriteAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: favoriteScale.value }],
  }));

  const handleAddToCart = async () => {
    if (!product) return;

    try {
      // Use product's shipping option, default to free delivery
      const shippingOption = product.shippingOptions?.[0] || { name: 'Free Delivery', price: 0 };

      if (user) {
        await addToCart({
          userId: user._id,
          productId: product._id,
          quantity: 1,
          selectedShipping: { name: shippingOption.name, price: shippingOption.price },
        });
      } else {
        addGuestCartItem({
          productId: product._id,
          quantity: 1,
          selectedShipping: { name: shippingOption.name, price: shippingOption.price },
          product: {
            _id: product._id,
            sellerId: product.sellerId,
            sellerName: product.seller?.displayName || 'Gettitonline',
            title: product.title,
            price: product.price,
            images: product.images,
            quantity: product.quantity,
            status: product.status,
            shippingOptions: product.shippingOptions ?? [],
          },
          addedAt: Date.now(),
        });
      }

      setSnackbarMessage('Added to cart!');
      setSnackbarVisible(true);
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
        showAIIndicator
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
              {product.images.length > 0 ? (
                product.images.map((image, index) => (
                  <Pressable key={index} style={styles.imageWrapper}>
                    <Image
                      source={{ uri: image }}
                      style={styles.image}
                      resizeMode="cover"
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
            {product.images.length > 1 && (
              <View style={styles.imageIndicators}>
                {product.images.map((_, index) => (
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
            {product.images.length > 0 && (
              <View style={[styles.imageCounter, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
                <Text style={{ color: '#fff', fontSize: 12 }}>
                  {currentImageIndex + 1}/{product.images.length}
                </Text>
              </View>
            )}

            {/* Favorite Button */}
            {!isOwnProduct && (
              <AnimatedPressable
                style={[styles.favoriteButton, favoriteAnimatedStyle]}
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

            <Text variant="headlineMedium" style={{ color: theme.colors.primary, marginTop: 8, fontWeight: '700' }}>
              {formatPrice(calculateDisplayPrice(product.price))}
            </Text>
          </Animated.View>

          <Animated.View entering={FadeInUp.delay(150).duration(400)} style={styles.tagsRow}>
            {isNewProduct(product.createdAt) && (
              <Surface style={[styles.newBadge]} elevation={0}>
                <Icon name="star-four-points" size={12} color="#fff" style={{ marginRight: 4 }} />
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 11 }}>
                  NEW
                </Text>
              </Surface>
            )}
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
          </Animated.View>

          {/* AI Price Insight */}
          <Animated.View entering={FadeInUp.delay(200).duration(400)}>
            <Surface style={[styles.aiInsight, { backgroundColor: theme.colors.tertiaryContainer }]} elevation={0}>
              <View style={styles.aiInsightHeader}>
                <Icon name="robot" size={20} color={theme.colors.tertiary} />
                <Text variant="labelMedium" style={{ color: theme.colors.tertiary, marginLeft: 8, fontWeight: '600' }}>
                  AI Price Analysis
                </Text>
              </View>
              <Text variant="bodySmall" style={{ color: theme.colors.onTertiaryContainer, marginTop: 4 }}>
                This price is competitive for similar items in {typeof product.location === 'string' ? 'your area' : product.location?.city || 'your area'}.
              </Text>
            </Surface>
          </Animated.View>

          {/* Description */}
          <Animated.View entering={FadeInUp.delay(250).duration(400)} style={styles.section}>
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginBottom: 8, fontWeight: '600' }}>
              Description
            </Text>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, lineHeight: 22 }}>
              {product.description}
            </Text>
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

          {/* Product Stats */}
          <Animated.View entering={FadeInUp.delay(350).duration(400)} style={styles.statsRow}>
            <View style={[styles.statItem, { backgroundColor: theme.colors.surfaceVariant }]}>
              <Icon name="eye" size={20} color={theme.colors.onSurfaceVariant} />
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                {product.views} views
              </Text>
            </View>
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
                {formatPrice(calculateDisplayPrice(product.price))}
              </Text>
            </View>
            <Button
              mode="contained"
              onPress={handleAddToCart}
              style={styles.addToCartButton}
              contentStyle={styles.buttonContent}
              icon="cart-plus"
            >
              Add to Cart
            </Button>
          </View>
        </Animated.View>
      )}

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

function isNewProduct(timestamp: number): boolean {
  return differenceInHours(new Date(), new Date(timestamp)) < 48;
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
  aiInsight: {
    padding: 16,
    borderRadius: 16,
    marginTop: 16,
  },
  aiInsightHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  section: {
    marginTop: 24,
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
