/**
 * useAIRecommendations Hook
 * Fetches AI-powered product recommendations for the current user
 */

import { useQuery } from 'convex/react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../convex/_generated/api';
import { useAppAuth } from '../context/AuthProvider';
import { hasAIConsent } from '../services/aiConsent';
import { apiService } from '../services/api';
import type { Product } from '../types';

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

  const fetchRecommendations = useCallback(async () => {
    if (!user || !enabled) {
      setRecommendedIds([]);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      if (!(await hasAIConsent())) {
        setRecommendedIds([]);
        setReasoning(null);
        return;
      }

      const response = await apiService.getRecommendations({
        userId: user._id,
        limit,
      });

      setRecommendedIds(response.productIds);
      setReasoning(response.reasoning);
    } catch (err) {
      console.error('Failed to fetch AI recommendations:', err);
      setError(err instanceof Error ? err.message : 'Failed to load recommendations');
      setRecommendedIds([]);
    } finally {
      setIsLoading(false);
    }
  }, [user, limit, enabled]);

  // Fetch recommendations when user changes or trigger is updated
  useEffect(() => {
    fetchRecommendations();
  }, [fetchRecommendations, fetchTrigger]);

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

  // Fetch product details for similar IDs
  const products = useQuery(
    api.products.getProductsByIds,
    similarIds.length > 0 ? { productIds: similarIds } : 'skip'
  );

  useEffect(() => {
    if (!productId || !enabled) {
      setSimilarIds([]);
      return;
    }

    const fetchSimilar = async () => {
      setIsLoading(true);
      setError(null);

      try {
        if (!(await hasAIConsent())) {
          setSimilarIds([]);
          return;
        }

        const ids = await apiService.getSimilarProducts({
          productId,
          limit,
        });
        setSimilarIds(ids);
      } catch (err) {
        console.error('Failed to fetch similar products:', err);
        setError(err instanceof Error ? err.message : 'Failed to load similar products');
        setSimilarIds([]);
      } finally {
        setIsLoading(false);
      }
    };

    fetchSimilar();
  }, [productId, limit, enabled]);

  return {
    similarProducts: products?.filter((p): p is Product => p !== null) ?? [],
    isLoading: isLoading || (similarIds.length > 0 && products === undefined),
    error,
  };
}

export default useAIRecommendations;
