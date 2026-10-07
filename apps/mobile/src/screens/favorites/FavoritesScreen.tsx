import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from 'convex/react';
import React from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Surface, Text, useTheme } from 'react-native-paper';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { TabHeader } from '../../components/ui/Header';
import { useAppAuth } from '../../context/AuthProvider';
import { calculateDisplayPrice } from '../../hooks/useOrderTotal';
import { formatPrice } from '../../theme';
import type { RootStackParamList } from '../../types';

export default function FavoritesScreen() {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { user } = useAppAuth();
  const favorites = useQuery(
    api.favorites.getUserFavorites,
    user ? { userId: user._id } : 'skip',
  );

  const products = (favorites ?? []).flatMap((favorite) => (favorite.product ? [favorite.product] : []));

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <TabHeader title="Favorites" subtitle="Saved products" />

      {!user ? (
        <View style={styles.centered}>
          <Icon name="heart-outline" size={52} color={theme.colors.primary} />
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 14 }}>
            Sign in to save favorites
          </Text>
        </View>
      ) : favorites === undefined ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : products.length === 0 ? (
        <View style={styles.centered}>
          <Surface style={[styles.emptyCard, { backgroundColor: theme.colors.surfaceVariant }]} elevation={0}>
            <Icon name="heart-outline" size={42} color={theme.colors.primary} />
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 12 }}>
              No favorites yet
            </Text>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 6, textAlign: 'center' }}>
              Save products from listings and they will appear here.
            </Text>
          </Surface>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
          <View style={styles.grid}>
            {products.map((product) => (
              <Pressable
                key={product._id}
                onPress={() => navigation.navigate('ProductDetail', { productId: product._id })}
                style={({ pressed }) => [
                  styles.productCard,
                  {
                    backgroundColor: theme.colors.surface,
                    opacity: pressed ? 0.82 : 1,
                  },
                ]}
              >
                <View style={styles.imageWrap}>
                  {product.images[0] ? (
                    <Image source={{ uri: product.images[0] }} style={styles.productImage} resizeMode="contain" />
                  ) : (
                    <View style={[styles.productImage, styles.imagePlaceholder]}>
                      <Icon name="image-outline" size={30} color={theme.colors.onSurfaceVariant} />
                    </View>
                  )}
                  <View style={[styles.conditionBadge, { backgroundColor: theme.colors.primary }]}>
                    <Text style={styles.conditionText}>{product.condition.replace('_', ' ').toUpperCase()}</Text>
                  </View>
                </View>
                <View style={styles.productContent}>
                  <Text variant="bodyMedium" numberOfLines={2} style={{ color: theme.colors.onSurface }}>
                    {product.title}
                  </Text>
                  <Text variant="titleMedium" style={{ color: theme.colors.primary, fontWeight: '700', marginTop: 6 }}>
                    {formatPrice(calculateDisplayPrice(product.price))}
                  </Text>
                  {product.seller ? (
                    <Text variant="bodySmall" numberOfLines={1} style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                      {product.seller.firstName} {product.seller.lastName}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  content: {
    padding: 16,
    paddingBottom: 100,
  },
  emptyCard: {
    width: '100%',
    borderRadius: 18,
    padding: 24,
    alignItems: 'center',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  productCard: {
    width: '48%',
    borderRadius: 8,
    overflow: 'hidden',
    marginBottom: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#111111',
  },
  imageWrap: {
    height: 142,
    position: 'relative',
    backgroundColor: '#FFFFFF',
  },
  productImage: {
    width: '100%',
    height: '100%',
  },
  imagePlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  conditionBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 6,
  },
  conditionText: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '800',
  },
  productContent: {
    padding: 10,
    minHeight: 106,
  },
});
