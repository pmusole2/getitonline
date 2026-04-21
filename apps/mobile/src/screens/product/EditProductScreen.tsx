import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery } from 'convex/react';
import { LinearGradient } from 'expo-linear-gradient';
import { MotiView } from 'moti';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import {
  Button,
  Dialog,
  MD3Theme,
  Portal,
  Surface,
  Text,
  TextInput,
  useTheme,
} from 'react-native-paper';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { StackHeader } from '../../components/ui/Header';
import { useAppAuth } from '../../context/AuthProvider';
import { calculateDisplayPrice, PLATFORM_FEE_PERCENTAGE } from '../../hooks/useOrderTotal';
import { formatPrice } from '../../theme';
import type { Category, Id, ProductCondition, RootStackParamList } from '../../types';
import { canManageCatalog } from '../../utils/roles';
import { canManageListings } from '../../utils/roles';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

type Props = NativeStackScreenProps<RootStackParamList, 'EditProduct'>;

const CONDITIONS: { value: ProductCondition; label: string; icon: string }[] = [
  { value: 'new', label: 'New', icon: 'star' },
  { value: 'like_new', label: 'Like New', icon: 'star-half-full' },
  { value: 'good', label: 'Good', icon: 'thumb-up' },
  { value: 'fair', label: 'Fair', icon: 'check' },
];

interface ConditionButtonProps {
  condition: typeof CONDITIONS[0];
  isSelected: boolean;
  onPress: () => void;
  theme: MD3Theme;
}

function ConditionButton({ condition, isSelected, onPress, theme }: ConditionButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.conditionButton,
        {
          backgroundColor: isSelected ? theme.colors.primary : theme.colors.surfaceVariant,
          borderColor: isSelected ? theme.colors.primary : 'transparent',
        },
      ]}
    >
      <Icon
        name={condition.icon}
        size={16}
        color={isSelected ? '#FFFFFF' : theme.colors.onSurfaceVariant}
      />
      <Text
        style={[
          styles.conditionButtonText,
          { color: isSelected ? '#FFFFFF' : theme.colors.onSurfaceVariant },
        ]}
      >
        {condition.label}
      </Text>
    </Pressable>
  );
}

interface StatusToggleProps {
  status: 'draft' | 'pending_review';
  onStatusChange: (status: 'draft' | 'pending_review') => void;
  theme: MD3Theme;
}

function StatusToggle({ status, onStatusChange, theme }: StatusToggleProps) {
  return (
    <View style={styles.statusContainer}>
      <Pressable
        onPress={() => onStatusChange('pending_review')}
        style={[
          styles.statusButton,
          status === 'pending_review' && styles.statusButtonActive,
          {
            backgroundColor: status === 'pending_review' ? '#10B981' : theme.colors.surfaceVariant,
          },
        ]}
      >
        <Icon
          name="check-circle"
          size={18}
          color={status === 'pending_review' ? '#FFFFFF' : theme.colors.onSurfaceVariant}
        />
        <Text
          style={[
            styles.statusButtonText,
            { color: status === 'pending_review' ? '#FFFFFF' : theme.colors.onSurfaceVariant },
          ]}
        >
          Submit for Review
        </Text>
      </Pressable>
      <Pressable
        onPress={() => onStatusChange('draft')}
        style={[
          styles.statusButton,
          status === 'draft' && styles.statusButtonActive,
          {
            backgroundColor: status === 'draft' ? '#64748B' : theme.colors.surfaceVariant,
          },
        ]}
      >
        <Icon
          name="file-edit-outline"
          size={18}
          color={status === 'draft' ? '#FFFFFF' : theme.colors.onSurfaceVariant}
        />
        <Text
          style={[
            styles.statusButtonText,
            { color: status === 'draft' ? '#FFFFFF' : theme.colors.onSurfaceVariant },
          ]}
        >
          Draft
        </Text>
      </Pressable>
    </View>
  );
}

export default function EditProductScreen({ route, navigation }: Props) {
  const theme = useTheme() as MD3Theme;
  const { productId } = route.params;
  const { user } = useAppAuth();
  const vendorProfile = useQuery(
    api.vendors.getMyVendorProfile,
    user?._id ? { ownerUserId: user._id } : 'skip'
  );
  const hasListingAccess = canManageListings(user?.role, vendorProfile?.status ?? null);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [condition, setCondition] = useState<ProductCondition>('good');
  const [status, setStatus] = useState<'draft' | 'pending_review'>('draft');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [location, setLocation] = useState('');
  const [loading, setLoading] = useState(false);
  const [deleteDialogVisible, setDeleteDialogVisible] = useState(false);
  const [categoryMenuVisible, setCategoryMenuVisible] = useState(false);
  const [deliveryType, setDeliveryType] = useState<'free' | 'paid'>('free');
  const [deliveryFee, setDeliveryFee] = useState('');

  const product = useQuery(api.products.getProduct, {
    productId: productId as Id<'products'>,
    viewerUserId: user?._id,
  });
  const categories = useQuery(api.categories.getCategoriesTree);
  const updateProduct = useMutation(api.products.updateProduct);
  const deleteProduct = useMutation(api.products.deleteProduct);

  useEffect(() => {
    if (product) {
      setTitle(product.title);
      setDescription(product.description);
      setPrice(product.price.toString());
      setQuantity((product.quantity || 1).toString());
      setCondition(product.condition);
      setStatus(product.status === 'draft' ? 'draft' : 'pending_review');
      setCategoryId(product.categoryId);
      if (product.location) {
        if (typeof product.location === 'string') {
          setLocation(product.location);
        } else {
          setLocation(product.location.city || '');
        }
      } else {
        setLocation('');
      }
      // Load shipping options
      if (product.shippingOptions && product.shippingOptions.length > 0) {
        const shipping = product.shippingOptions[0];
        if (shipping.price > 0) {
          setDeliveryType('paid');
          setDeliveryFee(shipping.price.toString());
        } else {
          setDeliveryType('free');
          setDeliveryFee('');
        }
      }
    }
  }, [product]);

  const selectedCategory = categories?.find((c) => c._id === categoryId) ||
    categories?.flatMap((c) => c.subcategories || []).find((c) => c._id === categoryId);

  const handleSubmit = async () => {
    if (!user || !product) return;

    if (!title.trim() || !description.trim() || !price || !categoryId) {
      Alert.alert('Missing Information', 'Please fill in all required fields');
      return;
    }

    const priceNum = parseFloat(price);
    if (isNaN(priceNum) || priceNum <= 0) {
      Alert.alert('Invalid Price', 'Please enter a valid price');
      return;
    }

    const quantityNum = parseInt(quantity, 10);
    if (isNaN(quantityNum) || quantityNum < 0) {
      Alert.alert('Invalid Quantity', 'Please enter a valid quantity');
      return;
    }

    setLoading(true);

    try {
      await updateProduct({
        productId: product._id,
        actorUserId: user._id,
        title: title.trim(),
        description: description.trim(),
        price: priceNum,
        quantity: quantityNum,
        condition,
        status,
        categoryId: categoryId as Id<'categories'>,
        location: location.trim() ? { city: location.trim(), province: '' } : undefined,
        shippingOptions: [{
          name: deliveryType === 'free' ? 'Free Delivery' : 'Standard Delivery',
          price: deliveryType === 'free' ? 0 : parseFloat(deliveryFee) || 0,
          estimatedDays: '3-5 days',
        }],
      });

      Alert.alert('Success', 'Your listing has been updated!', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to update listing';
      Alert.alert('Error', errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!user || !product) return;

    setDeleteDialogVisible(false);
    setLoading(true);

    try {
      await deleteProduct({
        productId: product._id,
        actorUserId: user._id,
      });

      Alert.alert('Deleted', 'Your listing has been removed', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to delete listing';
      Alert.alert('Error', errorMessage);
    } finally {
      setLoading(false);
    }
  };

  // Loading State
  if (user && !hasListingAccess) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Listing Access" onBackPress={() => navigation.goBack()} />
        <View style={styles.loadingContainer}>
          <Icon name="lock-outline" size={64} color={theme.colors.onSurfaceVariant} />
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 16 }}>
            Listing access is restricted
          </Text>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, textAlign: 'center' }}>
            Only approved vendors and catalog staff can edit listings.
          </Text>
        </View>
      </View>
    );
  }

  // Loading State
  if (product === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Edit Listing" onBackPress={() => navigation.goBack()} />
        <View style={styles.loadingContainer}>
          <MotiView
            from={{ opacity: 0.5, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{
              opacity: { type: 'timing', duration: 1000, loop: true, repeatReverse: true },
              scale: { type: 'timing', duration: 1000, loop: true, repeatReverse: true },
            }}
          >
            <ActivityIndicator size="large" color={theme.colors.primary} />
          </MotiView>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 16 }}>
            Loading product...
          </Text>
        </View>
      </View>
    );
  }

  // Not Found State
  if (product === null) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Edit Listing" onBackPress={() => navigation.goBack()} />
        <View style={styles.loadingContainer}>
          <Icon name="alert-circle-outline" size={64} color={theme.colors.error} />
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 16 }}>
          Product not found
        </Text>
          <Pressable
            onPress={() => navigation.goBack()}
            style={[styles.backButton, { backgroundColor: theme.colors.primary }]}
          >
            <Text style={{ color: '#FFFFFF', fontWeight: '600' }}>Go Back</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const flatCategories: Category[] = [];
  categories?.forEach((cat) => {
    flatCategories.push(cat);
    cat.subcategories?.forEach((sub) => flatCategories.push(sub));
  });

  const hasImage = product.images && product.images.length > 0 && product.images[0];

  return (
    <>
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Edit Listing"
          onBackPress={() => navigation.goBack()}
          rightActions={[
            {
              icon: 'eye-outline',
              onPress: () => navigation.navigate('ProductDetail', { productId: product._id }),
            },
          ]}
        />

        <ScrollView
          style={styles.scrollView}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Product Preview Card */}
          <Animated.View entering={FadeInDown.duration(400)}>
            <Surface style={[styles.previewCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <View style={styles.previewContent}>
                {hasImage ? (
                  <Image source={{ uri: product.images[0] }} style={styles.previewImage} />
                ) : (
                  <View style={[styles.previewImagePlaceholder, { backgroundColor: theme.colors.surfaceVariant }]}>
                    <Icon name="image-outline" size={32} color={theme.colors.onSurfaceVariant} />
                  </View>
                )}
                <View style={styles.previewInfo}>
                  <Text variant="titleMedium" numberOfLines={1} style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                    {title || product.title}
                  </Text>
                  <Text variant="titleLarge" style={{ color: theme.colors.primary, fontWeight: '800', marginTop: 4 }}>
                    {formatPrice(parseFloat(price) || product.price)}
                  </Text>
                  <View style={styles.previewStats}>
                    <View style={styles.previewStat}>
                      <Icon name="eye-outline" size={14} color={theme.colors.onSurfaceVariant} />
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginLeft: 4 }}>
                        {product.views || 0} views
                      </Text>
                    </View>
                    <View style={styles.previewStat}>
                      <Icon name="calendar-outline" size={14} color={theme.colors.onSurfaceVariant} />
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginLeft: 4 }}>
                        {new Date(product.createdAt).toLocaleDateString()}
                      </Text>
                    </View>
                  </View>
                </View>
              </View>
            </Surface>
          </Animated.View>

          {/* Status Section */}
          <Animated.View entering={FadeInDown.delay(50).duration(400)}>
            <Surface style={[styles.section, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <View style={styles.sectionHeader}>
                <Icon name="toggle-switch-outline" size={20} color={theme.colors.primary} />
                <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                  Listing Status
                </Text>
              </View>
              <StatusToggle status={status} onStatusChange={setStatus} theme={theme} />
            </Surface>
          </Animated.View>

          {/* Basic Info Section */}
          <Animated.View entering={FadeInDown.delay(100).duration(400)}>
            <Surface style={[styles.section, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <View style={styles.sectionHeader}>
                <Icon name="text-box-outline" size={20} color={theme.colors.primary} />
                <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                  Basic Information
                </Text>
              </View>

          <TextInput
            mode="outlined"
                label="Title"
            value={title}
            onChangeText={setTitle}
            maxLength={100}
            style={styles.input}
                outlineStyle={styles.inputOutline}
          />

          <TextInput
            mode="outlined"
                label="Description"
            value={description}
            onChangeText={setDescription}
            multiline
            numberOfLines={4}
            maxLength={2000}
                style={[styles.input, styles.textArea]}
                outlineStyle={styles.inputOutline}
          />
            </Surface>
          </Animated.View>

          {/* Pricing & Quantity Section */}
          <Animated.View entering={FadeInDown.delay(150).duration(400)}>
            <Surface style={[styles.section, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <View style={styles.sectionHeader}>
                <Icon name="cash" size={20} color={theme.colors.primary} />
                <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                  Pricing & Stock
                </Text>
              </View>

              <View style={styles.priceQuantityRow}>
                <View style={styles.priceInputContainer}>
          <TextInput
            mode="outlined"
                    label="Price (ZMW)"
            value={price}
            onChangeText={setPrice}
            keyboardType="decimal-pad"
                    left={<TextInput.Affix text="K" textStyle={{ fontWeight: '700', color: theme.colors.primary }} />}
            style={styles.input}
                    outlineStyle={styles.inputOutline}
                  />
                </View>
                <View style={styles.quantityInputContainer}>
                  <TextInput
                    mode="outlined"
                    label="Quantity"
                    value={quantity}
                    onChangeText={setQuantity}
                    keyboardType="number-pad"
                    left={<TextInput.Icon icon="package-variant" />}
                    style={styles.input}
                    outlineStyle={styles.inputOutline}
            />
          </View>
              </View>

              {/* Quick quantity buttons */}
              <View style={styles.quantityButtonsRow}>
                {[1, 5, 10, 25, 50].map((num) => (
                  <Pressable
                    key={num}
                    onPress={() => setQuantity(num.toString())}
                    style={[
                      styles.quantityQuickButton,
                      {
                        backgroundColor:
                          quantity === num.toString()
                            ? theme.colors.primary
                            : theme.colors.surfaceVariant,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.quantityQuickButtonText,
                        {
                          color:
                            quantity === num.toString()
                              ? '#FFFFFF'
                              : theme.colors.onSurfaceVariant,
                        },
                      ]}
                    >
                      {num}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {/* Fee Info Note */}
              <View style={[styles.feeInfoCard, { backgroundColor: theme.colors.primaryContainer + '40' }]}>
                <Icon name="information-outline" size={18} color={theme.colors.primary} />
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text variant="labelMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                    Buyers will see: {price ? `K${calculateDisplayPrice(parseFloat(price) || 0).toLocaleString('en-ZM', { minimumFractionDigits: 2 })}` : 'K0.00'}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                    A {PLATFORM_FEE_PERCENTAGE * 100}% service fee is added to your price for secure payments & escrow.
                  </Text>
                </View>
              </View>
            </Surface>
          </Animated.View>

          {/* Category Section */}
          <Animated.View entering={FadeInDown.delay(200).duration(400)}>
            <Surface style={[styles.section, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <View style={styles.sectionHeader}>
                <Icon name="folder-outline" size={20} color={theme.colors.primary} />
                <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                  Category
            </Text>
              </View>

              <Pressable
                  onPress={() => setCategoryMenuVisible(true)}
                style={[styles.categorySelector, { borderColor: theme.colors.outline }]}
              >
                <Text
                  style={{
                    color: selectedCategory ? theme.colors.onSurface : theme.colors.onSurfaceVariant,
                    flex: 1,
                  }}
                >
                  {selectedCategory?.name || 'Select a category'}
                </Text>
                <Icon name="chevron-down" size={20} color={theme.colors.onSurfaceVariant} />
              </Pressable>
            </Surface>
          </Animated.View>

          {/* Condition Section */}
          <Animated.View entering={FadeInDown.delay(250).duration(400)}>
            <Surface style={[styles.section, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <View style={styles.sectionHeader}>
                <Icon name="star-outline" size={20} color={theme.colors.primary} />
                <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                  Condition
                </Text>
              </View>

              <View style={styles.conditionContainer}>
                {CONDITIONS.map((c) => (
                  <ConditionButton
                    key={c.value}
                    condition={c}
                    isSelected={condition === c.value}
                    onPress={() => setCondition(c.value)}
                    theme={theme}
                  />
                ))}
          </View>
            </Surface>
          </Animated.View>

          {/* Location Section */}
          <Animated.View entering={FadeInDown.delay(300).duration(400)}>
            <Surface style={[styles.section, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <View style={styles.sectionHeader}>
                <Icon name="map-marker-outline" size={20} color={theme.colors.primary} />
                <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                  Location
            </Text>
          </View>

          <TextInput
            mode="outlined"
                label="City (optional)"
            value={location}
            onChangeText={setLocation}
            placeholder="e.g., Lusaka, Kitwe"
            style={styles.input}
                outlineStyle={styles.inputOutline}
                left={<TextInput.Icon icon="map-marker" />}
              />
            </Surface>
          </Animated.View>

          {/* Delivery Section */}
          <Animated.View entering={FadeInDown.delay(350).duration(400)}>
            <Surface style={[styles.section, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <View style={styles.sectionHeader}>
                <Icon name="truck-delivery" size={20} color={theme.colors.secondary} />
                <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                  Delivery Options
                </Text>
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
                    size={22}
                    color={deliveryType === 'free' ? theme.colors.secondary : theme.colors.onSurfaceVariant}
                  />
                  <Text
                    variant="labelMedium"
                    style={{
                      color: deliveryType === 'free' ? theme.colors.secondary : theme.colors.onSurface,
                      marginTop: 4,
                      fontWeight: deliveryType === 'free' ? '700' : '400',
                    }}
                  >
                    Free Delivery
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
                    size={22}
                    color={deliveryType === 'paid' ? theme.colors.primary : theme.colors.onSurfaceVariant}
                  />
                  <Text
                    variant="labelMedium"
                    style={{
                      color: deliveryType === 'paid' ? theme.colors.primary : theme.colors.onSurface,
                      marginTop: 4,
                      fontWeight: deliveryType === 'paid' ? '700' : '400',
                    }}
                  >
                    Paid Delivery
                  </Text>
                </Pressable>
              </View>

              {/* Delivery Fee Input */}
              {deliveryType === 'paid' && (
                <Animated.View entering={FadeInDown.duration(200)}>
                  <TextInput
                    mode="outlined"
                    label="Delivery Fee (ZMW)"
                    value={deliveryFee}
                    onChangeText={setDeliveryFee}
                    placeholder="e.g., 50"
                    keyboardType="decimal-pad"
                    left={<TextInput.Affix text="K" textStyle={{ color: theme.colors.primary, fontWeight: '600' }} />}
                    style={styles.input}
                    outlineStyle={styles.inputOutline}
                  />
                </Animated.View>
              )}
            </Surface>
          </Animated.View>

          {/* Action Buttons */}
          <Animated.View entering={FadeInUp.delay(350).duration(400)} style={styles.actionsContainer}>
            <Pressable
            onPress={handleSubmit}
            disabled={loading || !title || !description || !price || !categoryId}
              style={({ pressed }) => [
                styles.saveButton,
                { opacity: pressed ? 0.9 : 1 },
                (!title || !description || !price || !categoryId) && styles.buttonDisabled,
              ]}
            >
              <LinearGradient
                colors={[theme.colors.primary, theme.colors.tertiary]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.saveButtonGradient}
          >
                {loading ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <>
                    <Icon name="content-save-outline" size={22} color="#FFFFFF" />
                    <Text style={styles.saveButtonText}>Save Changes</Text>
                  </>
                )}
              </LinearGradient>
            </Pressable>

            <Pressable
            onPress={() => setDeleteDialogVisible(true)}
            disabled={loading}
              style={[styles.deleteButton, { borderColor: theme.colors.error }]}
          >
              <Icon name="trash-can-outline" size={20} color={theme.colors.error} />
              <Text style={[styles.deleteButtonText, { color: theme.colors.error }]}>
            Delete Listing
              </Text>
            </Pressable>
          </Animated.View>
        </ScrollView>
        </View>

      {/* Category Selection Modal */}
      <Portal>
        <Dialog
          visible={categoryMenuVisible}
          onDismiss={() => setCategoryMenuVisible(false)}
          style={{ backgroundColor: theme.colors.surface }}
        >
          <Dialog.Title>Select Category</Dialog.Title>
          <Dialog.ScrollArea style={{ maxHeight: 400 }}>
            <ScrollView>
              {flatCategories.map((cat) => (
                <Pressable
                  key={cat._id}
                  onPress={() => {
                    setCategoryId(cat._id);
                    setCategoryMenuVisible(false);
                  }}
                  style={[
                    styles.categoryItem,
                    categoryId === cat._id && { backgroundColor: theme.colors.primaryContainer },
                  ]}
                >
                  <Text
                    style={[
                      styles.categoryItemText,
                      { color: theme.colors.onSurface },
                      cat.parentId && styles.subcategoryText,
                      categoryId === cat._id && { color: theme.colors.primary, fontWeight: '700' },
                    ]}
                  >
                    {cat.parentId ? `  ${cat.name}` : cat.name}
                  </Text>
                  {categoryId === cat._id && (
                    <Icon name="check" size={20} color={theme.colors.primary} />
                  )}
                </Pressable>
              ))}
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button onPress={() => setCategoryMenuVisible(false)}>Cancel</Button>
          </Dialog.Actions>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <Dialog
          visible={deleteDialogVisible}
          onDismiss={() => setDeleteDialogVisible(false)}
          style={{ backgroundColor: theme.colors.surface }}
        >
          <Dialog.Title>
            <View style={styles.deleteDialogTitle}>
              <Icon name="alert-circle" size={24} color={theme.colors.error} />
              <Text style={{ marginLeft: 8, fontSize: 20, fontWeight: '600' }}>Delete Listing</Text>
            </View>
          </Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              Are you sure you want to delete "{product.title}"? This action cannot be undone.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeleteDialogVisible(false)}>Cancel</Button>
            <Button onPress={handleDelete} textColor={theme.colors.error}>
              Delete
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backButton: {
    marginTop: 24,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 20,
  },
  scrollView: {
    flex: 1,
  },
  previewCard: {
    margin: 16,
    marginBottom: 8,
    borderRadius: 16,
    overflow: 'hidden',
  },
  previewContent: {
    flexDirection: 'row',
    padding: 12,
  },
  previewImage: {
    width: 80,
    height: 80,
    borderRadius: 12,
    backgroundColor: '#E5E5E5',
  },
  previewImagePlaceholder: {
    width: 80,
    height: 80,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  previewInfo: {
    flex: 1,
    marginLeft: 12,
    justifyContent: 'center',
  },
  previewStats: {
    flexDirection: 'row',
    marginTop: 8,
    gap: 16,
  },
  previewStat: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  section: {
    margin: 16,
    marginTop: 8,
    padding: 16,
    borderRadius: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  sectionTitle: {
    marginLeft: 10,
    fontWeight: '700',
  },
  input: {
    marginBottom: 0,
    backgroundColor: 'transparent',
  },
  inputOutline: {
    borderRadius: 12,
  },
  textArea: {
    marginTop: 12,
    minHeight: 100,
  },
  priceQuantityRow: {
    flexDirection: 'row',
    gap: 12,
  },
  priceInputContainer: {
    flex: 2,
  },
  quantityInputContainer: {
    flex: 1,
  },
  quantityButtonsRow: {
    flexDirection: 'row',
    marginTop: 12,
    gap: 8,
  },
  quantityQuickButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
  },
  quantityQuickButtonText: {
    fontWeight: '600',
    fontSize: 14,
  },
  feeInfoCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 12,
    borderRadius: 10,
    marginTop: 16,
  },
  deliveryOptionsRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 12,
  },
  deliveryOption: {
    flex: 1,
    alignItems: 'center',
    padding: 14,
    borderRadius: 12,
    borderWidth: 2,
  },
  statusContainer: {
    flexDirection: 'row',
    gap: 12,
  },
  statusButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 12,
    gap: 8,
  },
  statusButtonActive: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  statusButtonText: {
    fontWeight: '600',
    fontSize: 15,
  },
  categorySelector: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
  },
  conditionContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  conditionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
    gap: 6,
  },
  conditionButtonText: {
    fontWeight: '600',
    fontSize: 13,
  },
  actionsContainer: {
    padding: 16,
    paddingTop: 8,
    paddingBottom: 40,
  },
  saveButton: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  saveButtonGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    gap: 10,
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 16,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  deleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 16,
    borderWidth: 1.5,
    marginTop: 12,
    gap: 8,
  },
  deleteButtonText: {
    fontWeight: '600',
    fontSize: 15,
  },
  categoryItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 8,
    marginHorizontal: 8,
    marginVertical: 2,
  },
  categoryItemText: {
    fontSize: 15,
  },
  subcategoryText: {
    fontWeight: '400',
  },
  deleteDialogTitle: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
