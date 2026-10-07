import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery } from 'convex/react';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Chip, Modal, Portal, Surface, Text, TextInput, useTheme } from 'react-native-paper';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { StackHeader } from '../../components/ui/Header';
import { useAppAuth } from '../../context/AuthProvider';
import { useImageUpload } from '../../hooks/useImageUpload';
import { formatPrice } from '../../theme';
import type { Id, RootStackParamList } from '../../types';
import { isAdminRole } from '../../utils/roles';

type Props = NativeStackScreenProps<RootStackParamList, 'AdminPromotions'>;
type BannerPlacement = 'home_hero' | 'home_monthly' | 'home_strip' | 'category' | 'pdp';
type PromotionType = 'deal_of_day' | 'flash_sale' | 'weekend_sale' | 'sponsored_product' | 'seller_campaign';
type PromotionDiscountType = 'percent' | 'fixed_amount' | 'compare_at';
type PromoCodeDiscountType = 'percent' | 'fixed_amount';
type BannerForm = {
  bannerId?: Id<'promotionBanners'>;
  title: string;
  subtitle: string;
  imageUrl: string;
  targetUrl: string;
  placement: BannerPlacement;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  sortOrder: string;
};
type PromotionForm = {
  promotionId?: Id<'promotions'>;
  name: string;
  type: PromotionType;
  productIds: string;
  discountType: PromotionDiscountType;
  discountValue: string;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  priority: string;
};
type PromoCodeForm = {
  promoCodeId?: Id<'promoCodes'>;
  code: string;
  title: string;
  description: string;
  discountType: PromoCodeDiscountType;
  discountValue: string;
  minimumSubtotal: string;
  maxDiscount: string;
  usageLimit: string;
  perUserLimit: string;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
};

const todayInput = () => new Date().toISOString().slice(0, 10);
const nextMonthInput = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const defaultBannerForm: BannerForm = {
  title: '',
  subtitle: '',
  imageUrl: '',
  targetUrl: '',
  placement: 'home_hero',
  startsAt: todayInput(),
  endsAt: nextMonthInput(),
  isActive: true,
  sortOrder: '0',
};
const defaultPromotionForm: PromotionForm = {
  name: '',
  type: 'deal_of_day',
  productIds: '',
  discountType: 'percent',
  discountValue: '10',
  startsAt: todayInput(),
  endsAt: nextMonthInput(),
  isActive: true,
  priority: '0',
};
const defaultPromoCodeForm: PromoCodeForm = {
  code: '',
  title: '',
  description: '',
  discountType: 'percent',
  discountValue: '10',
  minimumSubtotal: '',
  maxDiscount: '',
  usageLimit: '',
  perUserLimit: '',
  startsAt: todayInput(),
  endsAt: nextMonthInput(),
  isActive: true,
};

function parseDateInput(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function optionalDateInput(value: string) {
  if (!value.trim()) return undefined;
  return parseDateInput(value);
}

function optionalNumber(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requiredNumber(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatWindow(startsAt: number, endsAt?: number) {
  const start = new Date(startsAt).toLocaleDateString();
  const end = endsAt ? new Date(endsAt).toLocaleDateString() : 'No end';
  return `${start} - ${end}`;
}

function normalizeImageUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Banner image URL is required.');
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Banner image URL must start with http:// or https://.');
  }
  return parsed.toString();
}

function safeImageUrl(value: string) {
  try {
    return normalizeImageUrl(value);
  } catch {
    return value.trim();
  }
}

export default function AdminPromotionsScreen({ navigation }: Props) {
  const theme = useTheme();
  const { user } = useAppAuth();
  const isAdmin = isAdminRole(user?.role);
  const bannerUpload = useImageUpload();
  const [bannerForm, setBannerForm] = useState<BannerForm>(defaultBannerForm);
  const [promotionForm, setPromotionForm] = useState<PromotionForm>(defaultPromotionForm);
  const [promoCodeForm, setPromoCodeForm] = useState<PromoCodeForm>(defaultPromoCodeForm);
  const [showBannerForm, setShowBannerForm] = useState(false);
  const [showPromotionForm, setShowPromotionForm] = useState(false);
  const [showPromoCodeForm, setShowPromoCodeForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const banners = useQuery(
    api.promotions.listPromotionBannersForAdmin,
    user?._id && isAdmin ? { adminId: user._id } : 'skip',
  );
  const promotions = useQuery(
    api.promotions.listPromotionsForAdmin,
    user?._id && isAdmin ? { adminId: user._id } : 'skip',
  );
  const promoCodes = useQuery(
    api.promotions.listPromoCodesForAdmin,
    user?._id && isAdmin ? { adminId: user._id } : 'skip',
  );
  const upsertPromotionBanner = useMutation(api.promotions.upsertPromotionBanner);
  const upsertPromotion = useMutation(api.promotions.upsertPromotion);
  const upsertPromoCode = useMutation(api.promotions.upsertPromoCode);

  useEffect(() => {
    const uploadedBanner = bannerUpload.images[bannerUpload.images.length - 1]?.url;
    if (uploadedBanner) {
      setBannerForm((current) => ({ ...current, imageUrl: uploadedBanner }));
    }
  }, [bannerUpload.images]);

  const saveBanner = async () => {
    if (!user) return;
    if (!bannerForm.title.trim() || !bannerForm.imageUrl.trim()) {
      Alert.alert('Missing banner data', 'Enter a banner title and image URL.');
      return;
    }

    setSaving(true);
    try {
      const imageUrl = normalizeImageUrl(bannerForm.imageUrl);
      await upsertPromotionBanner({
        adminId: user._id,
        bannerId: bannerForm.bannerId,
        title: bannerForm.title.trim(),
        subtitle: bannerForm.subtitle.trim() || undefined,
        imageUrl,
        targetUrl: bannerForm.targetUrl.trim() || undefined,
        placement: bannerForm.placement,
        startsAt: parseDateInput(bannerForm.startsAt),
        endsAt: optionalDateInput(bannerForm.endsAt),
        isActive: bannerForm.isActive,
        sortOrder: requiredNumber(bannerForm.sortOrder, 0),
      });
      setShowBannerForm(false);
      setBannerForm(defaultBannerForm);
    } catch (error: unknown) {
      Alert.alert('Save failed', error instanceof Error ? error.message : 'Could not save banner');
    } finally {
      setSaving(false);
    }
  };

  const pickBannerImage = async () => {
    bannerUpload.clearImages();
    await bannerUpload.pickImages(1);
  };

  const savePromotion = async () => {
    if (!user) return;
    if (!promotionForm.name.trim()) {
      Alert.alert('Missing campaign name', 'Enter a promotion name.');
      return;
    }

    const productIds = promotionForm.productIds
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => id as Id<'products'>);

    setSaving(true);
    try {
      await upsertPromotion({
        adminId: user._id,
        promotionId: promotionForm.promotionId,
        name: promotionForm.name.trim(),
        type: promotionForm.type,
        productIds,
        discountType: promotionForm.discountType,
        discountValue: optionalNumber(promotionForm.discountValue),
        startsAt: parseDateInput(promotionForm.startsAt),
        endsAt: optionalDateInput(promotionForm.endsAt),
        isActive: promotionForm.isActive,
        priority: requiredNumber(promotionForm.priority, 0),
      });
      setShowPromotionForm(false);
      setPromotionForm(defaultPromotionForm);
    } catch (error: unknown) {
      Alert.alert('Save failed', error instanceof Error ? error.message : 'Could not save promotion');
    } finally {
      setSaving(false);
    }
  };

  const savePromoCode = async () => {
    if (!user) return;
    if (!promoCodeForm.code.trim() || !promoCodeForm.title.trim()) {
      Alert.alert('Missing promo code data', 'Enter a code and title.');
      return;
    }

    setSaving(true);
    try {
      await upsertPromoCode({
        adminId: user._id,
        promoCodeId: promoCodeForm.promoCodeId,
        code: promoCodeForm.code.trim(),
        title: promoCodeForm.title.trim(),
        description: promoCodeForm.description.trim() || undefined,
        scope: 'platform',
        discountType: promoCodeForm.discountType,
        discountValue: requiredNumber(promoCodeForm.discountValue, 0),
        minimumSubtotal: optionalNumber(promoCodeForm.minimumSubtotal),
        maxDiscount: optionalNumber(promoCodeForm.maxDiscount),
        usageLimit: optionalNumber(promoCodeForm.usageLimit),
        perUserLimit: optionalNumber(promoCodeForm.perUserLimit),
        startsAt: parseDateInput(promoCodeForm.startsAt),
        endsAt: optionalDateInput(promoCodeForm.endsAt),
        isActive: promoCodeForm.isActive,
      });
      setShowPromoCodeForm(false);
      setPromoCodeForm(defaultPromoCodeForm);
    } catch (error: unknown) {
      Alert.alert('Save failed', error instanceof Error ? error.message : 'Could not save promo code');
    } finally {
      setSaving(false);
    }
  };

  if (!user || !isAdmin) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Promotions Admin" onBackPress={() => navigation.goBack()} variant="gradient" />
        <View style={styles.centered}>
          <Icon name="shield-lock-outline" size={48} color={theme.colors.primary} />
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 16 }}>
            Super Admin access required
          </Text>
        </View>
      </View>
    );
  }

  if (banners === undefined || promotions === undefined || promoCodes === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Promotions Admin" onBackPress={() => navigation.goBack()} variant="gradient" />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader
        title="Promotions Admin"
        subtitle="Banners, deals, promo codes"
        onBackPress={() => navigation.goBack()}
        variant="gradient"
      />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.statsGrid}>
          <Surface style={[styles.statCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
            <Text variant="headlineSmall" style={{ color: theme.colors.primary }}>
              {banners.length}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Banners
            </Text>
          </Surface>
          <Surface style={[styles.statCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
            <Text variant="headlineSmall" style={{ color: theme.colors.primary }}>
              {promotions.length}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Campaigns
            </Text>
          </Surface>
          <Surface style={[styles.statCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
            <Text variant="headlineSmall" style={{ color: theme.colors.primary }}>
              {promoCodes.length}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Codes
            </Text>
          </Surface>
        </View>

        <Surface style={[styles.sectionCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <View style={styles.sectionTitleRow}>
            <View style={styles.sectionTitle}>
              <Icon name="image-multiple-outline" size={22} color={theme.colors.primary} />
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                Campaign Banners
              </Text>
            </View>
            <Button compact mode="contained-tonal" icon="plus" onPress={() => { bannerUpload.clearImages(); setBannerForm(defaultBannerForm); setShowBannerForm(true); }}>
              Add
            </Button>
          </View>
          <View style={styles.list}>
            {banners.map((banner) => (
              <Pressable
                key={banner._id}
                style={styles.bannerRow}
                onPress={() => {
                  setBannerForm({
                    bannerId: banner._id,
                    title: banner.title,
                    subtitle: banner.subtitle ?? '',
                    imageUrl: safeImageUrl(banner.imageUrl),
                    targetUrl: banner.targetUrl ?? '',
                    placement: banner.placement,
                    startsAt: new Date(banner.startsAt).toISOString().slice(0, 10),
                    endsAt: banner.endsAt ? new Date(banner.endsAt).toISOString().slice(0, 10) : '',
                    isActive: banner.isActive,
                    sortOrder: String(banner.sortOrder),
                  });
                  bannerUpload.clearImages();
                  setShowBannerForm(true);
                }}
              >
                {banner.imageUrl ? (
                  <Image source={{ uri: safeImageUrl(banner.imageUrl) }} style={styles.bannerThumb} />
                ) : (
                  <View style={[styles.bannerThumb, styles.thumbFallback, { backgroundColor: theme.colors.surfaceVariant }]}>
                    <Icon name="image-outline" size={22} color={theme.colors.onSurfaceVariant} />
                  </View>
                )}
                <View style={styles.rowText}>
                  <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                    {banner.title}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                    {banner.placement} • {formatWindow(banner.startsAt, banner.endsAt)}
                  </Text>
                </View>
                <Chip compact>{banner.isActive ? 'Active' : 'Off'}</Chip>
              </Pressable>
            ))}
          </View>
        </Surface>

        <Surface style={[styles.sectionCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <View style={styles.sectionTitleRow}>
            <View style={styles.sectionTitle}>
              <Icon name="sale-outline" size={22} color={theme.colors.secondary} />
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                Deals and Campaigns
              </Text>
            </View>
            <Button compact mode="contained-tonal" icon="plus" onPress={() => { setPromotionForm(defaultPromotionForm); setShowPromotionForm(true); }}>
              Add
            </Button>
          </View>
          <View style={styles.list}>
            {promotions.map((promotion) => (
              <Pressable
                key={promotion._id}
                style={styles.listRow}
                onPress={() => {
                  setPromotionForm({
                    promotionId: promotion._id,
                    name: promotion.name,
                    type: promotion.type,
                    productIds: promotion.productIds.join(', '),
                    discountType: promotion.discountType,
                    discountValue: promotion.discountValue === undefined ? '' : String(promotion.discountValue),
                    startsAt: new Date(promotion.startsAt).toISOString().slice(0, 10),
                    endsAt: promotion.endsAt ? new Date(promotion.endsAt).toISOString().slice(0, 10) : '',
                    isActive: promotion.isActive,
                    priority: String(promotion.priority),
                  });
                  setShowPromotionForm(true);
                }}
              >
                <View style={styles.rowText}>
                  <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                    {promotion.name}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                    {promotion.type} • {promotion.productIds.length} products • {formatWindow(promotion.startsAt, promotion.endsAt)}
                  </Text>
                </View>
                <Chip compact>{promotion.isActive ? 'Active' : 'Off'}</Chip>
              </Pressable>
            ))}
          </View>
        </Surface>

        <Surface style={[styles.sectionCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <View style={styles.sectionTitleRow}>
            <View style={styles.sectionTitle}>
              <Icon name="ticket-percent-outline" size={22} color={theme.colors.tertiary} />
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                Promo Codes
              </Text>
            </View>
            <Button compact mode="contained-tonal" icon="plus" onPress={() => { setPromoCodeForm(defaultPromoCodeForm); setShowPromoCodeForm(true); }}>
              Add
            </Button>
          </View>
          <View style={styles.list}>
            {promoCodes.map((code) => (
              <Pressable
                key={code._id}
                style={styles.listRow}
                onPress={() => {
                  setPromoCodeForm({
                    promoCodeId: code._id,
                    code: code.code,
                    title: code.title,
                    description: code.description ?? '',
                    discountType: code.discountType,
                    discountValue: String(code.discountValue),
                    minimumSubtotal: code.minimumSubtotal === undefined ? '' : String(code.minimumSubtotal),
                    maxDiscount: code.maxDiscount === undefined ? '' : String(code.maxDiscount),
                    usageLimit: code.usageLimit === undefined ? '' : String(code.usageLimit),
                    perUserLimit: code.perUserLimit === undefined ? '' : String(code.perUserLimit),
                    startsAt: new Date(code.startsAt).toISOString().slice(0, 10),
                    endsAt: code.endsAt ? new Date(code.endsAt).toISOString().slice(0, 10) : '',
                    isActive: code.isActive,
                  });
                  setShowPromoCodeForm(true);
                }}
              >
                <View style={styles.rowText}>
                  <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                    {code.code}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                    {code.discountType === 'percent'
                      ? `${code.discountValue}% off`
                      : `${formatPrice(code.discountValue)} off`}
                    {code.minimumSubtotal ? ` • Min ${formatPrice(code.minimumSubtotal)}` : ''}
                  </Text>
                </View>
                <Chip compact>{code.isActive ? 'Active' : 'Off'}</Chip>
              </Pressable>
            ))}
          </View>
        </Surface>
      </ScrollView>
      <Portal>
        <Modal
          visible={showBannerForm}
          onDismiss={() => setShowBannerForm(false)}
          contentContainerStyle={[styles.modal, { backgroundColor: theme.colors.surface }]}
        >
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.modalContent}>
            <Text variant="titleLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
              {bannerForm.bannerId ? 'Edit Banner' : 'New Banner'}
            </Text>
            <TextInput label="Title" mode="outlined" value={bannerForm.title} onChangeText={(title) => setBannerForm((current) => ({ ...current, title }))} />
            <TextInput label="Subtitle" mode="outlined" value={bannerForm.subtitle} onChangeText={(subtitle) => setBannerForm((current) => ({ ...current, subtitle }))} />
            <TextInput label="Image URL" mode="outlined" value={bannerForm.imageUrl} onChangeText={(imageUrl) => setBannerForm((current) => ({ ...current, imageUrl }))} />
            <Button mode="outlined" icon="image-plus" onPress={pickBannerImage} loading={bannerUpload.isUploading}>
              Upload Banner Image
            </Button>
            {bannerUpload.validationErrors.map((message) => (
              <Text key={message} variant="bodySmall" style={{ color: theme.colors.error }}>
                {message}
              </Text>
            ))}
            {bannerForm.imageUrl ? (
              <Image source={{ uri: safeImageUrl(bannerForm.imageUrl) }} style={styles.bannerPreview} resizeMode="cover" />
            ) : null}
            <TextInput label="Target URL" mode="outlined" value={bannerForm.targetUrl} onChangeText={(targetUrl) => setBannerForm((current) => ({ ...current, targetUrl }))} />
            <View style={styles.chipWrap}>
              {(['home_hero', 'home_monthly', 'home_strip', 'category', 'pdp'] as BannerPlacement[]).map((placement) => (
                <Chip key={placement} selected={bannerForm.placement === placement} onPress={() => setBannerForm((current) => ({ ...current, placement }))}>
                  {placement.replace(/_/g, ' ')}
                </Chip>
              ))}
            </View>
            <View style={styles.formRow}>
              <TextInput label="Starts" mode="outlined" value={bannerForm.startsAt} onChangeText={(startsAt) => setBannerForm((current) => ({ ...current, startsAt }))} style={styles.flexInput} />
              <TextInput label="Ends" mode="outlined" value={bannerForm.endsAt} onChangeText={(endsAt) => setBannerForm((current) => ({ ...current, endsAt }))} style={styles.flexInput} />
            </View>
            <TextInput label="Sort order" mode="outlined" value={bannerForm.sortOrder} keyboardType="number-pad" onChangeText={(sortOrder) => setBannerForm((current) => ({ ...current, sortOrder }))} />
            <ToggleChip active={bannerForm.isActive} label={bannerForm.isActive ? 'Active' : 'Off'} onPress={() => setBannerForm((current) => ({ ...current, isActive: !current.isActive }))} />
            <View style={styles.modalActions}>
              <Button onPress={() => setShowBannerForm(false)}>Cancel</Button>
              <Button mode="contained" onPress={saveBanner} loading={saving}>Save</Button>
            </View>
          </ScrollView>
        </Modal>

        <Modal
          visible={showPromotionForm}
          onDismiss={() => setShowPromotionForm(false)}
          contentContainerStyle={[styles.modal, { backgroundColor: theme.colors.surface }]}
        >
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.modalContent}>
            <Text variant="titleLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
              {promotionForm.promotionId ? 'Edit Campaign' : 'New Campaign'}
            </Text>
            <TextInput label="Name" mode="outlined" value={promotionForm.name} onChangeText={(name) => setPromotionForm((current) => ({ ...current, name }))} />
            <View style={styles.chipWrap}>
              {(['deal_of_day', 'flash_sale', 'weekend_sale', 'sponsored_product', 'seller_campaign'] as PromotionType[]).map((type) => (
                <Chip key={type} selected={promotionForm.type === type} onPress={() => setPromotionForm((current) => ({ ...current, type }))}>
                  {type.replace(/_/g, ' ')}
                </Chip>
              ))}
            </View>
            <TextInput label="Product IDs (comma-separated)" mode="outlined" value={promotionForm.productIds} onChangeText={(productIds) => setPromotionForm((current) => ({ ...current, productIds }))} />
            <View style={styles.chipWrap}>
              {(['percent', 'fixed_amount', 'compare_at'] as PromotionDiscountType[]).map((discountType) => (
                <Chip key={discountType} selected={promotionForm.discountType === discountType} onPress={() => setPromotionForm((current) => ({ ...current, discountType }))}>
                  {discountType.replace(/_/g, ' ')}
                </Chip>
              ))}
            </View>
            <TextInput label="Discount value" mode="outlined" value={promotionForm.discountValue} keyboardType="decimal-pad" onChangeText={(discountValue) => setPromotionForm((current) => ({ ...current, discountValue }))} />
            <View style={styles.formRow}>
              <TextInput label="Starts" mode="outlined" value={promotionForm.startsAt} onChangeText={(startsAt) => setPromotionForm((current) => ({ ...current, startsAt }))} style={styles.flexInput} />
              <TextInput label="Ends" mode="outlined" value={promotionForm.endsAt} onChangeText={(endsAt) => setPromotionForm((current) => ({ ...current, endsAt }))} style={styles.flexInput} />
            </View>
            <TextInput label="Priority" mode="outlined" value={promotionForm.priority} keyboardType="number-pad" onChangeText={(priority) => setPromotionForm((current) => ({ ...current, priority }))} />
            <ToggleChip active={promotionForm.isActive} label={promotionForm.isActive ? 'Active' : 'Off'} onPress={() => setPromotionForm((current) => ({ ...current, isActive: !current.isActive }))} />
            <View style={styles.modalActions}>
              <Button onPress={() => setShowPromotionForm(false)}>Cancel</Button>
              <Button mode="contained" onPress={savePromotion} loading={saving}>Save</Button>
            </View>
          </ScrollView>
        </Modal>

        <Modal
          visible={showPromoCodeForm}
          onDismiss={() => setShowPromoCodeForm(false)}
          contentContainerStyle={[styles.modal, { backgroundColor: theme.colors.surface }]}
        >
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.modalContent}>
            <Text variant="titleLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
              {promoCodeForm.promoCodeId ? 'Edit Promo Code' : 'New Promo Code'}
            </Text>
            <TextInput label="Code" mode="outlined" value={promoCodeForm.code} autoCapitalize="characters" onChangeText={(code) => setPromoCodeForm((current) => ({ ...current, code }))} />
            <TextInput label="Title" mode="outlined" value={promoCodeForm.title} onChangeText={(title) => setPromoCodeForm((current) => ({ ...current, title }))} />
            <TextInput label="Description" mode="outlined" value={promoCodeForm.description} onChangeText={(description) => setPromoCodeForm((current) => ({ ...current, description }))} />
            <View style={styles.chipWrap}>
              {(['percent', 'fixed_amount'] as PromoCodeDiscountType[]).map((discountType) => (
                <Chip key={discountType} selected={promoCodeForm.discountType === discountType} onPress={() => setPromoCodeForm((current) => ({ ...current, discountType }))}>
                  {discountType.replace(/_/g, ' ')}
                </Chip>
              ))}
            </View>
            <TextInput label="Discount value" mode="outlined" value={promoCodeForm.discountValue} keyboardType="decimal-pad" onChangeText={(discountValue) => setPromoCodeForm((current) => ({ ...current, discountValue }))} />
            <View style={styles.formRow}>
              <TextInput label="Minimum subtotal" mode="outlined" value={promoCodeForm.minimumSubtotal} keyboardType="decimal-pad" onChangeText={(minimumSubtotal) => setPromoCodeForm((current) => ({ ...current, minimumSubtotal }))} style={styles.flexInput} />
              <TextInput label="Max discount" mode="outlined" value={promoCodeForm.maxDiscount} keyboardType="decimal-pad" onChangeText={(maxDiscount) => setPromoCodeForm((current) => ({ ...current, maxDiscount }))} style={styles.flexInput} />
            </View>
            <View style={styles.formRow}>
              <TextInput label="Usage limit" mode="outlined" value={promoCodeForm.usageLimit} keyboardType="number-pad" onChangeText={(usageLimit) => setPromoCodeForm((current) => ({ ...current, usageLimit }))} style={styles.flexInput} />
              <TextInput label="Per user" mode="outlined" value={promoCodeForm.perUserLimit} keyboardType="number-pad" onChangeText={(perUserLimit) => setPromoCodeForm((current) => ({ ...current, perUserLimit }))} style={styles.flexInput} />
            </View>
            <View style={styles.formRow}>
              <TextInput label="Starts" mode="outlined" value={promoCodeForm.startsAt} onChangeText={(startsAt) => setPromoCodeForm((current) => ({ ...current, startsAt }))} style={styles.flexInput} />
              <TextInput label="Ends" mode="outlined" value={promoCodeForm.endsAt} onChangeText={(endsAt) => setPromoCodeForm((current) => ({ ...current, endsAt }))} style={styles.flexInput} />
            </View>
            <ToggleChip active={promoCodeForm.isActive} label={promoCodeForm.isActive ? 'Active' : 'Off'} onPress={() => setPromoCodeForm((current) => ({ ...current, isActive: !current.isActive }))} />
            <View style={styles.modalActions}>
              <Button onPress={() => setShowPromoCodeForm(false)}>Cancel</Button>
              <Button mode="contained" onPress={savePromoCode} loading={saving}>Save</Button>
            </View>
          </ScrollView>
        </Modal>
      </Portal>
    </View>
  );
}

function ToggleChip({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Chip selected={active} icon={active ? 'check-circle-outline' : 'close-circle-outline'} onPress={onPress}>
      {label}
    </Chip>
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
    gap: 12,
  },
  statCard: {
    flex: 1,
    borderRadius: 16,
    padding: 16,
  },
  sectionCard: {
    borderRadius: 18,
    padding: 16,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 14,
  },
  sectionTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  list: {
    gap: 12,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  bannerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  bannerThumb: {
    width: 72,
    height: 52,
    borderRadius: 12,
  },
  bannerPreview: {
    width: '100%',
    height: 140,
    borderRadius: 14,
  },
  thumbFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: {
    flex: 1,
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
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 10,
    marginTop: 8,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  formRow: {
    flexDirection: 'row',
    gap: 10,
  },
  flexInput: {
    flex: 1,
  },
});
