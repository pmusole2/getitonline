import React, { useState } from 'react';
import { View, StyleSheet, ScrollView, Alert, Pressable, Image, ActivityIndicator } from 'react-native';
import { Text, TextInput, Button, useTheme, Surface, ProgressBar } from 'react-native-paper';
import Animated, { FadeIn, FadeInDown, FadeInRight } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList, ProductCondition, Category, Id } from '../../types';
import { useAppAuth } from '../../context/AuthProvider';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { MotiView } from 'moti';
import { calculateDisplayPrice, PLATFORM_FEE_PERCENTAGE } from '../../hooks/useOrderTotal';
import { useImageUpload } from '../../hooks/useImageUpload';
import { StackHeader } from '../../components/ui/Header';
import { canManageCatalog, canManageListings } from '../../utils/roles';

type Props = NativeStackScreenProps<RootStackParamList, 'CreateProduct'>;

interface ConditionOption {
  value: ProductCondition;
  label: string;
  icon: string;
  description: string;
}

const CONDITIONS: ConditionOption[] = [
  { value: 'new', label: 'New', icon: 'star-circle', description: 'Brand new, unused' },
  { value: 'like_new', label: 'Like New', icon: 'star-half-full', description: 'Barely used' },
  { value: 'good', label: 'Good', icon: 'star-outline', description: 'Minor wear' },
  { value: 'fair', label: 'Fair', icon: 'star-off-outline', description: 'Visible wear' },
];

export default function CreateProductScreen({ navigation }: Props) {
  const theme = useTheme();
  const { user } = useAppAuth();
  const storefront = useQuery(api.platform.getStorefront);
  const vendorProfile = useQuery(
    api.vendors.getMyVendorProfile,
    user?._id ? { ownerUserId: user._id } : 'skip'
  );
  const hasListingAccess = canManageListings(user?.role, vendorProfile?.status ?? null);
  const isCompanyCatalogManager = canManageCatalog(user?.role);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [condition, setCondition] = useState<ProductCondition>('good');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [location, setLocation] = useState('');
  const [loading, setLoading] = useState(false);
  const [showCategoryPicker, setShowCategoryPicker] = useState(false);
  const [deliveryType, setDeliveryType] = useState<'free' | 'paid'>('free');
  const [deliveryFee, setDeliveryFee] = useState('');

  // Use the image upload hook for proper Convex storage handling
  const {
    images,
    isUploading,
    progress,
    pickImages,
    removeImage,
    getImageUrls
  } = useImageUpload();

  const categories = useQuery(api.categories.getCategoriesTree);
  const createProduct = useMutation(api.products.createProduct);

  const selectedCategory = categories?.find((c) => c._id === categoryId);

  const handleSubmit = async () => {
    if (!user || !hasListingAccess) {
      Alert.alert('Error', 'Only approved vendors and catalog staff can create listings');
      return;
    }

    if (isCompanyCatalogManager && storefront && !storefront.isConfigured) {
      Alert.alert(
        'Company storefront not configured',
        user.role === 'admin'
          ? 'Go back to the Sell tab and configure the company storefront before creating listings.'
          : 'An administrator must configure the company storefront before catalog staff can create listings.'
      );
      return;
    }

    if (!title.trim() || !description.trim() || !price || !categoryId) {
      Alert.alert('Error', 'Please fill in all required fields');
      return;
    }

    const priceNum = parseFloat(price);
    if (isNaN(priceNum) || priceNum <= 0) {
      Alert.alert('Error', 'Please enter a valid price');
      return;
    }

    setLoading(true);

    try {
      // Get the public Convex storage URLs for all uploaded images
      const imageUrls = getImageUrls();

      await createProduct({
        actorUserId: user._id,
        categoryId: categoryId as Id<'categories'>,
        title: title.trim(),
        description: description.trim(),
        price: priceNum,
        condition,
        images: imageUrls,
        quantity: 1,
        shippingOptions: [{
          name: deliveryType === 'free' ? 'Free Delivery' : 'Standard Delivery',
          price: deliveryType === 'free' ? 0 : parseFloat(deliveryFee) || 0,
          estimatedDays: '3-5 days',
        }],
        location: location.trim() ? { city: location.trim(), province: '' } : undefined,
        status: 'pending_review',
      });

      Alert.alert('Success', 'Your listing has been submitted for review.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to create listing';
      if (errorMessage.includes('Company seller account is not configured')) {
        Alert.alert(
          'Company storefront not configured',
          user.role === 'admin'
            ? 'Go back to the Sell tab and configure the company storefront before creating listings.'
            : 'An administrator must configure the company storefront before catalog staff can create listings.'
        );
        return;
      }
      Alert.alert('Error', errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const flatCategories: Category[] = [];
  categories?.forEach((cat) => {
    flatCategories.push(cat);
    cat.subcategories?.forEach((sub) => flatCategories.push(sub));
  });

  const isValid = title.trim() && description.trim() && price && categoryId && !isUploading;

  if (user && hasListingAccess && isCompanyCatalogManager && storefront === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Create Listing"
          subtitle="Preparing company catalog tools"
          onBackPress={() => navigation.goBack()}
          variant="gradient"
        />
        <View style={styles.emptyState}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </View>
    );
  }

  if (user && !hasListingAccess) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Listing Access"
          subtitle="Vendor approval required"
          onBackPress={() => navigation.goBack()}
          variant="gradient"
        />
        <View style={styles.emptyState}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            Listing access is restricted
          </Text>
          <Text
            variant="bodyMedium"
            style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, textAlign: 'center' }}
          >
            You need an approved vendor application before adding listings.
          </Text>
        </View>
      </View>
    );
  }

  if (user && hasListingAccess && isCompanyCatalogManager && storefront && !storefront.isConfigured) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Company Storefront Required"
          subtitle="Complete setup before adding listings"
          onBackPress={() => navigation.goBack()}
          variant="gradient"
        />
        <View style={styles.emptyState}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface, textAlign: 'center' }}>
            Company catalog setup is incomplete
          </Text>
          <Text
            variant="bodyMedium"
            style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, textAlign: 'center' }}
          >
            {user.role === 'admin'
              ? 'Go back to the Sell tab and choose the company seller account before creating listings.'
              : 'An administrator must configure the company storefront before catalog staff can create listings.'}
          </Text>
          <Button mode="contained" onPress={() => navigation.goBack()} style={styles.setupButton}>
            Back to Sell
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader
        title="Create Listing"
        subtitle="Add inventory to the Gettitonline store"
        onBackPress={() => navigation.goBack()}
        variant="gradient"
        showAIIndicator
      />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        {/* AI Tip Card */}
        <Animated.View entering={FadeInDown.delay(100).duration(400)}>
          <Surface style={[styles.tipCard, { backgroundColor: theme.colors.tertiaryContainer }]} elevation={0}>
            <View style={styles.tipContent}>
              <MotiView
                from={{ rotate: '0deg' }}
                animate={{ rotate: '360deg' }}
                transition={{
                  rotate: { type: 'timing', duration: 8000, loop: true },
                }}
              >
                <Icon name="creation" size={24} color={theme.colors.tertiary} />
              </MotiView>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text variant="labelLarge" style={{ color: theme.colors.onTertiaryContainer, fontWeight: '600' }}>
                  AI Listing Assistant
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onTertiaryContainer, opacity: 0.8 }}>
                  Add clear photos and detailed descriptions to sell faster!
                </Text>
              </View>
            </View>
          </Surface>
        </Animated.View>

        {/* Photos Section */}
        <Animated.View entering={FadeInDown.delay(150).duration(400)}>
          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={2}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionIcon, { backgroundColor: theme.colors.primaryContainer }]}>
                <Icon name="camera" size={20} color={theme.colors.primary} />
              </View>
              <View>
                <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                  Photos
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  Add up to 5 photos ({images.length}/5)
          </Text>
              </View>
            </View>

            {/* Upload progress indicator */}
            {isUploading && (
              <View style={styles.uploadProgress}>
                <ProgressBar progress={progress / 100} color={theme.colors.primary} style={{ borderRadius: 4 }} />
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4, textAlign: 'center' }}>
                  Uploading... {Math.round(progress)}%
                </Text>
              </View>
            )}

            <View style={styles.imagesGrid}>
            {images.map((image, index) => (
                <Animated.View key={image.storageId || index} entering={FadeInRight.delay(index * 50).duration(300)}>
                  <View style={styles.imageWrapper}>
                    {/* Use localUri for fast preview, or url as fallback */}
                    <Image
                      source={{ uri: image.localUri || image.url }}
                      style={styles.imagePreview}
                      resizeMode="cover"
                    />
                <Pressable
                  style={[styles.removeImageButton, { backgroundColor: theme.colors.error }]}
                      onPress={() => removeImage(index)}
                      disabled={isUploading}
                >
                      <Icon name="close" size={14} color="#fff" />
                </Pressable>
                    {index === 0 && (
                      <View style={[styles.mainBadge, { backgroundColor: theme.colors.primary }]}>
                        <Text style={{ color: '#fff', fontSize: 10, fontWeight: '600' }}>MAIN</Text>
                      </View>
                    )}
              </View>
                </Animated.View>
            ))}
            {images.length < 5 && !isUploading && (
              <Pressable
                  style={[styles.addImageButton, { borderColor: theme.colors.primary + '50' }]}
                onPress={() => pickImages(5)}
              >
                  <LinearGradient
                    colors={[theme.colors.primaryContainer + '50', theme.colors.primaryContainer + '30']}
                    style={styles.addImageGradient}
                  >
                    <Icon name="plus" size={28} color={theme.colors.primary} />
                    <Text variant="labelSmall" style={{ color: theme.colors.primary, marginTop: 4 }}>
                  Add Photo
                </Text>
                  </LinearGradient>
              </Pressable>
            )}
            {isUploading && images.length < 5 && (
              <View style={[styles.addImageButton, styles.uploadingPlaceholder, { borderColor: theme.colors.primary + '30' }]}>
                <ActivityIndicator size="small" color={theme.colors.primary} />
              </View>
            )}
          </View>
          </Surface>
        </Animated.View>

        {/* Details Section */}
        <Animated.View entering={FadeInDown.delay(200).duration(400)}>
          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={2}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionIcon, { backgroundColor: theme.colors.secondaryContainer }]}>
                <Icon name="text-box" size={20} color={theme.colors.secondary} />
              </View>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                Details
              </Text>
        </View>

            <View style={styles.inputGroup}>
              <Text variant="labelMedium" style={[styles.inputLabel, { color: theme.colors.onSurfaceVariant }]}>
                Title <Text style={{ color: theme.colors.error }}>*</Text>
              </Text>
        <TextInput
          mode="outlined"
          value={title}
          onChangeText={setTitle}
                placeholder="e.g., Toyota Corolla Brake Pads - New"
          maxLength={100}
          style={styles.input}
                outlineStyle={styles.inputOutline}
        />
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'right' }}>
                {title.length}/100
              </Text>
            </View>

            <View style={styles.inputGroup}>
              <Text variant="labelMedium" style={[styles.inputLabel, { color: theme.colors.onSurfaceVariant }]}>
                Description <Text style={{ color: theme.colors.error }}>*</Text>
              </Text>
        <TextInput
          mode="outlined"
          value={description}
          onChangeText={setDescription}
                placeholder="Describe your item in detail: condition, compatibility, any defects..."
          multiline
          numberOfLines={4}
          maxLength={2000}
                style={[styles.input, styles.textArea]}
                outlineStyle={styles.inputOutline}
        />
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'right' }}>
                {description.length}/2000
              </Text>
            </View>
          </Surface>
        </Animated.View>

        {/* Pricing Section */}
        <Animated.View entering={FadeInDown.delay(250).duration(400)}>
          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={2}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionIcon, { backgroundColor: theme.colors.primaryContainer }]}>
                <Icon name="cash" size={20} color={theme.colors.primary} />
              </View>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                Pricing
              </Text>
            </View>

            <View style={styles.inputGroup}>
              <Text variant="labelMedium" style={[styles.inputLabel, { color: theme.colors.onSurfaceVariant }]}>
                Your Price (ZMW) <Text style={{ color: theme.colors.error }}>*</Text>
              </Text>
        <TextInput
          mode="outlined"
          value={price}
          onChangeText={setPrice}
                placeholder="0.00"
          keyboardType="decimal-pad"
                left={<TextInput.Affix text="K" textStyle={{ color: theme.colors.primary, fontWeight: '600' }} />}
          style={styles.input}
                outlineStyle={styles.inputOutline}
        />
            </View>

            {/* Fee Info Note */}
            <View style={[styles.feeInfoCard, { backgroundColor: theme.colors.primaryContainer + '40' }]}>
              <Icon name="information-outline" size={18} color={theme.colors.primary} />
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text variant="labelMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                  Buyers will see: {price ? `K${calculateDisplayPrice(parseFloat(price) || 0).toLocaleString('en-ZM', { minimumFractionDigits: 2 })}` : 'K0.00'}
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                  A {PLATFORM_FEE_PERCENTAGE * 100}% service fee is added to your price to cover secure payments & escrow protection.
                </Text>
              </View>
            </View>
          </Surface>
        </Animated.View>

        {/* Category Section */}
        <Animated.View entering={FadeInDown.delay(300).duration(400)}>
          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={2}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionIcon, { backgroundColor: theme.colors.tertiaryContainer }]}>
                <Icon name="tag" size={20} color={theme.colors.tertiary} />
              </View>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                Category <Text style={{ color: theme.colors.error }}>*</Text>
          </Text>
            </View>

            <Pressable
              style={[
                styles.categorySelector,
                {
                  backgroundColor: theme.colors.surfaceVariant,
                  borderColor: categoryId ? theme.colors.primary : 'transparent',
                },
              ]}
              onPress={() => setShowCategoryPicker(!showCategoryPicker)}
            >
              <Icon
                name={selectedCategory ? 'check-circle' : 'folder-outline'}
                size={20}
                color={selectedCategory ? theme.colors.primary : theme.colors.onSurfaceVariant}
              />
              <Text
                variant="bodyMedium"
                style={{
                  flex: 1,
                  marginLeft: 12,
                  color: selectedCategory ? theme.colors.onSurface : theme.colors.onSurfaceVariant,
                }}
              >
                {selectedCategory?.name || 'Select a category'}
              </Text>
              <Icon
                name={showCategoryPicker ? 'chevron-up' : 'chevron-down'}
                size={24}
                color={theme.colors.onSurfaceVariant}
              />
            </Pressable>

            {showCategoryPicker && (
              <Animated.View entering={FadeIn.duration(200)} style={styles.categoryList}>
                {flatCategories.map((cat, index) => (
                  <Pressable
                  key={cat._id}
                    style={[
                      styles.categoryItem,
                      {
                        backgroundColor: categoryId === cat._id ? theme.colors.primaryContainer : 'transparent',
                        marginLeft: cat.parentId ? 24 : 0,
                      },
                    ]}
                  onPress={() => {
                    setCategoryId(cat._id);
                      setShowCategoryPicker(false);
                  }}
                  >
                    <Icon
                      name={cat.parentId ? 'subdirectory-arrow-right' : 'folder'}
                      size={18}
                      color={categoryId === cat._id ? theme.colors.primary : theme.colors.onSurfaceVariant}
                    />
                    <Text
                      variant="bodyMedium"
                      style={{
                        marginLeft: 8,
                        color: categoryId === cat._id ? theme.colors.primary : theme.colors.onSurface,
                        fontWeight: cat.parentId ? '400' : '600',
                      }}
                    >
                      {cat.name}
                    </Text>
                    {categoryId === cat._id && (
                      <Icon name="check" size={18} color={theme.colors.primary} style={{ marginLeft: 'auto' }} />
                    )}
                  </Pressable>
                ))}
              </Animated.View>
            )}
          </Surface>
        </Animated.View>

        {/* Condition Section */}
        <Animated.View entering={FadeInDown.delay(350).duration(400)}>
          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={2}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionIcon, { backgroundColor: theme.colors.secondaryContainer }]}>
                <Icon name="star" size={20} color={theme.colors.secondary} />
              </View>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                Condition <Text style={{ color: theme.colors.error }}>*</Text>
              </Text>
            </View>

            <View style={styles.conditionGrid}>
              {CONDITIONS.map((cond, index) => (
                <Animated.View key={cond.value} entering={FadeInRight.delay(index * 50).duration(300)}>
                  <Pressable
                    style={[
                      styles.conditionOption,
                      {
                        backgroundColor: condition === cond.value
                          ? theme.colors.primaryContainer
                          : theme.colors.surfaceVariant,
                        borderColor: condition === cond.value ? theme.colors.primary : 'transparent',
                      },
                    ]}
                    onPress={() => setCondition(cond.value)}
                  >
                    <Icon
                      name={cond.icon}
                      size={24}
                      color={condition === cond.value ? theme.colors.primary : theme.colors.onSurfaceVariant}
                    />
                    <Text
                      variant="labelMedium"
                      style={{
                        color: condition === cond.value ? theme.colors.primary : theme.colors.onSurface,
                        fontWeight: condition === cond.value ? '600' : '400',
                        marginTop: 4,
                      }}
                    >
                      {cond.label}
                    </Text>
                    <Text
                      variant="labelSmall"
                      style={{
                        color: condition === cond.value ? theme.colors.primary : theme.colors.onSurfaceVariant,
                        opacity: 0.8,
                        textAlign: 'center',
                      }}
                    >
                      {cond.description}
                    </Text>
                  </Pressable>
                </Animated.View>
              ))}
        </View>
          </Surface>
        </Animated.View>

        {/* Location Section */}
        <Animated.View entering={FadeInDown.delay(400).duration(400)}>
          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={2}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionIcon, { backgroundColor: theme.colors.surfaceVariant }]}>
                <Icon name="map-marker" size={20} color={theme.colors.onSurfaceVariant} />
              </View>
              <View>
                <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                  Location
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  Optional - helps buyers find local items
          </Text>
              </View>
        </View>

        <TextInput
          mode="outlined"
          value={location}
          onChangeText={setLocation}
              placeholder="e.g., Lusaka, Kitwe, Ndola"
              left={<TextInput.Icon icon="map-marker-outline" />}
              style={styles.input}
              outlineStyle={styles.inputOutline}
            />
          </Surface>
        </Animated.View>

        {/* Delivery Section */}
        <Animated.View entering={FadeInDown.delay(450).duration(400)}>
          <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={2}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionIcon, { backgroundColor: theme.colors.secondaryContainer }]}>
                <Icon name="truck-delivery" size={20} color={theme.colors.secondary} />
              </View>
              <View>
                <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                  Delivery
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  Set your delivery options
                </Text>
              </View>
            </View>

            {/* Delivery Type Options */}
            <View style={styles.deliveryOptionsRow}>
              <Pressable
                onPress={() => setDeliveryType('free')}
                style={[
                  styles.deliveryOption,
                  {
                    backgroundColor: deliveryType === 'free' ? theme.colors.secondaryContainer : theme.colors.surfaceVariant,
                    borderColor: deliveryType === 'free' ? theme.colors.secondary : 'transparent',
                  },
                ]}
              >
                <Icon
                  name="gift-outline"
                  size={24}
                  color={deliveryType === 'free' ? theme.colors.secondary : theme.colors.onSurfaceVariant}
                />
                <Text
                  variant="labelLarge"
                  style={{
                    color: deliveryType === 'free' ? theme.colors.secondary : theme.colors.onSurface,
                    marginTop: 6,
                    fontWeight: deliveryType === 'free' ? '700' : '400',
                  }}
                >
                  Free Delivery
                </Text>
                <Text
                  variant="labelSmall"
                  style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}
                >
                  K0.00
                </Text>
              </Pressable>

              <Pressable
                onPress={() => setDeliveryType('paid')}
                style={[
                  styles.deliveryOption,
                  {
                    backgroundColor: deliveryType === 'paid' ? theme.colors.primaryContainer : theme.colors.surfaceVariant,
                    borderColor: deliveryType === 'paid' ? theme.colors.primary : 'transparent',
                  },
                ]}
              >
                <Icon
                  name="truck-fast"
                  size={24}
                  color={deliveryType === 'paid' ? theme.colors.primary : theme.colors.onSurfaceVariant}
                />
                <Text
                  variant="labelLarge"
                  style={{
                    color: deliveryType === 'paid' ? theme.colors.primary : theme.colors.onSurface,
                    marginTop: 6,
                    fontWeight: deliveryType === 'paid' ? '700' : '400',
                  }}
                >
                  Paid Delivery
                </Text>
                <Text
                  variant="labelSmall"
                  style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}
                >
                  Set your fee
                </Text>
              </Pressable>
            </View>

            {/* Delivery Fee Input (only shown for paid delivery) */}
            {deliveryType === 'paid' && (
              <Animated.View entering={FadeInDown.duration(200)}>
                <View style={styles.inputGroup}>
                  <Text variant="labelMedium" style={[styles.inputLabel, { color: theme.colors.onSurfaceVariant }]}>
                    Delivery Fee (ZMW)
                  </Text>
                  <TextInput
                    mode="outlined"
                    value={deliveryFee}
                    onChangeText={setDeliveryFee}
                    placeholder="e.g., 50"
                    keyboardType="decimal-pad"
                    left={<TextInput.Affix text="K" textStyle={{ color: theme.colors.primary, fontWeight: '600' }} />}
          style={styles.input}
                    outlineStyle={styles.inputOutline}
        />
                </View>
              </Animated.View>
            )}
          </Surface>
        </Animated.View>

        {/* Submit Button */}
        <Animated.View entering={FadeInDown.delay(500).duration(400)} style={styles.submitContainer}>
        <Button
          mode="contained"
          onPress={handleSubmit}
          loading={loading}
            disabled={loading || !isValid}
          style={styles.submitButton}
          contentStyle={styles.submitButtonContent}
            icon="check-circle"
        >
            {loading ? 'Creating...' : 'Create Listing'}
        </Button>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center', marginTop: 12 }}>
            By creating a listing, you agree to our Terms of Service
          </Text>
        </Animated.View>
      </ScrollView>
      </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  tipCard: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  tipContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  card: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  sectionIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  uploadProgress: {
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  imagesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  uploadingPlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  imageWrapper: {
    position: 'relative',
  },
  imagePreview: {
    width: 90,
    height: 90,
    borderRadius: 12,
  },
  removeImageButton: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    justifyContent: 'center',
    alignItems: 'center',
  },
  mainBadge: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  addImageButton: {
    width: 90,
    height: 90,
    borderRadius: 12,
    borderWidth: 2,
    borderStyle: 'dashed',
    overflow: 'hidden',
  },
  addImageGradient: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  inputGroup: {
    marginBottom: 16,
  },
  feeInfoCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 12,
    borderRadius: 10,
    marginTop: 4,
  },
  deliveryOptionsRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 12,
  },
  deliveryOption: {
    flex: 1,
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: 2,
  },
  inputLabel: {
    marginBottom: 8,
  },
  input: {
    backgroundColor: 'transparent',
  },
  inputOutline: {
    borderRadius: 12,
  },
  textArea: {
    minHeight: 100,
  },
  categorySelector: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: 2,
  },
  categoryList: {
    marginTop: 12,
    maxHeight: 250,
  },
  categoryItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    marginBottom: 4,
  },
  conditionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  conditionOption: {
    width: '47%',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: 2,
    minWidth: 150,
    flex: 1,
  },
  submitContainer: {
    marginTop: 8,
  },
  setupButton: {
    marginTop: 20,
  },
  submitButton: {
    borderRadius: 16,
  },
  submitButtonContent: {
    paddingVertical: 8,
  },
});
