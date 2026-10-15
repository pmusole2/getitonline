import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery } from 'convex/react';
import { LinearGradient } from 'expo-linear-gradient';
import { MotiView } from 'moti';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { Button, Chip, Dialog, MD3Theme, Portal, Surface, Text, TextInput, useTheme } from 'react-native-paper';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { AccountAccessNotice } from '../../components/auth/AccountAccessNotice';
import { useAccountAccess } from '../../components/auth/useAccountAccess';
import { StackHeader } from '../../components/ui/Header';
import { useAppAuth } from '../../context/AuthProvider';
import { useImageUpload } from '../../hooks/useImageUpload';
import { calculateDisplayPrice, PLATFORM_FEE_PERCENTAGE } from '../../hooks/useOrderTotal';
import { formatPrice } from '../../theme';
import type { CategoryTreeItem, Id, ProductCondition, RootStackParamList } from '../../types';
import { canManageListings } from '../../utils/roles';
import { ProductVariantEditor } from './ProductVariantEditor';
import {
  createVariantEditorState,
  deriveProductColor,
  findRemovedStockedCombinations,
  materializeVariantMedia,
  reconcileVariantCombinations,
  validateVariantDraft,
  type VariantAttribute,
  type VariantCombination,
  type VariantCombinationPatch,
} from './productVariantDomain';

type Props = NativeStackScreenProps<RootStackParamList, 'EditProduct'>;
type AvailabilityStatus = 'in_stock' | 'low_stock' | 'out_of_stock' | 'preorder';
type WarrantyType = 'manufacturer' | 'seller' | 'none';

const MAX_IMAGES = 8;
const MIN_IMAGES = 3;
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const MIN_IMAGE_DIMENSION = 1000;
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png'] as const;

const CONDITIONS: { value: ProductCondition; label: string; icon: string }[] = [
  { value: 'new', label: 'New', icon: 'star' },
  { value: 'like_new', label: 'Like New', icon: 'star-half-full' },
  { value: 'good', label: 'Good', icon: 'thumb-up' },
  { value: 'fair', label: 'Fair', icon: 'check' },
];

const availabilityOptions: Array<{ value: AvailabilityStatus; label: string }> = [
  { value: 'in_stock', label: 'In stock' },
  { value: 'low_stock', label: 'Low stock' },
  { value: 'out_of_stock', label: 'Out of stock' },
  { value: 'preorder', label: 'Preorder' },
];

function parseMoney(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseInteger(value: string) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseOptionalNumber(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseLines(value: string, limit?: number) {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return limit ? lines.slice(0, limit) : lines;
}

function parseKeyValueLines(value: string) {
  return parseLines(value)
    .map((line) => {
      const [key, ...rest] = line.split(':');
      const resolvedKey = key.trim();
      const resolvedValue = rest.join(':').trim();
      if (!resolvedKey || !resolvedValue) return null;
      return { key: resolvedKey, value: resolvedValue };
    })
    .filter((item): item is { key: string; value: string } => item !== null);
}

function parseAddOns(value: string) {
  const addOns: Array<{ name: string; description?: string; price: number; isRequired: boolean }> = [];

  parseLines(value).forEach((line) => {
    const [name, rawPrice, description, required] = line.split('|').map((part) => part.trim());
    const price = Number.parseFloat(rawPrice ?? '');
    if (!name || !Number.isFinite(price) || price < 0) return;
    addOns.push({
      name,
      ...(description ? { description } : {}),
      price,
      isRequired: required?.toLowerCase() === 'required',
    });
  });

  return addOns;
}

function stringifyKeyValues(items?: Array<{ key: string; value: string }>) {
  return (items ?? []).map((item) => `${item.key}: ${item.value}`).join('\n');
}

function stringifyAddOns(items?: Array<{ name: string; price: number; description?: string; isRequired: boolean }>) {
  return (items ?? [])
    .map((addOn) => `${addOn.name}|${addOn.price}|${addOn.description ?? ''}${addOn.isRequired ? '|required' : ''}`)
    .join('\n');
}

function findL1(categories: CategoryTreeItem[] | undefined, categoryId: string | null) {
  return categories?.find((category) => category._id === categoryId) ?? null;
}

function findL2(category: CategoryTreeItem | null, subcategoryId: string | null) {
  return category?.subcategories.find((subcategory) => subcategory._id === subcategoryId) ?? null;
}

interface ConditionButtonProps {
  condition: (typeof CONDITIONS)[0];
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
      <Icon name={condition.icon} size={16} color={isSelected ? '#FFFFFF' : theme.colors.onSurfaceVariant} />
      <Text style={[styles.conditionButtonText, { color: isSelected ? '#FFFFFF' : theme.colors.onSurfaceVariant }]}>
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
          style={[styles.statusButtonText, { color: status === 'draft' ? '#FFFFFF' : theme.colors.onSurfaceVariant }]}
        >
          Draft
        </Text>
      </Pressable>
    </View>
  );
}

export default function EditProductScreen(props: Props) {
  const access = useAccountAccess();
  if (access.status !== 'ready') {
    return <AccountAccessNotice access={access} title="Edit Listing" />;
  }
  return <EditProductContent {...props} />;
}

function EditProductContent({ route, navigation }: Props) {
  const theme = useTheme() as MD3Theme;
  const { productId } = route.params;
  const { user } = useAppAuth();
  const vendorProfile = useQuery(api.vendors.getMyVendorProfile, user?._id && !user.isBanned ? {} : 'skip');
  const hasListingAccess = canManageListings(user?.role, vendorProfile?.status ?? null);
  const upload = useImageUpload();

  const [title, setTitle] = useState('');
  const [brand, setBrand] = useState('');
  const [sku, setSku] = useState('');
  const [shortDescription, setShortDescription] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [compareAtPrice, setCompareAtPrice] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [lowStockThreshold, setLowStockThreshold] = useState('3');
  const [availabilityStatus, setAvailabilityStatus] = useState<AvailabilityStatus>('in_stock');
  const [isPreorder, setIsPreorder] = useState(false);
  const [condition, setCondition] = useState<ProductCondition>('good');
  const [status, setStatus] = useState<'draft' | 'pending_review'>('draft');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [subcategoryId, setSubcategoryId] = useState<string | null>(null);
  const [classificationId, setClassificationId] = useState<string | null>(null);
  const [keyFeaturesText, setKeyFeaturesText] = useState('');
  const [specificationsText, setSpecificationsText] = useState('');
  const [variantAttributes, setVariantAttributes] = useState<VariantAttribute[]>([]);
  const [storedVariantCombinations, setStoredVariantCombinations] = useState<VariantCombination[]>([]);
  const [variantPatches, setVariantPatches] = useState<Record<string, VariantCombinationPatch>>({});
  const [colorMedia, setColorMedia] = useState<Record<string, string[]>>({});
  const [combinationMedia, setCombinationMedia] = useState<Record<string, string[]>>({});
  const [addOnsText, setAddOnsText] = useState('');
  const [weightKg, setWeightKg] = useState('');
  const [lengthCm, setLengthCm] = useState('');
  const [widthCm, setWidthCm] = useState('');
  const [heightCm, setHeightCm] = useState('');
  const [warrantyType, setWarrantyType] = useState<WarrantyType>('seller');
  const [warrantyDays, setWarrantyDays] = useState('');
  const [warrantyProvider, setWarrantyProvider] = useState('');
  const [warrantyTerms, setWarrantyTerms] = useState('');
  const [countryOfOrigin, setCountryOfOrigin] = useState('');
  const [modelNumber, setModelNumber] = useState('');
  const [material, setMaterial] = useState('');
  const [color, setColor] = useState('');
  const [city, setCity] = useState('');
  const [province, setProvince] = useState('');
  const [existingImages, setExistingImages] = useState<string[]>([]);
  const [primaryWhiteBackground, setPrimaryWhiteBackground] = useState(false);
  const [loading, setLoading] = useState(false);
  const [deleteDialogVisible, setDeleteDialogVisible] = useState(false);
  const [deliveryType, setDeliveryType] = useState<'free' | 'paid'>('free');
  const [deliveryName, setDeliveryName] = useState('Standard Delivery');
  const [deliveryFee, setDeliveryFee] = useState('');
  const [deliveryEta, setDeliveryEta] = useState('3-5 days');
  const initializedProductId = useRef<string | null>(null);

  const product = useQuery(api.products.getProduct, {
    productId: productId as Id<'products'>,
  });
  const categories = useQuery(api.categories.getCategoriesTree);
  const updateProduct = useMutation(api.products.updateProduct);
  const deleteProduct = useMutation(api.products.deleteProduct);
  const selectedL1 = findL1(categories, categoryId);
  const selectedL2 = findL2(selectedL1, subcategoryId);
  const keyFeatures = parseLines(keyFeaturesText, 10);
  const specifications = parseKeyValueLines(specificationsText);
  const allImageUrls = [...existingImages, ...upload.images.map((image) => image.url)].slice(0, MAX_IMAGES);
  const variantCombinations = reconcileVariantCombinations({
    attributes: variantAttributes,
    existing: storedVariantCombinations,
    patches: variantPatches,
    baseSku: sku,
    defaultPrice: parseMoney(price),
    defaultStock: parseInteger(quantity),
  });
  const variantValidationIssues = validateVariantDraft({
    attributes: variantAttributes,
    combinations: variantCombinations,
    productImages: allImageUrls,
    productSku: sku,
  });
  const addOns = parseAddOns(addOnsText);
  const validationErrors = (() => {
    const errors: string[] = [];
    const priceValue = parseMoney(price);
    const compareAtValue = parseOptionalNumber(compareAtPrice);
    const quantityValue = parseInteger(quantity);

    if (allImageUrls.length < MIN_IMAGES || allImageUrls.length > MAX_IMAGES) {
      errors.push(`Keep ${MIN_IMAGES}-${MAX_IMAGES} product images.`);
    }
    if (!primaryWhiteBackground) errors.push('Confirm the primary image uses a white background.');
    if (!categoryId || !subcategoryId || !classificationId) errors.push('Select L1, L2, and L3 categories.');
    if (!brand.trim()) errors.push('Brand is required.');
    if (!sku.trim()) errors.push('SKU is required.');
    if (!title.trim()) errors.push('Title is required.');
    if (!shortDescription.trim()) errors.push('Short description is required.');
    if (!description.trim()) errors.push('Full description is required.');
    if (keyFeatures.length < 3 || keyFeatures.length > 5) errors.push('Add 3-5 key features.');
    if (priceValue <= 0) errors.push('Price must be greater than zero.');
    if (compareAtValue !== undefined && compareAtValue <= priceValue) {
      errors.push('Compare-at price must be higher than the selling price.');
    }
    if (quantityValue < 0) errors.push('Stock quantity cannot be negative.');
    if (variantAttributes.length > 0) {
      errors.push(...variantValidationIssues.map((issue) => issue.message));
    }
    if (!deliveryName.trim()) errors.push('Delivery option name is required.');
    if (!deliveryEta.trim()) errors.push('Delivery ETA is required.');
    return errors;
  })();

  useEffect(() => {
    if (product && initializedProductId.current !== product._id) {
      initializedProductId.current = product._id;
      setTitle(product.title);
      setBrand(product.brand ?? '');
      setSku(product.sku ?? '');
      setShortDescription(product.shortDescription ?? '');
      setDescription(product.description);
      setPrice(product.price.toString());
      setCompareAtPrice(product.compareAtPrice?.toString() ?? '');
      setQuantity(product.variantCombinations?.length ? '0' : (product.quantity || 1).toString());
      setLowStockThreshold(product.lowStockThreshold?.toString() ?? '3');
      setAvailabilityStatus(product.availabilityStatus ?? 'in_stock');
      setIsPreorder(product.preorder?.isPreorder ?? false);
      setCondition(product.condition);
      setStatus(product.status === 'draft' ? 'draft' : 'pending_review');
      setCategoryId(product.categoryId);
      setSubcategoryId(product.subcategoryId ?? null);
      setClassificationId(product.classificationId ?? null);
      setKeyFeaturesText((product.keyFeatures ?? []).join('\n'));
      setSpecificationsText(stringifyKeyValues(product.specifications));
      const storedAttributes: VariantAttribute[] = product.variantAttributes?.length
        ? product.variantAttributes.map((attribute) => ({
            name: attribute.name,
            values: [...attribute.values],
          }))
        : (product.variants ?? []).map((variant) => ({
            name: variant.name,
            values: variant.options.map((option) => option.value),
          }));
      const variantEditorState = createVariantEditorState({
        attributes: storedAttributes,
        combinations: product.variantCombinations ?? [],
      });
      setVariantAttributes(variantEditorState.attributes);
      setStoredVariantCombinations(variantEditorState.existingCombinations);
      setVariantPatches(variantEditorState.combinationPatches);
      setColorMedia(variantEditorState.colorMedia);
      setCombinationMedia(variantEditorState.combinationMedia);
      setAddOnsText(stringifyAddOns(product.addOns));
      setWeightKg(product.weightKg?.toString() ?? '');
      setLengthCm(product.dimensions?.lengthCm?.toString() ?? '');
      setWidthCm(product.dimensions?.widthCm?.toString() ?? '');
      setHeightCm(product.dimensions?.heightCm?.toString() ?? '');
      setWarrantyType(product.warranty?.type ?? 'seller');
      setWarrantyDays(product.warranty?.durationDays?.toString() ?? '');
      setWarrantyProvider(product.warranty?.provider ?? '');
      setWarrantyTerms(product.warranty?.terms ?? '');
      setCountryOfOrigin(product.countryOfOrigin ?? '');
      setModelNumber(product.modelNumber ?? '');
      setMaterial(product.material ?? '');
      setColor(product.color ?? '');
      setExistingImages(product.images ?? []);
      setPrimaryWhiteBackground(product.imageMetadata?.find((image) => image.isPrimary)?.hasWhiteBackground ?? false);
      if (product.location) {
        setCity(product.location.city || '');
        setProvince(product.location.province || '');
      } else {
        setCity('');
        setProvince('');
      }
      // Load shipping options
      if (product.shippingOptions && product.shippingOptions.length > 0) {
        const shipping = product.shippingOptions[0];
        setDeliveryName(shipping.name);
        setDeliveryEta(shipping.estimatedDays);
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

  const performUpdate = async (persistedVariantCombinations: VariantCombination[]) => {
    if (!user || !product) return;

    const priceNum = parseMoney(price);
    const quantityNum = parseInt(quantity, 10);
    setLoading(true);

    try {
      const productDimensions =
        parseOptionalNumber(lengthCm) && parseOptionalNumber(widthCm) && parseOptionalNumber(heightCm)
          ? {
              lengthCm: parseOptionalNumber(lengthCm) ?? 0,
              widthCm: parseOptionalNumber(widthCm) ?? 0,
              heightCm: parseOptionalNumber(heightCm) ?? 0,
            }
          : undefined;
      const imageMetadata = allImageUrls.map((url, index) => {
        const uploaded = upload.images.find((image) => image.url === url);
        const original = product.imageMetadata?.find((image) => image.url === url);

        return {
          url,
          width: uploaded?.width ?? original?.width,
          height: uploaded?.height ?? original?.height,
          sizeBytes: uploaded?.sizeBytes ?? original?.sizeBytes,
          mimeType: uploaded?.mimeType ?? original?.mimeType,
          isPrimary: index === 0,
          hasWhiteBackground: index === 0 ? primaryWhiteBackground : original?.hasWhiteBackground,
        };
      });

      await updateProduct({
        productId: product._id,
        title: title.trim(),
        brand: brand.trim(),
        sku: sku.trim(),
        shortDescription: shortDescription.trim(),
        description: description.trim(),
        keyFeatures,
        price: priceNum,
        compareAtPrice: parseOptionalNumber(compareAtPrice),
        quantity: quantityNum,
        lowStockThreshold: parseInteger(lowStockThreshold),
        availabilityStatus: isPreorder ? 'preorder' : availabilityStatus,
        preorder: { isPreorder },
        condition,
        status,
        categoryId: categoryId as Id<'categories'>,
        subcategoryId: subcategoryId as Id<'categories'>,
        classificationId: classificationId as Id<'categories'>,
        images: allImageUrls,
        imageMetadata,
        variantAttributes,
        variantCombinations: persistedVariantCombinations,
        addOns,
        dimensions: productDimensions,
        weightKg: parseOptionalNumber(weightKg),
        packageDimensions: productDimensions,
        packageWeightKg: parseOptionalNumber(weightKg),
        warranty: {
          type: warrantyType,
          durationDays: parseInteger(warrantyDays) || undefined,
          provider: warrantyProvider.trim() || undefined,
          terms: warrantyTerms.trim() || undefined,
        },
        countryOfOrigin: countryOfOrigin.trim() || undefined,
        modelNumber: modelNumber.trim() || undefined,
        material: material.trim() || undefined,
        color: deriveProductColor(variantAttributes, color),
        specifications,
        location: city.trim() || province.trim() ? { city: city.trim(), province: province.trim() } : undefined,
        shippingOptions: [
          {
            name: deliveryName.trim() || (deliveryType === 'free' ? 'Free Delivery' : 'Standard Delivery'),
            price: deliveryType === 'free' ? 0 : parseFloat(deliveryFee) || 0,
            estimatedDays: deliveryEta.trim(),
          },
        ],
      });

      Alert.alert('Success', 'Your listing has been updated!', [{ text: 'OK', onPress: () => navigation.goBack() }]);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to update listing';
      Alert.alert('Error', errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = () => {
    if (!user || !product) return;

    if (validationErrors.length > 0) {
      Alert.alert('Listing is not ready', validationErrors[0]);
      return;
    }

    const priceNum = parseMoney(price);
    if (Number.isNaN(priceNum) || priceNum <= 0) {
      Alert.alert('Invalid Price', 'Please enter a valid price');
      return;
    }

    const quantityNum = Number.parseInt(quantity, 10);
    if (Number.isNaN(quantityNum) || quantityNum < 0) {
      Alert.alert('Invalid Quantity', 'Please enter a valid quantity');
      return;
    }

    let persistedVariantCombinations: VariantCombination[];
    try {
      persistedVariantCombinations = materializeVariantMedia({
        combinations: variantCombinations,
        colorMedia,
        combinationMedia,
        productImages: allImageUrls,
      });
    } catch (error: unknown) {
      Alert.alert(
        'Variant media is not ready',
        error instanceof Error ? error.message : 'Review the images assigned to product variants.',
      );
      return;
    }

    const removedStockedCombinations = findRemovedStockedCombinations(
      storedVariantCombinations,
      persistedVariantCombinations,
    );
    const save = () => {
      void performUpdate(persistedVariantCombinations);
    };

    if (removedStockedCombinations.length === 0) {
      save();
      return;
    }

    const totalRemainingStock = removedStockedCombinations.reduce((total, combination) => total + combination.stock, 0);
    Alert.alert(
      'Remove stocked variants?',
      `${removedStockedCombinations.map(({ sku: removedSku }) => removedSku).join(', ')} still hold ${totalRemainingStock} unit${totalRemainingStock === 1 ? '' : 's'}. Saving will remove these combinations.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove and save',
          style: 'destructive',
          onPress: save,
        },
      ],
    );
  };

  const handleDelete = async () => {
    if (!user || !product) return;

    setDeleteDialogVisible(false);
    setLoading(true);

    try {
      await deleteProduct({
        productId: product._id,
      });

      Alert.alert('Deleted', 'Your listing has been removed', [{ text: 'OK', onPress: () => navigation.goBack() }]);
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
          <Text
            variant="bodyMedium"
            style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, textAlign: 'center' }}
          >
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

  const hasImage = allImageUrls.length > 0;
  const pickImages = async () => {
    await upload.pickImages(MAX_IMAGES, {
      minWidth: MIN_IMAGE_DIMENSION,
      minHeight: MIN_IMAGE_DIMENSION,
      maxSizeBytes: MAX_IMAGE_SIZE_BYTES,
      allowedMimeTypes: IMAGE_MIME_TYPES,
    });
  };
  const removeExistingImage = (url: string) => {
    setExistingImages((current) => current.filter((imageUrl) => imageUrl !== url));
  };
  const resetSubcategory = (nextCategoryId: string) => {
    setCategoryId(nextCategoryId);
    setSubcategoryId(null);
    setClassificationId(null);
  };
  const resetClassification = (nextSubcategoryId: string) => {
    setSubcategoryId(nextSubcategoryId);
    setClassificationId(null);
  };

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

        <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {/* Product Preview Card */}
          <Animated.View entering={FadeInDown.duration(400)}>
            <Surface style={[styles.previewCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <View style={styles.previewContent}>
                {hasImage ? (
                  <Image source={{ uri: allImageUrls[0] }} style={styles.previewImage} />
                ) : (
                  <View style={[styles.previewImagePlaceholder, { backgroundColor: theme.colors.surfaceVariant }]}>
                    <Icon name="image-outline" size={32} color={theme.colors.onSurfaceVariant} />
                  </View>
                )}
                <View style={styles.previewInfo}>
                  <Text
                    variant="titleMedium"
                    numberOfLines={1}
                    style={{ color: theme.colors.onSurface, fontWeight: '600' }}
                  >
                    {title || product.title}
                  </Text>
                  <Text variant="titleLarge" style={{ color: theme.colors.primary, fontWeight: '800', marginTop: 4 }}>
                    {formatPrice(parseMoney(price) || product.price)}
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

          {/* Media Section */}
          <Animated.View entering={FadeInDown.delay(100).duration(400)}>
            <Surface style={[styles.section, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <View style={styles.sectionHeader}>
                <Icon name="image-multiple-outline" size={20} color={theme.colors.primary} />
                <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                  Product Images
                </Text>
              </View>
              <Text
                variant="bodySmall"
                style={{ color: theme.colors.onSurfaceVariant, lineHeight: 20, marginBottom: 12 }}
              >
                Maintain {MIN_IMAGES}-{MAX_IMAGES} JPG/PNG images. New uploads must be at least 1000x1000 and 5 MB or
                smaller.
              </Text>
              {upload.validationErrors.map((message) => (
                <Text key={message} variant="bodySmall" style={{ color: theme.colors.error, marginBottom: 8 }}>
                  {message}
                </Text>
              ))}
              <View style={styles.imageGrid}>
                {existingImages.map((imageUrl, index) => (
                  <View key={imageUrl} style={styles.imageTile}>
                    <Image source={{ uri: imageUrl }} style={styles.imageTilePreview} />
                    <Pressable style={styles.removeImageButton} onPress={() => removeExistingImage(imageUrl)}>
                      <Icon name="close" size={16} color="#FFFFFF" />
                    </Pressable>
                    {index === 0 && (
                      <Chip compact style={styles.primaryBadge}>
                        Primary
                      </Chip>
                    )}
                  </View>
                ))}
                {upload.images.map((image, index) => (
                  <View key={image.storageId || image.url} style={styles.imageTile}>
                    <Image source={{ uri: image.localUri || image.url }} style={styles.imageTilePreview} />
                    <Pressable style={styles.removeImageButton} onPress={() => upload.removeImage(index)}>
                      <Icon name="close" size={16} color="#FFFFFF" />
                    </Pressable>
                    {existingImages.length === 0 && index === 0 && (
                      <Chip compact style={styles.primaryBadge}>
                        Primary
                      </Chip>
                    )}
                  </View>
                ))}
                {allImageUrls.length < MAX_IMAGES && (
                  <Pressable
                    onPress={() => void pickImages()}
                    disabled={upload.isUploading}
                    style={[styles.addImageTile, { borderColor: theme.colors.primary }]}
                  >
                    <Icon name="plus" size={28} color={theme.colors.primary} />
                    <Text variant="labelMedium" style={{ color: theme.colors.primary, marginTop: 6 }}>
                      Add
                    </Text>
                  </Pressable>
                )}
              </View>
              <View style={styles.switchRow}>
                <View style={styles.switchText}>
                  <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                    Primary image has a white background
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                    Required for marketplace publishing.
                  </Text>
                </View>
                <Switch value={primaryWhiteBackground} onValueChange={setPrimaryWhiteBackground} />
              </View>
            </Surface>
          </Animated.View>

          {/* Taxonomy Section */}
          <Animated.View entering={FadeInDown.delay(150).duration(400)}>
            <Surface style={[styles.section, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <View style={styles.sectionHeader}>
                <Icon name="shape-outline" size={20} color={theme.colors.primary} />
                <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                  Retail Taxonomy
                </Text>
              </View>
              <TaxonomyGroup
                title="L1 Category"
                items={categories ?? []}
                selectedId={categoryId}
                onSelect={resetSubcategory}
              />
              <TaxonomyGroup
                title="L2 Subcategory"
                items={selectedL1?.subcategories ?? []}
                selectedId={subcategoryId}
                onSelect={resetClassification}
                disabled={!selectedL1}
              />
              <TaxonomyGroup
                title="L3 Classification"
                items={selectedL2?.classifications ?? []}
                selectedId={classificationId}
                onSelect={setClassificationId}
                disabled={!selectedL2}
              />
              {selectedL2 && (selectedL2.classifications?.length ?? 0) === 0 ? (
                <Text variant="bodySmall" style={{ color: theme.colors.error, marginTop: 10 }}>
                  This L2 category has no active L3 classifications. Ask an admin to complete the taxonomy before
                  resubmitting.
                </Text>
              ) : null}
            </Surface>
          </Animated.View>

          {/* Basic Info Section */}
          <Animated.View entering={FadeInDown.delay(200).duration(400)}>
            <Surface style={[styles.section, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <View style={styles.sectionHeader}>
                <Icon name="text-box-outline" size={20} color={theme.colors.primary} />
                <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                  Product Details
                </Text>
              </View>
              <View style={styles.formRow}>
                <TextInput
                  mode="outlined"
                  label="Brand"
                  value={brand}
                  onChangeText={setBrand}
                  style={styles.flexInput}
                  outlineStyle={styles.inputOutline}
                />
                <TextInput
                  mode="outlined"
                  label="SKU"
                  value={sku}
                  onChangeText={setSku}
                  style={styles.flexInput}
                  outlineStyle={styles.inputOutline}
                  autoCapitalize="characters"
                />
              </View>
              <TextInput
                mode="outlined"
                label="Title"
                value={title}
                onChangeText={setTitle}
                maxLength={150}
                style={styles.input}
                outlineStyle={styles.inputOutline}
              />
              <TextInput
                mode="outlined"
                label="Short description"
                value={shortDescription}
                onChangeText={setShortDescription}
                maxLength={300}
                multiline
                style={[styles.input, styles.textArea]}
                outlineStyle={styles.inputOutline}
              />
              <TextInput
                mode="outlined"
                label="Full description"
                value={description}
                onChangeText={setDescription}
                multiline
                numberOfLines={5}
                maxLength={5000}
                style={[styles.input, styles.textArea]}
                outlineStyle={styles.inputOutline}
              />
              <Text variant="labelMedium" style={[styles.groupLabel, { color: theme.colors.onSurfaceVariant }]}>
                Condition
              </Text>
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

          {/* Pricing & Quantity Section */}
          <Animated.View entering={FadeInDown.delay(250).duration(400)}>
            <Surface style={[styles.section, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <View style={styles.sectionHeader}>
                <Icon name="cash" size={20} color={theme.colors.primary} />
                <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                  Pricing & Inventory
                </Text>
              </View>
              <View style={styles.formRow}>
                <TextInput
                  mode="outlined"
                  label="Price (ZMW)"
                  value={price}
                  onChangeText={setPrice}
                  keyboardType="decimal-pad"
                  left={<TextInput.Affix text="K" textStyle={{ fontWeight: '700', color: theme.colors.primary }} />}
                  style={styles.flexInput}
                  outlineStyle={styles.inputOutline}
                />
                <TextInput
                  mode="outlined"
                  label="Compare-at"
                  value={compareAtPrice}
                  onChangeText={setCompareAtPrice}
                  keyboardType="decimal-pad"
                  style={styles.flexInput}
                  outlineStyle={styles.inputOutline}
                />
              </View>
              <View style={[styles.feeInfoCard, { backgroundColor: theme.colors.primaryContainer + '40' }]}>
                <Icon name="information-outline" size={18} color={theme.colors.primary} />
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text variant="labelMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                    Buyers will see:{' '}
                    {price
                      ? `K${calculateDisplayPrice(parseMoney(price)).toLocaleString('en-ZM', { minimumFractionDigits: 2 })}`
                      : 'K0.00'}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                    A {PLATFORM_FEE_PERCENTAGE * 100}% service fee is added to your price for secure payments & escrow.
                  </Text>
                </View>
              </View>
              <View style={styles.formRow}>
                <TextInput
                  mode="outlined"
                  label={variantAttributes.length > 0 ? 'Default stock for new variants' : 'Quantity'}
                  value={quantity}
                  onChangeText={setQuantity}
                  keyboardType="number-pad"
                  left={<TextInput.Icon icon="package-variant" />}
                  style={styles.flexInput}
                  outlineStyle={styles.inputOutline}
                />
                <TextInput
                  mode="outlined"
                  label="Low-stock alert"
                  value={lowStockThreshold}
                  onChangeText={setLowStockThreshold}
                  keyboardType="number-pad"
                  style={styles.flexInput}
                  outlineStyle={styles.inputOutline}
                />
              </View>
              <Text variant="labelMedium" style={[styles.groupLabel, { color: theme.colors.onSurfaceVariant }]}>
                Availability
              </Text>
              <View style={styles.chipWrap}>
                {availabilityOptions.map((option) => (
                  <Chip
                    key={option.value}
                    selected={availabilityStatus === option.value}
                    onPress={() => setAvailabilityStatus(option.value)}
                  >
                    {option.label}
                  </Chip>
                ))}
              </View>
              <View style={styles.switchRow}>
                <View style={styles.switchText}>
                  <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                    Available for preorder
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                    Mark this if customers can buy before stock arrives.
                  </Text>
                </View>
                <Switch value={isPreorder} onValueChange={setIsPreorder} />
              </View>
            </Surface>
          </Animated.View>

          {/* Specs Section */}
          <Animated.View entering={FadeInDown.delay(300).duration(400)}>
            <Surface style={[styles.section, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <View style={styles.sectionHeader}>
                <Icon name="format-list-checks" size={20} color={theme.colors.primary} />
                <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                  Features, Specs, Variants
                </Text>
              </View>
              <TextInput
                mode="outlined"
                label="Key features (one per line, 3-5)"
                value={keyFeaturesText}
                onChangeText={setKeyFeaturesText}
                multiline
                numberOfLines={6}
                style={[styles.input, styles.textArea]}
                outlineStyle={styles.inputOutline}
              />
              <Text variant="labelSmall" style={styles.counterText}>
                {keyFeatures.length}/5 features
              </Text>
              <TextInput
                mode="outlined"
                label="Specifications (Key: Value per line)"
                value={specificationsText}
                onChangeText={setSpecificationsText}
                multiline
                numberOfLines={5}
                style={[styles.input, styles.textArea]}
                outlineStyle={styles.inputOutline}
              />
              <ProductVariantEditor
                attributes={variantAttributes}
                combinations={variantCombinations}
                combinationPatches={variantPatches}
                colorMedia={colorMedia}
                combinationMedia={combinationMedia}
                productImages={allImageUrls}
                validationIssues={variantValidationIssues}
                onAttributesChange={setVariantAttributes}
                onCombinationPatchChange={(combinationKey, patch) =>
                  setVariantPatches((current) => ({
                    ...current,
                    [combinationKey]: {
                      ...(current[combinationKey] ?? {}),
                      ...patch,
                    },
                  }))
                }
                onColorMediaChange={(colorKey, images) =>
                  setColorMedia((current) => ({
                    ...current,
                    [colorKey]: images,
                  }))
                }
                onCombinationMediaChange={(combinationKey, images) =>
                  setCombinationMedia((current) => ({
                    ...current,
                    [combinationKey]: images,
                  }))
                }
              />
              <TextInput
                mode="outlined"
                label="Add-ons (Name|Price|Description|required)"
                value={addOnsText}
                onChangeText={setAddOnsText}
                multiline
                numberOfLines={3}
                style={[styles.input, styles.textArea]}
                outlineStyle={styles.inputOutline}
              />
              <View style={styles.formRow}>
                <TextInput
                  label="Weight kg"
                  mode="outlined"
                  value={weightKg}
                  onChangeText={setWeightKg}
                  keyboardType="decimal-pad"
                  style={styles.flexInput}
                  outlineStyle={styles.inputOutline}
                />
                <TextInput
                  label="Origin"
                  mode="outlined"
                  value={countryOfOrigin}
                  onChangeText={setCountryOfOrigin}
                  style={styles.flexInput}
                  outlineStyle={styles.inputOutline}
                />
              </View>
              <View style={styles.formRow}>
                <TextInput
                  label="Length cm"
                  mode="outlined"
                  value={lengthCm}
                  onChangeText={setLengthCm}
                  keyboardType="decimal-pad"
                  style={styles.flexInput}
                  outlineStyle={styles.inputOutline}
                />
                <TextInput
                  label="Width cm"
                  mode="outlined"
                  value={widthCm}
                  onChangeText={setWidthCm}
                  keyboardType="decimal-pad"
                  style={styles.flexInput}
                  outlineStyle={styles.inputOutline}
                />
                <TextInput
                  label="Height cm"
                  mode="outlined"
                  value={heightCm}
                  onChangeText={setHeightCm}
                  keyboardType="decimal-pad"
                  style={styles.flexInput}
                  outlineStyle={styles.inputOutline}
                />
              </View>
              <View style={styles.formRow}>
                <TextInput
                  label="Model"
                  mode="outlined"
                  value={modelNumber}
                  onChangeText={setModelNumber}
                  style={styles.flexInput}
                  outlineStyle={styles.inputOutline}
                />
                <TextInput
                  label="Material"
                  mode="outlined"
                  value={material}
                  onChangeText={setMaterial}
                  style={styles.flexInput}
                  outlineStyle={styles.inputOutline}
                />
              </View>
              <TextInput
                label="Color (single-option products)"
                mode="outlined"
                value={color}
                onChangeText={setColor}
                style={styles.input}
                outlineStyle={styles.inputOutline}
                disabled={variantAttributes.some((attribute) => attribute.name.trim().toLocaleLowerCase() === 'color')}
              />
            </Surface>
          </Animated.View>

          {/* Warranty and Delivery Section */}
          <Animated.View entering={FadeInDown.delay(350).duration(400)}>
            <Surface style={[styles.section, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <View style={styles.sectionHeader}>
                <Icon name="truck-delivery" size={20} color={theme.colors.secondary} />
                <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                  Warranty and Delivery
                </Text>
              </View>
              <Text variant="labelMedium" style={[styles.groupLabel, { color: theme.colors.onSurfaceVariant }]}>
                Warranty
              </Text>
              <View style={styles.chipWrap}>
                {(['manufacturer', 'seller', 'none'] as WarrantyType[]).map((type) => (
                  <Chip key={type} selected={warrantyType === type} onPress={() => setWarrantyType(type)}>
                    {type}
                  </Chip>
                ))}
              </View>
              <View style={styles.formRow}>
                <TextInput
                  label="Warranty days"
                  mode="outlined"
                  value={warrantyDays}
                  onChangeText={setWarrantyDays}
                  keyboardType="number-pad"
                  style={styles.flexInput}
                  outlineStyle={styles.inputOutline}
                />
                <TextInput
                  label="Provider"
                  mode="outlined"
                  value={warrantyProvider}
                  onChangeText={setWarrantyProvider}
                  style={styles.flexInput}
                  outlineStyle={styles.inputOutline}
                />
              </View>
              <TextInput
                label="Warranty terms"
                mode="outlined"
                value={warrantyTerms}
                onChangeText={setWarrantyTerms}
                multiline
                style={[styles.input, styles.textArea]}
                outlineStyle={styles.inputOutline}
              />
              <View style={styles.formRow}>
                <TextInput
                  label="City"
                  mode="outlined"
                  value={city}
                  onChangeText={setCity}
                  style={styles.flexInput}
                  outlineStyle={styles.inputOutline}
                />
                <TextInput
                  label="Province"
                  mode="outlined"
                  value={province}
                  onChangeText={setProvince}
                  style={styles.flexInput}
                  outlineStyle={styles.inputOutline}
                />
              </View>
              <TextInput
                label="Delivery option"
                mode="outlined"
                value={deliveryName}
                onChangeText={setDeliveryName}
                style={styles.input}
                outlineStyle={styles.inputOutline}
              />
              <View style={styles.deliveryOptionsRow}>
                <Pressable
                  onPress={() => setDeliveryType('free')}
                  style={[
                    styles.deliveryOption,
                    {
                      backgroundColor:
                        deliveryType === 'free' ? theme.colors.secondaryContainer : theme.colors.surfaceVariant,
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
                      backgroundColor:
                        deliveryType === 'paid' ? theme.colors.primaryContainer : theme.colors.surfaceVariant,
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

              <View style={styles.formRow}>
                <TextInput
                  mode="outlined"
                  label="Delivery Fee (ZMW)"
                  value={deliveryFee}
                  onChangeText={setDeliveryFee}
                  placeholder="e.g., 50"
                  keyboardType="decimal-pad"
                  left={<TextInput.Affix text="K" textStyle={{ color: theme.colors.primary, fontWeight: '600' }} />}
                  style={styles.flexInput}
                  outlineStyle={styles.inputOutline}
                  disabled={deliveryType === 'free'}
                />
                <TextInput
                  mode="outlined"
                  label="ETA"
                  value={deliveryEta}
                  onChangeText={setDeliveryEta}
                  style={styles.flexInput}
                  outlineStyle={styles.inputOutline}
                />
              </View>
              {validationErrors.length > 0 ? (
                <Surface style={[styles.errorCard, { backgroundColor: theme.colors.errorContainer }]} elevation={0}>
                  {validationErrors.slice(0, 5).map((error) => (
                    <Text
                      key={error}
                      variant="bodySmall"
                      style={{ color: theme.colors.onErrorContainer, marginBottom: 4 }}
                    >
                      {error}
                    </Text>
                  ))}
                </Surface>
              ) : null}
            </Surface>
          </Animated.View>

          {/* Action Buttons */}
          <Animated.View entering={FadeInUp.delay(350).duration(400)} style={styles.actionsContainer}>
            <Pressable
              onPress={handleSubmit}
              disabled={loading || validationErrors.length > 0}
              style={({ pressed }) => [
                styles.saveButton,
                { opacity: pressed ? 0.9 : 1 },
                validationErrors.length > 0 && styles.buttonDisabled,
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
              <Text style={[styles.deleteButtonText, { color: theme.colors.error }]}>Delete Listing</Text>
            </Pressable>
          </Animated.View>
        </ScrollView>
      </View>

      <Portal>
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

function TaxonomyGroup<T extends { _id: string; name: string }>({
  title,
  items,
  selectedId,
  onSelect,
  disabled,
}: {
  title: string;
  items: T[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={styles.taxonomyGroup}>
      <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
        {title}
      </Text>
      <View style={styles.chipWrap}>
        {items.length > 0 ? (
          items.map((item) => (
            <Chip
              key={item._id}
              selected={selectedId === item._id}
              disabled={disabled}
              onPress={() => onSelect(item._id)}
            >
              {item.name}
            </Chip>
          ))
        ) : (
          <Chip disabled>{disabled ? 'Select previous level' : 'No options'}</Chip>
        )}
      </View>
    </View>
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
  formRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 12,
  },
  flexInput: {
    flex: 1,
  },
  groupLabel: {
    marginTop: 14,
    marginBottom: 8,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  taxonomyGroup: {
    gap: 8,
    marginBottom: 14,
  },
  counterText: {
    alignSelf: 'flex-end',
    opacity: 0.7,
    marginTop: 4,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 14,
  },
  switchText: {
    flex: 1,
  },
  imageGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  imageTile: {
    width: 92,
    height: 92,
    borderRadius: 14,
    overflow: 'hidden',
    position: 'relative',
  },
  imageTilePreview: {
    width: '100%',
    height: '100%',
  },
  addImageTile: {
    width: 92,
    height: 92,
    borderRadius: 14,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeImageButton: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBadge: {
    position: 'absolute',
    left: 6,
    bottom: 6,
  },
  errorCard: {
    borderRadius: 12,
    padding: 12,
    marginTop: 14,
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
