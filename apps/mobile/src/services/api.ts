/**
 * API Service - HTTP Client for NestJS Backend
 * Handles all communication with the AI and backend services
 */

import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { requireAIConsent } from './aiConsent';

// Helper to get the correct API URL for the current environment
function getApiUrl(): string {
  // 1. Check for EXPO_PUBLIC_API_URL environment variable (e.g., ngrok URL)
  const envUrl = process.env.EXPO_PUBLIC_API_URL;
  if (envUrl) {
    return envUrl;
  }

  // 2. Check for explicit configuration in app.json extra
  const configuredUrl = Constants.expoConfig?.extra?.apiUrl;
  if (configuredUrl) {
    return configuredUrl;
  }

  // 3. Get the host from Expo dev server (works for physical devices)
  const expoHost = Constants.expoConfig?.hostUri;
  if (expoHost) {
    const host = expoHost.split(':')[0];
    return `http://${host}:3001`;
  }

  // 4. Fallback for different platforms
  if (Platform.OS === 'android') {
    return 'http://10.0.2.2:3001';
  }

  return 'http://localhost:3001';
}

// ============================================================================
// TYPES
// ============================================================================

// Request Types
export interface GetRecommendationsRequest {
  userId: string;
  limit?: number;
}

export interface GetSimilarProductsRequest {
  productId: string;
  limit?: number;
}

export interface VisualSearchRequest {
  imageDataUrl: string;
}

export interface RephraseMessageRequest {
  message: string;
  senderRole: 'buyer' | 'seller' | 'moderator';
  disputeContext?: string;
}

export interface AnalyzeDisputeRequest {
  disputeId: string;
  viewerId: string;
  viewerRole: 'buyer' | 'seller' | 'moderator';
}

export interface GenerateResolutionMessageRequest {
  resolutionType: 'full_refund' | 'partial_refund' | 'no_refund';
  disputeTitle: string;
  category: 'not_received' | 'defective' | 'not_as_described' | 'other';
  orderAmount: number;
  productTitle: string;
  refundAmount?: number;
}

export interface ModerateListingRequest {
  reviewerId: string;
  productId: string;
  title: string;
  description: string;
  price: number;
  quantity: number;
  imageUrls: string[];
  categoryName?: string;
}

export interface ChatRequest {
  message: string;
  conversationHistory?: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
  context?: {
    userId?: string;
    currentScreen?: string;
    productId?: string;
    orderId?: string;
  };
}

// Response Types
export interface RecommendationsResponse {
  productIds: string[];
  reasoning: string;
}

export interface VisualSearchResponse {
  query: string;
  terms: string[];
}

export interface RephraseResponse {
  original: string;
  rephrased: string;
  isProfessional: boolean;
  issues: string[];
  suggestions: string[];
}

export interface DisputeAnalysisResponse {
  summary: string;
  keyPoints: {
    yourClaims: string[];      // Personalized: the viewer's claims
    theirClaims: string[];     // Personalized: the other party's claims
    buyerClaims: string[];     // Original buyer claims (for reference)
    sellerClaims: string[];    // Original seller claims (for reference)
  };
  sentiment: {
    yours: 'cooperative' | 'frustrated' | 'hostile' | 'neutral';   // Viewer's sentiment
    theirs: 'cooperative' | 'frustrated' | 'hostile' | 'neutral';  // Other party's sentiment
    buyer: 'cooperative' | 'frustrated' | 'hostile' | 'neutral';
    seller: 'cooperative' | 'frustrated' | 'hostile' | 'neutral';
  };
  suggestedResolutions: Array<{
    type: 'full_refund' | 'partial_refund' | 'no_refund' | 'replacement' | 'mutual_agreement';
    description: string;
    fairnessScore: number;
  }>;
  recommendedAction: string;
  riskLevel: 'low' | 'medium' | 'high';
  additionalNotes: string;
  viewerRole: 'buyer' | 'seller' | 'moderator';
}

export interface ChatResponse {
  message: string;
  suggestions?: string[];
  actions?: Array<{
    type: 'navigate' | 'search' | 'filter';
    label: string;
    payload: Record<string, string>;
  }>;
}

export interface ApiHealthResponse {
  status: string;
  aiConfigured: boolean;
  timestamp: string;
}

export interface ModerateListingResponse {
  status: string;
  summary?: string;
  flags?: string[];
}

// Error Type
export interface ApiError {
  statusCode: number;
  message: string;
  error?: string;
}

// ============================================================================
// API SERVICE
// ============================================================================

class ApiService {
  private baseUrl: string;
  private apiPrefix: string = '/api/v1';

  constructor() {
    this.baseUrl = getApiUrl();
    console.log('[ApiService] Using API URL:', this.baseUrl);
  }

  /**
   * Set the API base URL (useful for dynamic configuration)
   */
  setBaseUrl(url: string) {
    this.baseUrl = url;
  }

  /**
   * Generic fetch wrapper with error handling
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${this.apiPrefix}${endpoint}`;

    const config: RequestInit = {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    };

    try {
      const response = await fetch(url, config);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: 'Unknown error occurred',
        }));
        throw new ApiServiceError(
          errorData.message || `Request failed with status ${response.status}`,
          response.status
        );
      }

      return await response.json();
    } catch (error) {
      if (error instanceof ApiServiceError) {
        throw error;
      }

      // Network or other errors
      throw new ApiServiceError(
        error instanceof Error ? error.message : 'Network error',
        0
      );
    }
  }

  /**
   * Generic GET request
   */
  async get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'GET' });
  }

  /**
   * Generic POST request
   */
  async post<T>(endpoint: string, data: Record<string, unknown>): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  /**
   * Generic PUT request
   */
  async put<T>(endpoint: string, data: Record<string, unknown>): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  /**
   * Generic DELETE request
   */
  async delete<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'DELETE' });
  }

  // ============================================================================
  // AI ENDPOINTS
  // ============================================================================

  private async requestAI<T>(
    endpoint: string,
    request: Record<string, unknown>,
  ): Promise<T> {
    await requireAIConsent();
    return this.request<T>(endpoint, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /**
   * Get personalized product recommendations for a user
   */
  async getRecommendations(
    request: GetRecommendationsRequest
  ): Promise<RecommendationsResponse> {
    return this.requestAI<RecommendationsResponse>('/ai/recommendations', {
      ...request,
    });
  }

  /**
   * Get similar products for a given product
   */
  async getSimilarProducts(
    request: GetSimilarProductsRequest
  ): Promise<string[]> {
    return this.requestAI<string[]>('/ai/similar-products', {
      ...request,
    });
  }

  /**
   * Generate product search terms from a captured image
   */
  async visualSearch(
    request: VisualSearchRequest
  ): Promise<VisualSearchResponse> {
    return this.requestAI<VisualSearchResponse>('/ai/visual-search', {
      ...request,
    });
  }

  /**
   * Analyze and rephrase a message for professionalism
   */
  async rephraseMessage(
    request: RephraseMessageRequest
  ): Promise<RephraseResponse> {
    return this.requestAI<RephraseResponse>('/ai/rephrase-message', {
      ...request,
    });
  }

  /**
   * Analyze a dispute and get resolution suggestions
   */
  async analyzeDispute(
    request: AnalyzeDisputeRequest
  ): Promise<DisputeAnalysisResponse> {
    return this.requestAI<DisputeAnalysisResponse>('/ai/analyze-dispute', {
      ...request,
    });
  }

  /**
   * Run AI moderation for a listing review item
   */
  async moderateListing(
    request: ModerateListingRequest
  ): Promise<ModerateListingResponse> {
    return this.requestAI<ModerateListingResponse>('/ai/moderate-listing', {
      ...request,
    });
  }

  /**
   * Generate a professional resolution message
   */
  async generateResolutionMessage(
    request: GenerateResolutionMessageRequest
  ): Promise<{ message: string }> {
    return this.requestAI<{ message: string }>('/ai/generate-resolution-message', {
      ...request,
    });
  }

  /**
   * General AI chat for the assistant
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    return this.requestAI<ChatResponse>('/ai/chat', {
      ...request,
    });
  }

  /**
   * Get response suggestions for dispute conversations
   */
  async getResponseSuggestions(
    conversationHistory: Array<{ sender: string; message: string }>,
    respondAs: 'buyer' | 'seller' | 'moderator',
    disputeContext: string
  ): Promise<string[]> {
    return this.requestAI<string[]>('/ai/suggest-responses', {
      conversationHistory,
      respondAs,
      disputeContext,
    });
  }

  // ============================================================================
  // HEALTH CHECK
  // ============================================================================

  /**
   * Check if the API and AI services are healthy
   */
  async checkHealth(): Promise<ApiHealthResponse> {
    return this.request<ApiHealthResponse>('/ai/health', {
      method: 'GET',
    });
  }

  /**
   * Check if the API is reachable
   */
  async isReachable(): Promise<boolean> {
    try {
      await this.checkHealth();
      return true;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// ERROR CLASS
// ============================================================================

export class ApiServiceError extends Error {
  public statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'ApiServiceError';
    this.statusCode = statusCode;
  }

  isNetworkError(): boolean {
    return this.statusCode === 0;
  }

  isNotFound(): boolean {
    return this.statusCode === 404;
  }

  isServerError(): boolean {
    return this.statusCode >= 500;
  }

  isClientError(): boolean {
    return this.statusCode >= 400 && this.statusCode < 500;
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const apiService = new ApiService();
export default apiService;
