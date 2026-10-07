import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery } from 'convex/react';
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import {
  Button,
  Chip,
  Modal,
  Portal,
  Searchbar,
  Surface,
  Text,
  TextInput,
  useTheme,
} from 'react-native-paper';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { StackHeader } from '../../components/ui/Header';
import { useAppAuth } from '../../context/AuthProvider';
import { requestAIConsent } from '../../services/aiConsent';
import {
  apiService,
  type ModerateListingResponse,
} from '../../services/api';
import { formatPrice } from '../../theme';
import type { CategoryTreeChild, CategoryTreeItem, Id, RootStackParamList } from '../../types';
import { isReviewerRole } from '../../utils/roles';

type Props = NativeStackScreenProps<RootStackParamList, 'ListingReview'>;
type ReviewQueueStatus = 'pending_review' | 'changes_requested';
type ReviewDecision = 'approved' | 'changes_requested' | 'rejected' | 'suspended';

const reviewStatusCopy: Record<ReviewQueueStatus, string> = {
  pending_review: 'Pending Review',
  changes_requested: 'Changes Requested',
};

function getReviewNote(decision: ReviewDecision) {
  switch (decision) {
    case 'approved':
      return 'Listing approved for public visibility.';
    case 'changes_requested':
      return 'Please improve listing accuracy or image quality and resubmit.';
    case 'rejected':
      return 'Listing rejected because it does not meet Getitonline publishing standards.';
    case 'suspended':
      return 'Listing suspended pending staff review.';
    default:
      return undefined;
  }
}

function getAiStatusTone(status: string | undefined) {
  switch (status) {
    case 'flagged':
      return '#DC2626';
    case 'approved':
      return '#059669';
    case 'pending':
      return '#2563EB';
    case 'error':
      return '#B45309';
    default:
      return '#6B7280';
  }
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

export default function ListingReviewScreen({ navigation }: Props) {
  const theme = useTheme();
  const { user } = useAppAuth();
  const hasReviewAccess = isReviewerRole(user?.role);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<ReviewQueueStatus>('pending_review');
  const [actingProductId, setActingProductId] = useState<string | null>(null);
  const [runningAiFor, setRunningAiFor] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [correctionListingId, setCorrectionListingId] = useState<string | null>(null);
  const [correctionNotes, setCorrectionNotes] = useState('');
  const [correctionSku, setCorrectionSku] = useState('');
  const [correctionCategoryId, setCorrectionCategoryId] = useState<string | null>(null);
  const [correctionSubcategoryId, setCorrectionSubcategoryId] = useState<string | null>(null);
  const [correctionClassificationId, setCorrectionClassificationId] = useState<string | null>(null);

  const listings = useQuery(
    api.products.getPendingReviewListings,
    user?._id && hasReviewAccess
      ? { reviewerId: user._id, status: selectedStatus }
      : 'skip'
  );
  const categories = useQuery(api.categories.getCategoriesTree);
  const reviewListing = useMutation(api.products.reviewListing);
  const bulkReviewListings = useMutation(api.products.bulkReviewListings);

  type ReviewItem = NonNullable<typeof listings>[number];

  const filteredListings = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const items = listings ?? [];

    if (!normalizedQuery) {
      return items;
    }

    return items.filter((listing) =>
      [
        listing.title,
        listing.description,
        listing.seller?.displayName ?? '',
        listing.category?.name ?? '',
      ].some((value) => value.toLowerCase().includes(normalizedQuery))
    );
  }, [listings, searchQuery]);
  const correctionListing = (listings ?? []).find((listing) => listing._id === correctionListingId) ?? null;
  const selectedL1 = findL1(categories, correctionCategoryId);
  const selectedL2 = findL2(selectedL1, correctionSubcategoryId);
  const selectedL3 = findL3(selectedL2, correctionClassificationId);

  const handleReview = async (
    listing: ReviewItem,
    decision: ReviewDecision,
    overrides?: {
      reviewNotes?: string;
      correctedCategoryId?: string | null;
      correctedSubcategoryId?: string | null;
      correctedClassificationId?: string | null;
      skuOverride?: string;
    },
  ) => {
    if (!user || !hasReviewAccess) {
      return;
    }

    setActingProductId(listing._id);

    try {
      await reviewListing({
        productId: listing._id,
        reviewerId: user._id,
        decision,
        reviewNotes: overrides?.reviewNotes?.trim() || getReviewNote(decision),
        correctedCategoryId: overrides?.correctedCategoryId
          ? overrides.correctedCategoryId as Id<'categories'>
          : undefined,
        correctedSubcategoryId: overrides?.correctedSubcategoryId
          ? overrides.correctedSubcategoryId as Id<'categories'>
          : undefined,
        correctedClassificationId: overrides?.correctedClassificationId
          ? overrides.correctedClassificationId as Id<'categories'>
          : undefined,
        skuOverride: overrides?.skuOverride?.trim() || undefined,
      });
      setSelectedIds((current) => current.filter((id) => id !== listing._id));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to update review status';
      Alert.alert('Error', message);
    } finally {
      setActingProductId(null);
    }
  };

  const openCorrectionModal = (listing: ReviewItem) => {
    setCorrectionListingId(listing._id);
    setCorrectionNotes(listing.reviewNotes ?? getReviewNote('changes_requested') ?? '');
    setCorrectionSku(listing.sku ?? '');
    setCorrectionCategoryId(listing.categoryId ?? null);
    setCorrectionSubcategoryId(listing.subcategoryId ?? null);
    setCorrectionClassificationId(listing.classificationId ?? null);
  };

  const resetCorrectionSubcategory = (nextCategoryId: string) => {
    setCorrectionCategoryId(nextCategoryId);
    setCorrectionSubcategoryId(null);
    setCorrectionClassificationId(null);
  };

  const resetCorrectionClassification = (nextSubcategoryId: string) => {
    setCorrectionSubcategoryId(nextSubcategoryId);
    setCorrectionClassificationId(null);
  };

  const handleCorrectionDecision = async (decision: ReviewDecision) => {
    if (!correctionListing) return;
    await handleReview(correctionListing, decision, {
      reviewNotes: correctionNotes,
      correctedCategoryId: correctionCategoryId,
      correctedSubcategoryId: correctionSubcategoryId,
      correctedClassificationId: correctionClassificationId,
      skuOverride: correctionSku,
    });
    setCorrectionListingId(null);
  };

  const toggleSelected = (listingId: string) => {
    setSelectedIds((current) =>
      current.includes(listingId)
        ? current.filter((id) => id !== listingId)
        : [...current, listingId],
    );
  };

  const handleBulkApprove = async () => {
    if (!user || selectedIds.length === 0) return;

    setActingProductId('bulk');
    try {
      await bulkReviewListings({
        reviewerId: user._id,
        productIds: selectedIds.map((id) => id as Id<'products'>),
        decision: 'approved',
        reviewNotes: 'Bulk approved from mobile listing review.',
      });
      setSelectedIds([]);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to bulk approve listings';
      Alert.alert('Error', message);
    } finally {
      setActingProductId(null);
    }
  };

  const handleAiModeration = async (listing: ReviewItem) => {
    if (!user || !hasReviewAccess) {
      return;
    }

    setRunningAiFor(listing._id);

    try {
      const hasConsent = await requestAIConsent();
      if (!hasConsent) {
        Alert.alert('AI features off', 'Allow AI features before running AI listing moderation.');
        return;
      }

      const result: ModerateListingResponse = await apiService.moderateListing({
        reviewerId: user._id,
        productId: listing._id,
        title: listing.title,
        description: listing.description,
        price: listing.price,
        quantity: listing.quantity,
        imageUrls: listing.images,
        categoryName: listing.category?.name,
      });

      Alert.alert(
        'AI moderation complete',
        result.summary ?? 'The AI moderation result has been stored for this listing.'
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to run AI moderation';
      Alert.alert('Error', message);
    } finally {
      setRunningAiFor(null);
    }
  };

  if (!user) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Listing Review"
          subtitle="Reviewer-Approver review queue"
          onBackPress={() => navigation.goBack()}
          variant="gradient"
        />
        <View style={styles.centered}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            Sign in required
          </Text>
        </View>
      </View>
    );
  }

  if (!hasReviewAccess) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Listing Review"
          subtitle="Reviewer-Approver review queue"
          onBackPress={() => navigation.goBack()}
          variant="gradient"
        />
        <View style={styles.centered}>
          <Icon name="shield-lock-outline" size={48} color={theme.colors.primary} />
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 16 }}>
            Access Restricted
          </Text>
          <Text
            variant="bodyMedium"
            style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, textAlign: 'center' }}
          >
            Only Super Admins and Reviewer-Approvers can review listings.
          </Text>
        </View>
      </View>
    );
  }

  if (listings === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Listing Review"
          subtitle="Reviewer-Approver review queue"
          onBackPress={() => navigation.goBack()}
          variant="gradient"
        />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader
        title="Approve Listings"
        subtitle="Publish pending products"
        onBackPress={() => navigation.goBack()}
        variant="gradient"
      />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <Surface style={[styles.summaryCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            Approve products for the store
          </Text>
          <Text
            variant="bodySmall"
            style={{ color: theme.colors.onSurfaceVariant, marginTop: 6, lineHeight: 20 }}
          >
            Tap Approve to make a pending listing active and visible in the store. You can also correct taxonomy,
            request changes, reject, suspend, or run AI moderation.
          </Text>
        </Surface>

        <Searchbar
          placeholder="Search title, store, or category"
          value={searchQuery}
          onChangeText={setSearchQuery}
          style={[styles.searchbar, { backgroundColor: theme.colors.surface }]}
        />

        <View style={styles.filterRow}>
          <Chip
            selected={selectedStatus === 'pending_review'}
            onPress={() => setSelectedStatus('pending_review')}
          >
            Pending Review
          </Chip>
          <Chip
            selected={selectedStatus === 'changes_requested'}
            onPress={() => setSelectedStatus('changes_requested')}
          >
            Changes Requested
          </Chip>
        </View>

        <View style={styles.resultsHeader}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            {reviewStatusCopy[selectedStatus]}
          </Text>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {filteredListings.length} items
          </Text>
        </View>

        {selectedIds.length > 0 ? (
          <Surface style={[styles.bulkBar, { backgroundColor: theme.colors.primaryContainer }]} elevation={0}>
            <Text variant="bodyMedium" style={{ color: theme.colors.onPrimaryContainer, flex: 1 }}>
              {selectedIds.length} selected
            </Text>
            <Button mode="text" onPress={() => setSelectedIds([])}>
              Clear
            </Button>
            <Button mode="contained" onPress={() => void handleBulkApprove()} loading={actingProductId === 'bulk'}>
              Bulk Approve
            </Button>
          </Surface>
        ) : null}

        {filteredListings.length === 0 ? (
          <Surface style={[styles.emptyCard, { backgroundColor: theme.colors.surface }]} elevation={0}>
            <Icon name="clipboard-check-outline" size={42} color={theme.colors.primary} />
            <Text variant="titleSmall" style={{ color: theme.colors.onSurface, marginTop: 12 }}>
              Nothing in this queue
            </Text>
            <Text
              variant="bodySmall"
              style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, textAlign: 'center' }}
            >
              There are no listings matching this status and search filter.
            </Text>
          </Surface>
        ) : (
          <View style={styles.list}>
            {filteredListings.map((listing) => {
              const aiStatusColor = getAiStatusTone(listing.aiModerationStatus);
              const isActing = actingProductId === listing._id;
              const isRunningAi = runningAiFor === listing._id;

              return (
                <Surface
                  key={listing._id}
                  style={[styles.listingCard, { backgroundColor: theme.colors.surface }]}
                  elevation={0}
                >
                  <View style={styles.listingHeader}>
                    <Pressable
                      onPress={() => toggleSelected(listing._id)}
                      style={styles.selectButton}
                      hitSlop={8}
                    >
                      <Icon
                        name={selectedIds.includes(listing._id) ? 'checkbox-marked-circle' : 'checkbox-blank-circle-outline'}
                        size={24}
                        color={selectedIds.includes(listing._id) ? theme.colors.primary : theme.colors.onSurfaceVariant}
                      />
                    </Pressable>
                    {listing.images[0] ? (
                      <Image source={{ uri: listing.images[0] }} style={styles.thumbnail} />
                    ) : (
                      <View
                        style={[
                          styles.thumbnailFallback,
                          { backgroundColor: theme.colors.surfaceVariant },
                        ]}
                      >
                        <Icon
                          name="image-outline"
                          size={24}
                          color={theme.colors.onSurfaceVariant}
                        />
                      </View>
                    )}

                    <View style={styles.listingInfo}>
                      <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                        {listing.title}
                      </Text>
                      <Text
                        variant="bodySmall"
                        style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}
                      >
                        {listing.seller?.displayName ?? 'Unknown store'}
                      </Text>
                      <Text
                        variant="bodySmall"
                        style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}
                      >
                        {listing.category?.name ?? 'Uncategorized'} • {listing.subcategory?.name ?? 'No L2'} • Qty {listing.quantity}
                      </Text>
                      {listing.sku || listing.brand ? (
                        <Text
                          variant="bodySmall"
                          style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}
                        >
                          {[listing.brand, listing.sku].filter(Boolean).join(' • ')}
                        </Text>
                      ) : null}
                      <Text variant="titleMedium" style={{ color: theme.colors.primary, marginTop: 8 }}>
                        {formatPrice(listing.price)}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.chipRow}>
                    <Chip compact>{reviewStatusCopy[selectedStatus]}</Chip>
                    <Chip
                      compact
                      style={{ backgroundColor: `${aiStatusColor}20` }}
                      textStyle={{ color: aiStatusColor }}
                    >
                      {listing.aiModerationStatus
                        ? `AI ${listing.aiModerationStatus}`
                        : 'AI not run'}
                    </Chip>
                  </View>

                  {listing.reviewNotes ? (
                    <Text
                      variant="bodySmall"
                      style={{ color: theme.colors.onSurfaceVariant, marginTop: 10 }}
                    >
                      Review notes: {listing.reviewNotes}
                    </Text>
                  ) : null}

                  {listing.aiModerationSummary ? (
                    <Text
                      variant="bodySmall"
                      style={{ color: theme.colors.onSurfaceVariant, marginTop: 8 }}
                    >
                      AI summary: {listing.aiModerationSummary}
                    </Text>
                  ) : null}

                  <View style={styles.primaryActionsRow}>
                    <Button
                      mode="outlined"
                      onPress={() =>
                        navigation.navigate('ProductDetail', { productId: listing._id })
                      }
                      style={styles.actionButton}
                    >
                      Preview
                    </Button>
                    <Button
                      mode="contained-tonal"
                      onPress={() => openCorrectionModal(listing)}
                      disabled={isRunningAi || isActing}
                      style={styles.actionButton}
                    >
                      Correct
                    </Button>
                    <Button
                      mode="contained-tonal"
                      onPress={() => void handleAiModeration(listing)}
                      loading={isRunningAi}
                      disabled={isRunningAi || isActing}
                      style={styles.actionButton}
                    >
                      Run AI Check
                    </Button>
                  </View>

                  <View style={styles.secondaryActionsRow}>
                    <Button
                      mode="contained"
                      onPress={() => void handleReview(listing, 'approved')}
                      loading={isActing}
                      disabled={isRunningAi || isActing}
                      style={styles.secondaryActionButton}
                    >
                      Approve
                    </Button>
                    {selectedStatus === 'pending_review' ? (
                      <Button
                        mode="outlined"
                        onPress={() => void handleReview(listing, 'changes_requested')}
                        disabled={isRunningAi || isActing}
                        style={styles.secondaryActionButton}
                      >
                        Request Changes
                      </Button>
                    ) : null}
                    <Button
                      mode="outlined"
                      onPress={() => void handleReview(listing, 'rejected')}
                      disabled={isRunningAi || isActing}
                      style={styles.secondaryActionButton}
                      textColor={theme.colors.error}
                    >
                      Reject
                    </Button>
                    <Button
                      mode="outlined"
                      onPress={() => void handleReview(listing, 'suspended')}
                      disabled={isRunningAi || isActing}
                      style={styles.secondaryActionButton}
                    >
                      Suspend
                    </Button>
                  </View>
                </Surface>
              );
            })}
          </View>
        )}
      </ScrollView>
      <Portal>
        <Modal
          visible={Boolean(correctionListing)}
          onDismiss={() => setCorrectionListingId(null)}
          contentContainerStyle={[styles.modal, { backgroundColor: theme.colors.surface }]}
        >
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.modalContent}>
            <Text variant="titleLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
              Review Corrections
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Correct taxonomy or SKU before approving, or leave explicit notes for seller changes.
            </Text>
            <TextInput
              label="SKU override"
              mode="outlined"
              value={correctionSku}
              onChangeText={setCorrectionSku}
              autoCapitalize="characters"
            />
            <TextInput
              label="Review notes"
              mode="outlined"
              value={correctionNotes}
              onChangeText={setCorrectionNotes}
              multiline
              numberOfLines={4}
            />
            <CorrectionTaxonomyGroup title="L1 Category" items={categories ?? []} selectedId={correctionCategoryId} onSelect={resetCorrectionSubcategory} />
            <CorrectionTaxonomyGroup title="L2 Subcategory" items={selectedL1?.subcategories ?? []} selectedId={correctionSubcategoryId} onSelect={resetCorrectionClassification} disabled={!selectedL1} />
            <CorrectionTaxonomyGroup title="L3 Classification" items={selectedL2?.classifications ?? []} selectedId={correctionClassificationId} onSelect={setCorrectionClassificationId} disabled={!selectedL2} />
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Selected: {[selectedL1?.name, selectedL2?.name, selectedL3?.name].filter(Boolean).join(' / ') || 'No taxonomy selected'}
            </Text>
            <View style={styles.modalActions}>
              <Button mode="text" onPress={() => setCorrectionListingId(null)}>
                Cancel
              </Button>
              <Button mode="outlined" onPress={() => void handleCorrectionDecision('changes_requested')}>
                Request Changes
              </Button>
              <Button mode="outlined" textColor={theme.colors.error} onPress={() => void handleCorrectionDecision('rejected')}>
                Reject
              </Button>
              <Button mode="contained" onPress={() => void handleCorrectionDecision('approved')}>
                Approve
              </Button>
            </View>
          </ScrollView>
        </Modal>
      </Portal>
    </View>
  );
}

function CorrectionTaxonomyGroup<T extends { _id: string; name: string }>({
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
            <Chip key={item._id} selected={selectedId === item._id} disabled={disabled} onPress={() => onSelect(item._id)}>
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
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  content: {
    padding: 16,
    paddingBottom: 32,
  },
  summaryCard: {
    borderRadius: 18,
    padding: 18,
  },
  searchbar: {
    marginTop: 16,
    borderRadius: 16,
  },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 16,
  },
  resultsHeader: {
    marginTop: 20,
    marginBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  bulkBar: {
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  emptyCard: {
    borderRadius: 18,
    padding: 24,
    alignItems: 'center',
  },
  list: {
    gap: 12,
  },
  listingCard: {
    borderRadius: 18,
    padding: 16,
  },
  listingHeader: {
    flexDirection: 'row',
    gap: 12,
  },
  selectButton: {
    justifyContent: 'center',
    alignSelf: 'stretch',
  },
  thumbnail: {
    width: 88,
    height: 88,
    borderRadius: 14,
  },
  thumbnailFallback: {
    width: 88,
    height: 88,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listingInfo: {
    flex: 1,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
  },
  primaryActionsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
  },
  secondaryActionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 12,
  },
  actionButton: {
    flex: 1,
  },
  secondaryActionButton: {
    flexGrow: 1,
  },
  modal: {
    margin: 18,
    borderRadius: 18,
    maxHeight: '88%',
  },
  modalContent: {
    padding: 18,
    gap: 12,
  },
  modalActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 10,
  },
  taxonomyGroup: {
    gap: 8,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
});
