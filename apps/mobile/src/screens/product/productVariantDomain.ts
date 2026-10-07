export type VariantStatus = 'active' | 'inactive' | 'out_of_stock';

export interface VariantAttribute {
  name: string;
  values: string[];
}

export interface VariantAttributeValue {
  name: string;
  value: string;
}

export interface VariantCombination {
  id: string;
  sku: string;
  attributes: VariantAttributeValue[];
  price: number;
  stock: number;
  status: VariantStatus;
  primaryImage?: string;
  galleryImages?: string[];
}

export interface VariantCombinationPatch {
  id?: string;
  sku?: string;
  price?: number;
  stock?: number;
  status?: VariantStatus;
}

export type VariantMediaMap = Readonly<
  Record<string, readonly string[]>
>;

export interface VariantValidationIssue {
  field:
    | 'attributes'
    | 'combinations'
    | 'sku'
    | 'price'
    | 'stock'
    | 'media';
  combinationKey?: string;
  message: string;
}

export interface VariantEditorState {
  attributes: VariantAttribute[];
  existingCombinations: VariantCombination[];
  combinationPatches: Record<string, VariantCombinationPatch>;
  colorMedia: Record<string, string[]>;
  combinationMedia: Record<string, string[]>;
}

const COLOR_ATTRIBUTE = 'color';

const normalizeToken = (value: string): string =>
  value.trim().toLocaleLowerCase();

const normalizeSlug = (value: string): string =>
  normalizeToken(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const normalizeSkuPart = (value: string): string =>
  value
    .trim()
    .toLocaleUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const deduplicateDisplayValues = (
  values: readonly string[]
): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const displayValue = value.trim();
    const normalizedValue = normalizeToken(displayValue);

    if (!normalizedValue || seen.has(normalizedValue)) {
      continue;
    }

    seen.add(normalizedValue);
    result.push(displayValue);
  }

  return result;
};

const buildCartesianProduct = (
  attributes: readonly VariantAttribute[]
): VariantAttributeValue[][] => {
  const normalizedAttributes = attributes
    .map((attribute) => ({
      name: attribute.name.trim(),
      values: deduplicateDisplayValues(attribute.values),
    }))
    .filter(
      (attribute) =>
        normalizeToken(attribute.name).length > 0 &&
        attribute.values.length > 0
    );

  if (normalizedAttributes.length === 0) {
    return [];
  }

  return normalizedAttributes.reduce<VariantAttributeValue[][]>(
    (combinations, attribute) =>
      combinations.flatMap((combination) =>
        attribute.values.map((value) => [
          ...combination,
          { name: attribute.name, value },
        ])
      ),
    [[]]
  );
};

const sortedAttributeValues = (
  attributes: readonly VariantAttributeValue[]
): VariantAttributeValue[] =>
  [...attributes].sort((left, right) =>
    normalizeToken(left.name).localeCompare(normalizeToken(right.name))
  );

const buildGeneratedId = (
  attributes: readonly VariantAttributeValue[]
): string => {
  const identity = sortedAttributeValues(attributes)
    .flatMap(({ name, value }) => [normalizeSlug(name), normalizeSlug(value)])
    .filter(Boolean)
    .join('-');

  return `variant-${identity || 'default'}`;
};

const buildGeneratedSku = (
  baseSku: string,
  attributes: readonly VariantAttributeValue[]
): string => {
  const parts = [
    normalizeSkuPart(baseSku) || 'VARIANT',
    ...sortedAttributeValues(attributes)
      .map(({ value }) => normalizeSkuPart(value))
      .filter(Boolean),
  ];

  return parts.join('-');
};

export function getCombinationKey(
  attributes: readonly VariantAttributeValue[]
): string {
  return [...attributes]
    .map(
      ({ name, value }) =>
        `${normalizeToken(name)}=${normalizeToken(value)}`
    )
    .sort()
    .join('|');
}

export function reconcileVariantCombinations(input: {
  attributes: readonly VariantAttribute[];
  existing: readonly VariantCombination[];
  patches: Readonly<Record<string, VariantCombinationPatch>>;
  baseSku: string;
  defaultPrice: number;
  defaultStock: number;
}): VariantCombination[] {
  const existingByKey = new Map(
    input.existing.map((combination) => [
      getCombinationKey(combination.attributes),
      combination,
    ])
  );

  return buildCartesianProduct(input.attributes).map((attributes) => {
    const key = getCombinationKey(attributes);
    const stored = existingByKey.get(key);
    const patch = input.patches[key];
    const defaultStock = Math.max(0, Math.trunc(input.defaultStock));
    const initial: VariantCombination =
      stored === undefined
        ? {
            id: buildGeneratedId(attributes),
            sku: buildGeneratedSku(input.baseSku, attributes),
            attributes,
            price: input.defaultPrice,
            stock: defaultStock,
            status: defaultStock === 0 ? 'out_of_stock' : 'active',
          }
        : {
            ...stored,
            attributes: [...stored.attributes],
            ...(stored.galleryImages === undefined
              ? {}
              : { galleryImages: [...stored.galleryImages] }),
          };

    const patched: VariantCombination = {
      ...initial,
      ...(patch ?? {}),
    };
    const stock = Math.max(0, Math.trunc(patched.stock));

    return {
      ...patched,
      stock,
      status: stock === 0 ? 'out_of_stock' : patched.status,
    };
  });
}

export function findRemovedStockedCombinations(
  previous: readonly VariantCombination[],
  next: readonly VariantCombination[]
): VariantCombination[] {
  const nextKeys = new Set(
    next.map((combination) => getCombinationKey(combination.attributes))
  );

  return previous.filter(
    (combination) =>
      combination.stock > 0 &&
      !nextKeys.has(getCombinationKey(combination.attributes))
  );
}

const combinationImages = (
  combination: VariantCombination
): string[] =>
  [
    combination.primaryImage,
    ...(combination.galleryImages ?? []),
  ].filter((image): image is string => Boolean(image));

const getAttributeValue = (
  attributes: readonly VariantAttributeValue[],
  attributeName: string
): string | undefined =>
  attributes.find(
    ({ name }) => normalizeToken(name) === normalizeToken(attributeName)
  )?.value;

const imageListsEqual = (
  left: readonly string[],
  right: readonly string[]
): boolean =>
  left.length === right.length &&
  left.every((image, index) => image === right[index]);

export function deriveVariantMediaState(input: {
  combinations: readonly VariantCombination[];
}): {
  colorMedia: Record<string, string[]>;
  combinationMedia: Record<string, string[]>;
} {
  const colorMedia: Record<string, string[]> = {};
  const combinationMedia: Record<string, string[]> = {};

  for (const combination of input.combinations) {
    const images = combinationImages(combination);

    if (images.length === 0) {
      continue;
    }

    const colorValue = getAttributeValue(
      combination.attributes,
      COLOR_ATTRIBUTE
    );
    const colorKey = colorValue && normalizeToken(colorValue);
    const combinationKey = getCombinationKey(combination.attributes);

    if (!colorKey) {
      combinationMedia[combinationKey] = images;
      continue;
    }

    const inheritedImages = colorMedia[colorKey];

    if (inheritedImages === undefined) {
      colorMedia[colorKey] = images;
    } else if (!imageListsEqual(inheritedImages, images)) {
      combinationMedia[combinationKey] = images;
    }
  }

  return { colorMedia, combinationMedia };
}

export function materializeVariantMedia(input: {
  combinations: readonly VariantCombination[];
  colorMedia: VariantMediaMap;
  combinationMedia: VariantMediaMap;
  productImages: readonly string[];
}): VariantCombination[] {
  const allowedImages = new Set(input.productImages);

  return input.combinations.map((combination) => {
    const combinationKey = getCombinationKey(combination.attributes);
    const colorValue = getAttributeValue(
      combination.attributes,
      COLOR_ATTRIBUTE
    );
    const colorKey = colorValue && normalizeToken(colorValue);
    const overrideImages = input.combinationMedia[combinationKey];
    const selectedImages =
      (overrideImages && overrideImages.length > 0
        ? overrideImages
        : undefined) ??
      (colorKey ? input.colorMedia[colorKey] : undefined) ??
      [];

    if (selectedImages.some((image) => !allowedImages.has(image))) {
      throw new Error(
        'Variant media must reference images in the product images gallery.'
      );
    }

    const {
      primaryImage: _primaryImage,
      galleryImages: _galleryImages,
      ...withoutMedia
    } = combination;

    if (selectedImages.length === 0) {
      return withoutMedia;
    }

    const [primaryImage, ...galleryImages] = selectedImages;

    return {
      ...withoutMedia,
      primaryImage,
      ...(galleryImages.length > 0 ? { galleryImages } : {}),
    };
  });
}

const addIssue = (
  issues: VariantValidationIssue[],
  issue: VariantValidationIssue
): void => {
  issues.push(issue);
};

export function validateVariantDraft(input: {
  attributes: readonly VariantAttribute[];
  combinations: readonly VariantCombination[];
  productImages: readonly string[];
  productSku?: string;
}): VariantValidationIssue[] {
  const issues: VariantValidationIssue[] = [];
  const attributeNames = new Set<string>();

  for (const attribute of input.attributes) {
    const name = normalizeToken(attribute.name);

    if (!name) {
      addIssue(issues, {
        field: 'attributes',
        message: 'Every variant attribute needs a name.',
      });
      continue;
    }

    if (attributeNames.has(name)) {
      addIssue(issues, {
        field: 'attributes',
        message: `Variant attribute "${attribute.name.trim()}" is duplicated.`,
      });
    }
    attributeNames.add(name);

    const values = new Set<string>();
    for (const value of attribute.values) {
      const normalizedValue = normalizeToken(value);
      if (!normalizedValue) {
        addIssue(issues, {
          field: 'attributes',
          message: `Variant attribute "${attribute.name.trim()}" contains an empty value.`,
        });
      } else if (values.has(normalizedValue)) {
        addIssue(issues, {
          field: 'attributes',
          message: `Variant value "${value.trim()}" is duplicated for ${attribute.name.trim()}.`,
        });
      }
      values.add(normalizedValue);
    }

    if (attribute.values.length === 0) {
      addIssue(issues, {
        field: 'attributes',
        message: `Variant attribute "${attribute.name.trim()}" needs at least one value.`,
      });
    }
  }

  const expectedCombinations = buildCartesianProduct(input.attributes);
  if (input.combinations.length > 100 || expectedCombinations.length > 100) {
    addIssue(issues, {
      field: 'combinations',
      message: 'A product can have at most 100 variant combinations.',
    });
  }

  if (
    input.attributes.length > 0 &&
    input.combinations.length !== expectedCombinations.length
  ) {
    addIssue(issues, {
      field: 'combinations',
      message: 'Variant combinations do not match the configured attributes.',
    });
  }

  const allowedValuesByAttribute = new Map(
    input.attributes.map((attribute) => [
      normalizeToken(attribute.name),
      new Set(attribute.values.map(normalizeToken)),
    ])
  );
  const seenCombinationKeys = new Set<string>();
  const seenSkus = new Set<string>();
  const productSku = normalizeToken(input.productSku ?? '');
  const allowedImages = new Set(input.productImages);

  for (const combination of input.combinations) {
    const combinationKey = getCombinationKey(combination.attributes);
    const combinationAttributeNames = new Set(
      combination.attributes.map(({ name }) => normalizeToken(name))
    );
    const hasExactAttributes =
      combination.attributes.length === allowedValuesByAttribute.size &&
      [...allowedValuesByAttribute.entries()].every(
        ([name, allowedValues]) => {
          const value = getAttributeValue(combination.attributes, name);
          return (
            combinationAttributeNames.has(name) &&
            value !== undefined &&
            allowedValues.has(normalizeToken(value))
          );
        }
      );

    if (!hasExactAttributes || seenCombinationKeys.has(combinationKey)) {
      addIssue(issues, {
        field: 'combinations',
        combinationKey,
        message: !hasExactAttributes
          ? 'Combination attributes do not match the configured variant values.'
          : 'This variant combination is duplicated.',
      });
    }
    seenCombinationKeys.add(combinationKey);

    const sku = normalizeToken(combination.sku);
    if (!sku || sku === productSku || seenSkus.has(sku)) {
      addIssue(issues, {
        field: 'sku',
        combinationKey,
        message: !sku
          ? 'Every combination needs a SKU.'
          : 'Combination SKUs must be unique and differ from the product SKU.',
      });
    }
    seenSkus.add(sku);

    if (!Number.isFinite(combination.price) || combination.price <= 0) {
      addIssue(issues, {
        field: 'price',
        combinationKey,
        message: 'Combination price must be greater than zero.',
      });
    }

    if (
      !Number.isInteger(combination.stock) ||
      combination.stock < 0
    ) {
      addIssue(issues, {
        field: 'stock',
        combinationKey,
        message: 'Combination stock must be a non-negative whole number.',
      });
    }

    if (
      combinationImages(combination).some(
        (image) => !allowedImages.has(image)
      )
    ) {
      addIssue(issues, {
        field: 'media',
        combinationKey,
        message:
          'Variant media must reference images in the product images gallery.',
      });
    }
  }

  return issues;
}

export function deriveProductColor(
  attributes: readonly VariantAttribute[],
  legacyColor: string
): string | undefined {
  const colorAttribute = attributes.find(
    ({ name }) => normalizeToken(name) === COLOR_ATTRIBUTE
  );
  const colors = colorAttribute
    ? deduplicateDisplayValues(colorAttribute.values)
    : [];

  if (colors.length > 0) {
    return colors.join(', ');
  }

  return legacyColor.trim() || undefined;
}

export function addVariantAttributeValue(input: {
  attributes: readonly VariantAttribute[];
  attributeName: string;
  value: string;
}): {
  attributes: VariantAttribute[];
  issue?: VariantValidationIssue;
} {
  const attributeName = input.attributeName.trim();
  const value = input.value.trim();
  const normalizedAttributeName = normalizeToken(attributeName);
  const normalizedValue = normalizeToken(value);
  const unchangedAttributes = input.attributes.map((attribute) => ({
    ...attribute,
    values: [...attribute.values],
  }));

  if (!normalizedAttributeName || !normalizedValue) {
    return {
      attributes: unchangedAttributes,
      issue: {
        field: 'attributes',
        message: !normalizedAttributeName
          ? 'Enter an attribute name.'
          : 'Enter a variant value.',
      },
    };
  }

  const matchingIndex = input.attributes.findIndex(
    ({ name }) => normalizeToken(name) === normalizedAttributeName
  );

  if (matchingIndex === -1) {
    return {
      attributes: [
        ...unchangedAttributes,
        { name: attributeName, values: [value] },
      ],
    };
  }

  const matchingAttribute = input.attributes[matchingIndex];
  if (
    matchingAttribute.values.some(
      (existingValue) =>
        normalizeToken(existingValue) === normalizedValue
    )
  ) {
    return {
      attributes: unchangedAttributes,
      issue: {
        field: 'attributes',
        message: `"${value}" already exists for ${matchingAttribute.name.trim()}.`,
      },
    };
  }

  return {
    attributes: unchangedAttributes.map((attribute, index) =>
      index === matchingIndex
        ? { ...attribute, values: [...attribute.values, value] }
        : attribute
    ),
  };
}

export function removeVariantAttributeValue(input: {
  attributes: readonly VariantAttribute[];
  attributeName: string;
  value: string;
}): VariantAttribute[] {
  const normalizedAttributeName = normalizeToken(input.attributeName);
  const normalizedValue = normalizeToken(input.value);

  return input.attributes.flatMap((attribute) => {
    const values =
      normalizeToken(attribute.name) === normalizedAttributeName
        ? attribute.values.filter(
            (value) => normalizeToken(value) !== normalizedValue
          )
        : [...attribute.values];

    return values.length > 0 ? [{ ...attribute, values }] : [];
  });
}

export function createVariantEditorState(input: {
  attributes?: readonly VariantAttribute[];
  combinations?: readonly VariantCombination[];
}): VariantEditorState {
  const attributes = (input.attributes ?? []).map((attribute) => ({
    name: attribute.name,
    values: [...attribute.values],
  }));
  const existingCombinations = (input.combinations ?? []).map(
    (combination) => ({
      ...combination,
      attributes: combination.attributes.map((attribute) => ({
        ...attribute,
      })),
      ...(combination.galleryImages === undefined
        ? {}
        : { galleryImages: [...combination.galleryImages] }),
    })
  );
  const { colorMedia, combinationMedia } = deriveVariantMediaState({
    combinations: existingCombinations,
  });

  return {
    attributes,
    existingCombinations,
    combinationPatches: {},
    colorMedia,
    combinationMedia,
  };
}

const normalizedSelection = (
  selection: Readonly<Record<string, string>>
): Map<string, string> =>
  new Map(
    Object.entries(selection)
      .map(
        ([name, value]) =>
          [normalizeToken(name), normalizeToken(value)] as const
      )
      .filter(([name, value]) => Boolean(name && value))
  );

const combinationMatchesSelection = (
  combination: VariantCombination,
  selection: ReadonlyMap<string, string>
): boolean =>
  [...selection.entries()].every(([attributeName, selectedValue]) => {
    const combinationValue = getAttributeValue(
      combination.attributes,
      attributeName
    );
    return (
      combinationValue !== undefined &&
      normalizeToken(combinationValue) === selectedValue
    );
  });

const isPurchasableCombination = (
  combination: VariantCombination
): boolean => combination.status === 'active' && combination.stock > 0;

const uniqueImages = (images: readonly string[]): string[] => [
  ...new Set(images.filter(Boolean)),
];

export function resolveExactVariant(
  combinations: readonly VariantCombination[],
  attributes: readonly VariantAttribute[],
  selection: Readonly<Record<string, string>>
): VariantCombination | null {
  if (attributes.length === 0) {
    return null;
  }

  const selectedValues = normalizedSelection(selection);
  const hasCompleteSelection = attributes.every(({ name }) =>
    selectedValues.has(normalizeToken(name))
  );

  if (!hasCompleteSelection) {
    return null;
  }

  return (
    combinations.find(
      (combination) =>
        isPurchasableCombination(combination) &&
        combinationMatchesSelection(combination, selectedValues)
    ) ?? null
  );
}

export function isVariantValueAvailable(input: {
  combinations: readonly VariantCombination[];
  attributes: readonly VariantAttribute[];
  selection: Readonly<Record<string, string>>;
  attributeName: string;
  value: string;
}): boolean {
  const canonicalAttributeNames = new Set(
    input.attributes.map(({ name }) => normalizeToken(name))
  );
  const proposedSelection = normalizedSelection(input.selection);
  const attributeName = normalizeToken(input.attributeName);

  if (!canonicalAttributeNames.has(attributeName)) {
    return false;
  }

  proposedSelection.set(attributeName, normalizeToken(input.value));

  return input.combinations.some(
    (combination) =>
      isPurchasableCombination(combination) &&
      combinationMatchesSelection(combination, proposedSelection)
  );
}

export function resolveVariantPreviewImages(input: {
  baseImages: readonly string[];
  combinations: readonly VariantCombination[];
  attributes: readonly VariantAttribute[];
  selection: Readonly<Record<string, string>>;
}): string[] {
  const exactVariant = resolveExactVariant(
    input.combinations,
    input.attributes,
    input.selection
  );
  const exactImages = exactVariant
    ? combinationImages(exactVariant)
    : [];

  if (exactImages.length > 0) {
    return uniqueImages(exactImages);
  }

  const selection = normalizedSelection(input.selection);
  const colorAttribute = input.attributes.find(
    ({ name }) => normalizeToken(name) === COLOR_ATTRIBUTE
  );
  const selectedColor = colorAttribute
    ? selection.get(normalizeToken(colorAttribute.name))
    : undefined;

  if (selectedColor) {
    const compatibleColorVariant = input.combinations.find(
      (combination) =>
        isPurchasableCombination(combination) &&
        normalizeToken(
          getAttributeValue(combination.attributes, COLOR_ATTRIBUTE) ?? ''
        ) === selectedColor &&
        combinationMatchesSelection(combination, selection) &&
        combinationImages(combination).length > 0
    );

    if (compatibleColorVariant) {
      return uniqueImages(combinationImages(compatibleColorVariant));
    }

    const colorVariant = input.combinations.find(
      (combination) =>
        isPurchasableCombination(combination) &&
        normalizeToken(
          getAttributeValue(combination.attributes, COLOR_ATTRIBUTE) ?? ''
        ) === selectedColor &&
        combinationImages(combination).length > 0
    );

    if (colorVariant) {
      return uniqueImages(combinationImages(colorVariant));
    }
  }

  return uniqueImages(input.baseImages);
}
