import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Convex HTTP Client Service
 * Uses raw HTTP calls to Convex functions
 */
@Injectable()
export class ConvexService implements OnModuleInit {
  private convexUrl: string;
  private isConfigured = false;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const url = this.configService.get<string>('convex.url');
    if (!url) {
      console.warn('Convex URL not configured - Convex features will be disabled');
      return;
    }
    this.convexUrl = url;
    this.isConfigured = true;
  }

  private ensureConfigured() {
    if (!this.isConfigured) {
      throw new Error('Convex is not configured');
    }
  }

  private async query<T>(functionPath: string, args: Record<string, any> = {}): Promise<T> {
    this.ensureConfigured();

    const response = await fetch(`${this.convexUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: functionPath,
        args,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Convex query failed: ${error}`);
    }

    const result = await response.json();
    return result.value;
  }

  private async mutation<T>(functionPath: string, args: Record<string, any> = {}): Promise<T> {
    this.ensureConfigured();

    console.log(`🔄 Calling Convex mutation: ${functionPath}`);
    console.log(`📤 Args:`, JSON.stringify(args, null, 2));

    const response = await fetch(`${this.convexUrl}/api/mutation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: functionPath,
        args,
      }),
    });

    const responseText = await response.text();
    console.log(`📥 Response status: ${response.status}`);
    console.log(`📥 Response body: ${responseText}`);

    if (!response.ok) {
      throw new Error(`Convex mutation failed: ${responseText}`);
    }

    try {
      const result = JSON.parse(responseText);
      return result.value;
    } catch {
      console.error(`Failed to parse Convex response: ${responseText}`);
      throw new Error(`Invalid Convex response: ${responseText}`);
    }
  }

  // User queries
  async getUser(userId: string) {
    return await this.query<any>('users:getUser', { userId });
  }

  async getUserByClerkId(clerkId: string) {
    return await this.query<any>('users:getUserByClerkId', { clerkId });
  }

  // Product queries
  async getProduct(productId: string) {
    return await this.query<any>('products:getProduct', { productId });
  }

  async getActiveProducts(limit: number = 50) {
    return await this.query<any[]>('products:getRecentProducts', { limit });
  }

  async getProductsByCategories(categoryIds: string[], limit: number = 10) {
    return await this.query<any[]>('products:getProductsByCategories', {
      categoryIds,
      limit,
    });
  }

  async getUserBehaviorSummary(userId: string, limit: number = 100) {
    return await this.query<{
      recentlyViewedProductIds: string[];
      recentlyViewedCategoryIds: string[];
      purchaseCategoryIds: string[];
    }>('notifications:getUserBehaviorSummary', { userId, limit });
  }

  // Category queries
  async getCategories() {
    return await this.query<any[]>('categories:getCategoriesTree', {});
  }

  async getCategory(categoryId: string) {
    return await this.query<any>('categories:getCategory', { categoryId });
  }

  // Order queries
  async getOrder(orderId: string) {
    return await this.query<any>('orders:getOrder', { orderId });
  }

  // Dispute queries
  async getDispute(disputeId: string) {
    return await this.query<any>('disputes:getDispute', { disputeId });
  }

  async getDisputeForAnalysis(disputeId: string) {
    const [dispute, messagesData] = await Promise.all([
      this.query<any>('disputes:getDispute', { disputeId }),
      this.query<any>('messages:getMessagesForAnalysis', { disputeId }),
    ]);

    if (!dispute || !messagesData) return null;

    return {
      dispute: {
        title: dispute.title,
        description: dispute.description,
        category: dispute.category,
        status: dispute.status,
      },
      order: dispute.order,
      messages: messagesData.messages,
      evidenceCount: dispute.evidence?.length || 0,
      buyer: dispute.buyer,
      seller: dispute.seller,
    };
  }

  // Dispute mutations
  async updateDisputeAiAnalysis(disputeId: string, summary: string, suggestions: string[]) {
    return await this.mutation<any>('disputes:updateAISummary', {
      disputeId,
      aiSummary: summary,
      aiSuggestions: suggestions,
    });
  }

  // Message queries
  async getMessages(disputeId: string) {
    return await this.query<any[]>('messages:getMessages', { disputeId });
  }

  // User mutations for webhook
  async upsertUser(data: {
    clerkId: string;
    email: string;
    firstName: string;
    lastName: string;
    avatar?: string;
  }) {
    return await this.mutation<any>('users:upsertUser', data);
  }

  // Category seeding
  async seedCategories(adminId: string) {
    return await this.mutation<any>('categories:seedCategories', { adminId });
  }

  // Search products
  async searchProducts(query: string, limit: number = 10) {
    return await this.query<any[]>('products:searchProducts', { query, limit });
  }

  // Get user's orders (as buyer)
  async getUserOrders(userId: string) {
    return await this.query<any[]>('orders:getBuyerOrders', { buyerId: userId });
  }

  // Get user's listings (products they're selling)
  async getUserListings(userId: string) {
    return await this.query<any[]>('products:getProductsBySeller', { sellerId: userId });
  }

  async storeListingModerationResult(data: {
    productId: string;
    reviewerId: string;
    status: 'clear' | 'flagged' | 'error';
    summary: string;
    flags: string[];
  }) {
    return await this.mutation('products:storeListingModerationResult', data);
  }

  // Get marketplace stats
  async getMarketplaceStats() {
    const [products, categories] = await Promise.all([
      this.getActiveProducts(200),
      this.getCategories(),
    ]);

    return {
      totalProducts: products?.length || 0,
      totalCategories: categories?.length || 0,
      products,
      categories,
    };
  }

  // ============ Transaction Methods ============

  // Create a new transaction
  async createTransaction(data: {
    orderId?: string;
    userId: string;
    type: 'collection' | 'transfer' | 'refund';
    paymentMethod: 'mobile_money' | 'card' | 'bank_transfer';
    amount: number;
    currency: string;
    description?: string;
    mobileMoneyProvider?: 'mtn' | 'airtel' | 'zamtel';
    mobileNumber?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ transactionId: string; reference: string }> {
    return await this.mutation('transactions:createTransaction', data);
  }

  // Update transaction with Lenco IDs
  async updateTransactionLencoIds(data: {
    transactionId: string;
    lencoTransactionId?: string;
    lencoCollectionId?: string;
    status?: string;
  }) {
    return await this.mutation('transactions:updateTransactionLencoIds', data);
  }

  // Update transaction status
  async updateTransactionStatus(data: {
    reference: string;
    status: string;
    failureReason?: string;
    fee?: number;
    netAmount?: number;
    metadata?: Record<string, unknown>;
  }) {
    return await this.mutation('transactions:updateTransactionStatus', data);
  }

  // Update transaction by Lenco collection ID
  async updateTransactionByLencoId(data: {
    lencoCollectionId: string;
    reference?: string; // Fallback lookup
    status: string;
    failureReason?: string;
    fee?: number;
    metadata?: Record<string, unknown>;
  }) {
    return await this.mutation('transactions:updateTransactionByLencoId', data);
  }

  // Get transaction by reference
  async getTransactionByReference(reference: string) {
    return await this.query<any>('transactions:getTransactionByReference', { reference });
  }

  // Get transaction by ID
  async getTransaction(transactionId: string) {
    return await this.query<any>('transactions:getTransaction', { transactionId });
  }

  // Get user's transactions
  async getUserTransactions(userId: string, limit?: number, status?: string) {
    return await this.query<any[]>('transactions:getUserTransactions', {
      userId,
      limit,
      status,
    });
  }

  // Get order transactions
  async getOrderTransactions(orderId: string) {
    return await this.query<any[]>('transactions:getOrderTransactions', { orderId });
  }

  // Get pre-purchase conversation history for a product/buyer combo
  async getProductConversationHistory(productId: string, buyerId: string) {
    return await this.query<{
      conversationId: string;
      participants: { buyer: string; seller: string };
      messages: Array<{
        sender: 'buyer' | 'seller';
        content: string;
        timestamp: number;
      }>;
      messageCount: number;
    } | null>('conversations:getProductConversationHistory', { productId, buyerId });
  }

  // Get comprehensive order details for AI context
  async getComprehensiveOrderDetails(orderId: string): Promise<{
    order: Record<string, unknown>;
    buyer: Record<string, unknown> | null;
    seller: Record<string, unknown> | null;
    dispute: Record<string, unknown> | null;
    escrow: Record<string, unknown> | null;
    transactions: Array<Record<string, unknown>>;
    disputeMessages: Array<Record<string, unknown>>;
    prePurchaseMessages: Array<Record<string, unknown>>;
    timeline: Array<{ event: string; timestamp: number; details?: string }>;
  } | null> {
    try {
      const order = await this.getOrder(orderId);
      if (!order) return null;

      // Fetch all related data in parallel
      const [transactions, disputeData] = await Promise.all([
        this.getOrderTransactions(orderId).catch(() => []),
        this.query<Record<string, unknown> | null>('disputes:getDisputeByOrder', { orderId }).catch(() => null),
      ]);

      // Get escrow if exists
      let escrow: Record<string, unknown> | null = null;
      try {
        escrow = await this.query<Record<string, unknown> | null>('escrow:getEscrowByOrder', { orderId });
      } catch {
        // Escrow might not exist yet
      }

      // Get dispute messages if dispute exists
      let disputeMessages: Array<Record<string, unknown>> = [];
      if (disputeData?._id) {
        try {
          disputeMessages = await this.getMessages(disputeData._id as string);
        } catch {
          // Ignore message fetch errors
        }
      }

      // Get pre-purchase conversation if exists
      let prePurchaseMessages: Array<Record<string, unknown>> = [];
      if (order.items?.[0]?.productId) {
        try {
          const prePurchase = await this.getProductConversationHistory(
            order.items[0].productId,
            order.buyerId,
          );
          if (prePurchase?.messages) {
            prePurchaseMessages = prePurchase.messages as Array<Record<string, unknown>>;
          }
        } catch {
          // Ignore pre-purchase fetch errors
        }
      }

      // Build timeline
      const timeline: Array<{ event: string; timestamp: number; details?: string }> = [];

      // Order created
      timeline.push({
        event: 'Order placed',
        timestamp: order.createdAt,
        details: `Order #${order.orderNumber} created with ${order.items?.length || 0} item(s)`,
      });

      // Add transaction events
      for (const tx of transactions || []) {
        if (tx.status === 'successful') {
          timeline.push({
            event: 'Payment received',
            timestamp: tx.completedAt || tx.createdAt,
            details: `K${(tx.amount as number)?.toLocaleString()} via ${tx.paymentMethod}`,
          });
        } else if (tx.status === 'failed') {
          timeline.push({
            event: 'Payment failed',
            timestamp: tx.updatedAt || tx.createdAt,
            details: tx.failureReason as string || 'Payment could not be processed',
          });
        }
      }

      // Order status updates (we'll infer from current status)
      if (order.status === 'paid' || ['processing', 'shipped', 'delivered', 'completed', 'disputed'].includes(order.status)) {
        timeline.push({
          event: 'Order confirmed',
          timestamp: order.updatedAt,
          details: 'Payment confirmed, awaiting processing',
        });
      }

      if (['shipped', 'delivered', 'completed', 'disputed'].includes(order.status)) {
        timeline.push({
          event: 'Order shipped',
          timestamp: order.shippedAt || order.updatedAt,
          details: order.trackingNumber ? `Tracking: ${order.trackingNumber}` : 'Item dispatched',
        });
      }

      if (['delivered', 'completed', 'disputed'].includes(order.status)) {
        timeline.push({
          event: 'Delivered',
          timestamp: order.deliveredAt || order.updatedAt,
          details: 'Item delivered to buyer',
        });
      }

      // Dispute events
      if (disputeData) {
        timeline.push({
          event: 'Dispute opened',
          timestamp: disputeData.createdAt as number,
          details: `${disputeData.category}: ${disputeData.title}`,
        });

        if (disputeData.status === 'resolved') {
          const resolution = disputeData.resolution as
            | { resolvedAt?: number; type?: string }
            | undefined;
          timeline.push({
            event: 'Dispute resolved',
            timestamp: (resolution?.resolvedAt as number) || (disputeData.updatedAt as number),
            details: `Resolution: ${resolution?.type || 'mutual agreement'}`,
          });
        }
      }

      // Escrow events
      if (escrow) {
        if (escrow.status === 'held') {
          timeline.push({
            event: 'Funds held in escrow',
            timestamp: escrow.createdAt as number,
            details: `K${(escrow.grossAmount as number)?.toLocaleString()} secured`,
          });
        }
        if (escrow.status === 'released') {
          timeline.push({
            event: 'Funds released to seller',
            timestamp: escrow.releasedAt as number || escrow.updatedAt as number,
            details: `K${(escrow.sellerAmount as number)?.toLocaleString()} paid out`,
          });
        }
        if (escrow.status === 'refunded') {
          timeline.push({
            event: 'Buyer refunded',
            timestamp: escrow.updatedAt as number,
            details: `K${(escrow.refundAmount as number || escrow.grossAmount as number)?.toLocaleString()} returned`,
          });
        }
      }

      // Sort timeline by timestamp
      timeline.sort((a, b) => a.timestamp - b.timestamp);

      return {
        order,
        buyer: order.buyer,
        seller: order.seller,
        dispute: disputeData,
        escrow,
        transactions: transactions || [],
        disputeMessages,
        prePurchaseMessages,
        timeline,
      };
    } catch (error) {
      console.error('Failed to get comprehensive order details:', error);
      return null;
    }
  }

  // Get seller's orders
  async getSellerOrders(sellerId: string) {
    return await this.query<Array<Record<string, unknown>>>('orders:getSellerOrders', { sellerId });
  }

  // Get user's disputes (as buyer)
  async getBuyerDisputes(buyerId: string) {
    return await this.query<Array<Record<string, unknown>>>('disputes:getBuyerDisputes', { buyerId });
  }

  // Get user's disputes (as seller)
  async getSellerDisputes(sellerId: string) {
    return await this.query<Array<Record<string, unknown>>>('disputes:getSellerDisputes', { sellerId });
  }

  // Get escrow by order
  async getEscrowByOrder(orderId: string) {
    return await this.query<Record<string, unknown> | null>('escrow:getEscrowByOrder', { orderId });
  }

  // ============ Wallet Methods ============

  // Get wallet balance
  async getWalletBalance(userId: string): Promise<{
    balance: number;
    pendingBalance: number;
    totalEarned: number;
    totalWithdrawn: number;
    totalSpent: number;
    hasWallet: boolean;
    isActive?: boolean;
    isFrozen?: boolean;
  }> {
    return await this.query('wallet:getWalletBalance', { userId });
  }

  // Get wallet activity
  async getWalletActivity(userId: string): Promise<{
    recentTransactions: Array<Record<string, unknown>>;
    pendingWithdrawals: number;
    thisMonthEarnings: number;
    thisMonthWithdrawals: number;
  }> {
    return await this.query('wallet:getWalletActivity', { userId });
  }

  // Get wallet transactions
  async getWalletTransactions(
    userId: string,
    limit?: number,
    type?: string,
  ): Promise<Array<Record<string, unknown>>> {
    return await this.query('wallet:getWalletTransactions', {
      userId,
      limit,
      type,
    });
  }

  // Ensure wallet exists
  async ensureWallet(userId: string): Promise<{ _id: string }> {
    return await this.mutation('wallet:ensureWallet', { userId });
  }

  // Credit wallet
  async creditWallet(data: {
    userId: string;
    amount: number;
    source: string;
    description: string;
    orderId?: string;
    escrowId?: string;
    externalReference?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ transactionId: string; reference: string; newBalance: number }> {
    return await this.mutation('wallet:creditWallet', data);
  }

  // Debit wallet
  async debitWallet(data: {
    userId: string;
    amount: number;
    source: string;
    description: string;
    orderId?: string;
    paymentAccountId?: string;
    externalReference?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    transactionId: string;
    reference: string;
    newBalance: number;
    status: string;
  }> {
    return await this.mutation('wallet:debitWallet', data);
  }

  // Update wallet withdrawal status
  async updateWalletWithdrawalStatus(
    reference: string,
    status: 'completed' | 'failed' | 'cancelled',
    failureReason?: string,
    externalReference?: string,
  ): Promise<{ success: boolean }> {
    return await this.mutation('wallet:updateWithdrawalStatus', {
      reference,
      status,
      failureReason,
      externalReference,
    });
  }

  // Update wallet transaction with external reference
  async updateWalletTransactionExternal(
    reference: string,
    externalReference: string,
  ): Promise<void> {
    // This updates the transaction with the Lenco transaction ID
    await this.mutation('wallet:updateTransactionExternalReference', {
      reference,
      externalReference,
    });
  }

  // Update wallet transaction by Lenco ID (for webhooks)
  async updateWalletTransactionByLencoId(data: {
    lencoId: string;
    reference?: string;
    status: 'completed' | 'failed' | 'cancelled';
    failureReason?: string;
  }): Promise<{ success: boolean; transaction: string }> {
    return await this.mutation('wallet:updateWalletTransactionByLencoId', data);
  }

  // Create pending top-up (stores in transactions table for webhook tracking)
  async createPendingTopUp(data: {
    userId: string;
    amount: number;
    reference: string;
    lencoCollectionId: string;
    paymentMethod: 'mobile_money' | 'card';
    provider?: string;
  }): Promise<void> {
    // Create a transaction record for webhook tracking
    // This is different from wallet credit - this tracks the Lenco collection
    await this.mutation('transactions:createTopUpTransaction', {
      userId: data.userId,
      amount: data.amount,
      reference: data.reference,
      lencoCollectionId: data.lencoCollectionId,
      paymentMethod: data.paymentMethod,
      provider: data.provider,
    });
  }

  // Mark order as paid by wallet
  async markOrderPaidByWallet(
    orderId: string,
    walletReference: string,
  ): Promise<void> {
    await this.mutation('orders:markPaidByWallet', {
      orderId,
      walletReference,
    });
  }

  // Check if user can pay with wallet
  async canPayWithWallet(
    userId: string,
    amount: number,
  ): Promise<{
    canPay: boolean;
    reason?: string;
    currentBalance?: number;
    shortfall?: number;
    balanceAfterPayment?: number;
  }> {
    return await this.query('wallet:canPayWithWallet', { userId, amount });
  }
}
