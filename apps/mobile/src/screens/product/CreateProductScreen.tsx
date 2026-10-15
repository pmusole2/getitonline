import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery } from 'convex/react';
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from 'react-native';
import { Button, Chip, ProgressBar, Surface, Text, TextInput, useTheme } from 'react-native-paper';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { AccountAccessNotice } from '../../components/auth/AccountAccessNotice';
import { useAccountAccess } from '../../components/auth/useAccountAccess';
import { StackHeader } from '../../components/ui/Header';
import { useAppAuth } from '../../context/AuthProvider';
import { useImageUpload } from '../../hooks/useImageUpload';
import { calculateDisplayPrice } from '../../hooks/useOrderTotal';
import { formatPrice } from '../../theme';
import type { CategoryTreeChild, CategoryTreeItem, Id, ProductCondition, RootStackParamList } from '../../types';
import { canManageCatalog, canManageListings } from '../../utils/roles';
import { ProductVariantEditor } from './ProductVariantEditor';
import {
  deriveProductColor,
  materializeVariantMedia,
  reconcileVariantCombinations,
  validateVariantDraft,
  type VariantAttribute,
  type VariantCombinationPatch,
} from './productVariantDomain';

type Props = NativeStackScreenProps<RootStackParamList, 'CreateProduct'>;
type ListingStatus = 'draft' | 'pending_review';
type AvailabilityStatus = 'in_stock' | 'low_stock' | 'out_of_stock' | 'preorder';
type WarrantyType = 'manufacturer' | 'seller' | 'none';

const MAX_IMAGES = 8;
const MIN_IMAGES = 3;
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const MIN_IMAGE_DIMENSION = 1000;
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png'] as const;

const steps = ['Media', 'Taxonomy', 'Details', 'Pricing', 'Specs', 'Delivery', 'Review'] as const;

const conditions: Array<{ value: ProductCondition; label: string; description: string; icon: string }> = [
  { value: 'new', label: 'New', description: 'Brand new and unused', icon: 'star-circle' },
  { value: 'like_new', label: 'Used - Like New', description: 'Opened or barely used', icon: 'star-half-full' },
  { value: 'good', label: 'Used - Good', description: 'Working with normal wear', icon: 'thumb-up-outline' },
  { value: 'fair', label: 'Refurbished/Fair', description: 'Works, with visible wear', icon: 'tools' },
];

const suggestedSpecFields = [
  'Brand',
  'Power',
  'Smart Capability',
  'Warranty',
  'Non-Stick',
  'Model',
  'Generation',
  "What's in the box",
  'Dishwasher Safe',
  'Appliance Type',
  'Basic Colours',
  'Barcode',
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

type SpecificationInput = { key: string; value: string };

function parseAddOns(value: string) {
  const addOns: Array<{ name: string; description?: string; price: number; isRequired: boolean }> = [];

  parseLines(value).forEach((line) => {
    const [name, rawPrice, description] = line.split('|').map((part) => part.trim());
    const price = Number.parseFloat(rawPrice ?? '');
    if (!name || !Number.isFinite(price) || price < 0) return;

    addOns.push({
      name,
      ...(description ? { description } : {}),
      price,
      isRequired: false,
    });
  });

  return addOns;
}

function findL1(categories: CategoryTreeItem[] | undefined, categoryId: string | null) {
  return categories?.find((category) => category._id === categoryId) ?? null;
}

function findL2(category: CategoryTreeItem | null, subcategoryId: string | null) {
  return category?.subcategories.find((subcategory) => subcategory._id === subcategoryId) ?? null;
}

function findL3(subcategory: CategoryTreeChild | null, classificationId: string | null) {
  return subcategory?.classifications?.find((classification) => classification._id === classificationId) ?? null;
}

function textMatchesQuery(value: string | undefined, normalizedQuery: string) {
  return Boolean(value?.toLowerCase().includes(normalizedQuery));
}

function filterL1Categories(categories: CategoryTreeItem[], query: string) {
  if (!query) return categories;

  return categories.filter(
    (category) =>
      textMatchesQuery(category.name, query) ||
      category.subcategories.some(
        (subcategory) =>
          textMatchesQuery(subcategory.name, query) ||
          subcategory.classifications?.some((classification) => textMatchesQuery(classification.name, query)),
      ),
  );
}

function filterL2Categories(subcategories: CategoryTreeChild[], query: string) {
  if (!query) return subcategories;

  return subcategories.filter(
    (subcategory) =>
      textMatchesQuery(subcategory.name, query) ||
      subcategory.classifications?.some((classification) => textMatchesQuery(classification.name, query)),
  );
}

function filterNamedItems<T extends { name: string }>(items: T[], query: string) {
  if (!query) return items;
  return items.filter((item) => textMatchesQuery(item.name, query));
}

export default function CreateProductScreen(props: Props) {
  const access = useAccountAccess();
  if (access.status !== 'ready') {
    return <AccountAccessNotice access={access} title="Create Listing" />;
  }
  return <CreateProductContent {...props} />;
}

function CreateProductContent({ navigation }: Props) {
  const theme = useTheme();
  const { user } = useAppAuth();
  const storefront = useQuery(api.platform.getStorefront);
  const vendorProfile = useQuery(api.vendors.getMyVendorProfile, user?._id && !user.isBanned ? {} : 'skip');
  const categories = useQuery(api.categories.getCategoriesTree);
  const createProduct = useMutation(api.products.createProduct);

  const hasListingAccess = canManageListings(user?.role, vendorProfile?.status ?? null);
  const isCompanyCatalogManager = canManageCatalog(user?.role);

  const upload = useImageUpload();
  const [stepIndex, setStepIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [primaryWhiteBackground, setPrimaryWhiteBackground] = useState(false);

  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [subcategoryId, setSubcategoryId] = useState<string | null>(null);
  const [classificationId, setClassificationId] = useState<string | null>(null);
  const [categorySearch, setCategorySearch] = useState('');

  const [brand, setBrand] = useState('');
  const [sku, setSku] = useState('');
  const [title, setTitle] = useState('');
  const [shortDescription, setShortDescription] = useState('');
  const [description, setDescription] = useState('');
  const [condition, setCondition] = useState<ProductCondition>('new');
  const [price, setPrice] = useState('');
  const [compareAtPrice, setCompareAtPrice] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [lowStockThreshold, setLowStockThreshold] = useState('3');
  const [availabilityStatus, setAvailabilityStatus] = useState<AvailabilityStatus>('in_stock');
  const [isPreorder, setIsPreorder] = useState(false);
  const [keyFeaturesText, setKeyFeaturesText] = useState('');
  const [specifications, setSpecifications] = useState<SpecificationInput[]>([]);
  const [variantAttributes, setVariantAttributes] = useState<VariantAttribute[]>([]);
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
  const [deliveryName, setDeliveryName] = useState('Standard Delivery');
  const [deliveryFee, setDeliveryFee] = useState('');
  const [deliveryEta, setDeliveryEta] = useState('3-5 days');

  const selectedL1 = useMemo(() => findL1(categories, categoryId), [categories, categoryId]);
  const selectedL2 = useMemo(() => findL2(selectedL1, subcategoryId), [selectedL1, subcategoryId]);
  const selectedL3 = useMemo(() => findL3(selectedL2, classificationId), [selectedL2, classificationId]);
  const normalizedCategorySearch = categorySearch.trim().toLowerCase();
  const filteredL1Categories = useMemo(
    () => filterL1Categories(categories ?? [], normalizedCategorySearch),
    [categories, normalizedCategorySearch],
  );
  const filteredL2Categories = useMemo(
    () => filterL2Categories(selectedL1?.subcategories ?? [], normalizedCategorySearch),
    [normalizedCategorySearch, selectedL1?.subcategories],
  );
  const filteredL3Categories = useMemo(
    () => filterNamedItems(selectedL2?.classifications ?? [], normalizedCategorySearch),
    [normalizedCategorySearch, selectedL2?.classifications],
  );
  const keyFeatures = useMemo(() => parseLines(keyFeaturesText, 10), [keyFeaturesText]);
  const validSpecifications = useMemo(
    () =>
      specifications
        .map((spec) => ({ key: spec.key.trim(), value: spec.value.trim() }))
        .filter((spec) => spec.key && spec.value),
    [specifications],
  );
  const hasIncompleteSpecification = useMemo(
    () =>
      specifications.some(
        (spec) => Boolean(spec.key.trim() || spec.value.trim()) && (!spec.key.trim() || !spec.value.trim()),
      ),
    [specifications],
  );
  const productImageUrls = useMemo(() => upload.images.map((image) => image.url), [upload.images]);
  const variantCombinations = useMemo(
    () =>
      reconcileVariantCombinations({
        attributes: variantAttributes,
        existing: [],
        patches: variantPatches,
        baseSku: sku,
        defaultPrice: parseMoney(price),
        defaultStock: parseInteger(quantity),
      }),
    [price, quantity, sku, variantAttributes, variantPatches],
  );
  const variantValidationIssues = useMemo(
    () =>
      validateVariantDraft({
        attributes: variantAttributes,
        combinations: variantCombinations,
        productImages: productImageUrls,
        productSku: sku,
      }),
    [productImageUrls, sku, variantAttributes, variantCombinations],
  );
  const addOns = useMemo(() => parseAddOns(addOnsText), [addOnsText]);

  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    const priceValue = parseMoney(price);
    const compareAtValue = parseOptionalNumber(compareAtPrice);
    const quantityValue = parseInteger(quantity);

    if (upload.images.length < MIN_IMAGES || upload.images.length > MAX_IMAGES) {
      errors.push(`Add ${MIN_IMAGES}-${MAX_IMAGES} product images.`);
    }
    if (!primaryWhiteBackground) errors.push('Confirm the primary image uses a white background.');
    if (!categoryId || !subcategoryId || !classificationId) errors.push('Select L1, L2, and L3 categories.');
    if (!brand.trim()) errors.push('Brand is required.');
    if (!sku.trim()) errors.push('SKU is required.');
    if (!title.trim()) errors.push('Title is required.');
    if (title.trim().length > 150) errors.push('Title must be 150 characters or less.');
    if (!shortDescription.trim()) errors.push('Short description is required.');
    if (shortDescription.trim().length > 300) errors.push('Short description must be 300 characters or less.');
    if (!description.trim()) errors.push('Full description is required.');
    if (keyFeatures.length < 3 || keyFeatures.length > 5) errors.push('Add 3-5 key features.');
    if (hasIncompleteSpecification) errors.push('Complete or remove incomplete specification rows.');
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
  }, [
    brand,
    categoryId,
    classificationId,
    compareAtPrice,
    deliveryEta,
    deliveryName,
    description,
    hasIncompleteSpecification,
    keyFeatures.length,
    price,
    primaryWhiteBackground,
    quantity,
    shortDescription,
    sku,
    subcategoryId,
    title,
    upload.images.length,
    variantAttributes.length,
    variantValidationIssues,
  ]);

  const canSubmit = validationErrors.length === 0 && !upload.isUploading && !submitting;
  const progress = (stepIndex + 1) / steps.length;

  const pickImages = async () => {
    await upload.pickImages(MAX_IMAGES, {
      minWidth: MIN_IMAGE_DIMENSION,
      minHeight: MIN_IMAGE_DIMENSION,
      maxSizeBytes: MAX_IMAGE_SIZE_BYTES,
      allowedMimeTypes: IMAGE_MIME_TYPES,
    });
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

  const addSpecification = (key = '') => {
    setSpecifications((current) => [...current, { key, value: '' }]);
  };

  const addSuggestedSpecification = (key: string) => {
    setSpecifications((current) => {
      const hasField = current.some((spec) => spec.key.trim().toLowerCase() === key.toLowerCase());
      if (hasField) return current;

      const firstEmptyIndex = current.findIndex((spec) => !spec.key.trim() && !spec.value.trim());
      if (firstEmptyIndex >= 0) {
        return current.map((spec, index) => (index === firstEmptyIndex ? { key, value: '' } : spec));
      }

      return [...current, { key, value: '' }];
    });
  };

  const updateSpecification = (index: number, field: keyof SpecificationInput, value: string) => {
    setSpecifications((current) =>
      current.map((spec, specIndex) => (specIndex === index ? { ...spec, [field]: value } : spec)),
    );
  };

  const removeSpecification = (index: number) => {
    setSpecifications((current) => current.filter((_, specIndex) => specIndex !== index));
  };

  const handleSubmit = async (status: ListingStatus) => {
    if (!user || !hasListingAccess) {
      Alert.alert('Listing access required', 'Only approved vendors and catalog staff can create listings.');
      return;
    }

    if (isCompanyCatalogManager && storefront && !storefront.isConfigured) {
      Alert.alert('Company storefront required', 'Configure the company storefront before creating official listings.');
      return;
    }

    if (!canSubmit) {
      Alert.alert('Listing is not ready', validationErrors[0] ?? 'Please complete all required fields.');
      return;
    }

    setSubmitting(true);

    try {
      const sellingPrice = parseMoney(price);
      const compareAt = parseOptionalNumber(compareAtPrice);
      const quantityValue = parseInteger(quantity);
      const lowStockValue = parseInteger(lowStockThreshold);
      const persistedVariantCombinations = materializeVariantMedia({
        combinations: variantCombinations,
        colorMedia,
        combinationMedia,
        productImages: productImageUrls,
      });
      const productDimensions =
        parseOptionalNumber(lengthCm) && parseOptionalNumber(widthCm) && parseOptionalNumber(heightCm)
          ? {
              lengthCm: parseOptionalNumber(lengthCm) ?? 0,
              widthCm: parseOptionalNumber(widthCm) ?? 0,
              heightCm: parseOptionalNumber(heightCm) ?? 0,
            }
          : undefined;

      await createProduct({
        categoryId: categoryId as Id<'categories'>,
        subcategoryId: subcategoryId as Id<'categories'>,
        classificationId: classificationId as Id<'categories'>,
        title: title.trim(),
        brand: brand.trim(),
        sku: sku.trim(),
        shortDescription: shortDescription.trim(),
        description: description.trim(),
        keyFeatures,
        price: sellingPrice,
        compareAtPrice: compareAt,
        images: productImageUrls,
        imageMetadata: upload.images.map((image, index) => ({
          url: image.url,
          width: image.width,
          height: image.height,
          sizeBytes: image.sizeBytes,
          mimeType: image.mimeType,
          isPrimary: index === 0,
          hasWhiteBackground: index === 0 ? primaryWhiteBackground : undefined,
        })),
        condition,
        quantity: quantityValue,
        lowStockThreshold: lowStockValue,
        availabilityStatus: isPreorder ? 'preorder' : availabilityStatus,
        preorder: {
          isPreorder,
        },
        variantAttributes: variantAttributes.length > 0 ? variantAttributes : undefined,
        variantCombinations: persistedVariantCombinations.length > 0 ? persistedVariantCombinations : undefined,
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
        specifications: validSpecifications,
        location: city.trim() || province.trim() ? { city: city.trim(), province: province.trim() } : undefined,
        shippingOptions: [
          {
            name: deliveryName.trim(),
            price: parseMoney(deliveryFee),
            estimatedDays: deliveryEta.trim(),
          },
        ],
        status,
      });

      Alert.alert(
        status === 'pending_review' ? 'Submitted for review' : 'Draft saved',
        status === 'pending_review'
          ? 'Your listing is hidden until a reviewer approves it.'
          : 'Your draft is saved and remains hidden.',
        [{ text: 'OK', onPress: () => navigation.goBack() }],
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to create listing';
      Alert.alert('Error', message);
    } finally {
      setSubmitting(false);
    }
  };

  if (user && (vendorProfile === undefined || storefront === undefined || categories === undefined)) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Create Listing" onBackPress={() => navigation.goBack()} variant="gradient" />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </View>
    );
  }

  if (!user || !hasListingAccess) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Listing Access" onBackPress={() => navigation.goBack()} variant="gradient" />
        <View style={styles.centered}>
          <Icon name="lock-outline" size={48} color={theme.colors.primary} />
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 16 }}>
            Vendor approval required
          </Text>
          <Text
            variant="bodyMedium"
            style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, textAlign: 'center' }}
          >
            Apply from Workspace before adding products.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader
        title="Create Listing"
        subtitle={steps[stepIndex]}
        onBackPress={() => navigation.goBack()}
        variant="gradient"
      />
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.progressWrap}>
          <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
            Step {stepIndex + 1} of {steps.length}: {steps[stepIndex]}
          </Text>
          <ProgressBar progress={progress} color={theme.colors.primary} style={styles.progressBar} />
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
        >
          {stepIndex === 0 && (
            <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <SectionTitle icon="image-multiple-outline" title="Product Images" />
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, lineHeight: 20 }}>
                Upload {MIN_IMAGES}-{MAX_IMAGES} JPG/PNG images. Each image must be at least 1000x1000 and 5 MB or
                smaller.
              </Text>
              {upload.validationErrors.map((message) => (
                <Text key={message} variant="bodySmall" style={{ color: theme.colors.error, marginTop: 8 }}>
                  {message}
                </Text>
              ))}
              {upload.isUploading ? (
                <View style={styles.uploadProgress}>
                  <ProgressBar progress={upload.progress / 100} color={theme.colors.primary} />
                  <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 6 }}>
                    Uploading {Math.round(upload.progress)}%
                  </Text>
                </View>
              ) : null}
              <View style={styles.imageGrid}>
                {upload.images.map((image, index) => (
                  <View key={image.storageId || image.url} style={styles.imageTile}>
                    <Image source={{ uri: image.localUri || image.url }} style={styles.imagePreview} />
                    <Pressable style={styles.removeImageButton} onPress={() => upload.removeImage(index)}>
                      <Icon name="close" size={16} color="#FFFFFF" />
                    </Pressable>
                    {index === 0 && (
                      <Chip compact style={styles.primaryBadge}>
                        Primary
                      </Chip>
                    )}
                  </View>
                ))}
                {upload.images.length < MAX_IMAGES && (
                  <Pressable
                    onPress={() => void pickImages()}
                    disabled={upload.isUploading}
                    style={[styles.addImageTile, { borderColor: theme.colors.primary }]}
                  >
                    <Icon name="plus" size={30} color={theme.colors.primary} />
                    <Text variant="labelMedium" style={{ color: theme.colors.primary, marginTop: 6 }}>
                      Add images
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
                    Required by the listing standards for the first image.
                  </Text>
                </View>
                <Switch value={primaryWhiteBackground} onValueChange={setPrimaryWhiteBackground} />
              </View>
            </Surface>
          )}

          {stepIndex === 1 && (
            <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <SectionTitle icon="shape-outline" title="Retail Taxonomy" />
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 12 }}>
                Every product must be assigned to one L1, L2, and L3 category before submission.
              </Text>
              <TextInput
                label="Search categories"
                mode="outlined"
                value={categorySearch}
                onChangeText={setCategorySearch}
                style={styles.input}
                left={<TextInput.Icon icon="magnify" />}
                right={
                  categorySearch ? <TextInput.Icon icon="close" onPress={() => setCategorySearch('')} /> : undefined
                }
              />
              <TaxonomyGroup
                title="L1 Category"
                items={filteredL1Categories}
                selectedId={categoryId}
                onSelect={resetSubcategory}
              />
              <TaxonomyGroup
                title="L2 Subcategory"
                items={filteredL2Categories}
                selectedId={subcategoryId}
                onSelect={resetClassification}
                disabled={!selectedL1}
              />
              <TaxonomyGroup
                title="L3 Classification"
                items={filteredL3Categories}
                selectedId={classificationId}
                onSelect={setClassificationId}
                disabled={!selectedL2}
              />
              {selectedL2 && (selectedL2.classifications?.length ?? 0) === 0 ? (
                <Text variant="bodySmall" style={{ color: theme.colors.error, marginTop: 10 }}>
                  This L2 category has no active L3 classifications. Ask an admin to complete the taxonomy before
                  listing here.
                </Text>
              ) : null}
            </Surface>
          )}

          {stepIndex === 2 && (
            <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <SectionTitle icon="text-box-outline" title="Product Details" />
              <View style={styles.row}>
                <TextInput
                  label="Brand"
                  mode="outlined"
                  value={brand}
                  onChangeText={setBrand}
                  style={styles.flexInput}
                />
                <TextInput
                  label="SKU"
                  mode="outlined"
                  value={sku}
                  onChangeText={setSku}
                  style={styles.flexInput}
                  autoCapitalize="characters"
                />
              </View>
              <TextInput
                label="Title"
                mode="outlined"
                value={title}
                onChangeText={setTitle}
                maxLength={150}
                style={styles.input}
              />
              <Text variant="labelSmall" style={styles.counterText}>
                {title.length}/150
              </Text>
              <TextInput
                label="Short description"
                mode="outlined"
                value={shortDescription}
                onChangeText={setShortDescription}
                maxLength={300}
                multiline
                style={styles.input}
              />
              <Text variant="labelSmall" style={styles.counterText}>
                {shortDescription.length}/300
              </Text>
              <TextInput
                label="Full description"
                mode="outlined"
                value={description}
                onChangeText={setDescription}
                multiline
                numberOfLines={5}
                style={styles.input}
              />
              <Text variant="labelMedium" style={[styles.groupLabel, { color: theme.colors.onSurfaceVariant }]}>
                Condition
              </Text>
              <View style={styles.optionGrid}>
                {conditions.map((item) => (
                  <Pressable
                    key={item.value}
                    onPress={() => setCondition(item.value)}
                    style={[
                      styles.optionCard,
                      {
                        backgroundColor:
                          condition === item.value ? theme.colors.primaryContainer : theme.colors.surfaceVariant,
                        borderColor: condition === item.value ? theme.colors.primary : 'transparent',
                      },
                    ]}
                  >
                    <Icon
                      name={item.icon}
                      size={22}
                      color={condition === item.value ? theme.colors.primary : theme.colors.onSurfaceVariant}
                    />
                    <Text
                      variant="labelLarge"
                      style={{
                        color: condition === item.value ? theme.colors.primary : theme.colors.onSurface,
                        marginTop: 6,
                      }}
                    >
                      {item.label}
                    </Text>
                    <Text
                      variant="bodySmall"
                      style={{ color: theme.colors.onSurfaceVariant, marginTop: 2, textAlign: 'center' }}
                    >
                      {item.description}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </Surface>
          )}

          {stepIndex === 3 && (
            <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <SectionTitle icon="cash-register" title="Pricing and Inventory" />
              <View style={styles.row}>
                <TextInput
                  label="Price (ZMW)"
                  mode="outlined"
                  value={price}
                  onChangeText={setPrice}
                  keyboardType="decimal-pad"
                  style={styles.flexInput}
                />
                <TextInput
                  label="Compare-at"
                  mode="outlined"
                  value={compareAtPrice}
                  onChangeText={setCompareAtPrice}
                  keyboardType="decimal-pad"
                  style={styles.flexInput}
                />
              </View>
              <Surface style={[styles.infoCard, { backgroundColor: theme.colors.primaryContainer }]} elevation={0}>
                <Icon name="information-outline" size={20} color={theme.colors.primary} />
                <Text variant="bodySmall" style={{ color: theme.colors.onPrimaryContainer, flex: 1 }}>
                  Buyers will see {formatPrice(calculateDisplayPrice(parseMoney(price)))} before delivery, discounts,
                  and checkout fees.
                </Text>
              </Surface>
              <View style={styles.row}>
                <TextInput
                  label={variantAttributes.length > 0 ? 'Default stock per new variant' : 'Stock quantity'}
                  mode="outlined"
                  value={quantity}
                  onChangeText={setQuantity}
                  keyboardType="number-pad"
                  style={styles.flexInput}
                />
                <TextInput
                  label="Low-stock alert"
                  mode="outlined"
                  value={lowStockThreshold}
                  onChangeText={setLowStockThreshold}
                  keyboardType="number-pad"
                  style={styles.flexInput}
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
          )}

          {stepIndex === 4 && (
            <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <SectionTitle icon="format-list-checks" title="Features, Specs, Variants" />
              <TextInput
                label="Key features (one per line, 3-5)"
                mode="outlined"
                value={keyFeaturesText}
                onChangeText={setKeyFeaturesText}
                multiline
                numberOfLines={6}
                style={styles.input}
              />
              <Text variant="labelSmall" style={styles.counterText}>
                {keyFeatures.length}/5 features
              </Text>
              <View style={styles.specBuilderHeader}>
                <View style={{ flex: 1 }}>
                  <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                    Specifications table
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                    Add field names and values shown in Product Details.
                  </Text>
                </View>
                <Button compact mode="outlined" icon="plus" onPress={() => addSpecification()}>
                  Add Field
                </Button>
              </View>
              <View style={styles.suggestedSpecWrap}>
                {suggestedSpecFields.map((field) => (
                  <Chip
                    key={field}
                    compact
                    onPress={() => addSuggestedSpecification(field)}
                    disabled={specifications.some((spec) => spec.key.trim().toLowerCase() === field.toLowerCase())}
                  >
                    {field}
                  </Chip>
                ))}
              </View>
              {specifications.length === 0 ? (
                <Surface
                  style={[styles.emptySpecsCard, { backgroundColor: theme.colors.surfaceVariant }]}
                  elevation={0}
                >
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
                    No custom specification fields added yet.
                  </Text>
                </Surface>
              ) : (
                specifications.map((spec, index) => (
                  <View key={`spec-${index}`} style={styles.specFieldRow}>
                    <TextInput
                      label="Field"
                      mode="outlined"
                      value={spec.key}
                      onChangeText={(value) => updateSpecification(index, 'key', value)}
                      style={styles.specNameInput}
                    />
                    <TextInput
                      label="Value"
                      mode="outlined"
                      value={spec.value}
                      onChangeText={(value) => updateSpecification(index, 'value', value)}
                      style={styles.specValueInput}
                    />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Remove specification field"
                      onPress={() => removeSpecification(index)}
                      style={[styles.removeSpecButton, { backgroundColor: theme.colors.errorContainer }]}
                    >
                      <Icon name="trash-can-outline" size={18} color={theme.colors.error} />
                    </Pressable>
                  </View>
                ))
              )}
              {hasIncompleteSpecification ? (
                <Text variant="bodySmall" style={{ color: theme.colors.error }}>
                  Complete or remove incomplete specification rows.
                </Text>
              ) : null}
              <ProductVariantEditor
                attributes={variantAttributes}
                combinations={variantCombinations}
                combinationPatches={variantPatches}
                colorMedia={colorMedia}
                combinationMedia={combinationMedia}
                productImages={productImageUrls}
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
                label="Add-ons (Name|Price|Description per line)"
                mode="outlined"
                value={addOnsText}
                onChangeText={setAddOnsText}
                multiline
                numberOfLines={3}
                style={styles.input}
              />
              <View style={styles.row}>
                <TextInput
                  label="Weight kg"
                  mode="outlined"
                  value={weightKg}
                  onChangeText={setWeightKg}
                  keyboardType="decimal-pad"
                  style={styles.flexInput}
                />
                <TextInput
                  label="Origin"
                  mode="outlined"
                  value={countryOfOrigin}
                  onChangeText={setCountryOfOrigin}
                  style={styles.flexInput}
                />
              </View>
              <View style={styles.row}>
                <TextInput
                  label="Length cm"
                  mode="outlined"
                  value={lengthCm}
                  onChangeText={setLengthCm}
                  keyboardType="decimal-pad"
                  style={styles.flexInput}
                />
                <TextInput
                  label="Width cm"
                  mode="outlined"
                  value={widthCm}
                  onChangeText={setWidthCm}
                  keyboardType="decimal-pad"
                  style={styles.flexInput}
                />
                <TextInput
                  label="Height cm"
                  mode="outlined"
                  value={heightCm}
                  onChangeText={setHeightCm}
                  keyboardType="decimal-pad"
                  style={styles.flexInput}
                />
              </View>
              <View style={styles.row}>
                <TextInput
                  label="Model"
                  mode="outlined"
                  value={modelNumber}
                  onChangeText={setModelNumber}
                  style={styles.flexInput}
                />
                <TextInput
                  label="Material"
                  mode="outlined"
                  value={material}
                  onChangeText={setMaterial}
                  style={styles.flexInput}
                />
              </View>
              <TextInput
                label="Color (single-option products)"
                mode="outlined"
                value={color}
                onChangeText={setColor}
                style={styles.input}
                disabled={variantAttributes.some((attribute) => attribute.name.trim().toLocaleLowerCase() === 'color')}
              />
            </Surface>
          )}

          {stepIndex === 5 && (
            <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <SectionTitle icon="truck-delivery-outline" title="Warranty and Delivery" />
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
              <View style={styles.row}>
                <TextInput
                  label="Warranty days"
                  mode="outlined"
                  value={warrantyDays}
                  onChangeText={setWarrantyDays}
                  keyboardType="number-pad"
                  style={styles.flexInput}
                />
                <TextInput
                  label="Provider"
                  mode="outlined"
                  value={warrantyProvider}
                  onChangeText={setWarrantyProvider}
                  style={styles.flexInput}
                />
              </View>
              <TextInput
                label="Warranty terms"
                mode="outlined"
                value={warrantyTerms}
                onChangeText={setWarrantyTerms}
                multiline
                style={styles.input}
              />
              <View style={styles.row}>
                <TextInput label="City" mode="outlined" value={city} onChangeText={setCity} style={styles.flexInput} />
                <TextInput
                  label="Province"
                  mode="outlined"
                  value={province}
                  onChangeText={setProvince}
                  style={styles.flexInput}
                />
              </View>
              <TextInput
                label="Delivery option"
                mode="outlined"
                value={deliveryName}
                onChangeText={setDeliveryName}
                style={styles.input}
              />
              <View style={styles.row}>
                <TextInput
                  label="Delivery fee"
                  mode="outlined"
                  value={deliveryFee}
                  onChangeText={setDeliveryFee}
                  keyboardType="decimal-pad"
                  style={styles.flexInput}
                />
                <TextInput
                  label="ETA"
                  mode="outlined"
                  value={deliveryEta}
                  onChangeText={setDeliveryEta}
                  style={styles.flexInput}
                />
              </View>
            </Surface>
          )}

          {stepIndex === 6 && (
            <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <SectionTitle icon="clipboard-check-outline" title="Review Listing" />
              <ReviewRow
                label="Taxonomy"
                value={[selectedL1?.name, selectedL2?.name, selectedL3?.name].filter(Boolean).join(' / ') || 'Missing'}
              />
              <ReviewRow label="Brand / SKU" value={`${brand || 'Missing'} / ${sku || 'Missing'}`} />
              <ReviewRow
                label="Price"
                value={`${formatPrice(parseMoney(price))}${parseOptionalNumber(compareAtPrice) ? ` compare at ${formatPrice(parseMoney(compareAtPrice))}` : ''}`}
              />
              <ReviewRow label="Stock" value={`${quantity || '0'} units • ${availabilityStatus}`} />
              <ReviewRow
                label="Variants"
                value={
                  variantCombinations.length > 0
                    ? `${variantCombinations.length} combinations • ${variantCombinations.reduce((total, combination) => total + combination.stock, 0)} total units`
                    : 'No structured variants'
                }
              />
              <ReviewRow
                label="Images"
                value={`${upload.images.length} images • primary white background ${primaryWhiteBackground ? 'confirmed' : 'missing'}`}
              />
              <ReviewRow
                label="Specifications"
                value={`${validSpecifications.length} custom field${validSpecifications.length === 1 ? '' : 's'}`}
              />
              <ReviewRow
                label="Delivery"
                value={`${deliveryName || 'Missing'} • ${deliveryEta || 'Missing'} • ${formatPrice(parseMoney(deliveryFee))}`}
              />
              {validationErrors.length > 0 ? (
                <Surface style={[styles.errorCard, { backgroundColor: theme.colors.errorContainer }]} elevation={0}>
                  {validationErrors.map((error) => (
                    <Text
                      key={error}
                      variant="bodySmall"
                      style={{ color: theme.colors.onErrorContainer, marginBottom: 4 }}
                    >
                      {error}
                    </Text>
                  ))}
                </Surface>
              ) : (
                <Surface style={[styles.infoCard, { backgroundColor: theme.colors.secondaryContainer }]} elevation={0}>
                  <Icon name="check-circle-outline" size={20} color={theme.colors.secondary} />
                  <Text variant="bodySmall" style={{ color: theme.colors.onSecondaryContainer, flex: 1 }}>
                    This listing meets the mobile PRD submission rules and can be submitted for moderation.
                  </Text>
                </Surface>
              )}
            </Surface>
          )}
        </ScrollView>

        <Surface style={[styles.footer, { backgroundColor: theme.colors.surface }]} elevation={2}>
          <Button
            mode="outlined"
            disabled={stepIndex === 0 || submitting}
            onPress={() => setStepIndex((current) => Math.max(0, current - 1))}
            style={styles.footerButton}
          >
            Back
          </Button>
          {stepIndex < steps.length - 1 ? (
            <Button
              mode="contained"
              onPress={() => setStepIndex((current) => Math.min(steps.length - 1, current + 1))}
              style={styles.footerButton}
            >
              Next
            </Button>
          ) : (
            <>
              <Button
                mode="outlined"
                disabled={!canSubmit}
                loading={submitting}
                onPress={() => void handleSubmit('draft')}
                style={styles.footerButton}
              >
                Draft
              </Button>
              <Button
                mode="contained"
                disabled={!canSubmit}
                loading={submitting}
                onPress={() => void handleSubmit('pending_review')}
                style={styles.footerButton}
              >
                Submit
              </Button>
            </>
          )}
        </Surface>
      </KeyboardAvoidingView>
    </View>
  );
}

function SectionTitle({ icon, title }: { icon: string; title: string }) {
  const theme = useTheme();
  return (
    <View style={styles.sectionTitleRow}>
      <View style={[styles.sectionIcon, { backgroundColor: theme.colors.primaryContainer }]}>
        <Icon name={icon} size={20} color={theme.colors.primary} />
      </View>
      <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
        {title}
      </Text>
    </View>
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

function ReviewRow({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={styles.reviewRow}>
      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
        {label}
      </Text>
      <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, flex: 1, textAlign: 'right' }}>
        {value}
      </Text>
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
  progressWrap: {
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 8,
  },
  progressBar: {
    height: 6,
    borderRadius: 999,
  },
  content: {
    padding: 16,
    paddingBottom: 120,
  },
  card: {
    borderRadius: 18,
    padding: 16,
    gap: 14,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  sectionIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  uploadProgress: {
    gap: 6,
  },
  imageGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  imageTile: {
    width: '30%',
    aspectRatio: 1,
    borderRadius: 14,
    overflow: 'hidden',
  },
  imagePreview: {
    width: '100%',
    height: '100%',
  },
  removeImageButton: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  primaryBadge: {
    position: 'absolute',
    left: 6,
    bottom: 6,
  },
  addImageTile: {
    width: '30%',
    aspectRatio: 1,
    borderRadius: 14,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  switchText: {
    flex: 1,
  },
  taxonomyGroup: {
    gap: 8,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  input: {
    width: '100%',
  },
  flexInput: {
    flex: 1,
  },
  counterText: {
    alignSelf: 'flex-end',
  },
  groupLabel: {
    marginTop: 4,
  },
  optionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  optionCard: {
    flexBasis: '47%',
    borderRadius: 14,
    borderWidth: 1,
    padding: 12,
    minHeight: 112,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoCard: {
    borderRadius: 14,
    padding: 12,
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  errorCard: {
    borderRadius: 14,
    padding: 12,
  },
  specBuilderHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  suggestedSpecWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  emptySpecsCard: {
    borderRadius: 14,
    padding: 14,
  },
  specFieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  specNameInput: {
    flex: 1,
  },
  specValueInput: {
    flex: 1.15,
  },
  removeSpecButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reviewRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 6,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 28 : 14,
  },
  footerButton: {
    flex: 1,
  },
});
