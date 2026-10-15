import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Image, View, StyleSheet, FlatList, ScrollView } from 'react-native';
import { Text, Searchbar, useTheme, ActivityIndicator, Chip, Menu, Button, TextInput } from 'react-native-paper';
import { useQuery } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList, Product, ProductCondition, Id } from '../../types';
import { AnimatedProductCard } from '../../components/ui/AnimatedProductCard';
import { useAppAuth } from '../../context/AuthProvider';
import { useAiActions } from '../../hooks/useAiActions';
import { aiErrorMessage } from '../../services/aiAdapters';
import { requestAIConsent } from '../../services/aiConsent';

type Props = NativeStackScreenProps<RootStackParamList, 'Search'>;

type SortOption = 'relevance' | 'newest' | 'price_asc' | 'price_desc' | 'popular' | 'best_rated';
type ConditionFilter = 'all' | ProductCondition;

function parseOptionalPrice(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export default function SearchScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { query: initialQuery, categoryId, brand: initialBrand, imageUri, imageDataUrl } = route.params || {};
  const { user } = useAppAuth();
  const visualSearchRequestedRef = useRef(false);
  const ai = useAiActions();

  const [searchQuery, setSearchQuery] = useState(initialQuery || '');
  const [visualSearchLoading, setVisualSearchLoading] = useState(false);
  const [visualSearchError, setVisualSearchError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortOption>('newest');
  const [condition, setCondition] = useState<ConditionFilter>('all');
  const [sortMenuVisible, setSortMenuVisible] = useState(false);
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [brandFilter, setBrandFilter] = useState(initialBrand || '');
  const [deliveryFilter, setDeliveryFilter] = useState<'all' | 'free' | 'paid'>('all');

  const textSearchResults = useQuery(
    api.products.searchProducts,
    searchQuery.trim()
      ? {
          query: searchQuery,
          categoryId: categoryId ? (categoryId as Id<'categories'>) : undefined,
          condition: condition === 'all' ? undefined : condition,
          minPrice: parseOptionalPrice(minPrice),
          maxPrice: parseOptionalPrice(maxPrice),
          limit: 50,
        }
      : 'skip'
  );
  const brandResults = useQuery(
    api.products.getProductsByBrand,
    !searchQuery.trim() && brandFilter.trim()
      ? {
          brand: brandFilter.trim(),
          limit: 50,
        }
      : 'skip',
  );
  const searchResults = searchQuery.trim()
    ? textSearchResults
    : brandFilter.trim()
      ? brandResults
      : undefined;

  useEffect(() => {
    if (!imageDataUrl || visualSearchRequestedRef.current || initialQuery || initialBrand) {
      return;
    }

    visualSearchRequestedRef.current = true;
    setVisualSearchLoading(true);
    setVisualSearchError(null);

    requestAIConsent()
      .then((hasConsent) => {
        // A result for a previous account is dropped, so it shows nothing.
        if (!ai.isCurrent()) return null;
        if (!hasConsent) {
          setVisualSearchError('AI image search is off until you allow AI features.');
          return null;
        }
        return ai.visualSearch({ imageDataUrl });
      })
      .then((result) => {
        if (!result || !ai.isCurrent()) return;
        if (result.query.trim()) {
          setSearchQuery(result.query.trim());
          return;
        }
        setVisualSearchError('Add a few words to search from this photo.');
      })
      .catch((error: unknown) => {
        const message = aiErrorMessage(error);
        if (message === null || !ai.isCurrent()) return;
        setVisualSearchError(`${message} Add a few words to search from this photo.`);
      })
      .finally(() => {
        // Busy is cleared even for a stale result, so the screen never keeps spinning for a request it no longer shows.
        setVisualSearchLoading(false);
      });
  }, [ai, imageDataUrl, initialBrand, initialQuery]);

  const filteredResults = useMemo(() => {
    const normalizedBrand = brandFilter.trim().toLowerCase();
    const items = [...(searchResults ?? [])].filter((product) => {
          if (normalizedBrand && !product.brand?.toLowerCase().includes(normalizedBrand)) {
            return false;
          }
      if (deliveryFilter === 'free') {
        return product.shippingOptions?.some((option) => option.price === 0);
      }
      if (deliveryFilter === 'paid') {
        return product.shippingOptions?.some((option) => option.price > 0);
      }
      return true;
    });

    switch (sortBy) {
      case 'newest':
        return items.sort((left, right) => right.createdAt - left.createdAt);
      case 'price_asc':
        return items.sort((left, right) => left.price - right.price);
      case 'price_desc':
        return items.sort((left, right) => right.price - left.price);
      case 'popular':
        return items.sort((left, right) => right.views - left.views);
      case 'best_rated':
        return items;
      case 'relevance':
      default:
        return items;
    }
  }, [brandFilter, deliveryFilter, searchResults, sortBy]);

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

  const sortOptions: { value: SortOption; label: string }[] = [
    { value: 'relevance', label: 'Relevance' },
    { value: 'newest', label: 'Newest First' },
    { value: 'price_asc', label: 'Price: Low to High' },
    { value: 'price_desc', label: 'Price: High to Low' },
    { value: 'popular', label: 'Popular' },
    { value: 'best_rated', label: 'Best Rated' },
  ];

  const conditionOptions: { value: ConditionFilter; label: string }[] = [
    { value: 'all', label: 'All Conditions' },
    { value: 'new', label: 'New' },
    { value: 'like_new', label: 'Like New' },
    { value: 'good', label: 'Good' },
    { value: 'fair', label: 'Fair' },
  ];
  const hasSearchIntent = Boolean(searchQuery.trim() || brandFilter.trim() || imageUri);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <Searchbar
          placeholder={imageUri ? 'Describe the product in your photo...' : 'Search products...'}
          value={searchQuery}
          onChangeText={setSearchQuery}
          style={[styles.searchBar, { backgroundColor: theme.colors.surfaceVariant }]}
        />
      </View>

      {imageUri ? (
        <View style={styles.imageSearchPreview}>
          <Image source={{ uri: imageUri }} style={styles.imageSearchThumb} />
          <View style={{ flex: 1 }}>
            <Text variant="labelLarge" style={{ color: theme.colors.onSurface }}>
              {visualSearchLoading ? 'Analyzing photo...' : 'Image search'}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {visualSearchError
                ? visualSearchError
                : searchQuery.trim()
                  ? `Searching for "${searchQuery.trim()}"`
                  : 'Add a few words above to refine matches from this photo.'}
            </Text>
          </View>
        </View>
      ) : null}

      {/* Filters */}
      <View style={styles.filtersContainer}>
        <Menu
          visible={sortMenuVisible}
          onDismiss={() => setSortMenuVisible(false)}
          anchor={
            <Button
              mode="outlined"
              onPress={() => setSortMenuVisible(true)}
              icon="sort"
              compact
              style={styles.filterButton}
            >
              {sortOptions.find((o) => o.value === sortBy)?.label}
            </Button>
          }
        >
          {sortOptions.map((option) => (
            <Menu.Item
              key={option.value}
              onPress={() => {
                setSortBy(option.value);
                setSortMenuVisible(false);
              }}
              title={option.label}
            />
          ))}
        </Menu>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.conditionFilters}>
          {conditionOptions.map((item) => (
              <Chip
                key={item.value}
                mode={condition === item.value ? 'flat' : 'outlined'}
                selected={condition === item.value}
                onPress={() => setCondition(item.value)}
                style={styles.conditionFilterChip}
              >
                {item.label}
              </Chip>
            ))}
          {(['all', 'free', 'paid'] as const).map((value) => (
            <Chip
              key={value}
              mode={deliveryFilter === value ? 'flat' : 'outlined'}
              selected={deliveryFilter === value}
              onPress={() => setDeliveryFilter(value)}
              style={styles.conditionFilterChip}
            >
              {value === 'all' ? 'All Delivery' : value === 'free' ? 'Free Delivery' : 'Paid Delivery'}
            </Chip>
          ))}
        </ScrollView>
        <View style={styles.advancedFilters}>
          <TextInput
            mode="outlined"
            label="Brand"
            value={brandFilter}
            onChangeText={setBrandFilter}
            style={styles.filterInput}
          />
          <TextInput
            mode="outlined"
            label="Min price"
            value={minPrice}
            onChangeText={setMinPrice}
            keyboardType="decimal-pad"
            style={styles.priceInput}
          />
          <TextInput
            mode="outlined"
            label="Max price"
            value={maxPrice}
            onChangeText={setMaxPrice}
            keyboardType="decimal-pad"
            style={styles.priceInput}
          />
        </View>
      </View>

      {/* Results */}
      {!hasSearchIntent ? (
        <View style={styles.emptyState}>
          <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant }}>
            Enter a search term
          </Text>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 8 }}>
            Search for products by name or description
          </Text>
        </View>
      ) : visualSearchLoading || (searchResults === undefined && (searchQuery.trim() || brandFilter.trim())) ? (
        <ActivityIndicator style={styles.loader} />
      ) : imageUri && !searchQuery.trim() && !brandFilter.trim() ? (
        <View style={styles.emptyState}>
          <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant }}>
            Add search words
          </Text>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, textAlign: 'center' }}>
            Describe the product in the photo to find matching listings.
          </Text>
        </View>
      ) : filteredResults.length === 0 ? (
        <View style={styles.emptyState}>
          <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant }}>
            No products found
          </Text>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 8 }}>
            Try adjusting your search or filters
          </Text>
        </View>
      ) : (
        <FlatList
          data={filteredResults}
          renderItem={renderProduct}
          keyExtractor={(item) => item._id}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 16 }}>
              {filteredResults.length} results
            </Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  searchContainer: {
    padding: 16,
    paddingBottom: 8,
  },
  searchBar: {
    borderRadius: 12,
  },
  imageSearchPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.04)',
  },
  imageSearchThumb: {
    width: 52,
    height: 52,
    borderRadius: 8,
  },
  filtersContainer: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  filterButton: {
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  conditionFilters: {
    gap: 8,
  },
  conditionFilterChip: {
    marginRight: 8,
  },
  advancedFilters: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  filterInput: {
    flex: 1.2,
  },
  priceInput: {
    flex: 1,
  },
  listContent: {
    padding: 16,
    paddingTop: 8,
  },
  row: {
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  loader: {
    flex: 1,
    justifyContent: 'center',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
});
