import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useQuery } from 'convex/react';
import React from 'react';
import { ActivityIndicator, Dimensions, FlatList, Image, StyleSheet, View } from 'react-native';
import { Avatar, Card, Chip, Text, useTheme } from 'react-native-paper';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { useAppAuth } from '../../context/AuthProvider';
import { calculateDisplayPrice } from '../../hooks/useOrderTotal';
import { formatPrice } from '../../theme';
import type { Id, Product, ReviewWithReviewer, RootStackParamList } from '../../types';

const { width } = Dimensions.get('window');
const CARD_WIDTH = (width - 48) / 2;

type Props = NativeStackScreenProps<RootStackParamList, 'SellerProfile'>;

export default function SellerProfileScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { user } = useAppAuth();
  const { sellerId } = route.params;

  const storefront = useQuery(api.vendors.getVendorStorefront, {
    sellerId: sellerId as Id<'users'>,
    viewerUserId: user?._id,
  });
  const products = useQuery(api.products.getProductsBySeller, {
    sellerId: sellerId as Id<'users'>,
    status: 'active',
    viewerUserId: user?._id,
  });
  const reviews = useQuery(api.reviews.getSellerReviews, {
    sellerId: sellerId as Id<'users'>,
  });

  const handleProductPress = (productId: string) => {
    navigation.navigate('ProductDetail', { productId });
  };

  if (storefront === undefined || products === undefined || reviews === undefined) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  if (storefront === null) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.colors.background }]}>
        <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant }}>
          Store not found
        </Text>
      </View>
    );
  }

  const renderReview = ({ item }: { item: ReviewWithReviewer }) => (
    <Card style={[styles.reviewCard, { backgroundColor: theme.colors.surface }]}>
      <Card.Content>
        <View style={styles.reviewHeader}>
          <Avatar.Text
            size={36}
            label={item.reviewer ? `${item.reviewer.firstName[0]}${item.reviewer.lastName[0]}` : '?'}
          />
          <View style={styles.reviewInfo}>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
              {item.reviewer ? `${item.reviewer.firstName} ${item.reviewer.lastName}` : 'Anonymous'}
            </Text>
            <View style={styles.ratingRow}>
              {[1, 2, 3, 4, 5].map((star) => (
                <Icon
                  key={star}
                  name={star <= item.rating ? 'star' : 'star-outline'}
                  size={14}
                  color="#F59E0B"
                />
              ))}
            </View>
          </View>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {new Date(item.createdAt).toLocaleDateString()}
          </Text>
        </View>
        {item.comment ? (
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 8 }}>
            {item.comment}
          </Text>
        ) : null}
      </Card.Content>
    </Card>
  );

  const ListHeader = () => (
    <>
      {storefront.bannerUrl ? (
        <Image source={{ uri: storefront.bannerUrl }} style={styles.banner} resizeMode="cover" />
      ) : null}

      <View style={styles.header}>
        {storefront.logoUrl ? (
          <Avatar.Image size={80} source={{ uri: storefront.logoUrl }} />
        ) : (
          <Avatar.Text
            size={80}
            label={storefront.displayName[0] || 'G'}
            style={{ backgroundColor: theme.colors.primary }}
          />
        )}

        <Text variant="headlineSmall" style={{ color: theme.colors.onSurface, marginTop: 16 }}>
          {storefront.displayName}
        </Text>

        <Chip
          icon={storefront.isCompanyStore ? 'storefront-outline' : 'check-decagram'}
          style={[styles.storeChip, { backgroundColor: theme.colors.primaryContainer }]}
          textStyle={{ color: theme.colors.primary }}
        >
          {storefront.isCompanyStore ? 'Official Store' : 'Approved Vendor'}
        </Chip>

        <Text
          variant="bodyMedium"
          style={{ color: theme.colors.onSurfaceVariant, marginTop: 12, textAlign: 'center', lineHeight: 22 }}
        >
          {storefront.description}
        </Text>

        <View style={styles.metaWrap}>
          <View style={styles.metaItem}>
            <Icon name="email-outline" size={16} color={theme.colors.onSurfaceVariant} />
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {storefront.contactEmail}
            </Text>
          </View>
          {storefront.contactPhone ? (
            <View style={styles.metaItem}>
              <Icon name="phone-outline" size={16} color={theme.colors.onSurfaceVariant} />
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {storefront.contactPhone}
              </Text>
            </View>
          ) : null}
          {storefront.address ? (
            <View style={styles.metaItem}>
              <Icon name="map-marker-outline" size={16} color={theme.colors.onSurfaceVariant} />
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {storefront.address.city}, {storefront.address.province}
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      <Card style={[styles.statsCard, { backgroundColor: theme.colors.surface }]}>
        <Card.Content style={styles.statsContent}>
          <View style={styles.statItem}>
            <Text variant="headlineSmall" style={{ color: theme.colors.primary }}>
              {storefront.totalSales}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Sales
            </Text>
          </View>
          <View style={[styles.statDivider, { backgroundColor: theme.colors.outline }]} />
          <View style={styles.statItem}>
            <View style={styles.ratingRow}>
              <Icon name="star" size={20} color="#F59E0B" />
              <Text variant="headlineSmall" style={{ color: theme.colors.primary, marginLeft: 4 }}>
                {storefront.rating?.toFixed(1) || 'N/A'}
              </Text>
            </View>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {reviews.length} reviews
            </Text>
          </View>
          <View style={[styles.statDivider, { backgroundColor: theme.colors.outline }]} />
          <View style={styles.statItem}>
            <Text variant="headlineSmall" style={{ color: theme.colors.primary }}>
              {products.length}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Listings
            </Text>
          </View>
        </Card.Content>
      </Card>

      <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
        Storefront Items ({products.length})
      </Text>

      {products.length > 0 ? (
        <View style={styles.productsGrid}>
          {products.map((product: Product) => (
            <Card
              key={product._id}
              style={[styles.productCard, { backgroundColor: theme.colors.surface }]}
              onPress={() => handleProductPress(product._id)}
            >
              <Card.Cover
                source={{ uri: product.images[0] || 'https://via.placeholder.com/150' }}
                style={styles.productImage}
              />
              <Card.Content style={styles.productContent}>
                <Text variant="bodyMedium" numberOfLines={2} style={{ color: theme.colors.onSurface }}>
                  {product.title}
                </Text>
                <Text variant="titleMedium" style={{ color: theme.colors.primary, marginTop: 4 }}>
                  {formatPrice(calculateDisplayPrice(product.price))}
                </Text>
              </Card.Content>
            </Card>
          ))}
        </View>
      ) : (
        <View style={styles.emptyProductState}>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
            No active listings are available from this store yet.
          </Text>
        </View>
      )}

      <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
        Reviews ({reviews.length})
      </Text>
    </>
  );

  return (
    <FlatList
      data={reviews}
      renderItem={renderReview}
      keyExtractor={(item) => item._id}
      ListHeaderComponent={ListHeader}
      contentContainerStyle={[styles.listContent, { backgroundColor: theme.colors.background }]}
      showsVerticalScrollIndicator={false}
      ListEmptyComponent={
        <View style={styles.emptyState}>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
            No reviews yet
          </Text>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  listContent: {
    paddingBottom: 32,
  },
  banner: {
    width: '100%',
    height: 180,
  },
  header: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 20,
  },
  storeChip: {
    marginTop: 12,
  },
  metaWrap: {
    marginTop: 16,
    alignItems: 'center',
    gap: 8,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statsCard: {
    marginHorizontal: 16,
    marginBottom: 24,
    borderRadius: 12,
  },
  statsContent: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 8,
  },
  statItem: {
    alignItems: 'center',
    flex: 1,
  },
  statDivider: {
    width: 1,
    height: '100%',
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sectionTitle: {
    fontWeight: '600',
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  productsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    gap: 16,
    marginBottom: 24,
  },
  productCard: {
    width: CARD_WIDTH,
    borderRadius: 12,
    overflow: 'hidden',
  },
  productImage: {
    height: 100,
  },
  productContent: {
    padding: 8,
  },
  reviewCard: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 12,
  },
  reviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  reviewInfo: {
    flex: 1,
    marginLeft: 12,
  },
  emptyState: {
    padding: 32,
    alignItems: 'center',
  },
  emptyProductState: {
    marginHorizontal: 16,
    marginBottom: 24,
    padding: 20,
    borderRadius: 12,
    alignItems: 'center',
  },
});
