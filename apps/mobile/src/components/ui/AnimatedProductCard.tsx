import React from 'react';
import { View, StyleSheet, Pressable, Dimensions } from 'react-native';
import { Text, useTheme, Surface } from 'react-native-paper';
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import type { Product, User } from '../../types';
import { formatPrice } from '../../theme';
import { calculateDisplayPrice } from '../../hooks/useOrderTotal';
import { canViewProductStats } from '../../utils/roles';

const { width } = Dimensions.get('window');
const CARD_WIDTH = (width - 48) / 2;
const CARD_TEXT_COLOR = '#111827';
const CARD_MUTED_TEXT_COLOR = '#4B5563';
const CARD_PLACEHOLDER_ICON_COLOR = '#9CA3AF';

interface AnimatedProductCardProps {
  product: Product;
  index: number;
  onPress: () => void;
  onFavorite?: () => void;
  isFavorited?: boolean;
  viewerUser?: Pick<User, '_id' | 'role'> | null;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function AnimatedProductCard({
  product,
  index,
  onPress,
  onFavorite,
  isFavorited = false,
  viewerUser,
}: AnimatedProductCardProps) {
  const theme = useTheme();
  const scale = useSharedValue(1);
  const favoriteScale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const favoriteAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: favoriteScale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.95, { damping: 15, stiffness: 300 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 300 });
  };

  const handleFavoritePress = () => {
    favoriteScale.value = withSpring(0.7, { damping: 10, stiffness: 400 }, () => {
      favoriteScale.value = withSpring(1, { damping: 10, stiffness: 400 });
    });
    onFavorite?.();
  };

  const conditionColors: Record<string, string> = {
    new: '#10B981',
    like_new: '#3B82F6',
    good: '#8B5CF6',
    fair: '#F59E0B',
  };
  const activeVariants = (product.variantCombinations ?? []).filter(
    (variant) => variant.status === 'active',
  );
  const variantPrices = activeVariants.map((variant) => variant.price);
  const minVariantPrice = variantPrices.length ? Math.min(...variantPrices) : product.price;
  const maxVariantPrice = variantPrices.length ? Math.max(...variantPrices) : product.price;
  const priceLabel =
    variantPrices.length > 0 && minVariantPrice !== maxVariantPrice
      ? `From ${formatPrice(calculateDisplayPrice(minVariantPrice))}`
      : formatPrice(calculateDisplayPrice(minVariantPrice));
  const canShowViews = canViewProductStats(viewerUser, product);

  return (
    <Animated.View entering={FadeInDown.delay(index * 80).duration(400).springify()}>
      <AnimatedPressable
        style={[styles.container, animatedStyle]}
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
      >
        <Surface
          style={[
            styles.card,
            { backgroundColor: '#FFFFFF', borderColor: '#111111' },
          ]}
          elevation={0}
        >
          <View style={styles.cardContent}>
            {/* Image Container */}
            <View style={styles.imageContainer}>
              {product.images[0] ? (
                <Animated.Image
                  source={{ uri: product.images[0] }}
                  style={styles.image}
                  resizeMode="contain"
                />
              ) : (
                <View style={styles.imagePlaceholder}>
                  <Icon name="image" size={32} color={CARD_PLACEHOLDER_ICON_COLOR} />
                </View>
              )}

              {/* Badges Row */}
              <View style={styles.badgesRow}>
                <View
                  style={[
                    styles.conditionBadge,
                    { backgroundColor: conditionColors[product.condition] || theme.colors.outline },
                  ]}
                >
                  <Text style={styles.conditionText}>
                    {product.condition.replace('_', ' ').toUpperCase()}
                  </Text>
                </View>
              </View>

              {/* Favorite Button */}
              {onFavorite && (
                <AnimatedPressable
                  style={[styles.favoriteButton, favoriteAnimatedStyle]}
                  onPress={handleFavoritePress}
                >
                  <Surface style={styles.favoriteCircle} elevation={0}>
                    <Icon
                      name={isFavorited ? 'heart' : 'heart-outline'}
                      size={18}
                      color={isFavorited ? theme.colors.error : CARD_MUTED_TEXT_COLOR}
                    />
                  </Surface>
                </AnimatedPressable>
              )}
            </View>

            {/* Content */}
            <View style={styles.content}>
              <Text
                variant="bodyMedium"
                numberOfLines={2}
                style={styles.title}
              >
                {product.title}
              </Text>

              <Text variant="titleMedium" style={styles.price}>
                {priceLabel}
              </Text>

              {canShowViews && (
                <View style={styles.footer}>
                  <View style={styles.viewsRow}>
                    <Icon name="eye-outline" size={14} color={CARD_MUTED_TEXT_COLOR} />
                    <Text variant="bodySmall" style={styles.viewsText}>
                      {product.views}
                    </Text>
                  </View>
                </View>
              )}
            </View>
          </View>
        </Surface>
      </AnimatedPressable>
    </Animated.View>
  );
}

// Grid wrapper for product cards
export function ProductGrid({ children }: { children: React.ReactNode }) {
  return <View style={styles.grid}>{children}</View>;
}

const styles = StyleSheet.create({
  container: {
    width: CARD_WIDTH,
    marginBottom: 16,
  },
  card: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  cardContent: {
    overflow: 'hidden',
    borderRadius: 8,
    minHeight: 252,
  },
  imageContainer: {
    position: 'relative',
    height: 140,
    backgroundColor: '#FFFFFF',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  imagePlaceholder: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  badgesRow: {
    position: 'absolute',
    top: 8,
    left: 8,
    flexDirection: 'row',
    gap: 4,
  },
  conditionBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  conditionText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
  },
  favoriteButton: {
    position: 'absolute',
    top: 8,
    right: 8,
  },
  favoriteCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  content: {
    padding: 12,
    backgroundColor: '#FFFFFF',
  },
  title: {
    color: CARD_TEXT_COLOR,
    fontWeight: '500',
    lineHeight: 20,
  },
  price: {
    color: CARD_TEXT_COLOR,
    marginTop: 4,
    fontWeight: '800',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginTop: 8,
  },
  viewsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  viewsText: {
    color: CARD_MUTED_TEXT_COLOR,
    marginLeft: 2,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
});
