import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery } from 'convex/react';
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';
import { Button, Chip, Modal, Portal, Surface, Text, TextInput, useTheme } from 'react-native-paper';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { StackHeader } from '../../components/ui/Header';
import { useAppAuth } from '../../context/AuthProvider';
import { formatPrice } from '../../theme';
import type { CategoryTreeItem, Doc, Id, Order, ProductCondition, RootStackParamList } from '../../types';
import { canManageCatalog, canManageListings } from '../../utils/roles';

type Props = NativeStackScreenProps<RootStackParamList, 'SellerOperations'>;
type ReturnRequest = Doc<'returnRequests'>;
type ReturnActionStatus = Extract<ReturnRequest['status'], 'approved' | 'rejected' | 'received' | 'refunded' | 'closed'>;
type CsvProductDraft = {
  title: string;
  brand: string;
  sku: string;
  shortDescription: string;
  description: string;
  keyFeatures: string[];
  price: number;
  compareAtPrice?: number;
  categoryId: Id<'categories'>;
  subcategoryId: Id<'categories'>;
  classificationId: Id<'categories'>;
  images: string[];
  condition: ProductCondition;
  quantity: number;
  lowStockThreshold: number;
  dimensions?: {
    lengthCm: number;
    widthCm: number;
    heightCm: number;
  };
  weightKg?: number;
  warranty: {
    type: 'manufacturer' | 'seller' | 'none';
    durationDays?: number;
    provider?: string;
    terms?: string;
  };
  countryOfOrigin?: string;
  specifications?: Array<{ key: string; value: string }>;
  shippingOptions: Array<{ name: string; price: number; estimatedDays: string }>;
};

const csvTemplate =
  'sku,title,brand,category,subcategory,classification,price,stock,short_description,description,key_features,condition,compare_at_price,low_stock_threshold,weight_kg,length_cm,width_cm,height_cm,warranty,country_of_origin,specifications,image_urls\nSKU-001,Example Product,Example Brand,Electronics,Phones,Smartphones,999,10,Short summary,Full description,"Feature 1|Feature 2|Feature 3|Feature 4|Feature 5",new,1199,3,1.2,20,10,5,seller:90,Zambia,"Color: Black|Material: Cotton","https://example.com/1.jpg|https://example.com/2.jpg|https://example.com/3.jpg"';

function countByStatus<T extends { status: string }>(items: T[]) {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {});
}

function buildPackingSlip(order: Order) {
  const items = order.items
    .map((item) => {
      const variants = item.selectedVariantOptions?.length
        ? ` (${item.selectedVariantOptions.map((option) => `${option.name}: ${option.value}`).join(', ')})`
        : '';
      const addOns = item.selectedAddOns?.length
        ? ` + ${item.selectedAddOns.map((addOn) => addOn.name).join(', ')}`
        : '';
      return `- ${item.title}${variants}${addOns} x${item.quantity}`;
    })
    .join('\n');

  return [
    `Getitonline Packing Slip`,
    `Order: ${order.orderNumber}`,
    `Status: ${order.status}`,
    `Delivery: ${order.deliveryMethodName ?? 'Seller delivery'}`,
    `Ship to: ${order.shippingAddress.street}, ${order.shippingAddress.city}, ${order.shippingAddress.province}`,
    `Phone: ${order.shippingAddress.phone}`,
    '',
    'Items',
    items,
    '',
    `Seller payout: ${formatPrice(order.sellerPayout)}`,
  ].join('\n');
}

function parseCsvRecords(input: string) {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const nextChar = input[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      record.push(field.trim());
      field = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        index += 1;
      }
      record.push(field.trim());
      if (record.some((value) => value.length > 0)) {
        records.push(record);
      }
      record = [];
      field = '';
      continue;
    }

    field += char;
  }

  record.push(field.trim());
  if (record.some((value) => value.length > 0)) {
    records.push(record);
  }

  return records;
}

function normalizeCsvHeader(header: string) {
  return header.trim().toLowerCase().replace(/\s+/g, '_');
}

function parsePipeList(value: string) {
  return value
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOptionalPositiveNumber(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseRequiredPositiveNumber(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseStock(value: string) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseCondition(value: string): ProductCondition {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'like_new' || normalized === 'good' || normalized === 'fair') {
    return normalized;
  }
  return 'new';
}

function parseWarranty(value: string): CsvProductDraft['warranty'] {
  const [typeInput, durationInput, providerInput, termsInput] = value.split(':').map((part) => part.trim());
  const type =
    typeInput === 'manufacturer' || typeInput === 'seller' || typeInput === 'none'
      ? typeInput
      : 'seller';
  const durationDays = Number.parseInt(durationInput ?? '', 10);
  return {
    type,
    ...(Number.isFinite(durationDays) && durationDays > 0 ? { durationDays } : {}),
    ...(providerInput ? { provider: providerInput } : {}),
    ...(termsInput ? { terms: termsInput } : {}),
  };
}

function parseSpecifications(value: string) {
  return parsePipeList(value)
    .map((item) => {
      const [key, ...rest] = item.split(':');
      const resolvedKey = key.trim();
      const resolvedValue = rest.join(':').trim();
      if (!resolvedKey || !resolvedValue) return null;
      return { key: resolvedKey, value: resolvedValue };
    })
    .filter((item): item is { key: string; value: string } => item !== null);
}

function matchesCategory(category: { _id: string; name: string; slug: string }, value: string) {
  const normalized = value.trim().toLowerCase();
  return (
    category._id === value.trim() ||
    category.name.trim().toLowerCase() === normalized ||
    category.slug.trim().toLowerCase() === normalized
  );
}

function resolveCsvCategory(
  categories: CategoryTreeItem[],
  row: Record<string, string>,
) {
  const category = categories.find((item) => matchesCategory(item, row.category ?? ''));
  const subcategory = category?.subcategories.find((item) => matchesCategory(item, row.subcategory ?? ''));
  const classification = subcategory?.classifications?.find((item) =>
    matchesCategory(item, row.classification ?? ''),
  );

  return { category, subcategory, classification };
}

function buildCsvDrafts(csvText: string, categories: CategoryTreeItem[]) {
  const records = parseCsvRecords(csvText);
  const errors: string[] = [];
  const drafts: CsvProductDraft[] = [];

  if (records.length < 2) {
    return { drafts, errors: ['Paste a header row and at least one product row.'] };
  }

  const headers = records[0].map(normalizeCsvHeader);
  const requiredHeaders = [
    'sku',
    'title',
    'brand',
    'category',
    'subcategory',
    'classification',
    'price',
    'stock',
    'short_description',
    'description',
    'key_features',
    'image_urls',
  ];
  const missingHeaders = requiredHeaders.filter((header) => !headers.includes(header));
  if (missingHeaders.length > 0) {
    return { drafts, errors: [`Missing columns: ${missingHeaders.join(', ')}`] };
  }

  records.slice(1).forEach((record, index) => {
    const rowNumber = index + 2;
    const row = headers.reduce<Record<string, string>>((acc, header, headerIndex) => {
      acc[header] = record[headerIndex]?.trim() ?? '';
      return acc;
    }, {});
    const rowErrors: string[] = [];
    const price = parseRequiredPositiveNumber(row.price);
    const compareAtPrice = parseOptionalPositiveNumber(row.compare_at_price ?? '');
    const quantity = parseStock(row.stock);
    const lowStockThreshold = parseStock(row.low_stock_threshold ?? '3') ?? 3;
    const images = parsePipeList(row.image_urls).slice(0, 8);
    const keyFeatures = parsePipeList(row.key_features).slice(0, 10);
    const { category, subcategory, classification } = resolveCsvCategory(categories, row);
    const weightKg = parseOptionalPositiveNumber(row.weight_kg ?? '');
    const lengthCm = parseOptionalPositiveNumber(row.length_cm ?? '');
    const widthCm = parseOptionalPositiveNumber(row.width_cm ?? '');
    const heightCm = parseOptionalPositiveNumber(row.height_cm ?? '');
    const specifications = parseSpecifications(row.specifications ?? '');

    if (!row.sku) rowErrors.push('SKU');
    if (!row.title) rowErrors.push('title');
    if (!row.brand) rowErrors.push('brand');
    if (!row.short_description) rowErrors.push('short description');
    if (!row.description) rowErrors.push('description');
    if (price === null) rowErrors.push('valid price');
    if (compareAtPrice !== undefined && price !== null && compareAtPrice <= price) {
      rowErrors.push('compare-at price higher than price');
    }
    if (quantity === null) rowErrors.push('valid stock');
    if (images.length < 3 || images.length > 8) rowErrors.push('3-8 image URLs');
    if (keyFeatures.length < 5 || keyFeatures.length > 10) rowErrors.push('5-10 key features');
    if (!category || !subcategory || !classification) rowErrors.push('matching L1/L2/L3 category names or slugs');

    if (rowErrors.length > 0 || price === null || quantity === null || !category || !subcategory || !classification) {
      errors.push(`Row ${rowNumber}: ${rowErrors.join(', ')}`);
      return;
    }

    drafts.push({
      title: row.title,
      brand: row.brand,
      sku: row.sku,
      shortDescription: row.short_description,
      description: row.description,
      keyFeatures,
      price,
      ...(compareAtPrice !== undefined ? { compareAtPrice } : {}),
      categoryId: category._id,
      subcategoryId: subcategory._id,
      classificationId: classification._id,
      images,
      condition: parseCondition(row.condition ?? 'new'),
      quantity,
      lowStockThreshold,
      ...(lengthCm && widthCm && heightCm ? { dimensions: { lengthCm, widthCm, heightCm } } : {}),
      ...(weightKg ? { weightKg } : {}),
      warranty: parseWarranty(row.warranty ?? 'seller:90'),
      ...(row.country_of_origin ? { countryOfOrigin: row.country_of_origin } : {}),
      ...(specifications.length > 0 ? { specifications } : {}),
      shippingOptions: [
        {
          name: row.delivery_name || 'Standard Delivery',
          price: parseOptionalPositiveNumber(row.delivery_fee ?? '') ?? 0,
          estimatedDays: row.delivery_eta || '3-5 days',
        },
      ],
    });
  });

  return { drafts, errors };
}

export default function SellerOperationsScreen({ navigation }: Props) {
  const theme = useTheme();
  const { user } = useAppAuth();
  const [showCsvImport, setShowCsvImport] = useState(false);
  const [csvText, setCsvText] = useState(csvTemplate);
  const [importingCsv, setImportingCsv] = useState(false);
  const vendorProfile = useQuery(
    api.vendors.getMyVendorProfile,
    user?._id ? { ownerUserId: user._id } : 'skip',
  );
  const storefront = useQuery(api.platform.getStorefront);
  const categories = useQuery(api.categories.getCategoriesTree);
  const isCatalogManager = canManageCatalog(user?.role);
  const hasListingAccess = canManageListings(user?.role, vendorProfile?.status ?? null);
  const sellerId = isCatalogManager ? storefront?.companySellerUserId : user?._id;

  const vendorListings = useQuery(
    api.products.getMyListings,
    user?._id && !isCatalogManager && hasListingAccess
      ? { actorUserId: user._id }
      : 'skip',
  );
  const managedListings = useQuery(
    api.products.getManagedCatalogProducts,
    user?._id && isCatalogManager ? { actorUserId: user._id } : 'skip',
  );
  const sellerOrders = useQuery(
    api.orders.getSellerOrders,
    sellerId && !isCatalogManager ? { sellerId } : 'skip',
  );
  const managedOrders = useQuery(
    api.orders.getManagedCatalogOrders,
    user?._id && isCatalogManager ? { actorUserId: user._id } : 'skip',
  );
  const pendingEscrow = useQuery(
    api.escrow.getSellerPendingEscrow,
    sellerId ? { sellerId } : 'skip',
  );
  const reviews = useQuery(
    api.reviews.getSellerReviews,
    sellerId ? { sellerId, limit: 5 } : 'skip',
  );
  const returnRequests = useQuery(
    api.delivery.getReturnRequests,
    user?._id ? { viewerUserId: user._id } : 'skip',
  );
  const createProduct = useMutation(api.products.createProduct);
  const reviewReturnRequest = useMutation(api.delivery.reviewReturnRequest);

  const listings = isCatalogManager ? managedListings : vendorListings;
  const orders = isCatalogManager ? managedOrders : sellerOrders;
  const isLoading =
    vendorProfile === undefined ||
    storefront === undefined ||
    categories === undefined ||
    listings === undefined ||
    orders === undefined ||
    pendingEscrow === undefined ||
    reviews === undefined ||
    returnRequests === undefined;

  const listingCounts = useMemo(() => countByStatus(listings ?? []), [listings]);
  const orderCounts = useMemo(() => countByStatus(orders ?? []), [orders]);
  const revenue = useMemo(
    () =>
      (orders ?? [])
        .filter((order) => ['paid', 'processing', 'shipped', 'delivered', 'completed'].includes(order.status))
        .reduce((sum, order) => sum + order.sellerPayout, 0),
    [orders],
  );
  const fulfillmentOrders = (orders ?? []).filter((order) =>
    ['paid', 'processing', 'shipped'].includes(order.status),
  );
  const activeReturnRequests = (returnRequests ?? []).filter((request) => {
    const isActive = ['requested', 'approved', 'in_transit', 'received'].includes(request.status);
    const belongsToSeller = request.sellerId === sellerId;
    return isActive && (belongsToSeller || isCatalogManager);
  });

  const shareCsvTemplate = async () => {
    await Share.share({
      title: 'Getitonline listing import template',
      message: csvTemplate,
    });
  };

  const handleCsvImport = async () => {
    if (!user || !categories) return;
    const { drafts, errors } = buildCsvDrafts(csvText, categories);

    if (errors.length > 0) {
      Alert.alert('CSV needs fixes', errors.slice(0, 5).join('\n'));
      return;
    }

    if (drafts.length === 0) {
      Alert.alert('No products found', 'Paste at least one valid product row.');
      return;
    }

    setImportingCsv(true);
    try {
      for (const draft of drafts) {
        await createProduct({
          actorUserId: user._id,
          ...draft,
          imageMetadata: draft.images.map((url, index) => ({
            url,
            isPrimary: index === 0,
            hasWhiteBackground: index === 0,
          })),
          availabilityStatus: draft.quantity > 0 ? 'in_stock' : 'out_of_stock',
          status: 'draft',
        });
      }
      setShowCsvImport(false);
      Alert.alert('Import complete', `${drafts.length} draft listing(s) created for review before submission.`);
    } catch (error) {
      Alert.alert('Import failed', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setImportingCsv(false);
    }
  };

  const handleReturnAction = async (
    returnRequestId: Id<'returnRequests'>,
    status: ReturnActionStatus,
  ) => {
    if (!user) return;

    try {
      await reviewReturnRequest({
        actorUserId: user._id,
        returnRequestId,
        status,
        resolution:
          status === 'rejected'
            ? { type: 'rejected', notes: 'Rejected from mobile seller operations.' }
            : status === 'refunded'
              ? { type: 'refund', notes: 'Refund marked from mobile seller operations.' }
              : undefined,
      });
      Alert.alert('Return updated', `Return request marked ${status.replace(/_/g, ' ')}.`);
    } catch (error) {
      Alert.alert(
        'Unable to update return',
        error instanceof Error ? error.message : 'Please try again.',
      );
    }
  };

  if (!user || !hasListingAccess || !sellerId) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Seller Operations" onBackPress={() => navigation.goBack()} variant="gradient" />
        <View style={styles.centered}>
          <Icon name="store-lock-outline" size={52} color={theme.colors.primary} />
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 16 }}>
            Approved seller access required
          </Text>
        </View>
      </View>
    );
  }

  if (isLoading) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Seller Operations" onBackPress={() => navigation.goBack()} variant="gradient" />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader title="Seller Operations" subtitle="Listings, orders, payouts" onBackPress={() => navigation.goBack()} variant="gradient" />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.statsGrid}>
          <MetricCard label="Active listings" value={String(listingCounts.active ?? 0)} icon="storefront-outline" />
          <MetricCard label="Needs review" value={String((listingCounts.pending_review ?? 0) + (listingCounts.changes_requested ?? 0))} icon="clipboard-alert-outline" />
          <MetricCard label="Fulfillment" value={String(fulfillmentOrders.length)} icon="truck-fast-outline" />
          <MetricCard label="Pending payout" value={formatPrice(pendingEscrow.totalPending)} icon="wallet-outline" />
        </View>

        <Surface style={[styles.sectionCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
              <Icon name="chart-line" size={22} color={theme.colors.primary} />
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                Analytics
              </Text>
            </View>
            <Chip compact>{formatPrice(revenue)} pipeline</Chip>
          </View>
          <View style={styles.analyticsGrid}>
            <MiniMetric label="Paid" value={orderCounts.paid ?? 0} />
            <MiniMetric label="Processing" value={orderCounts.processing ?? 0} />
            <MiniMetric label="Shipped" value={orderCounts.shipped ?? 0} />
            <MiniMetric label="Completed" value={orderCounts.completed ?? 0} />
          </View>
        </Surface>

        <Surface style={[styles.sectionCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
              <Icon name="package-variant-closed" size={22} color={theme.colors.secondary} />
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                Fulfillment
              </Text>
            </View>
            <Button compact mode="text" onPress={() => navigation.navigate('Main', { screen: 'Orders' } as never)}>
              Orders
            </Button>
          </View>
          <View style={styles.list}>
            {fulfillmentOrders.slice(0, 5).map((order) => (
              <Pressable key={order._id} onPress={() => navigation.navigate('OrderDetail', { orderId: order._id })}>
                <View style={styles.orderRow}>
                  <View style={{ flex: 1 }}>
                    <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                      {order.orderNumber}
                    </Text>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                      {order.items.length} item(s) • {order.shippingAddress.city}, {order.shippingAddress.province}
                    </Text>
                  </View>
                  <Button compact mode="contained-tonal" icon="file-document-outline" onPress={() => Share.share({ title: order.orderNumber, message: buildPackingSlip(order) })}>
                    Slip
                  </Button>
                </View>
              </Pressable>
            ))}
            {fulfillmentOrders.length === 0 ? (
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                No active fulfillment orders.
              </Text>
            ) : null}
          </View>
        </Surface>

        <Surface style={[styles.sectionCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
              <Icon name="keyboard-return" size={22} color={theme.colors.primary} />
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                Returns
              </Text>
            </View>
            <Chip compact>{activeReturnRequests.length} active</Chip>
          </View>
          <View style={styles.list}>
            {activeReturnRequests.slice(0, 5).map((request) => (
              <Pressable
                key={request._id}
                onPress={() => navigation.navigate('OrderDetail', { orderId: request.orderId })}
                style={styles.returnRow}
              >
                <View style={{ flex: 1, gap: 4 }}>
                  <View style={styles.returnTitleRow}>
                    <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                      {request.reason.replace(/_/g, ' ')}
                    </Text>
                    <Chip compact>{request.status.replace(/_/g, ' ')}</Chip>
                  </View>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    {request.description}
                  </Text>
                </View>
                <View style={styles.returnActions}>
                  {request.status === 'requested' ? (
                    <>
                      <Button
                        compact
                        mode="contained-tonal"
                        onPress={() => handleReturnAction(request._id, 'approved')}
                      >
                        Approve
                      </Button>
                      <Button
                        compact
                        mode="text"
                        textColor={theme.colors.error}
                        onPress={() => handleReturnAction(request._id, 'rejected')}
                      >
                        Reject
                      </Button>
                    </>
                  ) : null}
                  {request.status === 'approved' || request.status === 'in_transit' ? (
                    <Button
                      compact
                      mode="contained-tonal"
                      onPress={() => handleReturnAction(request._id, 'received')}
                    >
                      Received
                    </Button>
                  ) : null}
                  {request.status === 'received' ? (
                    <Button
                      compact
                      mode="contained"
                      onPress={() => handleReturnAction(request._id, 'refunded')}
                    >
                      Refunded
                    </Button>
                  ) : null}
                </View>
              </Pressable>
            ))}
            {activeReturnRequests.length === 0 ? (
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                No active return requests.
              </Text>
            ) : null}
          </View>
        </Surface>

        <Surface style={[styles.sectionCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
              <Icon name="star-outline" size={22} color={theme.colors.tertiary} />
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                Reviews
              </Text>
            </View>
            <Chip compact>{reviews.length} latest</Chip>
          </View>
          <View style={styles.list}>
            {reviews.map((review) => (
              <View key={review._id} style={styles.reviewRow}>
                <View style={styles.starRow}>
                  {[1, 2, 3, 4, 5].map((star) => (
                    <Icon key={star} name={star <= review.rating ? 'star' : 'star-outline'} size={15} color="#F59E0B" />
                  ))}
                </View>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                  {review.comment || review.title || 'No comment'}
                </Text>
              </View>
            ))}
            {reviews.length === 0 ? (
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                No seller reviews yet.
              </Text>
            ) : null}
          </View>
        </Surface>

        <Surface style={[styles.sectionCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <View style={styles.sectionTitleRow}>
            <Icon name="file-upload-outline" size={22} color={theme.colors.primary} />
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
              CSV Listing Import
            </Text>
          </View>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, lineHeight: 19 }}>
            Paste the template with category names or slugs to create draft listings. Review each draft before submitting to moderation.
          </Text>
          <View style={styles.importActions}>
            <Button mode="contained" icon="file-upload-outline" onPress={() => setShowCsvImport(true)}>
              Paste CSV
            </Button>
            <Button mode="contained-tonal" icon="share-variant-outline" onPress={shareCsvTemplate}>
              Share Template
            </Button>
          </View>
        </Surface>
      </ScrollView>
      <Portal>
        <Modal
          visible={showCsvImport}
          onDismiss={() => {
            if (!importingCsv) setShowCsvImport(false);
          }}
          contentContainerStyle={[styles.modalCard, { backgroundColor: theme.colors.surface }]}
        >
          <View style={styles.sectionTitleRow}>
            <Icon name="file-delimited-outline" size={24} color={theme.colors.primary} />
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
              Paste CSV Listings
            </Text>
          </View>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, lineHeight: 19 }}>
            Required columns: SKU, title, brand, L1/L2/L3 category, price, stock, descriptions, 5-10 features, and 3-8 image URLs.
          </Text>
          <TextInput
            mode="outlined"
            value={csvText}
            onChangeText={setCsvText}
            multiline
            numberOfLines={10}
            style={styles.csvInput}
            outlineStyle={styles.inputOutline}
          />
          <View style={styles.modalActions}>
            <Button disabled={importingCsv} onPress={() => setCsvText(csvTemplate)}>
              Reset
            </Button>
            <Button disabled={importingCsv} onPress={() => setShowCsvImport(false)}>
              Cancel
            </Button>
            <Button loading={importingCsv} disabled={importingCsv} mode="contained" onPress={handleCsvImport}>
              Import Drafts
            </Button>
          </View>
        </Modal>
      </Portal>
    </View>
  );
}

function MetricCard({ label, value, icon }: { label: string; value: string; icon: string }) {
  const theme = useTheme();
  return (
    <Surface style={[styles.metricCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
      <Icon name={icon} size={22} color={theme.colors.primary} />
      <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 8 }}>
        {value}
      </Text>
      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
        {label}
      </Text>
    </Surface>
  );
}

function MiniMetric({ label, value }: { label: string; value: number }) {
  const theme = useTheme();
  return (
    <View style={[styles.miniMetric, { backgroundColor: theme.colors.surfaceVariant }]}>
      <Text variant="titleMedium" style={{ color: theme.colors.primary }}>
        {value}
      </Text>
      <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
        {label}
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
  content: {
    padding: 16,
    paddingBottom: 40,
    gap: 16,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  metricCard: {
    flexBasis: '47%',
    borderRadius: 16,
    padding: 16,
    minHeight: 106,
  },
  sectionCard: {
    borderRadius: 18,
    padding: 16,
    gap: 12,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  analyticsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  miniMetric: {
    flexBasis: '48%',
    borderRadius: 12,
    padding: 12,
  },
  list: {
    gap: 10,
  },
  orderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  returnRow: {
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.06)',
  },
  returnTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  returnActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  importActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  modalCard: {
    margin: 20,
    borderRadius: 18,
    padding: 16,
    gap: 12,
    maxHeight: '86%',
  },
  csvInput: {
    minHeight: 220,
  },
  inputOutline: {
    borderRadius: 12,
  },
  modalActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 8,
  },
  reviewRow: {
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.06)',
  },
  starRow: {
    flexDirection: 'row',
    gap: 2,
  },
});
