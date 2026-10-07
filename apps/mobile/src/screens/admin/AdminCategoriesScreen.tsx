import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery } from 'convex/react';
import React, { useEffect, useMemo, useState } from 'react';
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
  Dialog,
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
import { useImageUpload } from '../../hooks/useImageUpload';
import type { Category, Id, RootStackParamList } from '../../types';
import { didCategoryParentChange } from './categoryHierarchyPolicy';

type Props = NativeStackScreenProps<RootStackParamList, 'AdminCategories'>;
type CategoryFilter = 'all' | 'parents' | 'subcategories' | 'inactive';

type CategoryFormState = {
  name: string;
  slug: string;
  description: string;
  image: string;
  sortOrder: string;
  parentId: Id<'categories'> | null;
  isActive: boolean;
};

const emptyForm: CategoryFormState = {
  name: '',
  slug: '',
  description: '',
  image: '',
  sortOrder: '0',
  parentId: null,
  isActive: true,
};

function toSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatRelationship(category: Category, parentName?: string) {
  if (!category.parentId) {
    return 'Top-level category';
  }

  return parentName ? `Subcategory of ${parentName}` : 'Subcategory';
}

function normalizeOptionalImageUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const parsed = new URL(withProtocol);

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Image URL must start with http:// or https://.');
  }

  return parsed.toString();
}

function safeImageUrl(value: string) {
  try {
    return normalizeOptionalImageUrl(value);
  } catch {
    return value.trim();
  }
}

export default function AdminCategoriesScreen({ navigation }: Props) {
  const theme = useTheme();
  const { user } = useAppAuth();
  const isAdmin = user?.role === 'admin';

  const categories = useQuery(
    api.categories.getAllCategories,
    user?._id && isAdmin ? { adminId: user._id } : 'skip'
  );

  const createCategory = useMutation(api.categories.createCategory);
  const updateCategory = useMutation(api.categories.updateCategory);
  const deleteCategory = useMutation(api.categories.deleteCategory);
  const seedCategories = useMutation(api.categories.seedCategories);
  const categoryUpload = useImageUpload();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFilter, setSelectedFilter] = useState<CategoryFilter>('all');
  const [dialogVisible, setDialogVisible] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [form, setForm] = useState<CategoryFormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deletingCategoryId, setDeletingCategoryId] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);

  const categoryMap = useMemo(() => {
    const entries: Array<[Id<'categories'>, Category]> = (categories ?? []).map((category) => [
      category._id,
      category,
    ]);
    return new Map<Id<'categories'>, Category>(entries);
  }, [categories]);

  const childCountMap = useMemo(() => {
    const counts = new Map<Id<'categories'>, number>();

    for (const category of categories ?? []) {
      if (!category.parentId) {
        continue;
      }

      counts.set(category.parentId, (counts.get(category.parentId) ?? 0) + 1);
    }

    return counts;
  }, [categories]);

  const parentCategories = useMemo(
    () =>
      (categories ?? [])
        .filter((category) => !category.parentId && category._id !== selectedCategory?._id)
        .sort((left, right) => left.name.localeCompare(right.name)),
    [categories, selectedCategory]
  );

  const filteredCategories = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    return [...(categories ?? [])]
      .sort((left, right) => {
        if (left.parentId === right.parentId) {
          if (left.sortOrder === right.sortOrder) {
            return left.name.localeCompare(right.name);
          }

          return left.sortOrder - right.sortOrder;
        }

        if (!left.parentId) {
          return -1;
        }

        if (!right.parentId) {
          return 1;
        }

        return left.name.localeCompare(right.name);
      })
      .filter((category) => {
        if (selectedFilter === 'parents' && category.parentId) {
          return false;
        }

        if (selectedFilter === 'subcategories' && !category.parentId) {
          return false;
        }

        if (selectedFilter === 'inactive' && category.isActive) {
          return false;
        }

        if (!normalizedQuery) {
          return selectedFilter !== 'inactive' || !category.isActive;
        }

        return [
          category.name,
          category.slug,
          category.description ?? '',
          category.image ?? '',
          category.parentId ? categoryMap.get(category.parentId)?.name ?? '' : '',
        ].some((value) => value.toLowerCase().includes(normalizedQuery));
      });
  }, [categories, categoryMap, searchQuery, selectedFilter]);

  useEffect(() => {
    if (!dialogVisible) {
      return;
    }

    if (!selectedCategory) {
      return;
    }

    setForm({
      name: selectedCategory.name,
      slug: selectedCategory.slug,
      description: selectedCategory.description ?? '',
      image: selectedCategory.image ?? '',
      sortOrder: String(selectedCategory.sortOrder),
      parentId: selectedCategory.parentId ?? null,
      isActive: selectedCategory.isActive,
    });
  }, [dialogVisible, selectedCategory]);

  useEffect(() => {
    const uploadedCategoryImage = categoryUpload.images[categoryUpload.images.length - 1]?.url;
    if (uploadedCategoryImage) {
      setForm((current) => ({ ...current, image: uploadedCategoryImage }));
    }
  }, [categoryUpload.images]);

  const openCreateDialog = () => {
    setSelectedCategory(null);
    setForm(emptyForm);
    categoryUpload.clearImages();
    setDialogVisible(true);
  };

  const openEditDialog = (category: Category) => {
    setSelectedCategory(category);
    categoryUpload.clearImages();
    setDialogVisible(true);
  };

  const closeDialog = () => {
    if (saving) {
      return;
    }

    setDialogVisible(false);
    setSelectedCategory(null);
    setForm(emptyForm);
    categoryUpload.clearImages();
  };

  const handleNameChange = (value: string) => {
    setForm((current) => {
      const nextName = value;
      const shouldRefreshSlug =
        !current.slug || current.slug === toSlug(current.name);

      return {
        ...current,
        name: nextName,
        slug: shouldRefreshSlug ? toSlug(nextName) : current.slug,
      };
    });
  };

  const handleSave = async () => {
    if (!user || user.role !== 'admin') {
      return;
    }

    const trimmedName = form.name.trim();
    const trimmedSlug = form.slug.trim();
    const trimmedDescription = form.description.trim();
    const parsedSortOrder = Number.parseInt(form.sortOrder.trim(), 10);
    let normalizedImage = '';

    if (!trimmedName || !trimmedSlug) {
      Alert.alert('Missing fields', 'Name and slug are required.');
      return;
    }

    try {
      normalizedImage = normalizeOptionalImageUrl(form.image);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Enter a valid category image URL.';
      Alert.alert('Invalid image URL', message);
      return;
    }

    if (!Number.isFinite(parsedSortOrder)) {
      Alert.alert('Invalid sort order', 'Sort order must be a whole number.');
      return;
    }

    const hasChildren = selectedCategory ? (childCountMap.get(selectedCategory._id) ?? 0) > 0 : false;
    if (
      hasChildren
      && didCategoryParentChange(selectedCategory?.parentId, form.parentId)
    ) {
      Alert.alert(
        'Hierarchy locked',
        'This category has subcategories. Move or edit its children first before changing its parent.'
      );
      return;
    }

    setSaving(true);

    try {
      if (selectedCategory) {
        await updateCategory({
          adminId: user._id,
          categoryId: selectedCategory._id,
          name: trimmedName,
          slug: trimmedSlug,
          description: trimmedDescription || undefined,
          image: normalizedImage,
          parentId: form.parentId ?? undefined,
          isActive: form.isActive,
          sortOrder: parsedSortOrder,
        });
      } else {
        await createCategory({
          adminId: user._id,
          name: trimmedName,
          slug: trimmedSlug,
          description: trimmedDescription || undefined,
          image: normalizedImage || undefined,
          parentId: form.parentId ?? undefined,
          sortOrder: parsedSortOrder,
        });
      }

      closeDialog();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to save category';
      Alert.alert('Error', message);
    } finally {
      setSaving(false);
    }
  };

  const pickCategoryImage = async () => {
    categoryUpload.clearImages();
    await categoryUpload.pickImages(1, {
      allowedMimeTypes: ['image/jpeg', 'image/png'],
      maxSizeBytes: 5 * 1024 * 1024,
    });
  };

  const handleDelete = (category: Category) => {
    if (!user || user.role !== 'admin') {
      return;
    }

    Alert.alert(
      'Delete category',
      `Delete ${category.name}? This only works if the category has no subcategories or products.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeletingCategoryId(category._id);

            try {
              await deleteCategory({
                adminId: user._id,
                categoryId: category._id,
              });
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : 'Failed to delete category';
              Alert.alert('Error', message);
            } finally {
              setDeletingCategoryId(null);
            }
          },
        },
      ]
    );
  };

  const handleSeedDefaults = async () => {
    if (!user || user.role !== 'admin') {
      return;
    }

    setSeeding(true);

    try {
      await seedCategories({ adminId: user._id });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to seed categories';
      Alert.alert('Error', message);
    } finally {
      setSeeding(false);
    }
  };

  if (!user) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Category Management"
          subtitle="Catalog structure"
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
          title="Category Management"
          subtitle="Catalog structure"
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
            Only Super Admins can create or edit marketplace categories.
          </Text>
        </View>
      </View>
    );
  }

  if (categories === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="Category Management"
          subtitle="Catalog structure"
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
        title="Category Management"
        subtitle="Catalog structure"
        onBackPress={() => navigation.goBack()}
        variant="gradient"
      />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <Surface style={[styles.heroCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <View style={styles.heroHeader}>
            <View style={styles.heroText}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                Shape the catalog from mobile
              </Text>
              <Text
                variant="bodySmall"
                style={{ color: theme.colors.onSurfaceVariant, marginTop: 6, lineHeight: 20 }}
              >
                Create parent categories, add subcategories, deactivate outdated sections, and
                keep storefront browsing structured for sellers and buyers.
              </Text>
            </View>
            <View style={[styles.heroIcon, { backgroundColor: theme.colors.primaryContainer }]}>
              <Icon name="shape-outline" size={24} color={theme.colors.primary} />
            </View>
          </View>

          <View style={styles.heroActions}>
            <Button mode="contained" onPress={openCreateDialog}>
              Add Category
            </Button>
            {categories.length === 0 ? (
              <Button mode="outlined" onPress={() => void handleSeedDefaults()} loading={seeding}>
                Seed Defaults
              </Button>
            ) : null}
          </View>
        </Surface>

        <Searchbar
          placeholder="Search categories by name or slug"
          value={searchQuery}
          onChangeText={setSearchQuery}
          style={[styles.searchbar, { backgroundColor: theme.colors.surface }]}
        />

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          <Chip selected={selectedFilter === 'all'} onPress={() => setSelectedFilter('all')}>
            All
          </Chip>
          <Chip selected={selectedFilter === 'parents'} onPress={() => setSelectedFilter('parents')}>
            Parents
          </Chip>
          <Chip
            selected={selectedFilter === 'subcategories'}
            onPress={() => setSelectedFilter('subcategories')}
          >
            Subcategories
          </Chip>
          <Chip selected={selectedFilter === 'inactive'} onPress={() => setSelectedFilter('inactive')}>
            Inactive
          </Chip>
        </ScrollView>

        <View style={styles.resultsHeader}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            Categories
          </Text>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {filteredCategories.length} visible
          </Text>
        </View>

        {filteredCategories.length === 0 ? (
          <Surface style={[styles.emptyCard, { backgroundColor: theme.colors.surface }]} elevation={0}>
            <Icon name="shape-outline" size={42} color={theme.colors.primary} />
            <Text variant="titleSmall" style={{ color: theme.colors.onSurface, marginTop: 12 }}>
              No categories match
            </Text>
            <Text
              variant="bodySmall"
              style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, textAlign: 'center' }}
            >
              Adjust the search or filter, or create a new category from mobile.
            </Text>
          </Surface>
        ) : (
          <View style={styles.list}>
            {filteredCategories.map((category) => {
              const parentName = category.parentId
                ? categoryMap.get(category.parentId)?.name
                : undefined;
              const hasChildren = (childCountMap.get(category._id) ?? 0) > 0;
              const isDeleting = deletingCategoryId === category._id;

              return (
                <Surface
                  key={category._id}
                  style={[styles.categoryCard, { backgroundColor: theme.colors.surface }]}
                  elevation={0}
                >
                  <View style={styles.categoryHeader}>
                    <View style={styles.categoryIdentity}>
                      {category.image ? (
                        <Image
                          source={{ uri: safeImageUrl(category.image) }}
                          style={styles.categoryThumbnail}
                          resizeMode="cover"
                        />
                      ) : (
                        <View style={[styles.categoryIcon, { backgroundColor: theme.colors.primaryContainer }]}>
                          <Icon
                            name={category.parentId ? 'shape-plus' : 'shape-outline'}
                            size={20}
                            color={theme.colors.primary}
                          />
                        </View>
                      )}
                      <View style={{ flex: 1 }}>
                        <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                          {category.name}
                        </Text>
                        <Text
                          variant="bodySmall"
                          style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}
                        >
                          {formatRelationship(category, parentName)}
                        </Text>
                      </View>
                    </View>
                  </View>

                  <View style={styles.chipRow}>
                    <Chip compact>{category.slug}</Chip>
                    <Chip
                      compact
                      style={{
                        backgroundColor: category.isActive
                          ? theme.colors.secondaryContainer
                          : theme.colors.errorContainer,
                      }}
                      textStyle={{
                        color: category.isActive
                          ? theme.colors.onSecondaryContainer
                          : theme.colors.onErrorContainer,
                      }}
                    >
                      {category.isActive ? 'Active' : 'Inactive'}
                    </Chip>
                    <Chip compact>Sort {category.sortOrder}</Chip>
                    {hasChildren ? <Chip compact>{childCountMap.get(category._id)} children</Chip> : null}
                  </View>

                  {category.description ? (
                    <Text
                      variant="bodySmall"
                      style={{ color: theme.colors.onSurfaceVariant, marginTop: 12 }}
                    >
                      {category.description}
                    </Text>
                  ) : null}

                  <View style={styles.actionsRow}>
                    <Button mode="outlined" onPress={() => openEditDialog(category)} style={styles.actionButton}>
                      Edit
                    </Button>
                    <Button
                      mode="contained-tonal"
                      onPress={() => handleDelete(category)}
                      loading={isDeleting}
                      disabled={isDeleting}
                      style={styles.actionButton}
                    >
                      Delete
                    </Button>
                  </View>
                </Surface>
              );
            })}
          </View>
        )}
      </ScrollView>

      <Portal>
        <Dialog visible={dialogVisible} onDismiss={closeDialog}>
          <Dialog.Title>{selectedCategory ? 'Edit Category' : 'Create Category'}</Dialog.Title>
          <Dialog.ScrollArea style={styles.dialogScrollArea}>
            <ScrollView contentContainerStyle={styles.dialogContent}>
              <TextInput
                mode="outlined"
                label="Name"
                value={form.name}
                onChangeText={handleNameChange}
              />
              <TextInput
                mode="outlined"
                label="Slug"
                value={form.slug}
                onChangeText={(value) => setForm((current) => ({ ...current, slug: toSlug(value) }))}
                style={styles.dialogInput}
              />
              <TextInput
                mode="outlined"
                label="Description"
                value={form.description}
                onChangeText={(value) => setForm((current) => ({ ...current, description: value }))}
                multiline
                numberOfLines={3}
                style={styles.dialogInput}
              />
              <TextInput
                mode="outlined"
                label="Image URL"
                value={form.image}
                onChangeText={(value) => setForm((current) => ({ ...current, image: value }))}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                style={styles.dialogInput}
              />
              <View style={styles.imageActions}>
                <Button
                  mode="outlined"
                  icon="image-plus"
                  onPress={() => void pickCategoryImage()}
                  loading={categoryUpload.isUploading}
                  disabled={categoryUpload.isUploading}
                >
                  Upload Image
                </Button>
                {form.image.trim() ? (
                  <Button
                    mode="text"
                    onPress={() => setForm((current) => ({ ...current, image: '' }))}
                    disabled={categoryUpload.isUploading}
                  >
                    Remove
                  </Button>
                ) : null}
              </View>
              {categoryUpload.validationErrors.map((message) => (
                <Text key={message} variant="bodySmall" style={{ color: theme.colors.error }}>
                  {message}
                </Text>
              ))}
              {form.image.trim() ? (
                <Image
                  source={{ uri: safeImageUrl(form.image) }}
                  style={styles.categoryImagePreview}
                  resizeMode="cover"
                />
              ) : null}
              <TextInput
                mode="outlined"
                label="Sort Order"
                value={form.sortOrder}
                onChangeText={(value) => setForm((current) => ({ ...current, sortOrder: value }))}
                keyboardType="number-pad"
                style={styles.dialogInput}
              />

              <View style={styles.dialogSection}>
                <Text variant="labelLarge" style={{ color: theme.colors.onSurface }}>
                  Parent Category
                </Text>
                <View style={styles.parentChips}>
                  <Chip
                    selected={form.parentId === null}
                    onPress={() => setForm((current) => ({ ...current, parentId: null }))}
                  >
                    None
                  </Chip>
                  {parentCategories.map((category) => (
                    <Chip
                      key={category._id}
                      selected={form.parentId === category._id}
                      onPress={() => setForm((current) => ({ ...current, parentId: category._id }))}
                    >
                      {category.name}
                    </Chip>
                  ))}
                </View>
              </View>

              {selectedCategory ? (
                <View style={styles.dialogSection}>
                  <Text variant="labelLarge" style={{ color: theme.colors.onSurface }}>
                    Status
                  </Text>
                  <View style={styles.parentChips}>
                    <Chip
                      selected={form.isActive}
                      onPress={() => setForm((current) => ({ ...current, isActive: true }))}
                    >
                      Active
                    </Chip>
                    <Chip
                      selected={!form.isActive}
                      onPress={() => setForm((current) => ({ ...current, isActive: false }))}
                    >
                      Inactive
                    </Chip>
                  </View>
                </View>
              ) : null}
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button onPress={closeDialog} disabled={saving}>
              Cancel
            </Button>
            <Button onPress={() => void handleSave()} loading={saving} disabled={saving}>
              Save
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
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
  heroCard: {
    borderRadius: 20,
    padding: 18,
  },
  heroHeader: {
    flexDirection: 'row',
    gap: 16,
  },
  heroText: {
    flex: 1,
  },
  heroIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  heroActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 18,
  },
  searchbar: {
    marginTop: 16,
    borderRadius: 16,
  },
  filterRow: {
    paddingTop: 16,
    gap: 10,
  },
  resultsHeader: {
    marginTop: 20,
    marginBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  emptyCard: {
    borderRadius: 18,
    padding: 24,
    alignItems: 'center',
  },
  list: {
    gap: 12,
  },
  categoryCard: {
    borderRadius: 18,
    padding: 16,
  },
  categoryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  categoryIdentity: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  categoryIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  categoryThumbnail: {
    width: 42,
    height: 42,
    borderRadius: 14,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
  },
  actionButton: {
    flex: 1,
  },
  dialogScrollArea: {
    maxHeight: 420,
    paddingHorizontal: 0,
  },
  dialogContent: {
    paddingHorizontal: 24,
    paddingBottom: 8,
  },
  dialogInput: {
    marginTop: 14,
  },
  imageActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 12,
  },
  categoryImagePreview: {
    width: '100%',
    height: 120,
    borderRadius: 14,
    marginTop: 12,
  },
  dialogSection: {
    marginTop: 18,
  },
  parentChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 10,
  },
});
