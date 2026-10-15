import React, { useState } from 'react';
import { View, StyleSheet, FlatList, Pressable } from 'react-native';
import { Text, Searchbar, useTheme, Chip, Surface } from 'react-native-paper';
import Animated, { FadeIn, FadeInDown, FadeInRight, useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { useQuery } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import type { RootStackParamList, CategoryTreeItem } from '../../types';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { CategoryChipSkeleton } from '../../components/ui/Skeleton';
import { TabHeader } from '../../components/ui/Header';
import { useAccountAccess } from '../../components/auth/useAccountAccess';
import { useAppAuth } from '../../context/AuthProvider';
import { useGuestCart } from '../../context/GuestCartProvider';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface CategoryCardProps {
  category: CategoryTreeItem;
  index: number;
  onPress: () => void;
  onSubcategoryPress: (sub: CategoryTreeItem) => void;
}

function AnimatedCategoryCard({ category, index, onPress, onSubcategoryPress }: CategoryCardProps) {
  const theme = useTheme();
  const scale = useSharedValue(1);

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
    <Animated.View entering={FadeInDown.delay(index * 100).duration(400).springify()}>
      <AnimatedPressable
        style={animatedStyle}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        onPress={onPress}
      >
        <Surface style={[styles.categoryCard, { backgroundColor: theme.colors.surface }]} elevation={2}>
          <View style={styles.categoryContent}>
            <View style={[styles.iconContainer, { backgroundColor: theme.colors.primaryContainer }]}>
              <Icon name={getCategoryIcon(category.slug)} size={32} color={theme.colors.primary} />
            </View>
            <View style={styles.categoryInfo}>
              <Text variant="titleMedium" style={[styles.categoryName, { color: theme.colors.onSurface }]}>
                {category.name}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {category.subcategories.length} subcategories
              </Text>
            </View>
            <Icon name="chevron-right" size={24} color={theme.colors.onSurfaceVariant} />
          </View>

          {category.subcategories.length > 0 && (
            <View style={styles.subcategoriesContainer}>
              {category.subcategories.slice(0, 4).map((sub, subIndex) => (
                <Animated.View key={sub._id} entering={FadeInRight.delay(index * 100 + subIndex * 50).duration(300)}>
                  <Chip
                    mode="flat"
                    compact
                    style={[styles.subChip, { backgroundColor: theme.colors.surfaceVariant }]}
                    textStyle={[styles.subChipText, { color: theme.colors.onSurfaceVariant }]}
                    onPress={() => onSubcategoryPress(sub as CategoryTreeItem)}
                  >
                    {sub.name}
                  </Chip>
                </Animated.View>
              ))}
              {category.subcategories.length > 4 && (
                <Chip
                  mode="flat"
                  compact
                  style={[styles.subChip, { backgroundColor: theme.colors.primaryContainer }]}
                  textStyle={[styles.subChipText, { color: theme.colors.primary }]}
                >
                  +{category.subcategories.length - 4} more
                </Chip>
              )}
            </View>
          )}
        </Surface>
      </AnimatedPressable>
    </Animated.View>
  );
}

export default function BrowseScreen() {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { user } = useAppAuth();
  // The signed-in cart is read only for a ready account; guests still see the public browse screen.
  const accountReady = useAccountAccess().status === 'ready';
  const { summary: guestCartSummary } = useGuestCart();
  const [searchQuery, setSearchQuery] = useState('');

  const categories = useQuery(api.categories.getCategoriesTree);
  const cart = useQuery(
    api.cart.getCart,
    accountReady ? {} : 'skip'
  );
  const cartCount = user ? cart?.itemCount || 0 : guestCartSummary.itemCount;

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

  const handleStoresPress = () => {
    navigation.navigate('StoresDirectory');
  };

  const renderCategory = ({ item, index }: { item: CategoryTreeItem; index: number }) => (
    <AnimatedCategoryCard
      category={item}
      index={index}
      onPress={() => handleCategoryPress(item)}
      onSubcategoryPress={(sub) =>
        navigation.navigate('CategoryProducts', {
          categoryId: sub._id,
          categoryName: sub.name,
        })
      }
    />
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <TabHeader
        title="Browse"
        subtitle="Explore products by category"
        showCart
        cartCount={cartCount}
        onCartPress={() => navigation.navigate('Cart')}
        showAIAssistant
      />

      {/* Search Bar */}
      <Animated.View entering={FadeInDown.delay(100).duration(400)} style={styles.searchContainer}>
        <Searchbar
          placeholder="Search all products..."
          value={searchQuery}
          onChangeText={setSearchQuery}
          onSubmitEditing={handleSearch}
          style={[styles.searchBar, { backgroundColor: theme.colors.surfaceVariant }]}
          inputStyle={{ fontSize: 14 }}
          icon="magnify"
          elevation={0}
        />
      </Animated.View>

      {/* Quick Filters */}
      <Animated.View entering={FadeInDown.delay(150).duration(400)} style={styles.quickFilters}>
        <Pressable
          style={[styles.quickFilter, { backgroundColor: theme.colors.primaryContainer }]}
          onPress={() => navigation.navigate('Search', { query: 'new' })}
        >
          <Icon name="tag-check" size={20} color={theme.colors.primary} />
          <Text variant="labelMedium" style={{ color: theme.colors.primary, marginLeft: 6 }}>
            New Arrivals
          </Text>
        </Pressable>
        <Pressable
          style={[styles.quickFilter, { backgroundColor: theme.colors.secondaryContainer }]}
          onPress={() => navigation.navigate('Search', {})}
        >
          <Icon name="currency-usd" size={20} color={theme.colors.secondary} />
          <Text variant="labelMedium" style={{ color: theme.colors.secondary, marginLeft: 6 }}>
            Best Deals
          </Text>
        </Pressable>
        <Pressable
          style={[styles.quickFilter, { backgroundColor: theme.colors.tertiaryContainer }]}
          onPress={() => navigation.navigate('Search', {})}
        >
          <Icon name="fire" size={20} color={theme.colors.tertiary} />
          <Text variant="labelMedium" style={{ color: theme.colors.tertiary, marginLeft: 6 }}>
            Popular
          </Text>
        </Pressable>
      </Animated.View>

      <Animated.View entering={FadeInDown.delay(175).duration(400)} style={styles.storesSection}>
        <Pressable
          style={[styles.storesCallout, { backgroundColor: theme.colors.secondaryContainer }]}
          onPress={handleStoresPress}
        >
          <View style={[styles.storesIcon, { backgroundColor: theme.colors.secondary + '20' }]}>
            <Icon name="storefront-outline" size={24} color={theme.colors.secondary} />
          </View>
          <View style={styles.storesContent}>
            <Text variant="titleMedium" style={{ color: theme.colors.onSecondaryContainer, fontWeight: '600' }}>
              Explore Stores
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSecondaryContainer, opacity: 0.82 }}>
              Browse official and approved vendor storefronts in one place.
            </Text>
          </View>
          <Icon name="chevron-right" size={24} color={theme.colors.secondary} />
        </Pressable>
      </Animated.View>

      {/* Categories List */}
      <Animated.View entering={FadeInDown.delay(200).duration(400)} style={styles.sectionHeader}>
        <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
          All Categories
        </Text>
      </Animated.View>

      {categories === undefined ? (
        <View style={styles.loadingContainer}>
          {[1, 2, 3, 4, 5].map((i) => (
            <View key={i} style={styles.skeletonCard}>
              <View style={styles.skeletonRow}>
                <CategoryChipSkeleton />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <View style={[styles.skeleton, { width: '60%', height: 18 }]} />
                  <View style={[styles.skeleton, { width: '40%', height: 14, marginTop: 8 }]} />
                </View>
              </View>
            </View>
          ))}
        </View>
      ) : (
        <FlatList
          data={categories}
          renderItem={renderCategory}
          keyExtractor={(item) => item._id}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

function getCategoryIcon(slug: string): string {
  const icons: Record<string, string> = {
    engines: 'engine',
    'body-parts': 'car-door',
    electronics: 'chip',
    interior: 'car-seat',
    wheels: 'tire',
    accessories: 'car-cog',
    tools: 'tools',
    'auto-parts': 'car-cog',
    'car-accessories': 'car',
    'tech-electronics': 'laptop',
    'home-garden': 'home',
    fashion: 'tshirt-crew',
    'sports-outdoors': 'basketball',
    other: 'dots-horizontal',
    default: 'tag',
  };
  return icons[slug] || icons.default;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  searchContainer: {
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  searchBar: {
    borderRadius: 16,
    elevation: 0,
  },
  quickFilters: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 8,
    marginBottom: 16,
  },
  quickFilter: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
  },
  storesSection: {
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  storesCallout: {
    borderRadius: 18,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  storesIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  storesContent: {
    flex: 1,
    gap: 4,
  },
  sectionHeader: {
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  listContent: {
    padding: 16,
    paddingTop: 0,
    paddingBottom: 100,
  },
  categoryCard: {
    borderRadius: 16,
    marginBottom: 12,
    overflow: 'hidden',
  },
  categoryContent: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
  },
  iconContainer: {
    width: 56,
    height: 56,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  categoryInfo: {
    flex: 1,
    marginLeft: 12,
  },
  categoryName: {
    fontWeight: '600',
    marginBottom: 2,
  },
  subcategoriesContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    paddingBottom: 16,
    gap: 8,
  },
  subChip: {
    height: 30,
    borderRadius: 15,
  },
  subChipText: {
    fontSize: 12,
  },
  loadingContainer: {
    padding: 16,
  },
  skeletonCard: {
    backgroundColor: 'rgba(0,0,0,0.05)',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  skeleton: {
    backgroundColor: 'rgba(0,0,0,0.1)',
    borderRadius: 8,
  },
});
