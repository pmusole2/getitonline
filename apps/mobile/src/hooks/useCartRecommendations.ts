import { AiRequestError } from '@gettitonline/shared';
import { useConvex } from 'convex/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../../convex/_generated/api';
import { useAppAuth } from '../context/AuthProvider';
import { requestAIConsent } from '../services/aiConsent';
import type { Product } from '../types';
import { useAiActions } from './useAiActions';

interface CartRecommendationItem {
  productId: string;
  quantity: number;
  selectedVariant?: unknown;
  selectedVariantOptions?: unknown;
  selectedAddOns?: unknown;
  selectedShipping?: unknown;
}

type Status = 'idle' | 'guest' | 'loading' | 'consent_required' | 'empty' | 'error' | 'ready';

interface Ownership {
  key: string;
  generation: number;
}

interface RecommendationState {
  owner: Ownership;
  status: Status;
  products: Product[];
}

interface CartRecommendations {
  status: Status;
  products: Product[];
  error: string | null;
  askPinkie(): Promise<void>;
  refresh(): void;
}

export function useCartRecommendations({
  items,
  enabled,
}: {
  items: readonly CartRecommendationItem[];
  enabled: boolean;
}): CartRecommendations {
  const ai = useAiActions();
  const { user } = useAppAuth();
  const convex = useConvex();
  // Stable values avoid a new request whenever CartScreen recreates its mapped item array. Quantities and choices retire
  // the previous result too, even though the server only needs the unique product IDs to check its authoritative cart.
  const fingerprint = JSON.stringify(items.map((item) => JSON.stringify(item)).sort());
  const idsKey = JSON.stringify([...new Set(items.map((item) => item.productId))].sort());
  const cartProductIds = useMemo<string[]>(() => JSON.parse(idsKey), [idsKey]);
  const sellerId = user?._id ?? null;
  const key = JSON.stringify([ai.subject, sellerId, enabled, fingerprint]);
  const [tracked, setTracked] = useState<Ownership>({ key, generation: 0 });
  const owner = tracked.key === key ? tracked : { key, generation: tracked.generation + 1 };
  if (owner !== tracked) {
    setTracked(owner);
  }

  const active = useRef(owner);
  const live = useRef(false);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    active.current = owner;
  }, [owner]);

  const [state, setState] = useState<RecommendationState>({ owner, status: 'idle', products: [] });
  const [refreshCount, setRefreshCount] = useState(0);
  const [askingOwner, setAskingOwner] = useState<Ownership | null>(null);
  const asking = askingOwner === owner;
  const ready = enabled && cartProductIds.length > 0;
  const isCurrent = useCallback((): boolean => live.current && active.current === owner && ai.isCurrent(), [ai, owner]);

  useEffect(() => {
    if (!ready || sellerId === null) {
      return;
    }

    let pending = true;
    const current = (): boolean => pending && isCurrent();
    setState({ owner, status: 'loading', products: [] });
    const load = async (): Promise<void> => {
      try {
        const response = await ai.getRecommendations({ limit: 3, cartProductIds });
        if (!current()) {
          return;
        }
        // A browsing fallback is never evidence of a match for this cart, even if a server unexpectedly sends IDs.
        const ids =
          response.source === 'ai'
            ? [...new Set(response.productIds)].filter((id) => !cartProductIds.includes(id))
            : [];
        if (ids.length === 0) {
          setState({ owner, status: 'empty', products: [] });
          return;
        }

        const products = await convex.query(api.products.getProductsByIds, { productIds: ids });
        if (!current()) {
          return;
        }
        const eligible = products.filter(
          (product): product is Product =>
            product !== null &&
            ids.includes(product._id) &&
            !cartProductIds.includes(product._id) &&
            product.sellerId !== sellerId &&
            product.status === 'active' &&
            Number.isSafeInteger(product.quantity) &&
            product.quantity > 0 &&
            product.availabilityStatus !== 'out_of_stock' &&
            product.availabilityStatus !== 'preorder' &&
            product.preorder?.isPreorder !== true &&
            (product.variantCombinations?.length
              ? product.variantCombinations.some(
                  (variant) => variant.status === 'active' && Number.isSafeInteger(variant.stock) && variant.stock > 0,
                )
              : (product.variants ?? []).every((variant) =>
                  variant.options.some(
                    (option) =>
                      option.quantity === undefined || (Number.isSafeInteger(option.quantity) && option.quantity > 0),
                  ),
                )),
        );
        setState({ owner, status: eligible.length > 0 ? 'ready' : 'empty', products: eligible });
      } catch (error: unknown) {
        if (!current()) {
          return;
        }
        setState({
          owner,
          status: error instanceof AiRequestError && error.code === 'consent_required' ? 'consent_required' : 'error',
          products: [],
        });
      }
    };
    void load();

    return () => {
      pending = false;
    };
  }, [ai, cartProductIds, convex, isCurrent, owner, ready, refreshCount, sellerId]);

  const refresh = useCallback((): void => {
    if (isCurrent()) {
      setRefreshCount((value) => value + 1);
    }
  }, [isCurrent]);

  const askPinkie = useCallback(async (): Promise<void> => {
    if (!isCurrent() || asking || !ready || sellerId === null) {
      return;
    }
    setAskingOwner(owner);
    try {
      const accepted = await requestAIConsent();
      if (isCurrent() && accepted) {
        refresh();
      }
    } catch {
      if (isCurrent()) {
        setState({ owner, status: 'error', products: [] });
      }
    } finally {
      if (isCurrent()) {
        setAskingOwner(null);
      }
    }
  }, [asking, isCurrent, owner, ready, refresh, sellerId]);

  // Ownership is checked during render: old products disappear before effects clean up, including an A → B → A cycle.
  const status: Status = !ready
    ? 'idle'
    : sellerId === null
      ? 'guest'
      : state.owner === owner
        ? state.status
        : 'loading';
  return {
    status: asking && state.owner === owner ? 'loading' : status,
    products: status === 'ready' ? state.products.filter((product) => !cartProductIds.includes(product._id)) : [],
    error: status === 'error' ? 'Recommendations are unavailable. Try again.' : null,
    askPinkie,
    refresh,
  };
}
