import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery } from 'convex/react';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Avatar, Button, Chip, Searchbar, Surface, Text, TextInput, useTheme } from 'react-native-paper';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { StackHeader } from '../../components/ui/Header';
import { AccountAccessNotice } from '../../components/auth/AccountAccessNotice';
import { useAccountAccess } from '../../components/auth/useAccountAccess';
import { useAppAuth } from '../../context/AuthProvider';
import { getRoleLabel } from '../../utils/roles';
import type {
  AdminVendorStoreCounts,
  AdminVendorStoreItem,
  Id,
  RootStackParamList,
  VendorStatus,
} from '../../types';

type Props = NativeStackScreenProps<RootStackParamList, 'AdminStores'>;
type StatusFilter = 'all' | VendorStatus;
type ReviewDecision = 'approved' | 'changes_requested' | 'suspended';

const vendorStatusCopy: Record<VendorStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  changes_requested: 'Changes Requested',
  suspended: 'Suspended',
};

const emptyCounts: AdminVendorStoreCounts = {
  all: 0,
  pending: 0,
  approved: 0,
  changes_requested: 0,
  suspended: 0,
};

function getReviewNote(decision: ReviewDecision) {
  switch (decision) {
    case 'approved':
      return 'Approved for public browsing.';
    case 'changes_requested':
      return 'Please update your store details and resubmit.';
    case 'suspended':
      return 'Storefront has been suspended.';
    default:
      return undefined;
  }
}

export default function AdminStoresScreen(props: Props) {
  // Admin data is read only for a ready account, so no admin query runs while the account is loading or unavailable.
  const access = useAccountAccess();
  if (access.status !== 'ready') {
    return <AccountAccessNotice access={access} title="Store Management" />;
  }
  return <AdminStoresContent {...props} />;
}

function AdminStoresContent({ navigation }: Props) {
  const theme = useTheme();
  const { user } = useAppAuth();
  const isAdmin = user?.role === 'admin';

  const vendorStores = useQuery(
    api.vendors.listVendorStoresForAdmin,
    user?._id && isAdmin ? { adminId: user._id } : 'skip'
  );
  const platformSettings = useQuery(
    api.platform.getPlatformSettingsForAdmin,
    user?._id && isAdmin ? {} : 'skip'
  );
  const usersResult = useQuery(
    api.users.getAllUsers,
    user?._id && isAdmin ? { limit: 100 } : 'skip'
  );

  const reviewApplication = useMutation(api.vendors.reviewApplication);
  const updatePlatformSettings = useMutation(api.platform.updatePlatformSettings);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<StatusFilter>('all');
  const [companyDisplayName, setCompanyDisplayName] = useState('Gettitonline');
  const [selectedCompanySellerId, setSelectedCompanySellerId] = useState<Id<'users'> | null>(null);
  const [savingStorefront, setSavingStorefront] = useState(false);
  const [reviewingStoreId, setReviewingStoreId] = useState<Id<'vendorProfiles'> | null>(null);

  useEffect(() => {
    if (!platformSettings) {
      return;
    }

    setCompanyDisplayName(platformSettings.companyDisplayName);
    setSelectedCompanySellerId(platformSettings.companySellerUserId ?? null);
  }, [platformSettings]);

  const sortedUsers = useMemo(() => {
    const users = usersResult?.items ?? [];
    return [...users].sort((left, right) =>
      `${left.firstName} ${left.lastName}`.localeCompare(
        `${right.firstName} ${right.lastName}`
      )
    );
  }, [usersResult]);

  const filteredStores = useMemo(() => {
    const items = vendorStores?.items ?? [];
    const normalizedQuery = searchQuery.trim().toLowerCase();

    return items.filter((store) => {
      if (selectedStatus !== 'all' && store.status !== selectedStatus) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      return [
        store.storeName,
        store.ownerName,
        store.ownerEmail,
        store.contactEmail,
        store.address.city,
        store.address.province,
      ].some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [searchQuery, selectedStatus, vendorStores]);

  const counts = vendorStores?.counts ?? emptyCounts;
  const companySellerSummary = platformSettings?.companySeller
    ? `${platformSettings.companySeller.firstName} ${platformSettings.companySeller.lastName} (${platformSettings.companySeller.email})`
    : 'No company seller configured yet';
  const companySellerUserId = platformSettings?.companySellerUserId ?? null;

  const handleSaveStorefront = async () => {
    if (!user || user.role !== 'admin') {
      return;
    }

    if (!selectedCompanySellerId) {
      Alert.alert('Select a company seller', 'Choose the internal account that should own official listings.');
      return;
    }

    setSavingStorefront(true);

    try {
      await updatePlatformSettings({
        adminId: user._id,
        companySellerUserId: selectedCompanySellerId,
        companyDisplayName: companyDisplayName.trim() || 'Gettitonline',
      });

      Alert.alert('Storefront updated', 'The official storefront settings were saved.');
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to update the company storefront';
      Alert.alert('Error', message);
    } finally {
      setSavingStorefront(false);
    }
  };

  const handleReview = async (
    store: AdminVendorStoreItem,
    decision: ReviewDecision
  ) => {
    if (!user || user.role !== 'admin') {
      return;
    }

    setReviewingStoreId(store.vendorProfileId);

    try {
      await reviewApplication({
        adminId: user._id,
        vendorProfileId: store.vendorProfileId,
        decision,
        reviewNotes: getReviewNote(decision),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to update storefront status';
      Alert.alert('Error', message);
    } finally {
      setReviewingStoreId(null);
    }
  };

  const statusActions = (store: AdminVendorStoreItem) => {
    switch (store.status) {
      case 'pending':
        return (
          <>
            <Button
              mode="contained"
              compact
              disabled={reviewingStoreId === store.vendorProfileId}
              onPress={() => handleReview(store, 'approved')}
            >
              Approve
            </Button>
            <Button
              mode="outlined"
              compact
              disabled={reviewingStoreId === store.vendorProfileId}
              onPress={() => handleReview(store, 'changes_requested')}
            >
              Request Changes
            </Button>
            <Button
              mode="outlined"
              compact
              disabled={reviewingStoreId === store.vendorProfileId}
              onPress={() => handleReview(store, 'suspended')}
            >
              Suspend
            </Button>
          </>
        );
      case 'approved':
        return (
          <>
            <Button
              mode="outlined"
              compact
              disabled={reviewingStoreId === store.vendorProfileId}
              onPress={() => handleReview(store, 'changes_requested')}
            >
              Request Changes
            </Button>
            <Button
              mode="outlined"
              compact
              disabled={reviewingStoreId === store.vendorProfileId}
              onPress={() => handleReview(store, 'suspended')}
            >
              Suspend
            </Button>
          </>
        );
      case 'changes_requested':
        return (
          <>
            <Button
              mode="contained"
              compact
              disabled={reviewingStoreId === store.vendorProfileId}
              onPress={() => handleReview(store, 'approved')}
            >
              Re-approve
            </Button>
            <Button
              mode="outlined"
              compact
              disabled={reviewingStoreId === store.vendorProfileId}
              onPress={() => handleReview(store, 'suspended')}
            >
              Suspend
            </Button>
          </>
        );
      case 'suspended':
        return (
          <Button
            mode="contained"
            compact
            disabled={reviewingStoreId === store.vendorProfileId}
            onPress={() => handleReview(store, 'approved')}
          >
            Re-approve
          </Button>
        );
      default:
        return null;
    }
  };

  if (!user) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Store Management"
          subtitle="Super Admin storefront tools"
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

  if (!isAdmin) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Store Management"
          subtitle="Super Admin storefront tools"
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
            Only Super Admins can manage storefronts and vendor approvals.
          </Text>
        </View>
      </View>
    );
  }

  if (vendorStores === undefined || platformSettings === undefined || usersResult === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Store Management"
          subtitle="Super Admin storefront tools"
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
        title="Store Management"
        subtitle="Official storefront and vendor approvals"
        onBackPress={() => navigation.goBack()}
        variant="gradient"
      />

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <View style={styles.cardHeader}>
            <View style={{ flex: 1 }}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                Official Storefront
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                Configure the company display name and the internal seller account used for official listings.
              </Text>
            </View>
            <Chip compact>{platformSettings.isConfigured ? 'Configured' : 'Needs Setup'}</Chip>
          </View>

          <View style={styles.metaBlock}>
            <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              Current company seller
            </Text>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, marginTop: 4 }}>
              {companySellerSummary}
            </Text>
          </View>

          <TextInput
            label="Store display name"
            mode="outlined"
            value={companyDisplayName}
            onChangeText={setCompanyDisplayName}
            style={styles.input}
          />

          <Text variant="labelMedium" style={[styles.sectionLabel, { color: theme.colors.onSurfaceVariant }]}>
            Company seller account
          </Text>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Select the internal account that should appear as the seller for official company listings.
          </Text>

          {sortedUsers.length === 0 ? (
            <Surface style={[styles.noticeCard, { backgroundColor: theme.colors.surfaceVariant }]} elevation={0}>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                No users are available to assign yet.
              </Text>
            </Surface>
          ) : (
            <View style={styles.userOptions}>
              {sortedUsers.map((listedUser) => {
                const isSelected = listedUser._id === selectedCompanySellerId;

                return (
                  <Pressable
                    key={listedUser._id}
                    onPress={() => setSelectedCompanySellerId(listedUser._id)}
                  >
                    <Surface
                      style={[
                        styles.userOption,
                        {
                          backgroundColor: isSelected
                            ? theme.colors.primaryContainer
                            : theme.colors.surfaceVariant,
                          borderColor: isSelected
                            ? theme.colors.primary
                            : theme.colors.outlineVariant,
                        },
                      ]}
                      elevation={0}
                    >
                      <View style={{ flex: 1 }}>
                        <Text variant="bodyLarge" style={{ color: theme.colors.onSurface }}>
                          {listedUser.firstName} {listedUser.lastName}
                        </Text>
                        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                          {listedUser.email}
                        </Text>
                        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 6 }}>
                          {getRoleLabel(listedUser.role)}
                          {listedUser.isBanned ? ' • banned' : ''}
                        </Text>
                      </View>
                      <Icon
                        name={isSelected ? 'check-circle' : 'circle-outline'}
                        size={22}
                        color={isSelected ? theme.colors.primary : theme.colors.onSurfaceVariant}
                      />
                    </Surface>
                  </Pressable>
                );
              })}
            </View>
          )}

          <View style={styles.officialActions}>
            <Button
              mode="contained"
              onPress={handleSaveStorefront}
              loading={savingStorefront}
              disabled={savingStorefront}
            >
              Save Storefront
            </Button>
            {companySellerUserId ? (
              <Button
                mode="outlined"
                onPress={() =>
                  navigation.navigate('SellerProfile', {
                    sellerId: companySellerUserId,
                  })
                }
              >
                Preview Store
              </Button>
            ) : null}
          </View>
        </Surface>

        <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            Vendor Stores
          </Text>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
            Review vendor applications and manage storefront visibility from mobile.
          </Text>

          <Searchbar
            placeholder="Search stores, owners, or cities..."
            value={searchQuery}
            onChangeText={setSearchQuery}
            style={[styles.searchBar, { backgroundColor: theme.colors.surfaceVariant }]}
          />

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterRow}
          >
            {([
              'all',
              'pending',
              'approved',
              'changes_requested',
              'suspended',
            ] as StatusFilter[]).map((status) => {
              const count = status === 'all' ? counts.all : counts[status];
              const label = status === 'all' ? 'All' : vendorStatusCopy[status];

              return (
                <Chip
                  key={status}
                  selected={selectedStatus === status}
                  mode={selectedStatus === status ? 'flat' : 'outlined'}
                  onPress={() => setSelectedStatus(status)}
                  style={styles.filterChip}
                >
                  {label} ({count})
                </Chip>
              );
            })}
          </ScrollView>

          {filteredStores.length === 0 ? (
            <View style={styles.emptyState}>
              <Icon name="store-search-outline" size={42} color={theme.colors.primary} />
              <Text variant="titleSmall" style={{ color: theme.colors.onSurface, marginTop: 12 }}>
                No storefronts match this filter
              </Text>
              <Text
                variant="bodySmall"
                style={{ color: theme.colors.onSurfaceVariant, marginTop: 6, textAlign: 'center' }}
              >
                Adjust the status filter or search terms to find vendor stores.
              </Text>
            </View>
          ) : (
            filteredStores.map((store) => (
              <Surface
                key={store.vendorProfileId}
                style={[styles.storeCard, { backgroundColor: theme.colors.surfaceVariant }]}
                elevation={0}
              >
                <Pressable
                  onPress={() =>
                    navigation.navigate('SellerProfile', { sellerId: store.ownerUserId })
                  }
                >
                  <View style={styles.storeHeader}>
                    {store.logoUrl ? (
                      <Avatar.Image size={48} source={{ uri: store.logoUrl }} />
                    ) : (
                      <Avatar.Text
                        size={48}
                        label={store.storeName.slice(0, 2).toUpperCase()}
                        style={{ backgroundColor: theme.colors.primaryContainer }}
                        color={theme.colors.primary}
                      />
                    )}

                    <View style={styles.storeInfo}>
                      <View style={styles.storeTitleRow}>
                        <Text variant="titleMedium" style={{ color: theme.colors.onSurface, flex: 1 }}>
                          {store.storeName}
                        </Text>
                        <Chip compact>{vendorStatusCopy[store.status]}</Chip>
                      </View>
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                        {store.ownerName} • {store.ownerEmail}
                      </Text>
                      <Text
                        variant="bodySmall"
                        numberOfLines={2}
                        style={{ color: theme.colors.onSurfaceVariant, marginTop: 6 }}
                      >
                        {store.description}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.metaRow}>
                    <View style={styles.metaItem}>
                      <Icon name="map-marker-outline" size={16} color={theme.colors.onSurfaceVariant} />
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                        {store.address.city}, {store.address.province}
                      </Text>
                    </View>
                    <View style={styles.metaItem}>
                      <Icon name="email-outline" size={16} color={theme.colors.onSurfaceVariant} />
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                        {store.contactEmail}
                      </Text>
                    </View>
                  </View>

                  {store.reviewNotes ? (
                    <Surface
                      style={[styles.noteCard, { backgroundColor: theme.colors.surface }]}
                      elevation={0}
                    >
                      <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                        Latest review note
                      </Text>
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurface, marginTop: 4 }}>
                        {store.reviewNotes}
                      </Text>
                    </Surface>
                  ) : null}

                  <Text variant="labelSmall" style={{ color: theme.colors.primary, marginTop: 12 }}>
                    Tap to preview storefront
                  </Text>
                </Pressable>

                <View style={styles.actionRow}>{statusActions(store)}</View>
              </Surface>
            ))
          )}
        </Surface>
      </ScrollView>
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
  scrollContent: {
    padding: 16,
    paddingBottom: 120,
    gap: 16,
  },
  card: {
    borderRadius: 18,
    padding: 16,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  metaBlock: {
    marginTop: 16,
  },
  input: {
    marginTop: 16,
  },
  sectionLabel: {
    marginTop: 16,
    marginBottom: 6,
  },
  noticeCard: {
    marginTop: 12,
    padding: 14,
    borderRadius: 14,
  },
  userOptions: {
    marginTop: 12,
    gap: 10,
  },
  userOption: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  officialActions: {
    marginTop: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  searchBar: {
    marginTop: 16,
    borderRadius: 16,
  },
  filterRow: {
    marginTop: 16,
    gap: 8,
  },
  filterChip: {
    marginRight: 8,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    paddingHorizontal: 16,
  },
  storeCard: {
    marginTop: 16,
    borderRadius: 16,
    padding: 16,
  },
  storeHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  storeInfo: {
    flex: 1,
  },
  storeTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  metaRow: {
    marginTop: 12,
    gap: 8,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  noteCard: {
    marginTop: 12,
    borderRadius: 12,
    padding: 12,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 16,
  },
});
