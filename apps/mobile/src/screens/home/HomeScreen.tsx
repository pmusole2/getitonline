import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from 'convex/react';
import React, { useState } from 'react';
import { Dimensions, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Chip, Searchbar, Surface, Text, useTheme } from 'react-native-paper';
import Animated, { FadeInDown, SlideInRight } from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { AIAssistantFAB, AIAssistantModal, AIInsightCard } from '../../components/ui/AIAssistant';
import { AnimatedProductCard, ProductGrid } from '../../components/ui/AnimatedProductCard';
import { TabHeader } from '../../components/ui/Header';
import { CategoryChipSkeleton, ListSkeleton } from '../../components/ui/Skeleton';
import { useAppAuth } from '../../context/AuthProvider';
import { useGuestCart } from '../../context/GuestCartProvider';
import { useAIRecommendations } from '../../hooks/useAIRecommendations';
import type { CategoryTreeItem, RootStackParamList } from '../../types';

const { width } = Dimensions.get('window');

interface Notification {
  isRead: boolean;
}

export default function HomeScreen() {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { user } = useAppAuth();
  const { summary: guestCartSummary } = useGuestCart();
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [aiModalVisible, setAIModalVisible] = useState(false);

  const categories = useQuery(api.categories.getCategoriesTree);
  const recentProducts = useQuery(api.products.getRecentProducts, { limit: 10 });

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
    user ? { userId: user._id } : 'skip'
  );
  const cartCount = user ? cart?.itemCount || 0 : guestCartSummary.itemCount;

  // Get notification count
  const notifications = useQuery(
    api.notifications.getUserNotifications,
    user ? { userId: user._id } : 'skip'
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
        showNotifications={!!user}
        notificationCount={unreadCount}
        onNotificationPress={handleNotificationPress}
        showAIAssistant
        onAIPress={() => setAIModalVisible(true)}
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
            elevation={0}
          />
        </Animated.View>

        {/* AI Insight Card */}
        <Animated.View entering={FadeInDown.delay(150).duration(400)} style={styles.aiSection}>
          <AIInsightCard
            title="AI Shopping Assistant"
            description="Ask me about products, track orders, or get help with disputes"
            icon="robot"
            onPress={() => setAIModalVisible(true)}
          />
        </Animated.View>

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

        {/* Categories */}
        <Animated.View entering={FadeInDown.delay(200).duration(400)} style={styles.section}>
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
              contentContainerStyle={styles.categoriesContainer}
            >
              {categories.map((category, index) => (
                <Animated.View key={category._id} entering={SlideInRight.delay(index * 50).duration(300)}>
                  <Chip
                    mode="flat"
                    onPress={() => handleCategoryPress(category)}
                    style={[styles.categoryChip, { backgroundColor: theme.colors.surfaceVariant }]}
                    textStyle={{ color: theme.colors.onSurfaceVariant }}
                    icon={() => (
                      <Icon
                        name={getCategoryIcon(category.slug)}
                        size={18}
                        color={theme.colors.primary}
                      />
                    )}
                  >
                    {category.name}
                  </Chip>
                </Animated.View>
              ))}
            </ScrollView>
          )}
        </Animated.View>

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
              AI Support
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
                  onPress={() => handleProductPress(product._id)}
                />
              ))}
            </ProductGrid>
          )}
        </Animated.View>
      </ScrollView>

      {/* AI Assistant FAB */}
      <AIAssistantFAB onPress={() => setAIModalVisible(true)} />

      {/* AI Assistant Modal */}
      <AIAssistantModal
        visible={aiModalVisible}
        onClose={() => setAIModalVisible(false)}
        currentScreen="Home"
      />
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
  aiSection: {
    paddingHorizontal: 16,
    marginBottom: 16,
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
