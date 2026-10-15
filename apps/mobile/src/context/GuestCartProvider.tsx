import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  GETTITONLINE_GUEST_CART_STORAGE_KEY,
  GuestCartItem,
  GuestCartItemArraySchema,
  GuestCartSummary,
  calculateGuestCartSummary,
  getMergeGuestCartSkipReasonMessage,
} from "@gettitonline/shared";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { useMutation } from "convex/react";
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Alert } from "react-native";
import { useAppAuth } from "./AuthProvider";
import {
  MAX_GUEST_CART_QUANTITY,
  normalizeGuestCartQuantity,
} from "./guestCartQuantity";

interface GuestCartContextValue {
  items: GuestCartItem[];
  summary: GuestCartSummary;
  isHydrated: boolean;
  isMerging: boolean;
  hasPendingMerge: boolean;
  mergeFailed: boolean;
  addItem: (item: GuestCartItem) => void;
  updateQuantity: (productId: string, quantity: number) => void;
  updateShipping: (
    productId: string,
    selectedShipping: GuestCartItem["selectedShipping"]
  ) => void;
  removeItem: (productId: string) => void;
  clear: () => void;
}

const GuestCartContext = createContext<GuestCartContextValue | undefined>(
  undefined
);

async function readStoredGuestCart(): Promise<GuestCartItem[]> {
  const rawCart = await AsyncStorage.getItem(
    GETTITONLINE_GUEST_CART_STORAGE_KEY
  );

  if (!rawCart) {
    return [];
  }

  try {
    const parsedCart = JSON.parse(rawCart) as unknown;
    const result = GuestCartItemArraySchema.safeParse(parsedCart);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

export function GuestCartProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, isSignedIn } = useAppAuth();
  const mergeGuestCart = useMutation(api.cart.mergeGuestCart);
  const userId = user?._id ?? null;

  const [items, setItems] = useState<GuestCartItem[]>([]);
  const [isHydrated, setIsHydrated] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [mergeFailed, setMergeFailed] = useState(false);
  const attemptedMergeKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function hydrateGuestCart() {
      const storedItems = await readStoredGuestCart();

      if (isMounted) {
        setItems(storedItems);
        setIsHydrated(true);
      }
    }

    void hydrateGuestCart();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    async function persistGuestCart() {
      if (items.length === 0) {
        await AsyncStorage.removeItem(GETTITONLINE_GUEST_CART_STORAGE_KEY);
        return;
      }

      await AsyncStorage.setItem(
        GETTITONLINE_GUEST_CART_STORAGE_KEY,
        JSON.stringify(items)
      );
    }

    void persistGuestCart();
  }, [isHydrated, items]);

  const mergeKey =
    isHydrated && isSignedIn && userId && items.length > 0
      ? `${userId}:${items
          .map((item) => `${item.customizationKey ?? item.productId}:${item.quantity}`)
          .join("|")}`
      : null;

  useEffect(() => {
    if (!mergeKey || !userId || !isSignedIn || items.length === 0) {
      if (!isSignedIn || !userId || items.length === 0) {
        attemptedMergeKeyRef.current = null;
        setMergeFailed(false);
      }
      return;
    }

    if (attemptedMergeKeyRef.current === mergeKey) {
      return;
    }

    attemptedMergeKeyRef.current = mergeKey;
    let isCancelled = false;

    async function mergeStoredGuestCart() {
      setMergeFailed(false);
      setIsMerging(true);

      try {
        if (!userId) {
          return;
        }

        const result = await mergeGuestCart({
          items: items.flatMap((item) => {
            const quantity = normalizeGuestCartQuantity(item.quantity);
            return quantity === null
              ? []
              : [
                  {
                    ...item,
                    quantity,
                    productId: item.productId as Id<"products">,
                  },
                ];
          }),
        });

        if (isCancelled) {
          return;
        }

        setItems([]);

        if (result.skipped.length > 0) {
          const skippedSummary = result.skipped
            .slice(0, 3)
            .map((item) => getMergeGuestCartSkipReasonMessage(item.reason))
            .join("\n");

          Alert.alert(
            "Some cart items could not be synced",
            result.skipped.length > 3
              ? `${skippedSummary}\n...and ${result.skipped.length - 3} more`
              : skippedSummary
          );
        }
      } catch (error: unknown) {
        if (!isCancelled) {
          setMergeFailed(true);
          const errorMessage =
            error instanceof Error
              ? error.message
              : "Failed to sync your guest cart";
          Alert.alert("Cart Sync Failed", errorMessage);
        }
      } finally {
        if (!isCancelled) {
          setIsMerging(false);
        }
      }
    }

    void mergeStoredGuestCart();

    return () => {
      isCancelled = true;
    };
  }, [isSignedIn, items, mergeGuestCart, mergeKey, userId]);

  const summary = calculateGuestCartSummary(items);
  const hasPendingMerge = Boolean(mergeKey) && !mergeFailed;

  const addItem = (item: GuestCartItem) => {
    const quantity = normalizeGuestCartQuantity(item.quantity);
    if (quantity === null) {
      return;
    }

    setItems((currentItems) => {
      const itemKey = item.customizationKey ?? item.productId;
      const existingItem = currentItems.find(
        (currentItem) => (currentItem.customizationKey ?? currentItem.productId) === itemKey
      );

      if (!existingItem) {
        return [...currentItems, { ...item, quantity }];
      }

      return currentItems.map((currentItem) => {
        if ((currentItem.customizationKey ?? currentItem.productId) !== itemKey) {
          return currentItem;
        }

        return {
          ...currentItem,
          quantity: Math.min(
            currentItem.quantity + quantity,
            Math.max(item.product.quantity, 1),
            MAX_GUEST_CART_QUANTITY
          ),
          selectedShipping: item.selectedShipping,
          selectedVariantOptions: item.selectedVariantOptions,
          selectedAddOns: item.selectedAddOns,
          customizationKey: item.customizationKey,
          product: item.product,
        };
      });
    });
  };

  const updateQuantity = (productId: string, quantity: number) => {
    const nextQuantity = normalizeGuestCartQuantity(quantity);

    setItems((currentItems) => {
      if (nextQuantity === null) {
        return currentItems.filter((item) => item.productId !== productId);
      }

      return currentItems.map((item) => {
        const itemKey = item.customizationKey ?? item.productId;
        if (itemKey !== productId) {
          return item;
        }

        return {
          ...item,
          quantity: Math.min(nextQuantity, Math.max(item.product.quantity, 1)),
        };
      });
    });
  };

  const updateShipping = (
    productId: string,
    selectedShipping: GuestCartItem["selectedShipping"]
  ) => {
    setItems((currentItems) =>
      currentItems.map((item) =>
        (item.customizationKey ?? item.productId) === productId
          ? { ...item, selectedShipping }
          : item
      )
    );
  };

  const removeItem = (productId: string) => {
    setItems((currentItems) =>
      currentItems.filter((item) => (item.customizationKey ?? item.productId) !== productId)
    );
  };

  const clear = () => {
    setItems([]);
  };

  return (
    <GuestCartContext.Provider
      value={{
        items,
        summary,
        isHydrated,
        isMerging,
        hasPendingMerge,
        mergeFailed,
        addItem,
        updateQuantity,
        updateShipping,
        removeItem,
        clear,
      }}
    >
      {children}
    </GuestCartContext.Provider>
  );
}

export function useGuestCart() {
  const context = useContext(GuestCartContext);

  if (!context) {
    throw new Error("useGuestCart must be used within a GuestCartProvider");
  }

  return context;
}
