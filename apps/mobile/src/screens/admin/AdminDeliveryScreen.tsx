import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery } from 'convex/react';
import React, { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Chip, Modal, Portal, Surface, Text, TextInput, useTheme } from 'react-native-paper';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { StackHeader } from '../../components/ui/Header';
import { AccountAccessNotice } from '../../components/auth/AccountAccessNotice';
import { useAccountAccess } from '../../components/auth/useAccountAccess';
import { useAppAuth } from '../../context/AuthProvider';
import { formatPrice } from '../../theme';
import type { Id, RootStackParamList } from '../../types';
import { isAdminRole } from '../../utils/roles';

type Props = NativeStackScreenProps<RootStackParamList, 'AdminDelivery'>;
type DeliveryMethodType = 'standard' | 'express' | 'same_day' | 'pickup';
type ZoneForm = {
  zoneId?: Id<'deliveryZones'>;
  name: string;
  slug: string;
  province: string;
  city: string;
  isActive: boolean;
  sortOrder: string;
};
type MethodForm = {
  methodId?: Id<'deliveryMethods'>;
  zoneId?: Id<'deliveryZones'>;
  name: string;
  code: string;
  type: DeliveryMethodType;
  baseFee: string;
  perKgFee: string;
  freeAboveSubtotal: string;
  minDays: string;
  maxDays: string;
  courierName: string;
  isActive: boolean;
};
type PickupPointForm = {
  pickupPointId?: Id<'pickupPoints'>;
  zoneId?: Id<'deliveryZones'>;
  name: string;
  code: string;
  street: string;
  city: string;
  province: string;
  contactPhone: string;
  openingHours: string;
  isActive: boolean;
};

const defaultZoneForm: ZoneForm = {
  name: '',
  slug: '',
  province: '',
  city: '',
  isActive: true,
  sortOrder: '0',
};
const defaultMethodForm: MethodForm = {
  name: '',
  code: '',
  type: 'standard',
  baseFee: '0',
  perKgFee: '',
  freeAboveSubtotal: '',
  minDays: '1',
  maxDays: '3',
  courierName: '',
  isActive: true,
};
const defaultPickupPointForm: PickupPointForm = {
  name: '',
  code: '',
  street: '',
  city: '',
  province: '',
  contactPhone: '',
  openingHours: '',
  isActive: true,
};

function slugify(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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

export default function AdminDeliveryScreen(props: Props) {
  // Admin data is read only for a ready account, so no admin query runs while the account is loading or unavailable.
  const access = useAccountAccess();
  if (access.status !== 'ready') {
    return <AccountAccessNotice access={access} title="Delivery Admin" />;
  }
  return <AdminDeliveryContent {...props} />;
}

function AdminDeliveryContent({ navigation }: Props) {
  const theme = useTheme();
  const { user } = useAppAuth();
  const isAdmin = isAdminRole(user?.role);
  const [zoneForm, setZoneForm] = useState<ZoneForm>(defaultZoneForm);
  const [methodForm, setMethodForm] = useState<MethodForm>(defaultMethodForm);
  const [pickupPointForm, setPickupPointForm] = useState<PickupPointForm>(defaultPickupPointForm);
  const [showZoneForm, setShowZoneForm] = useState(false);
  const [showMethodForm, setShowMethodForm] = useState(false);
  const [showPickupPointForm, setShowPickupPointForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const zones = useQuery(
    api.delivery.listDeliveryZones,
    isAdmin ? { includeInactive: true } : 'skip',
  );
  const methods = useQuery(
    api.delivery.listDeliveryMethods,
    isAdmin ? { includeInactive: true } : 'skip',
  );
  const pickupPoints = useQuery(
    api.delivery.listPickupPoints,
    isAdmin ? { includeInactive: true } : 'skip',
  );
  const upsertDeliveryZone = useMutation(api.delivery.upsertDeliveryZone);
  const upsertDeliveryMethod = useMutation(api.delivery.upsertDeliveryMethod);
  const upsertPickupPoint = useMutation(api.delivery.upsertPickupPoint);

  const saveZone = async () => {
    if (!user) return;
    if (!zoneForm.name.trim()) {
      Alert.alert('Missing zone name', 'Enter a delivery zone name.');
      return;
    }

    setSaving(true);
    try {
      await upsertDeliveryZone({
        adminId: user._id,
        zoneId: zoneForm.zoneId,
        name: zoneForm.name.trim(),
        slug: (zoneForm.slug.trim() || slugify(zoneForm.name)).toLowerCase(),
        province: zoneForm.province.trim() || undefined,
        city: zoneForm.city.trim() || undefined,
        isActive: zoneForm.isActive,
        sortOrder: requiredNumber(zoneForm.sortOrder, 0),
      });
      setShowZoneForm(false);
      setZoneForm(defaultZoneForm);
    } catch (error: unknown) {
      Alert.alert('Save failed', error instanceof Error ? error.message : 'Could not save zone');
    } finally {
      setSaving(false);
    }
  };

  const saveMethod = async () => {
    if (!user) return;
    if (!methodForm.name.trim() || !methodForm.code.trim()) {
      Alert.alert('Missing method data', 'Enter a method name and code.');
      return;
    }

    setSaving(true);
    try {
      await upsertDeliveryMethod({
        adminId: user._id,
        methodId: methodForm.methodId,
        zoneId: methodForm.zoneId,
        name: methodForm.name.trim(),
        code: methodForm.code.trim().toUpperCase(),
        type: methodForm.type,
        baseFee: requiredNumber(methodForm.baseFee, 0),
        perKgFee: optionalNumber(methodForm.perKgFee),
        freeAboveSubtotal: optionalNumber(methodForm.freeAboveSubtotal),
        minDays: requiredNumber(methodForm.minDays, 1),
        maxDays: requiredNumber(methodForm.maxDays, 3),
        courierName: methodForm.courierName.trim() || undefined,
        isActive: methodForm.isActive,
      });
      setShowMethodForm(false);
      setMethodForm(defaultMethodForm);
    } catch (error: unknown) {
      Alert.alert('Save failed', error instanceof Error ? error.message : 'Could not save delivery method');
    } finally {
      setSaving(false);
    }
  };

  const savePickupPoint = async () => {
    if (!user) return;
    if (!pickupPointForm.name.trim() || !pickupPointForm.code.trim()) {
      Alert.alert('Missing pickup data', 'Enter a pickup point name and code.');
      return;
    }

    setSaving(true);
    try {
      await upsertPickupPoint({
        adminId: user._id,
        pickupPointId: pickupPointForm.pickupPointId,
        zoneId: pickupPointForm.zoneId,
        name: pickupPointForm.name.trim(),
        code: pickupPointForm.code.trim().toUpperCase(),
        address: {
          street: pickupPointForm.street.trim(),
          city: pickupPointForm.city.trim(),
          province: pickupPointForm.province.trim(),
          country: 'Zambia',
        },
        contactPhone: pickupPointForm.contactPhone.trim() || undefined,
        openingHours: pickupPointForm.openingHours.trim() || undefined,
        isActive: pickupPointForm.isActive,
      });
      setShowPickupPointForm(false);
      setPickupPointForm(defaultPickupPointForm);
    } catch (error: unknown) {
      Alert.alert('Save failed', error instanceof Error ? error.message : 'Could not save pickup point');
    } finally {
      setSaving(false);
    }
  };

  if (!user || !isAdmin) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Delivery Admin" onBackPress={() => navigation.goBack()} variant="gradient" />
        <View style={styles.centered}>
          <Icon name="shield-lock-outline" size={48} color={theme.colors.primary} />
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 16 }}>
            Super Admin access required
          </Text>
        </View>
      </View>
    );
  }

  if (zones === undefined || methods === undefined || pickupPoints === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Delivery Admin" onBackPress={() => navigation.goBack()} variant="gradient" />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader
        title="Delivery Admin"
        subtitle="Zones, tiers, pickup points"
        onBackPress={() => navigation.goBack()}
        variant="gradient"
      />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.statsGrid}>
          <Surface style={[styles.statCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
            <Text variant="headlineSmall" style={{ color: theme.colors.primary }}>
              {zones.length}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Zones
            </Text>
          </Surface>
          <Surface style={[styles.statCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
            <Text variant="headlineSmall" style={{ color: theme.colors.primary }}>
              {methods.length}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Methods
            </Text>
          </Surface>
          <Surface style={[styles.statCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
            <Text variant="headlineSmall" style={{ color: theme.colors.primary }}>
              {pickupPoints.length}
            </Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Pickup
            </Text>
          </Surface>
        </View>

        <Surface style={[styles.sectionCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <View style={styles.sectionTitleRow}>
            <View style={styles.sectionTitle}>
              <Icon name="map-marker-radius-outline" size={22} color={theme.colors.primary} />
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                Delivery Zones
              </Text>
            </View>
            <Button
              compact
              mode="contained-tonal"
              icon="plus"
              onPress={() => {
                setZoneForm(defaultZoneForm);
                setShowZoneForm(true);
              }}
            >
              Add
            </Button>
          </View>
          <View style={styles.list}>
            {zones.map((zone) => (
              <Pressable
                key={zone._id}
                style={styles.listRow}
                onPress={() => {
                  setZoneForm({
                    zoneId: zone._id,
                    name: zone.name,
                    slug: zone.slug,
                    province: zone.province ?? '',
                    city: zone.city ?? '',
                    isActive: zone.isActive,
                    sortOrder: String(zone.sortOrder),
                  });
                  setShowZoneForm(true);
                }}
              >
                <View style={styles.rowText}>
                  <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                    {zone.name}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                    {[zone.city, zone.province].filter(Boolean).join(', ') || 'Nationwide'}
                  </Text>
                </View>
                <Chip compact>{zone.isActive ? 'Active' : 'Inactive'}</Chip>
              </Pressable>
            ))}
          </View>
        </Surface>

        <Surface style={[styles.sectionCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <View style={styles.sectionTitleRow}>
            <View style={styles.sectionTitle}>
              <Icon name="truck-fast-outline" size={22} color={theme.colors.secondary} />
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                Delivery Methods
              </Text>
            </View>
            <Button
              compact
              mode="contained-tonal"
              icon="plus"
              onPress={() => {
                setMethodForm(defaultMethodForm);
                setShowMethodForm(true);
              }}
            >
              Add
            </Button>
          </View>
          <View style={styles.list}>
            {methods.map((method) => (
              <Pressable
                key={method._id}
                style={styles.listRow}
                onPress={() => {
                  setMethodForm({
                    methodId: method._id,
                    zoneId: method.zoneId,
                    name: method.name,
                    code: method.code,
                    type: method.type,
                    baseFee: String(method.baseFee),
                    perKgFee: method.perKgFee === undefined ? '' : String(method.perKgFee),
                    freeAboveSubtotal: method.freeAboveSubtotal === undefined ? '' : String(method.freeAboveSubtotal),
                    minDays: String(method.minDays),
                    maxDays: String(method.maxDays),
                    courierName: method.courierName ?? '',
                    isActive: method.isActive,
                  });
                  setShowMethodForm(true);
                }}
              >
                <View style={styles.rowText}>
                  <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                    {method.name}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                    {method.minDays}-{method.maxDays} days • {formatPrice(method.baseFee)}
                    {method.perKgFee ? ` + ${formatPrice(method.perKgFee)}/kg` : ''}
                  </Text>
                </View>
                <Chip compact>{method.type}</Chip>
              </Pressable>
            ))}
          </View>
        </Surface>

        <Surface style={[styles.sectionCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <View style={styles.sectionTitleRow}>
            <View style={styles.sectionTitle}>
              <Icon name="store-marker-outline" size={22} color={theme.colors.tertiary} />
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                Pickup Points
              </Text>
            </View>
            <Button
              compact
              mode="contained-tonal"
              icon="plus"
              onPress={() => {
                setPickupPointForm(defaultPickupPointForm);
                setShowPickupPointForm(true);
              }}
            >
              Add
            </Button>
          </View>
          <View style={styles.list}>
            {pickupPoints.map((point) => (
              <Pressable
                key={point._id}
                style={styles.listRow}
                onPress={() => {
                  setPickupPointForm({
                    pickupPointId: point._id,
                    zoneId: point.zoneId,
                    name: point.name,
                    code: point.code,
                    street: point.address.street,
                    city: point.address.city,
                    province: point.address.province,
                    contactPhone: point.contactPhone ?? '',
                    openingHours: point.openingHours ?? '',
                    isActive: point.isActive,
                  });
                  setShowPickupPointForm(true);
                }}
              >
                <View style={styles.rowText}>
                  <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                    {point.name}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                    {point.address.city}, {point.address.province}
                  </Text>
                </View>
                <Chip compact>{point.isActive ? 'Active' : 'Inactive'}</Chip>
              </Pressable>
            ))}
          </View>
        </Surface>
      </ScrollView>
      <Portal>
        <Modal
          visible={showZoneForm}
          onDismiss={() => setShowZoneForm(false)}
          contentContainerStyle={[styles.modal, { backgroundColor: theme.colors.surface }]}
        >
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.modalContent}>
            <Text variant="titleLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
              {zoneForm.zoneId ? 'Edit Zone' : 'New Zone'}
            </Text>
            <TextInput label="Name" mode="outlined" value={zoneForm.name} onChangeText={(name) => setZoneForm((current) => ({ ...current, name, slug: current.slug || slugify(name) }))} />
            <TextInput label="Slug" mode="outlined" value={zoneForm.slug} onChangeText={(slug) => setZoneForm((current) => ({ ...current, slug }))} />
            <TextInput label="Province" mode="outlined" value={zoneForm.province} onChangeText={(province) => setZoneForm((current) => ({ ...current, province }))} />
            <TextInput label="City" mode="outlined" value={zoneForm.city} onChangeText={(city) => setZoneForm((current) => ({ ...current, city }))} />
            <TextInput label="Sort order" mode="outlined" value={zoneForm.sortOrder} keyboardType="number-pad" onChangeText={(sortOrder) => setZoneForm((current) => ({ ...current, sortOrder }))} />
            <ToggleChip active={zoneForm.isActive} label={zoneForm.isActive ? 'Active' : 'Inactive'} onPress={() => setZoneForm((current) => ({ ...current, isActive: !current.isActive }))} />
            <View style={styles.modalActions}>
              <Button onPress={() => setShowZoneForm(false)}>Cancel</Button>
              <Button mode="contained" onPress={saveZone} loading={saving}>Save</Button>
            </View>
          </ScrollView>
        </Modal>

        <Modal
          visible={showMethodForm}
          onDismiss={() => setShowMethodForm(false)}
          contentContainerStyle={[styles.modal, { backgroundColor: theme.colors.surface }]}
        >
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.modalContent}>
            <Text variant="titleLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
              {methodForm.methodId ? 'Edit Method' : 'New Method'}
            </Text>
            <TextInput label="Name" mode="outlined" value={methodForm.name} onChangeText={(name) => setMethodForm((current) => ({ ...current, name }))} />
            <TextInput label="Code" mode="outlined" value={methodForm.code} autoCapitalize="characters" onChangeText={(code) => setMethodForm((current) => ({ ...current, code }))} />
            <View style={styles.chipWrap}>
              {(['standard', 'express', 'same_day', 'pickup'] as DeliveryMethodType[]).map((type) => (
                <Chip key={type} selected={methodForm.type === type} onPress={() => setMethodForm((current) => ({ ...current, type }))}>
                  {type.replace(/_/g, ' ')}
                </Chip>
              ))}
            </View>
            <View style={styles.chipWrap}>
              <Chip selected={!methodForm.zoneId} onPress={() => setMethodForm((current) => ({ ...current, zoneId: undefined }))}>
                All zones
              </Chip>
              {zones.map((zone) => (
                <Chip key={zone._id} selected={methodForm.zoneId === zone._id} onPress={() => setMethodForm((current) => ({ ...current, zoneId: zone._id }))}>
                  {zone.name}
                </Chip>
              ))}
            </View>
            <View style={styles.formRow}>
              <TextInput label="Base fee" mode="outlined" value={methodForm.baseFee} keyboardType="decimal-pad" onChangeText={(baseFee) => setMethodForm((current) => ({ ...current, baseFee }))} style={styles.flexInput} />
              <TextInput label="Per kg" mode="outlined" value={methodForm.perKgFee} keyboardType="decimal-pad" onChangeText={(perKgFee) => setMethodForm((current) => ({ ...current, perKgFee }))} style={styles.flexInput} />
            </View>
            <View style={styles.formRow}>
              <TextInput label="Min days" mode="outlined" value={methodForm.minDays} keyboardType="number-pad" onChangeText={(minDays) => setMethodForm((current) => ({ ...current, minDays }))} style={styles.flexInput} />
              <TextInput label="Max days" mode="outlined" value={methodForm.maxDays} keyboardType="number-pad" onChangeText={(maxDays) => setMethodForm((current) => ({ ...current, maxDays }))} style={styles.flexInput} />
            </View>
            <TextInput label="Free above subtotal" mode="outlined" value={methodForm.freeAboveSubtotal} keyboardType="decimal-pad" onChangeText={(freeAboveSubtotal) => setMethodForm((current) => ({ ...current, freeAboveSubtotal }))} />
            <TextInput label="Courier" mode="outlined" value={methodForm.courierName} onChangeText={(courierName) => setMethodForm((current) => ({ ...current, courierName }))} />
            <ToggleChip active={methodForm.isActive} label={methodForm.isActive ? 'Active' : 'Inactive'} onPress={() => setMethodForm((current) => ({ ...current, isActive: !current.isActive }))} />
            <View style={styles.modalActions}>
              <Button onPress={() => setShowMethodForm(false)}>Cancel</Button>
              <Button mode="contained" onPress={saveMethod} loading={saving}>Save</Button>
            </View>
          </ScrollView>
        </Modal>

        <Modal
          visible={showPickupPointForm}
          onDismiss={() => setShowPickupPointForm(false)}
          contentContainerStyle={[styles.modal, { backgroundColor: theme.colors.surface }]}
        >
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.modalContent}>
            <Text variant="titleLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
              {pickupPointForm.pickupPointId ? 'Edit Pickup Point' : 'New Pickup Point'}
            </Text>
            <TextInput label="Name" mode="outlined" value={pickupPointForm.name} onChangeText={(name) => setPickupPointForm((current) => ({ ...current, name }))} />
            <TextInput label="Code" mode="outlined" value={pickupPointForm.code} autoCapitalize="characters" onChangeText={(code) => setPickupPointForm((current) => ({ ...current, code }))} />
            <View style={styles.chipWrap}>
              <Chip selected={!pickupPointForm.zoneId} onPress={() => setPickupPointForm((current) => ({ ...current, zoneId: undefined }))}>
                No zone
              </Chip>
              {zones.map((zone) => (
                <Chip key={zone._id} selected={pickupPointForm.zoneId === zone._id} onPress={() => setPickupPointForm((current) => ({ ...current, zoneId: zone._id }))}>
                  {zone.name}
                </Chip>
              ))}
            </View>
            <TextInput label="Street" mode="outlined" value={pickupPointForm.street} onChangeText={(street) => setPickupPointForm((current) => ({ ...current, street }))} />
            <View style={styles.formRow}>
              <TextInput label="City" mode="outlined" value={pickupPointForm.city} onChangeText={(city) => setPickupPointForm((current) => ({ ...current, city }))} style={styles.flexInput} />
              <TextInput label="Province" mode="outlined" value={pickupPointForm.province} onChangeText={(province) => setPickupPointForm((current) => ({ ...current, province }))} style={styles.flexInput} />
            </View>
            <TextInput label="Phone" mode="outlined" value={pickupPointForm.contactPhone} keyboardType="phone-pad" onChangeText={(contactPhone) => setPickupPointForm((current) => ({ ...current, contactPhone }))} />
            <TextInput label="Opening hours" mode="outlined" value={pickupPointForm.openingHours} onChangeText={(openingHours) => setPickupPointForm((current) => ({ ...current, openingHours }))} />
            <ToggleChip active={pickupPointForm.isActive} label={pickupPointForm.isActive ? 'Active' : 'Inactive'} onPress={() => setPickupPointForm((current) => ({ ...current, isActive: !current.isActive }))} />
            <View style={styles.modalActions}>
              <Button onPress={() => setShowPickupPointForm(false)}>Cancel</Button>
              <Button mode="contained" onPress={savePickupPoint} loading={saving}>Save</Button>
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
