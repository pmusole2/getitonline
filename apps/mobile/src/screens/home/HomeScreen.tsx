import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from 'convex/react';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import React, { useState } from 'react';
import { Alert, Dimensions, Image, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Chip, IconButton, Searchbar, Surface, Text, useTheme } from 'react-native-paper';
import Animated, { FadeInDown, SlideInRight } from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { AnimatedProductCard, ProductGrid } from '../../components/ui/AnimatedProductCard';
import { TabHeader } from '../../components/ui/Header';
import { CategoryChipSkeleton, ListSkeleton } from '../../components/ui/Skeleton';
import { ASSISTANT_NAME } from '../../config/assistant';
import { useAccountAccess } from '../../components/auth/useAccountAccess';
import { useAppAuth } from '../../context/AuthProvider';
import { useGuestCart } from '../../context/GuestCartProvider';
import { useAIRecommendations } from '../../hooks/useAIRecommendations';
import { formatPrice } from '../../theme';
import type { CategoryTreeItem, RootStackParamList } from '../../types';

const { width } = Dimensions.get('window');

interface Notification {
  isRead: boolean;
}

function normalizeImageUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export default function HomeScreen() {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { user } = useAppAuth();
  // The signed-in cart and notifications are read only for a ready account; guests still see the public home.
  const accountReady = useAccountAccess().status === 'ready';
  const { summary: guestCartSummary } = useGuestCart();
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const categories = useQuery(api.categories.getCategoriesTree);
  const recentProducts = useQuery(api.products.getRecentProducts, { limit: 10 });
  const trendingProducts = useQuery(api.products.getPopularProducts, { limit: 6 });
  const monthlyBanners = useQuery(api.promotions.listActiveBanners, { placement: 'home_monthly' });
  const heroBanners = useQuery(api.promotions.listActiveBanners, { placement: 'home_hero' });
  const stripBanners = useQuery(api.promotions.listActiveBanners, { placement: 'home_strip' });
  const deals = useQuery(api.promotions.listActivePromotions, { type: 'deal_of_day', limit: 6 });
  const monthlyCarouselBanners = monthlyBanners && monthlyBanners.length > 0 ? monthlyBanners : heroBanners;

  // AI Recommendations
  const {
    recommendations,
    isLoading: isLoadingRecommendations,
    reasoning: recommendationReasoning,
    refetch: refetchRecommendations
  } = useAIRecommendations({ limit: 6, enabled: !!user });

  // Get cart item count
  const cart = useQuery(
    api.cart.getCart,
    accountReady ? {} : 'skip'
  );
  const cartCount = user ? cart?.itemCount || 0 : guestCartSummary.itemCount;

  // Get notification count
  const notifications = useQuery(
    api.notifications.getUserNotifications,
    accountReady ? {} : 'skip'
  );
  const unreadCount = notifications?.filter((n: Notification) => !n.isRead).length || 0;

  const onRefresh = React.useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  }, []);

  const handleSearch = () => {
    if (searchQuery.trim()) {
      navigation.navigate('Search', { query: searchQuery });
    }
  };

  const handleImageSearch = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Camera permission required', 'Allow camera access to start an image search.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
    });

    const asset = result.canceled ? undefined : result.assets[0];
    if (asset?.uri) {
      try {
        const preparedImage = await ImageManipulator.manipulateAsync(
          asset.uri,
          [{ resize: { width: 512 } }],
          {
            compress: 0.35,
            format: ImageManipulator.SaveFormat.JPEG,
            base64: true,
          },
        );
        navigation.navigate('Search', {
          imageUri: preparedImage.uri,
          imageDataUrl: preparedImage.base64
            ? `data:image/jpeg;base64,${preparedImage.base64}`
            : undefined,
        });
      } catch {
        navigation.navigate('Search', { imageUri: asset.uri });
      }
    }
  };

  const handleCategoryPress = (category: CategoryTreeItem) => {
    navigation.navigate('CategoryProducts', {
      categoryId: category._id,
      categoryName: category.name,
    });
  };

  const handleProductPress = (productId: string) => {
    navigation.navigate('ProductDetail', { productId });
  };

  const handleCartPress = () => {
    navigation.navigate('Cart');
  };

  const handleNotificationPress = () => {
    if (!user) {
      navigation.navigate('Auth');
      return;
    }

    navigation.navigate('Notifications');
  };

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Custom Futuristic Header */}
      <TabHeader
        title="Home"
        greeting={getGreeting()}
        userName={user?.firstName || 'Welcome'}
        showCart
        cartCount={cartCount}
        onCartPress={handleCartPress}
        showAIAssistant
        showNotifications={!!user}
        notificationCount={unreadCount}
        onNotificationPress={handleNotificationPress}
      />

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Search Bar */}
        <Animated.View entering={FadeInDown.delay(100).duration(400)} style={styles.searchContainer}>
          <Searchbar
            placeholder="Search fashion, electronics, essentials..."
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={handleSearch}
            style={[styles.searchBar, { backgroundColor: theme.colors.surfaceVariant }]}
            inputStyle={{ fontSize: 14 }}
            icon="magnify"
            right={(props) => (
              <IconButton
                {...props}
                icon="camera-outline"
                onPress={() => void handleImageSearch()}
                accessibilityLabel="Search by image"
              />
            )}
            elevation={0}
          />
        </Animated.View>

        {/* Categories */}
        <Animated.View entering={FadeInDown.delay(150).duration(400)} style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
              Categories
            </Text>
            <Pressable onPress={() => navigation.navigate('Browse' as never)}>
              <Text variant="labelLarge" style={{ color: theme.colors.primary }}>
                See All
              </Text>
            </Pressable>
          </View>

          {categories === undefined ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoriesContainer}>
              {[1, 2, 3, 4, 5].map((i) => (
                <View key={i} style={{ marginRight: 8 }}>
                  <CategoryChipSkeleton />
                </View>
              ))}
            </ScrollView>
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.categoryTilesContainer}
            >
              {categories.map((category, index) => (
                <Animated.View
                  key={category._id}
                  entering={SlideInRight.delay(index * 50).duration(300)}
                  style={styles.categoryTileWrapper}
                >
                  <Pressable
                    onPress={() => handleCategoryPress(category)}
                    style={[styles.categoryTile, { backgroundColor: theme.colors.surface }]}
                  >
                    {category.image ? (
                      <Image source={{ uri: normalizeImageUrl(category.image) }} style={styles.categoryImage} resizeMode="cover" />
                    ) : (
                      <View style={[styles.categoryIconFallback, { backgroundColor: theme.colors.primaryContainer }]}>
                        <Icon name={getCategoryIcon(category.slug)} size={24} color={theme.colors.primary} />
                      </View>
                    )}
                    <Text
                      variant="labelMedium"
                      numberOfLines={2}
                      style={[styles.categoryTileLabel, { color: theme.colors.onSurface }]}
                    >
                      {category.name}
                    </Text>
                  </Pressable>
                </Animated.View>
              ))}
            </ScrollView>
          )}
        </Animated.View>

        {monthlyCarouselBanners && monthlyCarouselBanners.length > 0 && (
          <Animated.View entering={FadeInDown.delay(165).duration(400)} style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                Monthly Specials
              </Text>
              <Text variant="labelSmall" style={{ color: theme.colors.primary }}>
                Carousel
              </Text>
            </View>
            <ScrollView
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.bannerRail}
            >
              {monthlyCarouselBanners.slice(0, 5).map((banner) => (
                <Surface
                  key={banner._id}
                  style={[styles.heroBanner, { backgroundColor: theme.colors.surface }]}
                  elevation={1}
                >
                  <Image source={{ uri: normalizeImageUrl(banner.imageUrl) }} style={styles.heroBannerImage} resizeMode="cover" />
                  <View style={styles.heroBannerOverlay}>
                    <Text variant="titleMedium" style={styles.heroBannerTitle} numberOfLines={2}>
                      {banner.title}
                    </Text>
                    {banner.subtitle ? (
                      <Text variant="bodySmall" style={styles.heroBannerSubtitle} numberOfLines={2}>
                        {banner.subtitle}
                      </Text>
                    ) : null}
                  </View>
                </Surface>
              ))}
            </ScrollView>
          </Animated.View>
        )}

        {stripBanners && stripBanners.length > 0 && (
          <Animated.View entering={FadeInDown.delay(170).duration(400)} style={styles.stripSection}>
            {stripBanners.slice(0, 1).map((banner) => (
              <Surface
                key={banner._id}
                style={[styles.stripBanner, { backgroundColor: theme.colors.secondaryContainer }]}
                elevation={0}
              >
                <Icon name="bullhorn-outline" size={22} color={theme.colors.secondary} />
                <View style={{ flex: 1 }}>
                  <Text variant="titleSmall" style={{ color: theme.colors.onSecondaryContainer }}>
                    {banner.title}
                  </Text>
                  {banner.subtitle ? (
                    <Text variant="bodySmall" style={{ color: theme.colors.onSecondaryContainer, marginTop: 2 }}>
                      {banner.subtitle}
                    </Text>
                  ) : null}
                </View>
              </Surface>
            ))}
          </Animated.View>
        )}

        {deals && deals.length > 0 && (
          <Animated.View entering={FadeInDown.delay(172).duration(400)} style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionTitleRow}>
                <Icon name="flash-outline" size={20} color={theme.colors.error} style={{ marginRight: 8 }} />
                <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                  Deals of the Day
                </Text>
              </View>
              <Text variant="labelSmall" style={{ color: theme.colors.error }}>
                Limited time
              </Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dealsRail}>
              {deals.map((deal) => (
                <Surface key={deal._id} style={[styles.dealCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
                  <Text variant="titleSmall" style={{ color: theme.colors.onSurface }} numberOfLines={2}>
                    {deal.name}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 6 }}>
                    {deal.discountType === 'percent'
                      ? `${deal.discountValue ?? 0}% off`
                      : deal.discountType === 'fixed_amount'
                        ? `${formatPrice(deal.discountValue ?? 0)} off`
                        : 'Compare-at pricing'}
                  </Text>
                  <Chip compact style={styles.dealBadge}>{deal.type.replace(/_/g, ' ')}</Chip>
                </Surface>
              ))}
            </ScrollView>
          </Animated.View>
        )}

        {/* AI Recommendations Section */}
        {user && (
          <Animated.View entering={FadeInDown.delay(175).duration(400)} style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionTitleRow}>
                <Icon name="auto-fix" size={20} color={theme.colors.tertiary} style={{ marginRight: 8 }} />
                <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                  Recommended for You
                </Text>
              </View>
              <Pressable onPress={refetchRecommendations}>
                <Icon name="refresh" size={20} color={theme.colors.primary} />
              </Pressable>
            </View>

            {recommendationReasoning && (
              <Text
                variant="bodySmall"
                style={{
                  color: theme.colors.onSurfaceVariant,
                  paddingHorizontal: 16,
                  marginBottom: 12,
                  fontStyle: 'italic'
                }}
                numberOfLines={2}
              >
                {recommendationReasoning}
              </Text>
            )}

            {isLoadingRecommendations ? (
              <ListSkeleton count={3} type="product" />
            ) : recommendations.length > 0 ? (
              <ProductGrid>
                {recommendations.map((product, index) => (
                  <AnimatedProductCard
                    key={product._id}
                    product={product}
                    index={index}
                    viewerUser={user}
                    onPress={() => handleProductPress(product._id)}
                  />
                ))}
              </ProductGrid>
            ) : (
              <View style={styles.emptyRecommendations}>
                <Surface style={[styles.emptyCard, { backgroundColor: theme.colors.surfaceVariant }]}>
                  <Icon name="star-four-points" size={32} color={theme.colors.tertiary} />
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 12, textAlign: 'center' }}>
                    Browse more products to get personalized recommendations
                  </Text>
                </Surface>
              </View>
            )}
          </Animated.View>
        )}

        {trendingProducts && trendingProducts.length > 0 && (
          <Animated.View entering={FadeInDown.delay(275).duration(400)} style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                Trending Now
              </Text>
              <Pressable onPress={() => navigation.navigate('Search', {})}>
                <Text variant="labelLarge" style={{ color: theme.colors.primary }}>
                  View All
                </Text>
              </Pressable>
            </View>
            <ProductGrid>
              {trendingProducts.map((product, index) => (
                <AnimatedProductCard
                  key={product._id}
                  product={product}
                  index={index}
                  viewerUser={user}
                  onPress={() => handleProductPress(product._id)}
                />
              ))}
            </ProductGrid>
          </Animated.View>
        )}

        {/* Quick Stats */}
        <Animated.View entering={FadeInDown.delay(250).duration(400)} style={styles.statsContainer}>
          <Surface style={[styles.statCard, { backgroundColor: theme.colors.primaryContainer }]}>
            <Icon name="shield-check" size={24} color={theme.colors.primary} />
            <Text variant="titleSmall" style={{ color: theme.colors.onPrimaryContainer, marginTop: 8 }}>
              Secure Escrow
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onPrimaryContainer, opacity: 0.7 }}>
              Protected payments
            </Text>
          </Surface>
          <Surface style={[styles.statCard, { backgroundColor: theme.colors.secondaryContainer }]}>
            <Icon name="truck-fast" size={24} color={theme.colors.secondary} />
            <Text variant="titleSmall" style={{ color: theme.colors.onSecondaryContainer, marginTop: 8 }}>
              Fast Delivery
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSecondaryContainer, opacity: 0.7 }}>
              Nationwide shipping
            </Text>
          </Surface>
          <Surface style={[styles.statCard, { backgroundColor: theme.colors.tertiaryContainer }]}>
            <Icon name="creation" size={24} color={theme.colors.tertiary} />
            <Text variant="titleSmall" style={{ color: theme.colors.onTertiaryContainer, marginTop: 8 }}>
              Ask {ASSISTANT_NAME}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onTertiaryContainer, opacity: 0.7 }}>
              24/7 assistance
            </Text>
          </Surface>
        </Animated.View>

        {/* Recent Products */}
        <Animated.View entering={FadeInDown.delay(300).duration(400)} style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
              Recent Listings
            </Text>
            <Pressable onPress={() => navigation.navigate('Search', {})}>
              <Text variant="labelLarge" style={{ color: theme.colors.primary }}>
                View All
              </Text>
            </Pressable>
          </View>

          {recentProducts === undefined ? (
            <ListSkeleton count={4} type="product" />
          ) : recentProducts.length === 0 ? (
            <View style={styles.emptyState}>
              <Icon name="package-variant" size={48} color={theme.colors.onSurfaceVariant} />
              <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant, marginTop: 16 }}>
                No products yet. Be the first to sell!
              </Text>
            </View>
          ) : (
            <ProductGrid>
              {recentProducts.map((product, index) => (
                <AnimatedProductCard
                  key={product._id}
                  product={product}
                  index={index}
                  viewerUser={user}
                  onPress={() => handleProductPress(product._id)}
                />
              ))}
            </ProductGrid>
          )}
        </Animated.View>
      </ScrollView>

    </View>
  );
}

// Helper function to get category icons
function getCategoryIcon(slug: string): string {
  const icons: Record<string, string> = {
    engines: 'engine',
    'body-parts': 'car-door',
    electronics: 'chip',
    interior: 'car-seat',
    wheels: 'tire',
    accessories: 'car-cog',
    tools: 'tools',
    default: 'tag',
  };
  return icons[slug] || icons.default;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 100,
  },
  searchContainer: {
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  searchBar: {
    borderRadius: 16,
    elevation: 0,
  },
  section: {
    marginBottom: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  emptyRecommendations: {
    paddingHorizontal: 16,
  },
  emptyCard: {
    padding: 24,
    borderRadius: 16,
    alignItems: 'center',
  },
  categoriesContainer: {
    paddingHorizontal: 16,
    gap: 8,
  },
  bannerRail: {
    paddingHorizontal: 16,
    gap: 12,
  },
  heroBanner: {
    width: width - 32,
    height: 172,
    borderRadius: 18,
    overflow: 'hidden',
  },
  heroBannerImage: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  heroBannerOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    padding: 16,
    backgroundColor: 'rgba(0,0,0,0.28)',
  },
  heroBannerTitle: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
  heroBannerSubtitle: {
    color: '#FFFFFF',
    marginTop: 4,
  },
  stripSection: {
    paddingHorizontal: 16,
    marginBottom: 18,
  },
  stripBanner: {
    borderRadius: 16,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  dealsRail: {
    paddingHorizontal: 16,
    gap: 12,
  },
  dealCard: {
    width: 164,
    borderRadius: 16,
    padding: 14,
  },
  dealBadge: {
    marginTop: 12,
    alignSelf: 'flex-start',
  },
  categoryTilesContainer: {
    paddingHorizontal: 16,
    gap: 10,
  },
  categoryTileWrapper: {
    width: 108,
  },
  categoryTile: {
    width: 108,
    height: 118,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 12,
  },
  categoryImage: {
    width: 56,
    height: 56,
    borderRadius: 14,
  },
  categoryIconFallback: {
    width: 56,
    height: 56,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryTileLabel: {
    height: 34,
    lineHeight: 16,
    marginTop: 8,
    textAlign: 'center',
  },
  categoryChip: {
    marginRight: 8,
    borderRadius: 12,
  },
  statsContainer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 12,
    marginBottom: 24,
  },
  statCard: {
    flex: 1,
    padding: 16,
    borderRadius: 16,
    alignItems: 'center',
  },
  emptyState: {
    padding: 32,
    alignItems: 'center',
  },
});
