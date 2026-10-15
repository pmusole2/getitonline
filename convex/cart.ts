import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { getSellerDisplayInfo, isPublicStorefrontSeller } from "./lib/platform";
import { canViewerSeeProduct } from "./products";

const DEFAULT_SHIPPING = { name: "Free Delivery", price: 0 };
// The most of one item a single cart line may hold. Every quantity write is a whole number from 1 up to this cap.
const MAX_CART_QUANTITY = 99;

const selectedVariantOptionValidator = v.object({
  name: v.string(),
  value: v.string(),
  sku: v.optional(v.string()),
  priceDelta: v.optional(v.number()),
});

const selectedVariantValidator = v.object({
  variantId: v.string(),
  sku: v.string(),
  attributes: v.array(v.object({ name: v.string(), value: v.string() })),
  price: v.number(),
  image: v.optional(v.string()),
});

const selectedAddOnValidator = v.object({
  name: v.string(),
  description: v.optional(v.string()),
  price: v.number(),
});

type ProductDoc = Doc<"products">;
type CartIssue = {
  productId: string;
  reason: "product_missing" | "product_unavailable" | "seller_unavailable" | "invalid_line" | "insufficient_stock";
  issue: string;
};
type SelectedVariantOption = {
  name: string;
  value: string;
  sku?: string;
  priceDelta?: number;
};
type SelectedVariant = {
  variantId: string;
  sku: string;
  attributes: Array<{ name: string; value: string }>;
  price: number;
  image?: string;
};
type SelectedAddOn = {
  name: string;
  description?: string;
  price: number;
};
type VariantCombination = {
  id: string;
  sku: string;
  attributes: Array<{ name: string; value: string }>;
  price: number;
  stock: number;
  status: "active" | "inactive" | "out_of_stock";
  primaryImage?: string;
  galleryImages?: string[];
};

function resolveSelectedShipping(
  product: {
    shippingOptions?: Array<{ name: string; price: number }> | undefined;
  },
  selectedShipping?: { name: string; price: number }
) {
  const matchedShipping = product.shippingOptions?.find((option) => option.name === selectedShipping?.name);

  if (matchedShipping) {
    return { name: matchedShipping.name, price: matchedShipping.price };
  }

  const fallbackShipping = product.shippingOptions?.[0];
  if (fallbackShipping) {
    return { name: fallbackShipping.name, price: fallbackShipping.price };
  }

  return DEFAULT_SHIPPING;
}

function createCustomizationKey(input: {
  productId: string;
  selectedVariant?: SelectedVariant;
  selectedVariantOptions?: SelectedVariantOption[];
  selectedAddOns?: SelectedAddOn[];
}) {
  const selectedVariantKey = input.selectedVariant ? input.selectedVariant.variantId || input.selectedVariant.sku : "";
  const variantKey = [...(input.selectedVariantOptions ?? [])]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((option) => `${option.name}:${option.value}`)
    .join("|");
  const addOnKey = [...(input.selectedAddOns ?? [])]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((addOn) => addOn.name)
    .join("|");

  return `${input.productId}::variant=${selectedVariantKey}::variants=${variantKey}::addons=${addOnKey}`;
}

function getVariantCombinations(product: ProductDoc): VariantCombination[] {
  return (product.variantCombinations ?? []) as VariantCombination[];
}

function resolveSelectedVariant(product: ProductDoc, requestedVariant?: SelectedVariant): SelectedVariant | undefined {
  const combinations = getVariantCombinations(product);
  if (combinations.length === 0) {
    return undefined;
  }

  if (!requestedVariant) {
    throw new Error("Select product variant before adding to cart");
  }

  const combination = combinations.find(
    (candidate) => candidate.id === requestedVariant.variantId || candidate.sku === requestedVariant.sku
  );

  if (!combination) {
    throw new Error("Invalid product variant");
  }

  if (combination.status !== "active" || combination.stock <= 0) {
    throw new Error("Selected variant is out of stock");
  }

  return {
    variantId: combination.id,
    sku: combination.sku,
    attributes: combination.attributes,
    price: combination.price,
    image: combination.primaryImage,
  };
}

function resolveSelectedVariantOptions(
  product: ProductDoc,
  requestedOptions?: SelectedVariantOption[]
): SelectedVariantOption[] {
  if (getVariantCombinations(product).length > 0) {
    return [];
  }

  const variants = product.variants ?? [];
  if (variants.length === 0) {
    return [];
  }

  return variants.map((variant) => {
    const requestedOption = requestedOptions?.find((option) => option.name === variant.name);

    if (!requestedOption) {
      throw new Error(`Select a ${variant.name} option`);
    }

    const canonicalOption = variant.options.find((option) => option.value === requestedOption.value);

    if (!canonicalOption) {
      throw new Error(`Invalid ${variant.name} option`);
    }

    if (typeof canonicalOption.quantity === "number" && canonicalOption.quantity <= 0) {
      throw new Error(`${variant.name} ${canonicalOption.value} is out of stock`);
    }

    const selected: SelectedVariantOption = {
      name: variant.name,
      value: canonicalOption.value,
    };

    if (canonicalOption.sku) {
      selected.sku = canonicalOption.sku;
    }
    if (typeof canonicalOption.priceDelta === "number") {
      selected.priceDelta = canonicalOption.priceDelta;
    }

    return selected;
  });
}

function resolveSelectedAddOns(product: ProductDoc, requestedAddOns?: SelectedAddOn[]): SelectedAddOn[] {
  const addOns = product.addOns ?? [];
  if (addOns.length === 0) {
    return [];
  }

  for (const requestedAddOn of requestedAddOns ?? []) {
    const isValid = addOns.some((addOn) => addOn.name === requestedAddOn.name);
    if (!isValid) {
      throw new Error(`Invalid add-on: ${requestedAddOn.name}`);
    }
  }

  const requestedNames = new Set((requestedAddOns ?? []).map((addOn) => addOn.name));

  return addOns
    .filter((addOn) => addOn.isRequired || requestedNames.has(addOn.name))
    .map((addOn) => {
      const selected: SelectedAddOn = {
        name: addOn.name,
        price: addOn.price,
      };

      if (addOn.description) {
        selected.description = addOn.description;
      }
      return selected;
    });
}

function getAvailableQuantity(
  product: ProductDoc,
  selectedVariant?: SelectedVariant,
  selectedVariantOptions?: SelectedVariantOption[]
) {
  if (selectedVariant) {
    const combination = getVariantCombinations(product).find((candidate) => candidate.id === selectedVariant.variantId);
    return Math.min(product.quantity, combination?.stock ?? 0);
  }

  const optionQuantities = (selectedVariantOptions ?? [])
    .map((selectedOption) => {
      const variant = product.variants?.find((candidate) => candidate.name === selectedOption.name);
      const option = variant?.options.find((candidate) => candidate.value === selectedOption.value);
      return option?.quantity;
    })
    .filter((quantity): quantity is number => typeof quantity === "number");

  if (optionQuantities.length === 0) {
    return product.quantity;
  }
  return Math.min(product.quantity, ...optionQuantities);
}

function calculateLineUnitPrice(
  productPrice: number,
  selectedVariant?: SelectedVariant,
  selectedVariantOptions?: SelectedVariantOption[],
  selectedAddOns?: SelectedAddOn[]
) {
  const basePrice = selectedVariant?.price ?? productPrice;
  const variantTotal = (selectedVariantOptions ?? []).reduce((sum, option) => sum + (option.priceDelta ?? 0), 0);
  const addOnTotal = (selectedAddOns ?? []).reduce((sum, addOn) => sum + addOn.price, 0);

  return Math.max(0, Math.round((basePrice + variantTotal + addOnTotal) * 100) / 100);
}

// A write sets a quantity only when it is a whole number from 1 to the cap. Each writer checks this before its first write.
function assertWriteQuantity(quantity: number) {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_CART_QUANTITY) {
    throw new Error(`Quantity must be a whole number from 1 to ${MAX_CART_QUANTITY}`);
  }
}

// A saved line may predate the cap, so a stored quantity is checked only for being a positive whole number.
function isStoredQuantityValid(quantity: number) {
  return Number.isSafeInteger(quantity) && quantity >= 1;
}

// A product can be bought only while it is active and its seller is a public storefront. canViewerSeeProduct decides what a
// viewer may read; this decides what may be purchased.
async function isPurchasableProduct(ctx: QueryCtx | MutationCtx, product: ProductDoc) {
  return product.status === "active" && (await isPublicStorefrontSeller(ctx, product.sellerId));
}

// Prices a saved line from the product as it is now. Returns null when the stored values are not finite numbers, so the
// line is reported as invalid instead of being summed as NaN or Infinity.
function priceCartLine(product: ProductDoc, item: Doc<"cartItems">) {
  const shipping = resolveSelectedShipping(product, item.selectedShipping);
  const lineUnitPrice = calculateLineUnitPrice(
    product.price,
    item.selectedVariant,
    item.selectedVariantOptions,
    item.selectedAddOns
  );
  const isValid =
    isStoredQuantityValid(item.quantity) && Number.isFinite(lineUnitPrice) && Number.isFinite(shipping.price);

  return isValid ? { quantity: item.quantity, lineUnitPrice, shipping } : null;
}

// Stands in for a cart line the buyer may not see or buy now. The line stays so it can be removed. It carries only the row
// id, product id, and saved quantity, so no saved variant, add-on, image, price, SKU, customization, or seller detail leaves
// the server. It adds nothing to the totals.
function unavailableCartLine(product: ProductDoc, item: Doc<"cartItems">) {
  return {
    _id: item._id,
    _creationTime: item._creationTime,
    productId: item.productId,
    quantity: isStoredQuantityValid(item.quantity) ? item.quantity : 0,
    selectedShipping: { name: "Unavailable", price: 0 },
    lineUnitPrice: 0,
    product: {
      _id: product._id,
      title: "Listing unavailable",
      price: 0,
      images: [] as string[],
      quantity: 0,
      // Any non-active status tells clients the line cannot be bought. The real status is withheld.
      status: "suspended" as const,
      // The category is public taxonomy, so the placeholder keeps it. Detail fields are present but empty.
      categoryId: product.categoryId,
      subcategoryId: undefined,
      classificationId: undefined,
      weightKg: undefined,
      sellerName: "Unavailable",
    },
  };
}

// Get user's cart with product details
export const getCart = query({
  args: {},
  handler: async (ctx, _args) => {
    const actor = await requireUser(ctx);
    const cartItems = await ctx.db
      .query("cartItems")
      .withIndex("by_user", (q) => q.eq("userId", actor._id))
      .collect();

    const linesWithTotals = await Promise.all(
      cartItems.map(async (item) => {
        const product = await ctx.db.get(item.productId);
        if (!product) {
          return null;
        }

        if (!(await canViewerSeeProduct(ctx, product, actor))) {
          return { line: unavailableCartLine(product, item), priced: null };
        }

        const priced = priceCartLine(product, item);
        if (!priced) {
          return { line: unavailableCartLine(product, item), priced: null };
        }

        const sellerInfo = await getSellerDisplayInfo(ctx, product.sellerId);

        return {
          line: {
            ...item,
            selectedShipping: priced.shipping,
            lineUnitPrice: priced.lineUnitPrice,
            product: {
              _id: product._id,
              title: product.title,
              price: product.price,
              images: product.images,
              quantity: product.quantity,
              status: product.status,
              categoryId: product.categoryId,
              subcategoryId: product.subcategoryId,
              classificationId: product.classificationId,
              weightKg: product.weightKg,
              sellerId: product.sellerId,
              sellerName: sellerInfo.displayName,
              shippingOptions: product.shippingOptions,
            },
          },
          priced,
        };
      })
    );

    // Drop lines whose product no longer exists
    const validLines = linesWithTotals.filter((entry) => entry !== null);

    // Only priced lines add to the totals. A placeholder has no price, so it adds nothing.
    const subtotal = validLines.reduce(
      (sum, entry) => (entry.priced ? sum + entry.priced.lineUnitPrice * entry.priced.quantity : sum),
      0
    );
    const shippingTotal = validLines.reduce(
      (sum, entry) => (entry.priced ? sum + entry.priced.shipping.price : sum),
      0
    );

    return {
      items: validLines.map((entry) => entry.line),
      subtotal,
      shippingTotal,
      total: subtotal + shippingTotal,
      itemCount: validLines.length,
    };
  },
});

// Add item to cart
export const addToCart = mutation({
  args: {
    productId: v.id("products"),
    quantity: v.number(),
    selectedShipping: v.object({
      name: v.string(),
      price: v.number(),
    }),
    selectedVariant: v.optional(selectedVariantValidator),
    selectedVariantOptions: v.optional(v.array(selectedVariantOptionValidator)),
    selectedAddOns: v.optional(v.array(selectedAddOnValidator)),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    assertWriteQuantity(args.quantity);
    // Check if product exists and can be bought
    const product = await ctx.db.get(args.productId);
    if (!product) {
      throw new Error("Product not found");
    }
    if (!(await isPurchasableProduct(ctx, product))) {
      throw new Error("Product is not available");
    }
    if (product.quantity < args.quantity) {
      throw new Error("Insufficient stock");
    }

    const selectedVariant = resolveSelectedVariant(product, args.selectedVariant);
    const selectedVariantOptions = resolveSelectedVariantOptions(product, args.selectedVariantOptions);
    const selectedAddOns = resolveSelectedAddOns(product, args.selectedAddOns);
    const availableQuantity = getAvailableQuantity(product, selectedVariant, selectedVariantOptions);
    if (availableQuantity < args.quantity) {
      throw new Error("Insufficient stock");
    }

    const customizationKey = createCustomizationKey({
      productId: args.productId,
      selectedVariant,
      selectedVariantOptions,
      selectedAddOns,
    });

    // Check if user is trying to buy their own product
    if (product.sellerId === actor._id) {
      throw new Error("You cannot add your own product to cart");
    }

    // Check if item already in cart
    const existingItems = await ctx.db
      .query("cartItems")
      .withIndex("by_user_product", (q) => q.eq("userId", actor._id).eq("productId", args.productId))
      .collect();
    const existingItem = existingItems.find((item) => {
      const existingCustomizationKey =
        item.customizationKey ??
        createCustomizationKey({
          productId: item.productId,
          selectedVariant: item.selectedVariant,
          selectedVariantOptions: item.selectedVariantOptions,
          selectedAddOns: item.selectedAddOns,
        });
      return existingCustomizationKey === customizationKey;
    });

    if (existingItem) {
      // Update quantity
      const keptQuantity = isStoredQuantityValid(existingItem.quantity) ? existingItem.quantity : 0;
      const newQuantity = keptQuantity + args.quantity;
      if (newQuantity > MAX_CART_QUANTITY) {
        throw new Error(`A cart line can hold at most ${MAX_CART_QUANTITY} of one item`);
      }
      if (newQuantity > availableQuantity) {
        throw new Error("Cannot add more than available stock");
      }

      await ctx.db.patch(existingItem._id, {
        quantity: newQuantity,
        selectedShipping: args.selectedShipping,
        selectedVariant,
        selectedVariantOptions,
        selectedAddOns,
        customizationKey,
        updatedAt: Date.now(),
      });

      await ctx.db.insert("behaviorEvents", {
        userId: actor._id,
        eventType: "add_to_cart",
        productId: product._id,
        categoryId: product.categoryId,
        variantId: selectedVariant?.variantId,
        quantity: args.quantity,
        createdAt: Date.now(),
      });

      return existingItem._id;
    }

    // Add new item
    const cartItemId = await ctx.db.insert("cartItems", {
      userId: actor._id,
      productId: args.productId,
      quantity: args.quantity,
      selectedShipping: args.selectedShipping,
      selectedVariant,
      selectedVariantOptions,
      selectedAddOns,
      customizationKey,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await ctx.db.insert("behaviorEvents", {
      userId: actor._id,
      eventType: "add_to_cart",
      productId: product._id,
      categoryId: product.categoryId,
      variantId: selectedVariant?.variantId,
      quantity: args.quantity,
      createdAt: Date.now(),
    });

    return cartItemId;
  },
});

// Merge locally persisted guest cart items into a signed-in user's cart
export const mergeGuestCart = mutation({
  args: {
    items: v.array(
      v.object({
        productId: v.id("products"),
        quantity: v.number(),
        selectedShipping: v.object({
          name: v.string(),
          price: v.number(),
        }),
        selectedVariant: v.optional(selectedVariantValidator),
        selectedVariantOptions: v.optional(v.array(selectedVariantOptionValidator)),
        selectedAddOns: v.optional(v.array(selectedAddOnValidator)),
        customizationKey: v.optional(v.string()),
        product: v.object({
          _id: v.string(),
          sellerId: v.string(),
          sellerName: v.string(),
          title: v.string(),
          price: v.number(),
          images: v.array(v.string()),
          quantity: v.number(),
          status: v.string(),
          shippingOptions: v.array(
            v.object({
              name: v.string(),
              price: v.number(),
              estimatedDays: v.string(),
            })
          ),
        }),
        addedAt: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    // Check every quantity before the first write, so a bad item refuses the whole batch with nothing merged.
    for (const item of args.items) {
      assertWriteQuantity(item.quantity);
    }

    const skipped: Array<{
      productId: string;
      reason: "product_missing" | "inactive" | "seller_owned" | "out_of_stock";
    }> = [];
    let mergedCount = 0;

    for (const item of args.items) {
      const product = await ctx.db.get(item.productId);

      if (!product) {
        skipped.push({
          productId: item.productId,
          reason: "product_missing",
        });
        continue;
      }

      if (!(await isPurchasableProduct(ctx, product))) {
        skipped.push({
          productId: item.productId,
          reason: "inactive",
        });
        continue;
      }

      if (product.sellerId === actor._id) {
        skipped.push({
          productId: item.productId,
          reason: "seller_owned",
        });
        continue;
      }

      if (product.quantity <= 0) {
        skipped.push({
          productId: item.productId,
          reason: "out_of_stock",
        });
        continue;
      }

      const selectedShipping = resolveSelectedShipping(product, item.selectedShipping);
      const selectedVariant = resolveSelectedVariant(product, item.selectedVariant);
      const selectedVariantOptions = resolveSelectedVariantOptions(product, item.selectedVariantOptions);
      const selectedAddOns = resolveSelectedAddOns(product, item.selectedAddOns);
      const availableQuantity = getAvailableQuantity(product, selectedVariant, selectedVariantOptions);
      const customizationKey = createCustomizationKey({
        productId: item.productId,
        selectedVariant,
        selectedVariantOptions,
        selectedAddOns,
      });

      const existingItems = await ctx.db
        .query("cartItems")
        .withIndex("by_user_product", (q) => q.eq("userId", actor._id).eq("productId", item.productId))
        .collect();
      const existingItem = existingItems.find((cartItem) => {
        const existingCustomizationKey =
          cartItem.customizationKey ??
          createCustomizationKey({
            productId: cartItem.productId,
            selectedVariant: cartItem.selectedVariant,
            selectedVariantOptions: cartItem.selectedVariantOptions,
            selectedAddOns: cartItem.selectedAddOns,
          });
        return existingCustomizationKey === customizationKey;
      });

      if (existingItem) {
        const keptQuantity = isStoredQuantityValid(existingItem.quantity) ? existingItem.quantity : 0;
        await ctx.db.patch(existingItem._id, {
          quantity: Math.min(keptQuantity + item.quantity, availableQuantity, MAX_CART_QUANTITY),
          selectedShipping,
          selectedVariant,
          selectedVariantOptions,
          selectedAddOns,
          customizationKey,
          updatedAt: Date.now(),
        });
      } else {
        await ctx.db.insert("cartItems", {
          userId: actor._id,
          productId: item.productId,
          quantity: Math.min(item.quantity, availableQuantity),
          selectedShipping,
          selectedVariant,
          selectedVariantOptions,
          selectedAddOns,
          customizationKey,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }

      mergedCount += 1;
    }

    return { mergedCount, skipped };
  },
});

// Update cart item quantity
export const updateCartQuantity = mutation({
  args: {
    cartItemId: v.id("cartItems"),
    quantity: v.number(),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const cartItem = await ctx.db.get(args.cartItemId);
    if (!cartItem) {
      throw new Error("Cart item not found");
    }
    if (cartItem.userId !== actor._id) {
      throw new Error("Unauthorized");
    }
    assertWriteQuantity(args.quantity);

    // Check stock
    const product = await ctx.db.get(cartItem.productId);
    if (!product) {
      throw new Error("Product not found");
    }
    // Raising a line needs a listing the buyer can still buy. Lowering it never does.
    if (!isStoredQuantityValid(cartItem.quantity) || args.quantity > cartItem.quantity) {
      if (!(await isPurchasableProduct(ctx, product))) {
        throw new Error("Product is not available");
      }
    }
    const availableQuantity = getAvailableQuantity(product, cartItem.selectedVariant, cartItem.selectedVariantOptions);
    if (args.quantity > availableQuantity) {
      throw new Error("Cannot add more than available stock");
    }

    await ctx.db.patch(args.cartItemId, {
      quantity: args.quantity,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.cartItemId);
  },
});

// Update cart item shipping option
export const updateCartShipping = mutation({
  args: {
    cartItemId: v.id("cartItems"),
    selectedShipping: v.object({
      name: v.string(),
      price: v.number(),
    }),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const cartItem = await ctx.db.get(args.cartItemId);
    if (!cartItem) {
      throw new Error("Cart item not found");
    }
    if (cartItem.userId !== actor._id) {
      throw new Error("Unauthorized");
    }

    await ctx.db.patch(args.cartItemId, {
      selectedShipping: args.selectedShipping,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.cartItemId);
  },
});

// Remove item from cart
export const removeFromCart = mutation({
  args: {
    cartItemId: v.id("cartItems"),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const cartItem = await ctx.db.get(args.cartItemId);
    if (!cartItem) {
      throw new Error("Cart item not found");
    }
    if (cartItem.userId !== actor._id) {
      throw new Error("Unauthorized");
    }

    await ctx.db.delete(args.cartItemId);
  },
});

// Clear user's cart
export const clearCart = mutation({
  args: {},
  handler: async (ctx, _args) => {
    const actor = await requireUser(ctx);
    const cartItems = await ctx.db
      .query("cartItems")
      .withIndex("by_user", (q) => q.eq("userId", actor._id))
      .collect();

    for (const item of cartItems) {
      await ctx.db.delete(item._id);
    }
  },
});

// Get cart item count
export const getCartCount = query({
  args: {},
  handler: async (ctx, _args) => {
    const actor = await requireUser(ctx);
    const cartItems = await ctx.db
      .query("cartItems")
      .withIndex("by_user", (q) => q.eq("userId", actor._id))
      .collect();

    return cartItems.length;
  },
});

// Validate cart items (check stock and status before checkout)
export const validateCart = query({
  args: {},
  handler: async (ctx, _args) => {
    const actor = await requireUser(ctx);
    const cartItems = await ctx.db
      .query("cartItems")
      .withIndex("by_user", (q) => q.eq("userId", actor._id))
      .collect();

    const issues: CartIssue[] = [];

    for (const item of cartItems) {
      const product = await ctx.db.get(item.productId);

      if (!product) {
        issues.push({ productId: item.productId, reason: "product_missing", issue: "Product no longer exists" });
        continue;
      }

      if (product.status !== "active") {
        issues.push({
          productId: item.productId,
          reason: "product_unavailable",
          issue: "Product is no longer available",
        });
        continue;
      }

      if (!(await isPublicStorefrontSeller(ctx, product.sellerId))) {
        issues.push({
          productId: item.productId,
          reason: "seller_unavailable",
          issue: "Seller is no longer available",
        });
        continue;
      }

      // A line with a non-finite or non-positive stored value can never pass, even when stock looks sufficient.
      if (!priceCartLine(product, item)) {
        issues.push({
          productId: item.productId,
          reason: "invalid_line",
          issue: "This item has an invalid quantity or price. Remove it and add it again",
        });
        continue;
      }

      const availableQuantity = getAvailableQuantity(product, item.selectedVariant, item.selectedVariantOptions);

      if (availableQuantity < item.quantity) {
        issues.push({
          productId: item.productId,
          reason: "insufficient_stock",
          issue: `Only ${availableQuantity} items available`,
        });
      }
    }

    return {
      isValid: issues.length === 0,
      issues,
      itemCount: cartItems.length,
    };
  },
});

// Get cart items grouped by seller (for checkout)
export const getCartBySeller = query({
  args: {},
  handler: async (ctx, _args) => {
    const actor = await requireUser(ctx);
    const cartItems = await ctx.db
      .query("cartItems")
      .withIndex("by_user", (q) => q.eq("userId", actor._id))
      .collect();

    const sellerGroups: Record<
      string,
      {
        sellerId: string;
        sellerName: string;
        items: Array<{
          _id: string;
          productId: string;
          quantity: number;
          selectedShipping: { name: string; price: number };
          selectedVariant?: SelectedVariant;
          selectedVariantOptions?: SelectedVariantOption[];
          selectedAddOns?: SelectedAddOn[];
          customizationKey?: string;
          lineUnitPrice: number;
          product: {
            _id: string;
            title: string;
            price: number;
            images: string[];
            quantity: number;
            categoryId: string;
            subcategoryId?: string;
            classificationId?: string;
            weightKg?: number;
          };
        }>;
        subtotal: number;
        shippingTotal: number;
      }
    > = {};

    for (const item of cartItems) {
      const product = await ctx.db.get(item.productId);
      if (!product) {
        continue;
      }

      // Checkout offers only lines the buyer may see and can buy now, under the same rules as getCart and validateCart.
      if (!(await canViewerSeeProduct(ctx, product, actor))) {
        continue;
      }
      if (!(await isPurchasableProduct(ctx, product))) {
        continue;
      }

      const priced = priceCartLine(product, item);
      if (!priced) {
        continue;
      }

      const sellerId = product.sellerId;
      const resolvedShipping = priced.shipping;
      const lineUnitPrice = priced.lineUnitPrice;

      if (!sellerGroups[sellerId]) {
        const sellerInfo = await getSellerDisplayInfo(ctx, sellerId);
        sellerGroups[sellerId] = {
          sellerId,
          sellerName: sellerInfo.displayName,
          items: [],
          subtotal: 0,
          shippingTotal: 0,
        };
      }

      sellerGroups[sellerId].items.push({
        ...item,
        selectedShipping: resolvedShipping,
        lineUnitPrice,
        product: {
          _id: product._id,
          title: product.title,
          price: product.price,
          images: product.images,
          quantity: product.quantity,
          categoryId: product.categoryId,
          subcategoryId: product.subcategoryId,
          classificationId: product.classificationId,
          weightKg: product.weightKg,
        },
      });
      sellerGroups[sellerId].subtotal += lineUnitPrice * item.quantity;
      sellerGroups[sellerId].shippingTotal += resolvedShipping.price;
    }

    return Object.values(sellerGroups);
  },
});
