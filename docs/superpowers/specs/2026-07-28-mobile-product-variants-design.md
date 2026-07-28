# Mobile Product Variants Design

**Date:** 2026-07-28

**Status:** Approved for implementation planning

## Goal

Make product customization dependable in the mobile application so vendors can create and safely edit products with Color and Size variants, buyers receive an immediate color-specific image preview, and cart and inventory operations continue to use an exact purchasable combination.

The web application and browse-level color or size filtering are outside this design and will be handled separately.

## Product Requirements

### Vendor creation

- Replace the free-form variant textarea with structured attribute controls.
- Treat `Color` and `Size` as the primary mobile attributes while retaining support for another named attribute when the existing product already contains one.
- Let the vendor add, rename, reorder, and remove attribute values without producing duplicate values that differ only by case or whitespace.
- Generate the Cartesian product of selected attribute values.
- Give every generated combination an editable SKU, seller price, stock quantity, and status.
- Let the vendor assign uploaded product media once to a color.
- Apply that color media to every size or other combination containing the color unless the vendor explicitly assigns media to a specific combination.
- Fall back to the base product gallery when a color or combination has no assigned media.
- Show validation errors before saving rather than silently dropping malformed attributes or combinations.

### Vendor editing

- Load the product's stored attributes and combinations into the same structured editor used by creation.
- Match existing combinations by normalized attribute identity, not by array position or generated display text.
- Preserve an existing combination's ID, SKU, price, stock, status, primary image, and gallery images when its attribute identity still exists.
- Remove combinations only when the vendor removes the attribute value that produced them.
- Initialize newly generated combinations from the product's base SKU, seller price, stock default, and applicable color media.
- Never reset every combination to the base product price, stock, or first image merely because one attribute was edited.
- Warn before saving when removing an attribute value will remove combinations with stock.

### Buyer product detail

- Render a selectable control for every variant attribute.
- Disable a value only when no active, in-stock combination remains compatible with the buyer's current partial selection.
- When the buyer selects a color, update the visible gallery immediately using the color's inherited media, even if Size or another required attribute has not yet been selected.
- When the buyer completes the selection, prefer the exact combination's explicit media over inherited color media.
- Update displayed seller price, SKU, and stock only from an exact selected combination.
- Keep Add to Cart and Buy Now disabled until every required attribute resolves to one active, in-stock combination.
- Preserve the exact variant ID, SKU, attributes, price, and image in authenticated and guest carts.

## Canonical Data Model

The existing Convex fields remain authoritative:

- `variantAttributes` defines the selectable dimensions and values.
- `variantCombinations` defines purchasable identities with SKU, price, stock, status, and media.
- `selectedVariant` identifies the exact combination stored in cart and order data.

No new backend field is required for the first mobile tightening pass. The mobile editor keeps color-owned media as draft UI state and materializes it into each applicable `variantCombination` when saving. This retains compatibility with the existing Convex validators, web consumers, cart validation, and order stock decrement logic.

`product.color` is not an independent variant source. For a variant product, mobile display behavior derives available colors from the `Color` variant attribute. The legacy top-level field remains readable for products without color variants, but the mobile editor must not create conflicting color values in both places.

## Mobile Variant Domain Boundary

Variant behavior will be extracted from the large screens into a small typed domain module. It owns:

- normalization of attribute names and values;
- stable attribute and combination identity;
- Cartesian combination generation;
- merge behavior that preserves stored combination overrides;
- color-media inheritance;
- compatible-value availability checks;
- exact-combination resolution;
- partial-selection preview resolution;
- validation of attributes, combinations, prices, stock, SKU uniqueness, and media references.

The module accepts plain serializable values and has no React Native, Convex hook, navigation, or component dependency. Creation, editing, and product detail consume the same functions so their interpretation of a variant cannot drift.

## Combination Identity

A combination key is built from normalized attribute name/value pairs:

1. Trim attribute names and values.
2. Compare names and values case-insensitively.
3. Sort pairs by normalized attribute name when constructing the identity.
4. Keep the vendor-facing capitalization for display.

For example, `Color=Red, Size=M` and `size=M, color=red` have the same identity. Reordering attributes therefore does not destroy stored combination data.

Stored combination IDs remain unchanged when the combination survives an edit. New combinations receive a deterministic ID and SKU derived from the base SKU plus normalized values. Duplicate IDs or SKUs are validation errors.

## Media Ownership and Resolution

### Vendor draft state

The editor maintains:

- the base product gallery;
- a color-to-media assignment;
- optional combination-specific media overrides.

Uploaded images remain part of the base gallery. Color and combination assignments reference those URLs rather than uploading duplicate files.

### Save behavior

For each combination:

1. Use the combination override when present.
2. Otherwise use media assigned to its Color value.
3. Otherwise leave variant media empty so consumers fall back to the base product gallery.

The selected primary image is first in that media assignment; the remaining images become `galleryImages`.

### Buyer preview behavior

The gallery is resolved in this order:

1. Exact selected combination media.
2. Media from the first active, in-stock combination compatible with the selected Color.
3. Base product gallery.

Partial preview resolution must never be treated as a purchasable selection. Only an exact combination can supply cart identity, exact price, or exact stock.

## Mobile Components

### Variant attribute editor

Used by create and edit screens. It provides attribute name selection, value chips, add/remove controls, duplicate prevention, and a generated-combination count.

### Color media editor

Shown when a Color attribute exists. Each color row lets the vendor choose a primary image and additional gallery images from the already uploaded product images. It clearly indicates when the base gallery will be used.

### Combination editor

Displays one collapsible row or card per generated combination with:

- human-readable attribute values;
- SKU;
- seller price;
- stock;
- active, inactive, or out-of-stock status;
- inherited color media summary;
- optional media override.

Large combination sets remain usable by rendering a scrollable list instead of one oversized form.

### Buyer option selector

Product detail renders attribute chips from canonical variant data. Color chips trigger preview resolution immediately. Exact selection controls seller price, SKU, stock, and purchasing availability.

## Data Flow

### Create

1. Vendor defines attributes and values.
2. The domain module generates combinations.
3. Vendor edits combination inventory and assigns color media.
4. Validation returns field-specific issues.
5. The screen materializes inherited media and calls `products.createProduct`.
6. Convex normalizes and persists the combinations.

### Edit

1. The screen loads stored variant attributes and combinations.
2. The domain module derives editor state and color media.
3. Attribute changes regenerate the desired identities.
4. The merge retains stored values for surviving identities and initializes only new identities.
5. The screen shows destructive-removal warnings where necessary.
6. The materialized result is sent to `products.updateProduct`.

### Product detail

1. The buyer selects any attribute value.
2. Compatibility logic disables impossible next values.
3. A Color selection updates preview media immediately.
4. A complete selection resolves the exact combination.
5. Purchase actions receive only the exact combination snapshot.

## Validation and Error Handling

- Attribute names must be unique after normalization.
- Attribute values must be non-empty and unique after normalization.
- At least one value is required for each retained attribute.
- Combination count must be bounded to prevent an accidental explosion; mobile will reject more than 100 generated combinations.
- Every combination must include one value for every attribute.
- Seller price must be greater than zero.
- Stock must be a non-negative integer.
- SKU must be non-empty and unique across the product and its combinations.
- A zero-stock combination is saved as `out_of_stock`.
- A media assignment may reference only URLs present in the uploaded product gallery.
- Invalid draft data remains visible with an actionable error; it is not silently removed.
- Existing legacy products without canonical combinations continue to use the current legacy variant fallback on product detail.

## Testing Strategy

Pure domain tests will prove:

- normalization and stable identity across casing and attribute reordering;
- complete Cartesian generation;
- preservation of existing IDs, SKUs, prices, stock, statuses, and media;
- initialization of only new combinations;
- identification of stocked combinations removed by an edit;
- color-media inheritance and explicit override precedence;
- immediate color preview from a partial selection;
- exact selection resolution;
- compatible-value availability;
- validation failures for duplicates, invalid stock or price, excessive combinations, and unknown media URLs.

Screen-level verification will prove:

- create and edit screens consume the shared domain functions;
- product detail separates preview resolution from exact cart selection;
- mobile TypeScript compilation passes;
- existing mobile policy tests still pass;
- repository typechecking remains green.

## Compatibility and Rollout

- Existing products without `variantAttributes` or `variantCombinations` remain valid.
- Existing canonical variant products are loaded without a data migration.
- No production data repair, Convex deployment, or product rewrite occurs as part of this mobile tightening pass.
- The implementation is limited to mobile UI and shared pure mobile domain behavior unless a failing contract test proves a backend change is necessary.
- Web creation, web detail behavior, and browse-level color or size filtering remain unchanged.

## Completion Criteria

The mobile tightening pass is complete only when:

1. Structured mobile creation and editing support Color and Size.
2. Existing combination overrides survive a no-op edit and compatible attribute changes.
3. Vendors can assign one gallery per color and optionally override a combination.
4. Selecting a color immediately changes buyer preview media.
5. Purchasing still requires and stores an exact active, in-stock combination.
6. Targeted variant tests, mobile typechecking, relevant existing tests, and full repository typechecking pass.
7. No unrelated worktree files are modified, staged, or committed by this work.
