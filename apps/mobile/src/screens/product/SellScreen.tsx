import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useMutation, useQuery } from 'convex/react';
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Chip, Surface, Text, TextInput, useTheme } from 'react-native-paper';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { AccountAccessNotice } from '../../components/auth/AccountAccessNotice';
import { useAccountAccess } from '../../components/auth/useAccountAccess';
import { TabHeader } from '../../components/ui/Header';
import { useAppAuth } from '../../context/AuthProvider';
import { useImageUpload } from '../../hooks/useImageUpload';
import { formatPrice } from '../../theme';
import type { RootStackParamList } from '../../types';
import { canManageCatalog, canManageListings, isReviewerRole } from '../../utils/roles';
import { getVendorApplicationValidationMessage, type VendorApplicationForm } from './vendorApplicationValidation';

type VendorStatus = 'pending' | 'approved' | 'changes_requested' | 'suspended';

const emptyForm: VendorApplicationForm = {
  storeName: '',
  description: '',
  logoUrl: '',
  bannerUrl: '',
  contactEmail: '',
  contactPhone: '',
  street: '',
  city: '',
  province: '',
  country: 'Zambia',
  website: '',
  instagram: '',
  facebook: '',
};

const vendorStatusCopy: Record<VendorStatus, string> = {
  pending: 'Pending Review',
  approved: 'Approved',
  changes_requested: 'Changes Requested',
  suspended: 'Suspended',
};

function normalizeOptionalUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return trimmed;
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

const productStatusCopy: Record<
  'draft' | 'pending_review' | 'changes_requested' | 'rejected' | 'active' | 'sold' | 'suspended',
  string
> = {
  draft: 'Draft',
  pending_review: 'Pending Review',
  changes_requested: 'Changes Requested',
  rejected: 'Rejected',
  active: 'Active',
  sold: 'Sold',
  suspended: 'Suspended',
};

export default function SellScreen() {
  const access = useAccountAccess();
  if (access.status !== 'ready') {
    return <AccountAccessNotice access={access} title="Sell" />;
  }
  return <SellContent />;
}

function SellContent() {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { user } = useAppAuth();
  const storefront = useQuery(api.platform.getStorefront);
  const vendorProfile = useQuery(api.vendors.getMyVendorProfile, user?._id && !user.isBanned ? {} : 'skip');
  const submitApplication = useMutation(api.vendors.submitApplication);

  const logoUpload = useImageUpload();
  const bannerUpload = useImageUpload();

  const isCompanyCatalogManager = canManageCatalog(user?.role);
  const isReviewerOnly = isReviewerRole(user?.role) && !isCompanyCatalogManager;
  const hasListingAccess = canManageListings(user?.role, vendorProfile?.status ?? null);

  const companyListings = useQuery(
    api.products.getManagedCatalogProducts,
    user?._id && isCompanyCatalogManager ? {} : 'skip',
  );
  const vendorListings = useQuery(
    api.products.getMyListings,
    user?._id && !isCompanyCatalogManager && vendorProfile?.status === 'approved' ? {} : 'skip',
  );

  const [form, setForm] = useState<VendorApplicationForm>(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!vendorProfile) {
      return;
    }

    setForm({
      storeName: vendorProfile.storeName,
      description: vendorProfile.description,
      logoUrl: vendorProfile.logoUrl ?? '',
      bannerUrl: vendorProfile.bannerUrl ?? '',
      contactEmail: vendorProfile.contactEmail,
      contactPhone: vendorProfile.contactPhone ?? '',
      street: vendorProfile.address.street,
      city: vendorProfile.address.city,
      province: vendorProfile.address.province,
      country: vendorProfile.address.country,
      website: vendorProfile.socialLinks?.website ?? '',
      instagram: vendorProfile.socialLinks?.instagram ?? '',
      facebook: vendorProfile.socialLinks?.facebook ?? '',
    });
  }, [vendorProfile]);

  useEffect(() => {
    const uploadedLogo = logoUpload.images[logoUpload.images.length - 1]?.url;
    if (uploadedLogo) {
      setForm((current) => ({ ...current, logoUrl: uploadedLogo }));
    }
  }, [logoUpload.images]);

  useEffect(() => {
    const uploadedBanner = bannerUpload.images[bannerUpload.images.length - 1]?.url;
    if (uploadedBanner) {
      setForm((current) => ({ ...current, bannerUrl: uploadedBanner }));
    }
  }, [bannerUpload.images]);

  const listings = useMemo(
    () => (isCompanyCatalogManager ? (companyListings ?? []) : (vendorListings ?? [])),
    [companyListings, isCompanyCatalogManager, vendorListings],
  );

  const stats = useMemo(
    () => ({
      total: listings.length,
      active: listings.filter((product) => product.status === 'active').length,
      pending: listings.filter((product) => product.status === 'pending_review').length,
      changesRequested: listings.filter((product) => product.status === 'changes_requested').length,
    }),
    [listings],
  );

  const isStorefrontConfigured = storefront?.isConfigured ?? false;
  const storefrontBlockedForCompanyCatalog = isCompanyCatalogManager && !isStorefrontConfigured;

  const handleSubmitApplication = async () => {
    if (!user) {
      return;
    }

    const validationMessage = getVendorApplicationValidationMessage(form);
    if (validationMessage) {
      Alert.alert('Missing required details', validationMessage);
      return;
    }

    setSubmitting(true);

    try {
      await submitApplication({
        storeName: form.storeName.trim(),
        description: form.description.trim(),
        logoUrl: normalizeOptionalUrl(form.logoUrl),
        bannerUrl: normalizeOptionalUrl(form.bannerUrl),
        contactEmail: form.contactEmail.trim(),
        contactPhone: form.contactPhone.trim() || undefined,
        address: {
          street: form.street.trim(),
          city: form.city.trim(),
          province: form.province.trim(),
          country: form.country.trim(),
        },
        socialLinks: {
          website: normalizeOptionalUrl(form.website),
          instagram: normalizeOptionalUrl(form.instagram),
          facebook: normalizeOptionalUrl(form.facebook),
        },
      });
      Alert.alert(
        'Application submitted',
        vendorProfile
          ? 'Your vendor application has been resubmitted for review.'
          : 'Your vendor application has been submitted for review.',
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unable to submit your vendor application.';
      Alert.alert('Unable to submit application', message);
    } finally {
      setSubmitting(false);
    }
  };

  const pickLogo = async () => {
    logoUpload.clearImages();
    await logoUpload.pickImages(1);
  };

  const pickBanner = async () => {
    bannerUpload.clearImages();
    await bannerUpload.pickImages(1);
  };

  const openCreateListing = () => {
    navigation.navigate('CreateProduct');
  };

  const openListing = (productId: string) => {
    navigation.navigate('EditProduct', { productId });
  };

  const openStoreManagement = () => {
    navigation.navigate('AdminStores');
  };

  const openListingReview = () => {
    navigation.navigate('ListingReview');
  };

  const openDisputes = () => {
    navigation.navigate('Disputes');
  };

  if (
    !user ||
    storefront === undefined ||
    vendorProfile === undefined ||
    (hasListingAccess && listings === undefined)
  ) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <TabHeader title="Sell" subtitle="Vendor operations" showAIAssistant />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </View>
    );
  }

  if (isReviewerOnly) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <TabHeader title="Review Queue" subtitle="Reviewer-Approver tools on mobile" showAIAssistant />
        <View style={styles.centered}>
          <Icon name="clipboard-check-outline" size={48} color={theme.colors.primary} />
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 16 }}>
            Review listings from mobile
          </Text>
          <Text
            variant="bodyMedium"
            style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, textAlign: 'center', maxWidth: 280 }}
          >
            Reviewer-Approvers can review product submissions and monitor disputes directly from the mobile app.
          </Text>
          <Button mode="contained" onPress={openListingReview} style={styles.primaryButton}>
            Open Listing Review
          </Button>
          <Button mode="outlined" onPress={openDisputes} style={styles.secondaryButton}>
            Open Dispute Queue
          </Button>
        </View>
      </View>
    );
  }

  if (hasListingAccess) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <TabHeader
          title={isCompanyCatalogManager ? 'Company Catalog' : vendorProfile?.storeName || 'My Store'}
          subtitle={
            isCompanyCatalogManager
              ? 'Manage official Gettitonline inventory'
              : 'Manage your store and watch review status'
          }
          showAIAssistant
        />
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          {isCompanyCatalogManager ? (
            <Surface style={[styles.storefrontCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <View style={styles.storefrontHeader}>
                <View style={{ flex: 1 }}>
                  <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                    Company Storefront
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                    Choose the internal account that owns official Gettitonline catalog listings.
                  </Text>
                </View>
                <Chip compact>{isStorefrontConfigured ? 'Configured' : 'Needs Setup'}</Chip>
              </View>

              <View style={styles.storefrontMeta}>
                <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  Store display name
                </Text>
                <Text variant="bodyLarge" style={{ color: theme.colors.onSurface, marginTop: 4 }}>
                  {storefront.companyDisplayName}
                </Text>
              </View>

              <View style={styles.storefrontMeta}>
                <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  Status
                </Text>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, marginTop: 4 }}>
                  {isStorefrontConfigured
                    ? 'Official company storefront is configured for mobile catalog management.'
                    : 'A Super Admin must choose the company seller account before official listings can be created.'}
                </Text>
              </View>

              {user.role === 'admin' ? (
                <Button mode="contained" onPress={openStoreManagement} style={styles.primaryButton}>
                  Open Store Management
                </Button>
              ) : (
                <Surface
                  style={[styles.storefrontNotice, { backgroundColor: theme.colors.secondaryContainer }]}
                  elevation={0}
                >
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSecondaryContainer }}>
                    Store setup is managed by Super Admins from the mobile Store Management screen.
                  </Text>
                </Surface>
              )}
            </Surface>
          ) : null}

          {storefrontBlockedForCompanyCatalog ? (
            <Surface style={[styles.emptyCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                Company catalog setup required
              </Text>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 8 }}>
                {user.role === 'admin'
                  ? 'Open Store Management from mobile and choose the company seller account before creating official listings.'
                  : 'Ask a Super Admin to configure the company storefront in the mobile app before adding listings.'}
              </Text>
              {user.role === 'admin' ? (
                <Button mode="contained" onPress={openStoreManagement} style={styles.primaryButton}>
                  Open Store Management
                </Button>
              ) : null}
            </Surface>
          ) : (
            <>
              <View style={styles.statsRow}>
                <Surface style={[styles.statCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
                  <Text variant="headlineSmall" style={{ color: theme.colors.primary }}>
                    {stats.total}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    Listings
                  </Text>
                </Surface>
                <Surface style={[styles.statCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
                  <Text variant="headlineSmall" style={{ color: theme.colors.primary }}>
                    {stats.active}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    Active
                  </Text>
                </Surface>
                <Surface style={[styles.statCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
                  <Text variant="headlineSmall" style={{ color: theme.colors.primary }}>
                    {stats.pending}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    Pending
                  </Text>
                </Surface>
                <Surface style={[styles.statCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
                  <Text variant="headlineSmall" style={{ color: theme.colors.primary }}>
                    {stats.changesRequested}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    Action Needed
                  </Text>
                </Surface>
              </View>

              <Button mode="contained" onPress={openCreateListing} style={styles.primaryButton}>
                Add Listing
              </Button>

              {listings.length === 0 ? (
                <Surface style={[styles.emptyCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
                  <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                    No listings yet
                  </Text>
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 8 }}>
                    Drafts stay private and submitted listings remain hidden until a Reviewer-Approver approves them.
                  </Text>
                </Surface>
              ) : (
                listings.map((product) => (
                  <Pressable key={product._id} onPress={() => openListing(product._id)}>
                    <Surface style={[styles.listingCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
                      <View style={styles.listingHeader}>
                        <View style={{ flex: 1 }}>
                          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                            {product.title}
                          </Text>
                          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                            {formatPrice(product.price)} • {product.quantity} in stock
                          </Text>
                        </View>
                        <Chip compact>{productStatusCopy[product.status]}</Chip>
                      </View>
                    </Surface>
                  </Pressable>
                ))
              )}
            </>
          )}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <TabHeader title="Vendor Application" subtitle="Apply to sell on Gettitonline" showAIAssistant />
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {vendorProfile && (
          <Surface style={[styles.statusCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
            <Chip compact>{vendorStatusCopy[vendorProfile.status as VendorStatus]}</Chip>
            {vendorProfile.reviewNotes ? (
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 12 }}>
                {vendorProfile.reviewNotes}
              </Text>
            ) : null}
          </Surface>
        )}

        <Surface style={[styles.formCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            Store Details
          </Text>
          <TextInput
            label="Store name"
            mode="outlined"
            value={form.storeName}
            onChangeText={(value) => setForm((current) => ({ ...current, storeName: value }))}
            style={styles.input}
          />
          <TextInput
            label="Description"
            mode="outlined"
            multiline
            value={form.description}
            onChangeText={(value) => setForm((current) => ({ ...current, description: value }))}
            style={styles.input}
          />
          <TextInput
            label="Contact email"
            mode="outlined"
            value={form.contactEmail}
            onChangeText={(value) => setForm((current) => ({ ...current, contactEmail: value }))}
            style={styles.input}
          />
          <TextInput
            label="Contact phone"
            mode="outlined"
            value={form.contactPhone}
            onChangeText={(value) => setForm((current) => ({ ...current, contactPhone: value }))}
            style={styles.input}
          />
          <TextInput
            label="Street"
            mode="outlined"
            value={form.street}
            onChangeText={(value) => setForm((current) => ({ ...current, street: value }))}
            style={styles.input}
          />
          <TextInput
            label="City"
            mode="outlined"
            value={form.city}
            onChangeText={(value) => setForm((current) => ({ ...current, city: value }))}
            style={styles.input}
          />
          <TextInput
            label="Province"
            mode="outlined"
            value={form.province}
            onChangeText={(value) => setForm((current) => ({ ...current, province: value }))}
            style={styles.input}
          />
          <TextInput
            label="Country"
            mode="outlined"
            value={form.country}
            onChangeText={(value) => setForm((current) => ({ ...current, country: value }))}
            style={styles.input}
          />
          <TextInput
            label="Website"
            mode="outlined"
            value={form.website}
            onChangeText={(value) => setForm((current) => ({ ...current, website: value }))}
            style={styles.input}
          />
          <TextInput
            label="Instagram"
            mode="outlined"
            value={form.instagram}
            onChangeText={(value) => setForm((current) => ({ ...current, instagram: value }))}
            style={styles.input}
          />
          <TextInput
            label="Facebook"
            mode="outlined"
            value={form.facebook}
            onChangeText={(value) => setForm((current) => ({ ...current, facebook: value }))}
            style={styles.input}
          />
          <TextInput
            label="Store banner URL"
            mode="outlined"
            value={form.bannerUrl}
            onChangeText={(value) => setForm((current) => ({ ...current, bannerUrl: value }))}
            style={styles.input}
          />

          <View style={styles.assetRow}>
            <Button mode="outlined" onPress={pickLogo} loading={logoUpload.isUploading}>
              Upload Logo
            </Button>
            {form.logoUrl ? <Image source={{ uri: form.logoUrl }} style={styles.logoPreview} /> : null}
          </View>

          <View style={styles.assetRow}>
            <Button mode="outlined" onPress={pickBanner} loading={bannerUpload.isUploading}>
              Upload Banner
            </Button>
          </View>
          {form.bannerUrl ? (
            <Image
              source={{ uri: normalizeOptionalUrl(form.bannerUrl) ?? form.bannerUrl }}
              style={styles.bannerPreview}
              resizeMode="cover"
            />
          ) : null}

          <Button mode="contained" onPress={handleSubmitApplication} loading={submitting} style={styles.primaryButton}>
            {vendorProfile ? 'Resubmit Application' : 'Submit Application'}
          </Button>
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
  statsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  statCard: {
    flexBasis: '47%',
    padding: 16,
    borderRadius: 16,
  },
  primaryButton: {
    marginTop: 8,
  },
  secondaryButton: {
    marginTop: 12,
  },
  emptyCard: {
    padding: 20,
    borderRadius: 16,
  },
  listingCard: {
    padding: 16,
    borderRadius: 16,
    marginTop: 12,
  },
  listingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  statusCard: {
    padding: 16,
    borderRadius: 16,
    marginBottom: 16,
  },
  formCard: {
    padding: 16,
    borderRadius: 16,
  },
  storefrontCard: {
    padding: 16,
    borderRadius: 16,
  },
  storefrontHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  storefrontMeta: {
    marginTop: 16,
  },
  storefrontNotice: {
    marginTop: 16,
    borderRadius: 14,
    padding: 14,
  },
  input: {
    marginTop: 12,
  },
  assetRow: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  logoPreview: {
    width: 56,
    height: 56,
    borderRadius: 14,
  },
  bannerPreview: {
    width: '100%',
    height: 120,
    marginTop: 12,
    borderRadius: 16,
  },
});
