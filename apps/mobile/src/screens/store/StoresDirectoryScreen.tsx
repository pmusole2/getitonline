import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useQuery } from 'convex/react';
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { Avatar, Chip, Searchbar, Surface, Text, useTheme } from 'react-native-paper';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { StackHeader } from '../../components/ui/Header';
import type {
  RootStackParamList,
  StorefrontDirectoryItem,
} from '../../types';

type Props = NativeStackScreenProps<RootStackParamList, 'StoresDirectory'>;

function StorefrontCard({
  store,
  onPress,
}: {
  store: StorefrontDirectoryItem;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <Pressable onPress={onPress}>
      <Surface style={[styles.storeCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
        <View style={styles.storeHeader}>
          {store.logoUrl ? (
            <Avatar.Image size={56} source={{ uri: store.logoUrl }} />
          ) : (
            <Avatar.Text
              size={56}
              label={store.displayName.slice(0, 2).toUpperCase()}
              style={{ backgroundColor: theme.colors.primaryContainer }}
              color={theme.colors.primary}
            />
          )}

          <View style={styles.storeHeaderText}>
            <View style={styles.storeTitleRow}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, flex: 1 }}>
                {store.displayName}
              </Text>
              <Chip compact>{store.isCompanyStore ? 'Official Store' : 'Approved Vendor'}</Chip>
            </View>

            <Text
              variant="bodySmall"
              numberOfLines={2}
              style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}
            >
              {store.description}
            </Text>
          </View>
        </View>

        <View style={styles.metaRow}>
          <View style={styles.metaItem}>
            <Icon
              name={store.isCompanyStore ? 'storefront-outline' : 'check-decagram'}
              size={16}
              color={theme.colors.onSurfaceVariant}
            />
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {store.isCompanyStore ? 'Official store' : 'Approved vendor'}
            </Text>
          </View>
          <View style={styles.metaItem}>
            <Icon name="star-outline" size={16} color={theme.colors.onSurfaceVariant} />
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {store.rating ? store.rating.toFixed(1) : 'New'} rating
            </Text>
          </View>
          <View style={styles.metaItem}>
            <Icon name="shopping-outline" size={16} color={theme.colors.onSurfaceVariant} />
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {store.totalSales} sales
            </Text>
          </View>
        </View>
      </Surface>
    </Pressable>
  );
}

export default function StoresDirectoryScreen({ navigation }: Props) {
  const theme = useTheme();
  const stores = useQuery(api.vendors.listPublicStorefronts);
  const [searchQuery, setSearchQuery] = useState('');

  const filteredStores = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!stores) {
      return [];
    }

    if (!query) {
      return stores;
    }

    return stores.filter((store) =>
      [
        store.displayName,
        store.description,
      ].some((value) => value.toLowerCase().includes(query))
    );
  }, [searchQuery, stores]);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader
        title="Stores"
        subtitle="Official and approved storefronts"
        onBackPress={() => navigation.goBack()}
        variant="gradient"
      />

      <View style={styles.searchContainer}>
        <Searchbar
          placeholder="Search stores by name..."
          value={searchQuery}
          onChangeText={setSearchQuery}
          style={[styles.searchBar, { backgroundColor: theme.colors.surfaceVariant }]}
        />
      </View>

      {stores === undefined ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : filteredStores.length === 0 ? (
        <View style={styles.centered}>
          <Icon name="store-search-outline" size={48} color={theme.colors.primary} />
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 16 }}>
            No stores found
          </Text>
          <Text
            variant="bodyMedium"
            style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, textAlign: 'center' }}
          >
            {searchQuery.trim()
              ? 'Try a different store name.'
              : 'Public storefronts will appear here as soon as they are available.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filteredStores}
          keyExtractor={(item) => item.sellerId}
          renderItem={({ item }) => (
            <StorefrontCard
              store={item}
              onPress={() => navigation.navigate('SellerProfile', { sellerId: item.sellerId })}
            />
          )}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 12 }}>
              {filteredStores.length} storefront{filteredStores.length === 1 ? '' : 's'}
            </Text>
          }
        />
      )}
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
  searchContainer: {
    padding: 16,
    paddingBottom: 8,
  },
  searchBar: {
    borderRadius: 16,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 120,
  },
  storeCard: {
    borderRadius: 18,
    padding: 16,
    marginBottom: 12,
  },
  storeHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  storeHeaderText: {
    flex: 1,
    gap: 4,
  },
  storeTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  metaRow: {
    marginTop: 16,
    gap: 8,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
});
