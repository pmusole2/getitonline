import React, { useEffect, useState } from 'react';
import { View, StyleSheet, FlatList, Dimensions, Pressable } from 'react-native';
import { Text, useTheme, Chip, Surface } from 'react-native-paper';
import Animated, {
  FadeIn,
  FadeInDown,
} from 'react-native-reanimated';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList, Product, Id } from '../../types';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { MotiView } from 'moti';
import { AnimatedProductCard } from '../../components/ui/AnimatedProductCard';
import { StackHeader } from '../../components/ui/Header';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAppAuth } from '../../context/AuthProvider';
import { canManageCatalog } from '../../utils/roles';

const { width } = Dimensions.get('window');
const CARD_WIDTH = (width - 48) / 2;

type Props = NativeStackScreenProps<RootStackParamList, 'CategoryProducts'>;

export default function CategoryProductsScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { categoryId, categoryName } = route.params;
  const { user } = useAppAuth();
  const hasCatalogAccess = canManageCatalog(user?.role);
  const [selectedSubcategory, setSelectedSubcategory] = useState<string | null>(null);

  const category = useQuery(api.categories.getCategoryWithSubcategories, {
    categoryId: categoryId as Id<'categories'>
  });
  const recordBehaviorEvent = useMutation(api.notifications.recordBehaviorEvent);
  const categoryProducts = useQuery(
    api.products.getProductsByCategory,
    selectedSubcategory
      ? 'skip'
      : {
          categoryId: categoryId as Id<'categories'>,
          limit: 50,
        },
  );
  const subcategoryProducts = useQuery(
    api.products.getProductsBySubcategory,
    selectedSubcategory
      ? {
          subcategoryId: selectedSubcategory as Id<'categories'>,
          limit: 50,
        }
      : 'skip',
  );
  const products = selectedSubcategory
    ? subcategoryProducts === undefined
      ? undefined
      : { items: subcategoryProducts, hasMore: false, nextCursor: null }
    : categoryProducts;

  useEffect(() => {
    void recordBehaviorEvent({
      userId: user?._id,
      eventType: 'category_browse',
      categoryId: (selectedSubcategory ?? categoryId) as Id<'categories'>,
    });
  }, [categoryId, recordBehaviorEvent, selectedSubcategory, user?._id]);

  const handleProductPress = (productId: string) => {
    navigation.navigate('ProductDetail', { productId });
  };

  const renderProduct = ({ item, index }: { item: Product; index: number }) => (
    <AnimatedProductCard
      product={item}
      index={index}
      viewerUser={user}
      onPress={() => handleProductPress(item._id)}
    />
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Custom Futuristic Header */}
      <StackHeader
        title={categoryName}
        subtitle={products ? `${products.items.length} products` : 'Loading...'}
        onBackPress={() => navigation.goBack()}
        variant="gradient"
        showAIIndicator
      />

      {/* Subcategories */}
      {category?.subcategories && category.subcategories.length > 0 && (
        <Animated.View entering={FadeIn.delay(100).duration(300)}>
          <View style={[styles.subcategoriesContainer, { borderBottomColor: theme.colors.outlineVariant }]}>
          <FlatList
            horizontal
            data={[{ _id: categoryId, name: 'All' } as { _id: string; name: string }, ...category.subcategories.map(sub => ({ _id: sub._id, name: sub.name }))]}
              renderItem={({ item, index }) => (
                <Animated.View entering={FadeInDown.delay(index * 50).duration(200)}>
              <Chip
                mode={(selectedSubcategory === null && item._id === categoryId) || selectedSubcategory === item._id ? 'flat' : 'outlined'}
                selected={(selectedSubcategory === null && item._id === categoryId) || selectedSubcategory === item._id}
                onPress={() => setSelectedSubcategory(item._id === categoryId ? null : item._id)}
                    style={[
                      styles.subcategoryChip,
                      (selectedSubcategory === null && item._id === categoryId) || selectedSubcategory === item._id
                        ? { backgroundColor: theme.colors.primaryContainer }
                        : {}
                    ]}
                    textStyle={{
                      color: (selectedSubcategory === null && item._id === categoryId) || selectedSubcategory === item._id
                        ? theme.colors.primary
                        : theme.colors.onSurfaceVariant
                    }}
              >
                {item.name}
              </Chip>
                </Animated.View>
            )}
            keyExtractor={(item) => item._id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.subcategoriesList}
          />
        </View>
        </Animated.View>
      )}

      {/* Products */}
      {products === undefined ? (
        <View style={styles.loadingContainer}>
          <View style={styles.loadingRow}>
            {[1, 2].map((i) => (
              <View key={i} style={[styles.skeletonCard, { backgroundColor: theme.colors.surfaceVariant }]}>
                <Skeleton width="100%" height={120} borderRadius={12} />
                <View style={{ padding: 8 }}>
                  <Skeleton width="80%" height={16} />
                  <Skeleton width="50%" height={20} style={{ marginTop: 8 }} />
                </View>
              </View>
            ))}
          </View>
          <View style={styles.loadingRow}>
            {[3, 4].map((i) => (
              <View key={i} style={[styles.skeletonCard, { backgroundColor: theme.colors.surfaceVariant }]}>
                <Skeleton width="100%" height={120} borderRadius={12} />
                <View style={{ padding: 8 }}>
                  <Skeleton width="80%" height={16} />
                  <Skeleton width="50%" height={20} style={{ marginTop: 8 }} />
                </View>
              </View>
            ))}
          </View>
        </View>
      ) : products.items.length === 0 ? (
        <Animated.View entering={FadeIn.duration(400)} style={styles.emptyState}>
          <MotiView
            from={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ opacity: { type: 'timing', duration: 400 }, scale: { type: 'timing', duration: 400 } }}
          >
            <View style={[styles.emptyIcon, { backgroundColor: theme.colors.surfaceVariant }]}>
              <Icon name="package-variant-closed" size={48} color={theme.colors.onSurfaceVariant} />
            </View>
          </MotiView>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 16 }}>
            No products found
          </Text>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, textAlign: 'center' }}>
            {hasCatalogAccess
              ? 'No catalog items are live in this category yet.'
              : 'No products are available in this category right now.'}
          </Text>
          {hasCatalogAccess && (
            <Pressable
              style={[styles.emptyButton, { backgroundColor: theme.colors.primary }]}
              onPress={() => navigation.navigate('CreateProduct')}
            >
              <Icon name="plus" size={20} color={theme.colors.onPrimary} />
              <Text style={{ color: theme.colors.onPrimary, fontWeight: '600', marginLeft: 8 }}>
                Add Listing
              </Text>
            </Pressable>
          )}
        </Animated.View>
      ) : (
        <FlatList
          data={products.items}
          renderItem={renderProduct}
          keyExtractor={(item) => item._id}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  subcategoriesContainer: {
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  subcategoriesList: {
    paddingHorizontal: 16,
    gap: 8,
  },
  subcategoryChip: {
    marginRight: 8,
    borderRadius: 20,
  },
  listContent: {
    padding: 16,
    paddingBottom: 100,
  },
  row: {
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  loadingContainer: {
    padding: 16,
  },
  loadingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  skeletonCard: {
    width: CARD_WIDTH,
    borderRadius: 16,
    overflow: 'hidden',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  emptyIcon: {
    width: 100,
    height: 100,
    borderRadius: 50,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 24,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 24,
  },
});
