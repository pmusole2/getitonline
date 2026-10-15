/**
 * useAIRecommendations Hook
 * Fetches AI-powered product recommendations for the current user
 */

import { AiRequestError } from '@gettitonline/shared';
import { useQuery } from 'convex/react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../convex/_generated/api';
import { useAppAuth } from '../context/AuthProvider';
import { aiErrorMessage } from '../services/aiAdapters';
import type { Product } from '../types';
import { useAiActions } from './useAiActions';

// Consent that is off, and a discarded result for a previous account, are not errors on these panels.
function failureMessage(err: unknown): string | null {
  if (err instanceof AiRequestError && (err.code === 'consent_required' || err.code === 'account_changed')) {
    return null;
  }
  return aiErrorMessage(err);
}

interface UseAIRecommendationsOptions {
  limit?: number;
  enabled?: boolean;
}

interface UseAIRecommendationsResult {
  recommendations: Product[];
  isLoading: boolean;
  error: string | null;
  reasoning: string | null;
  refetch: () => void;
}

export function useAIRecommendations(
  options: UseAIRecommendationsOptions = {}
): UseAIRecommendationsResult {
  const { limit = 6, enabled = true } = options;
  const { user } = useAppAuth();
  const ai = useAiActions();

  const [recommendedIds, setRecommendedIds] = useState<string[]>([]);
  const [reasoning, setReasoning] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchTrigger, setFetchTrigger] = useState(0);

  // Fetch product details for recommended IDs
  const productsData = useQuery(
    api.products.getProductsByIds,
    recommendedIds.length > 0 ? { productIds: recommendedIds } : 'skip'
  );

  // Filter out user's own products and null values (safety net - backend should already do this)
  const products = productsData?.filter((p): p is Product => p !== null && p.sellerId !== user?._id) ?? [];

  // Recommendations belong to the account that asked. A change of account clears them, so none stay on screen.
  const { subject } = ai;
  useEffect(() => {
    setRecommendedIds([]);
    setReasoning(null);
    setError(null);
  }, [subject]);

  // A request whose account changed, or that a newer request replaced, is ignored when it finishes.
  useEffect(() => {
    if (!user || !enabled) {
      setRecommendedIds([]);
      return;
    }

    let isCurrent = true;
    setIsLoading(true);
    setError(null);

    // The effect cleanup marks a superseded request. `ai.isCurrent` also covers a switch whose cleanup has not run yet.
    const stillCurrent = () => isCurrent && ai.isCurrent();

    ai.getRecommendations({ limit })
      .then((response) => {
        if (!stillCurrent()) return;
        setRecommendedIds(response.productIds);
        setReasoning(response.reasoning);
      })
      .catch((err: unknown) => {
        if (!stillCurrent()) return;
        setRecommendedIds([]);
        setReasoning(null);
        setError(failureMessage(err));
      })
      .finally(() => {
        if (stillCurrent()) setIsLoading(false);
      });

    return () => {
      isCurrent = false;
    };
  }, [ai, user, limit, enabled, fetchTrigger]);

  const refetch = useCallback(() => {
    setFetchTrigger((prev) => prev + 1);
  }, []);

  return {
    recommendations: products,
    isLoading: isLoading || (recommendedIds.length > 0 && productsData === undefined),
    error,
    reasoning,
    refetch,
  };
}

/**
 * useSimilarProducts Hook
 * Fetches similar products for a given product
 */
interface UseSimilarProductsOptions {
  productId: string;
  limit?: number;
  enabled?: boolean;
}

interface UseSimilarProductsResult {
  similarProducts: Product[];
  isLoading: boolean;
  error: string | null;
}

export function useSimilarProducts(
  options: UseSimilarProductsOptions
): UseSimilarProductsResult {
  const { productId, limit = 4, enabled = true } = options;

  const [similarIds, setSimilarIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ai = useAiActions();

  // Fetch product details for similar IDs
  const products = useQuery(
    api.products.getProductsByIds,
    similarIds.length > 0 ? { productIds: similarIds } : 'skip'
  );

  // Similar products belong to the account that asked, so a change of account clears them.
  const { subject } = ai;
  useEffect(() => {
    setSimilarIds([]);
    setError(null);
  }, [subject]);

  useEffect(() => {
    if (!productId || !enabled) {
      setSimilarIds([]);
      return;
    }

    let isCurrent = true;
    setIsLoading(true);
    setError(null);

    ai.getSimilarProducts({ productId, limit })
      .then((ids) => {
        if (isCurrent) setSimilarIds(ids);
      })
      .catch((err: unknown) => {
        if (!isCurrent) return;
        setSimilarIds([]);
        setError(failureMessage(err));
      })
      .finally(() => {
        if (isCurrent) setIsLoading(false);
      });

    return () => {
      isCurrent = false;
    };
  }, [ai, productId, limit, enabled]);

  return {
    similarProducts: products?.filter((p): p is Product => p !== null) ?? [],
    isLoading: isLoading || (similarIds.length > 0 && products === undefined),
    error,
  };
}

export default useAIRecommendations;
