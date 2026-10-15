import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery } from 'convex/react';
import React, { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Pressable, StyleSheet, View } from 'react-native';
import { Avatar, Card, Chip, Text, useTheme } from 'react-native-paper';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { useAppAuth } from '../../context/AuthProvider';
import type { Id, ReviewWithReviewer, RootStackParamList } from '../../types';

type Props = NativeStackScreenProps<RootStackParamList, 'SellerProfile'>;

export default function SellerProfileScreen({ route }: Props) {
  const theme = useTheme();
  const { user } = useAppAuth();
  const { sellerId } = route.params;
  const [deletingReviewId, setDeletingReviewId] = useState<string | null>(null);

  const storefront = useQuery(api.vendors.getVendorStorefront, {
    sellerId: sellerId as Id<'users'>,
  });
  const reviews = useQuery(api.reviews.getSellerReviews, {
    sellerId: sellerId as Id<'users'>,
  });
  const deleteReview = useMutation(api.reviews.deleteReview);
  const isAdmin = user?.role === 'admin';

  const handleDeleteReview = (reviewId: string) => {
    if (!user || user.role !== 'admin') {
      return;
    }

    Alert.alert('Delete review', 'Remove this review from the storefront?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setDeletingReviewId(reviewId);

          try {
            await deleteReview({
              reviewId: reviewId as Id<'reviews'>,
            });
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Failed to delete review';
            Alert.alert('Error', message);
          } finally {
            setDeletingReviewId(null);
          }
        },
      },
    ]);
  };

  if (storefront === undefined || reviews === undefined) {
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

  const renderReview = ({ item }: { item: ReviewWithReviewer }) => {
    const isDeleting = deletingReviewId === item._id;

    return (
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
                  <Icon key={star} name={star <= item.rating ? 'star' : 'star-outline'} size={14} color="#F59E0B" />
                ))}
              </View>
            </View>
            <View style={styles.reviewMeta}>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {new Date(item.createdAt).toLocaleDateString()}
              </Text>
              {isAdmin ? (
                <Pressable
                  onPress={() => handleDeleteReview(item._id)}
                  disabled={isDeleting}
                  style={({ pressed }) => [
                    styles.deleteReviewButton,
                    {
                      backgroundColor: theme.colors.errorContainer,
                      opacity: pressed || isDeleting ? 0.75 : 1,
                    },
                  ]}
                >
                  {isDeleting ? (
                    <ActivityIndicator size="small" color={theme.colors.error} />
                  ) : (
                    <Icon name="trash-can-outline" size={16} color={theme.colors.error} />
                  )}
                </Pressable>
              ) : null}
            </View>
          </View>
          {item.comment ? (
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 8 }}>
              {item.comment}
            </Text>
          ) : null}
        </Card.Content>
      </Card>
    );
  };

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
        </Card.Content>
      </Card>

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
  reviewMeta: {
    alignItems: 'flex-end',
    gap: 8,
  },
  deleteReviewButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyState: {
    padding: 32,
    alignItems: 'center',
  },
});
