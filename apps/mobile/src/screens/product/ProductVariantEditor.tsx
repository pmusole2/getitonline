import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import {
  Button,
  Chip,
  Surface,
  Text,
  TextInput,
  useTheme,
} from 'react-native-paper';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import {
  addVariantAttributeValue,
  getCombinationKey,
  removeVariantAttributeValue,
  type VariantAttribute,
  type VariantCombination,
  type VariantCombinationPatch,
  type VariantStatus,
  type VariantValidationIssue,
} from './productVariantDomain';

export interface ProductVariantEditorProps {
  attributes: VariantAttribute[];
  combinations: VariantCombination[];
  combinationPatches: Record<string, VariantCombinationPatch>;
  colorMedia: Record<string, string[]>;
  combinationMedia: Record<string, string[]>;
  productImages: string[];
  validationIssues: VariantValidationIssue[];
  onAttributesChange: (attributes: VariantAttribute[]) => void;
  onCombinationPatchChange: (
    combinationKey: string,
    patch: VariantCombinationPatch
  ) => void;
  onColorMediaChange: (colorKey: string, images: string[]) => void;
  onCombinationMediaChange: (
    combinationKey: string,
    images: string[]
  ) => void;
}

const normalizeToken = (value: string): string =>
  value.trim().toLocaleLowerCase();

const toggleMedia = (
  selectedImages: readonly string[],
  image: string
): string[] =>
  selectedImages.includes(image)
    ? selectedImages.filter((selectedImage) => selectedImage !== image)
    : [...selectedImages, image];

interface MediaPickerProps {
  label: string;
  images: string[];
  selectedImages: string[];
  onChange: (images: string[]) => void;
}

function MediaPicker({
  label,
  images,
  selectedImages,
  onChange,
}: MediaPickerProps) {
  const theme = useTheme();

  return (
    <View style={styles.mediaSection}>
      <Text variant="labelMedium" style={{ color: theme.colors.onSurface }}>
        {label}
      </Text>
      {images.length === 0 ? (
        <Text
          variant="bodySmall"
          style={{ color: theme.colors.onSurfaceVariant }}
        >
          Upload product images first, then assign them here.
        </Text>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.mediaRow}
        >
          {images.map((image) => {
            const selectedIndex = selectedImages.indexOf(image);
            const selected = selectedIndex >= 0;

            return (
              <Pressable
                key={image}
                accessibilityRole="button"
                accessibilityLabel={`${selected ? 'Remove' : 'Assign'} image`}
                onPress={() =>
                  onChange(toggleMedia(selectedImages, image))
                }
                style={[
                  styles.mediaTile,
                  {
                    borderColor: selected
                      ? theme.colors.primary
                      : theme.colors.outlineVariant,
                  },
                ]}
              >
                <Image source={{ uri: image }} style={styles.mediaImage} />
                {selected ? (
                  <View
                    style={[
                      styles.mediaBadge,
                      { backgroundColor: theme.colors.primary },
                    ]}
                  >
                    <Text
                      variant="labelSmall"
                      style={{ color: theme.colors.onPrimary }}
                    >
                      {selectedIndex === 0
                        ? 'Primary'
                        : selectedIndex + 1}
                    </Text>
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

interface CombinationFieldsProps {
  combination: VariantCombination;
  combinationKey: string;
  issues: VariantValidationIssue[];
  onPatchChange: (patch: VariantCombinationPatch) => void;
}

function CombinationFields({
  combination,
  combinationKey,
  issues,
  onPatchChange,
}: CombinationFieldsProps) {
  const theme = useTheme();
  const [skuDraft, setSkuDraft] = useState(combination.sku);
  const [priceDraft, setPriceDraft] = useState(String(combination.price));
  const [stockDraft, setStockDraft] = useState(String(combination.stock));
  const editingFields = useRef(new Set<'sku' | 'price' | 'stock'>());

  useEffect(() => {
    if (!editingFields.current.has('sku')) {
      setSkuDraft(combination.sku);
    }
    if (!editingFields.current.has('price')) {
      setPriceDraft(String(combination.price));
    }
    if (!editingFields.current.has('stock')) {
      setStockDraft(String(combination.stock));
    }
  }, [
    combination.id,
    combination.price,
    combination.sku,
    combination.stock,
  ]);

  const updatePrice = (value: string) => {
    setPriceDraft(value);
    const price = Number.parseFloat(value);
    onPatchChange({ price: Number.isFinite(price) ? price : 0 });
  };
  const updateStock = (value: string) => {
    setStockDraft(value);
    const stock = Number.parseInt(value, 10);
    onPatchChange({ stock: Number.isFinite(stock) ? stock : -1 });
  };

  return (
    <>
      <View style={styles.inputRow}>
        <TextInput
          mode="outlined"
          label="SKU"
          value={skuDraft}
          onFocus={() => editingFields.current.add('sku')}
          onChangeText={(value) => {
            setSkuDraft(value);
            onPatchChange({ sku: value.trim() });
          }}
          onBlur={() => editingFields.current.delete('sku')}
          autoCapitalize="characters"
          style={styles.skuInput}
        />
        <TextInput
          mode="outlined"
          label="Price"
          value={priceDraft}
          onFocus={() => editingFields.current.add('price')}
          onChangeText={updatePrice}
          onBlur={() => editingFields.current.delete('price')}
          keyboardType="decimal-pad"
          style={styles.numericInput}
        />
        <TextInput
          mode="outlined"
          label="Stock"
          value={stockDraft}
          onFocus={() => editingFields.current.add('stock')}
          onChangeText={updateStock}
          onBlur={() => editingFields.current.delete('stock')}
          keyboardType="number-pad"
          style={styles.numericInput}
        />
      </View>
      <View style={styles.chipWrap}>
        {(['active', 'inactive', 'out_of_stock'] as VariantStatus[]).map(
          (status) => (
            <Chip
              key={`${combinationKey}-${status}`}
              compact
              selected={combination.status === status}
              onPress={() => onPatchChange({ status })}
            >
              {status.replaceAll('_', ' ')}
            </Chip>
          )
        )}
      </View>
      {issues.map((issue) => (
        <Text
          key={`${issue.field}-${issue.message}`}
          variant="bodySmall"
          style={{ color: theme.colors.error }}
        >
          {issue.message}
        </Text>
      ))}
    </>
  );
}

export function ProductVariantEditor({
  attributes,
  combinations,
  combinationPatches,
  colorMedia,
  combinationMedia,
  productImages,
  validationIssues,
  onAttributesChange,
  onCombinationPatchChange,
  onColorMediaChange,
  onCombinationMediaChange,
}: ProductVariantEditorProps) {
  const theme = useTheme();
  const [valueDrafts, setValueDrafts] = useState<Record<string, string>>(
    {}
  );
  const [customAttributeName, setCustomAttributeName] = useState('');
  const [customAttributeValue, setCustomAttributeValue] = useState('');
  const [localIssue, setLocalIssue] = useState<string | null>(null);

  const attributeCards = useMemo(() => {
    const names = new Set(attributes.map(({ name }) => normalizeToken(name)));
    return [
      ...attributes,
      ...(['Color', 'Size'] as const)
        .filter((name) => !names.has(normalizeToken(name)))
        .map((name) => ({ name, values: [] })),
    ];
  }, [attributes]);

  const colorValues =
    attributes.find(({ name }) => normalizeToken(name) === 'color')
      ?.values ?? [];
  const globalIssues = validationIssues.filter(
    (issue) => issue.combinationKey === undefined
  );

  const addValue = (attributeName: string, value: string) => {
    const result = addVariantAttributeValue({
      attributes,
      attributeName,
      value,
    });
    if (result.issue) {
      setLocalIssue(result.issue.message);
      return;
    }

    setLocalIssue(null);
    onAttributesChange(result.attributes);
    setValueDrafts((current) => ({
      ...current,
      [normalizeToken(attributeName)]: '',
    }));
  };

  const addCustomAttribute = () => {
    const result = addVariantAttributeValue({
      attributes,
      attributeName: customAttributeName,
      value: customAttributeValue,
    });
    if (result.issue) {
      setLocalIssue(result.issue.message);
      return;
    }

    setLocalIssue(null);
    onAttributesChange(result.attributes);
    setCustomAttributeName('');
    setCustomAttributeValue('');
  };

  return (
    <View style={styles.container}>
      <View>
        <Text
          variant="titleSmall"
          style={{ color: theme.colors.onSurface, fontWeight: '700' }}
        >
          Product options
        </Text>
        <Text
          variant="bodySmall"
          style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}
        >
          Add colors and sizes. Each generated combination can have its own
          SKU, price, stock, status, and optional media override.
        </Text>
      </View>

      {attributeCards.map((attribute) => {
        const attributeKey = normalizeToken(attribute.name);
        return (
          <Surface
            key={attributeKey}
            elevation={0}
            style={[
              styles.attributeCard,
              { backgroundColor: theme.colors.surfaceVariant },
            ]}
          >
            <Text
              variant="labelLarge"
              style={{ color: theme.colors.onSurface }}
            >
              {attribute.name}
            </Text>
            <View style={styles.chipWrap}>
              {attribute.values.map((value) => (
                <Chip
                  key={`${attributeKey}-${normalizeToken(value)}`}
                  compact
                  onClose={() =>
                    onAttributesChange(
                      removeVariantAttributeValue({
                        attributes,
                        attributeName: attribute.name,
                        value,
                      })
                    )
                  }
                >
                  {value}
                </Chip>
              ))}
            </View>
            <View style={styles.addValueRow}>
              <TextInput
                mode="outlined"
                dense
                label={`Add ${attribute.name.toLowerCase()}`}
                value={valueDrafts[attributeKey] ?? ''}
                onChangeText={(value) =>
                  setValueDrafts((current) => ({
                    ...current,
                    [attributeKey]: value,
                  }))
                }
                onSubmitEditing={() =>
                  addValue(
                    attribute.name,
                    valueDrafts[attributeKey] ?? ''
                  )
                }
                style={styles.valueInput}
              />
              <Button
                mode="contained-tonal"
                compact
                onPress={() =>
                  addValue(
                    attribute.name,
                    valueDrafts[attributeKey] ?? ''
                  )
                }
              >
                Add
              </Button>
            </View>
          </Surface>
        );
      })}

      <Surface
        elevation={0}
        style={[
          styles.attributeCard,
          { backgroundColor: theme.colors.surfaceVariant },
        ]}
      >
        <Text variant="labelLarge">Custom option</Text>
        <View style={styles.inputRow}>
          <TextInput
            mode="outlined"
            dense
            label="Name"
            value={customAttributeName}
            onChangeText={setCustomAttributeName}
            style={styles.valueInput}
          />
          <TextInput
            mode="outlined"
            dense
            label="First value"
            value={customAttributeValue}
            onChangeText={setCustomAttributeValue}
            style={styles.valueInput}
          />
        </View>
        <Button mode="contained-tonal" onPress={addCustomAttribute}>
          Add custom option
        </Button>
      </Surface>

      {localIssue ? (
        <Text variant="bodySmall" style={{ color: theme.colors.error }}>
          {localIssue}
        </Text>
      ) : null}
      {globalIssues.map((issue) => (
        <Text
          key={`${issue.field}-${issue.message}`}
          variant="bodySmall"
          style={{ color: theme.colors.error }}
        >
          {issue.message}
        </Text>
      ))}

      {colorValues.map((color) => {
        const colorKey = normalizeToken(color);
        return (
          <MediaPicker
            key={colorKey}
            label={`${color} media (shared across sizes)`}
            images={productImages}
            selectedImages={colorMedia[colorKey] ?? []}
            onChange={(images) => onColorMediaChange(colorKey, images)}
          />
        );
      })}

      {combinations.length > 0 ? (
        <View style={styles.combinationsHeader}>
          <Text
            variant="titleSmall"
            style={{ color: theme.colors.onSurface, fontWeight: '700' }}
          >
            {combinations.length} combinations
          </Text>
          <Text
            variant="bodySmall"
            style={{ color: theme.colors.onSurfaceVariant }}
          >
            Defaults come from the main price and stock fields.
          </Text>
        </View>
      ) : null}

      {combinations.map((combination) => {
        const combinationKey = getCombinationKey(combination.attributes);
        const labels = combination.attributes
          .map(({ name, value }) => `${name}: ${value}`)
          .join(' · ');
        const combinationIssues = validationIssues.filter(
          (issue) => issue.combinationKey === combinationKey
        );
        const overrideImages = combinationMedia[combinationKey] ?? [];
        const colorValue = combination.attributes.find(
          ({ name }) => normalizeToken(name) === 'color'
        )?.value;
        const inheritedImages = colorValue
          ? colorMedia[normalizeToken(colorValue)] ?? []
          : [];

        return (
          <Surface
            key={combinationKey}
            elevation={0}
            style={[
              styles.combinationCard,
              { borderColor: theme.colors.outlineVariant },
            ]}
          >
            <View style={styles.combinationTitleRow}>
              <View style={styles.combinationTitle}>
                <Text
                  variant="labelLarge"
                  style={{ color: theme.colors.onSurface }}
                >
                  {labels}
                </Text>
                <Text
                  variant="bodySmall"
                  style={{ color: theme.colors.onSurfaceVariant }}
                >
                  {overrideImages.length > 0
                    ? 'Uses combination media override'
                    : inheritedImages.length > 0
                      ? `Inherits ${colorValue} media`
                      : 'Uses the product gallery'}
                </Text>
              </View>
              {overrideImages.length > 0 ? (
                <Button
                  compact
                  onPress={() =>
                    onCombinationMediaChange(combinationKey, [])
                  }
                >
                  Use color media
                </Button>
              ) : null}
            </View>
            <CombinationFields
              combination={combination}
              combinationKey={combinationKey}
              issues={combinationIssues}
              onPatchChange={(patch) =>
                onCombinationPatchChange(combinationKey, {
                  ...(combinationPatches[combinationKey] ?? {}),
                  ...patch,
                })
              }
            />
            <MediaPicker
              label="Combination media override (optional)"
              images={productImages}
              selectedImages={overrideImages}
              onChange={(images) =>
                onCombinationMediaChange(combinationKey, images)
              }
            />
          </Surface>
        );
      })}

      {combinations.length > 100 ? (
        <View style={styles.limitWarning}>
          <Icon name="alert-circle-outline" size={18} color={theme.colors.error} />
          <Text variant="bodySmall" style={{ color: theme.colors.error }}>
            Reduce option values to 100 combinations or fewer.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 14,
  },
  attributeCard: {
    borderRadius: 14,
    padding: 12,
    gap: 10,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  addValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  valueInput: {
    flex: 1,
  },
  mediaSection: {
    gap: 8,
  },
  mediaRow: {
    gap: 8,
  },
  mediaTile: {
    width: 88,
    height: 88,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 2,
  },
  mediaImage: {
    width: '100%',
    height: '100%',
  },
  mediaBadge: {
    position: 'absolute',
    left: 4,
    bottom: 4,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  combinationsHeader: {
    gap: 2,
    marginTop: 4,
  },
  combinationCard: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    gap: 10,
  },
  combinationTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  combinationTitle: {
    flex: 1,
    gap: 2,
  },
  skuInput: {
    flex: 1.5,
  },
  numericInput: {
    flex: 1,
  },
  limitWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});
