import { Injectable } from '@nestjs/common';
import { ConvexService } from '../../convex/convex.service';
import { AiService } from '../ai.service';

interface ChatContext {
  userId?: string;
  currentScreen?: string;
  productId?: string;
  orderId?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatAction {
  type: 'navigate' | 'search' | 'filter';
  label: string;
  payload: Record<string, string>;
}

interface ChatResult {
  message: string;
  suggestions?: string[];
  actions?: ChatAction[];
}

interface MarketplaceStats {
  totalProducts: number;
  totalCategories: number;
  productsByCategory: Array<{ id: string; name: string; count: number }>;
  recentProducts: Array<{
    title: string;
    price: number;
    condition: string;
    categoryName: string;
  }>;
  priceRange: { min: number; max: number };
}

interface ProductSearchResult {
  title: string;
  price: number;
  condition: string;
  categoryId: string;
  categoryName?: string;
}

@Injectable()
export class ChatService {
  constructor(
    private aiService: AiService,
    private convexService: ConvexService,
  ) {}

  /**
   * Fetch real-time marketplace data for AI context
   */
  private async getMarketplaceData(): Promise<MarketplaceStats | null> {
    try {
      const [products, categories] = await Promise.all([
        this.convexService.getActiveProducts(200), // Get more products
        this.convexService.getCategories(),
      ]);

      if (!products || !categories) return null;

      // Build category lookup map
      const categoryMap = new Map<string, string>();
      for (const cat of categories) {
        categoryMap.set(cat._id, cat.name);
      }

      // Count products by category
      const categoryCounts = new Map<
        string,
        { id: string; name: string; count: number }
      >();
      for (const cat of categories) {
        categoryCounts.set(cat._id, { id: cat._id, name: cat.name, count: 0 });
      }

      let minPrice = Infinity;
      let maxPrice = 0;

      for (const product of products) {
        const catData = categoryCounts.get(product.categoryId);
        if (catData) {
          catData.count++;
        }
        if (product.price < minPrice) minPrice = product.price;
        if (product.price > maxPrice) maxPrice = product.price;
      }

      return {
        totalProducts: products.length,
        totalCategories: categories.length,
        productsByCategory: Array.from(categoryCounts.values()).filter(
          (c) => c.count > 0,
        ),
        recentProducts: products.slice(0, 20).map((p) => ({
          title: p.title,
          price: p.price,
          condition: p.condition,
          categoryName: categoryMap.get(p.categoryId) || 'Unknown',
        })),
        priceRange: {
          min: minPrice === Infinity ? 0 : minPrice,
          max: maxPrice,
        },
      };
    } catch (error) {
      console.error('Failed to fetch marketplace data:', error);
      return null;
    }
  }

  /**
   * Expand search terms to include related keywords
   */
  private expandSearchTerms(query: string): string[] {
    const lowerQuery = query.toLowerCase();
    const terms = [query];

    // Car/vehicle related expansions
    const carBrands = [
      'bmw',
      'toyota',
      'honda',
      'nissan',
      'mercedes',
      'audi',
      'volkswagen',
      'vw',
      'ford',
      'mazda',
      'hyundai',
      'kia',
      'suzuki',
      'mitsubishi',
      'subaru',
      'lexus',
      'isuzu',
      'land rover',
      'range rover',
      'jeep',
      'peugeot',
      'renault',
    ];
    const carTerms = [
      'car',
      'cars',
      'vehicle',
      'vehicles',
      'auto',
      'automobile',
      'motor',
    ];

    if (carTerms.some((term) => lowerQuery.includes(term))) {
      terms.push(...carBrands);
    }

    // If searching for a brand, also search for "car" category
    if (carBrands.some((brand) => lowerQuery.includes(brand))) {
      terms.push('car', 'vehicle', 'auto');
    }

    // Phone related
    const phoneBrands = [
      'iphone',
      'samsung',
      'xiaomi',
      'oppo',
      'huawei',
      'tecno',
      'infinix',
      'redmi',
      'pixel',
    ];
    const phoneTerms = ['phone', 'phones', 'mobile', 'smartphone', 'cell'];

    if (phoneTerms.some((term) => lowerQuery.includes(term))) {
      terms.push(...phoneBrands);
    }

    // Parts related
    const partsTerms = ['part', 'parts', 'spare', 'spares', 'component'];
    const partTypes = [
      'engine',
      'brake',
      'suspension',
      'filter',
      'oil',
      'tire',
      'tyre',
      'battery',
      'alternator',
      'starter',
      'radiator',
      'clutch',
      'gearbox',
      'transmission',
    ];

    if (partsTerms.some((term) => lowerQuery.includes(term))) {
      terms.push(...partTypes);
    }

    return [...new Set(terms)]; // Remove duplicates
  }

  /**
   * Fuzzy match check - does the product title contain any search terms?
   */
  private fuzzyMatch(title: string, searchTerms: string[]): boolean {
    const lowerTitle = title.toLowerCase();
    return searchTerms.some((term) => lowerTitle.includes(term.toLowerCase()));
  }

  /**
   * Search products based on query with fuzzy matching and category search
   */
  private async searchProducts(query: string): Promise<ProductSearchResult[]> {
    try {
      const expandedTerms = this.expandSearchTerms(query);
      const allResults: ProductSearchResult[] = [];
      const seenTitles = new Set<string>();

      // Get all categories for name matching
      const categoryMap = new Map<string, string>();
      const matchingCategoryIds: string[] = [];
      try {
        const categories = await this.convexService.getCategories();
        if (categories) {
          for (const cat of categories) {
            categoryMap.set(cat._id, cat.name);
            // Check if category name matches any search term
            const catNameLower = cat.name.toLowerCase();
            if (
              expandedTerms.some(
                (term) =>
                  catNameLower.includes(term.toLowerCase()) ||
                  term.toLowerCase().includes(catNameLower),
              )
            ) {
              matchingCategoryIds.push(cat._id);
            }
          }
        }
      } catch {
        // Continue without category matching
      }

      // Search with each expanded term (title search)
      for (const term of expandedTerms.slice(0, 5)) {
        try {
          const products = await this.convexService.searchProducts(term, 15);
          for (const p of products) {
            if (!seenTitles.has(p.title)) {
              seenTitles.add(p.title);
              allResults.push({
                title: p.title,
                price: p.price,
                condition: p.condition,
                categoryId: p.categoryId,
                categoryName: categoryMap.get(p.categoryId),
              });
            }
          }
        } catch {
          // Continue with other terms if one fails
        }
      }

      // Also do a broad search in all products for fuzzy matching AND category matching
      try {
        const allProducts = await this.convexService.getActiveProducts(200);
        for (const p of allProducts) {
          if (seenTitles.has(p.title)) continue;

          // Match by title OR by category
          const matchesTitle = this.fuzzyMatch(p.title, expandedTerms);
          const matchesCategory = matchingCategoryIds.includes(p.categoryId);
          const categoryName = categoryMap.get(p.categoryId) || '';
          const categoryNameMatches = this.fuzzyMatch(
            categoryName,
            expandedTerms,
          );

          if (matchesTitle || matchesCategory || categoryNameMatches) {
            seenTitles.add(p.title);
            allResults.push({
              title: p.title,
              price: p.price,
              condition: p.condition,
              categoryId: p.categoryId,
              categoryName: categoryMap.get(p.categoryId),
            });
          }
        }
      } catch {
        // Continue if broad search fails
      }

      return allResults.slice(0, 20); // Return top 20 results
    } catch {
      return [];
    }
  }

  /**
   * Get user's orders summary
   */
  private async getUserOrdersSummary(userId: string): Promise<{
    totalOrders: number;
    pendingOrders: number;
    completedOrders: number;
    disputedOrders: number;
    recentOrders: Array<{
      orderNumber: string;
      status: string;
      total: number;
      _id: string;
    }>;
  } | null> {
    try {
      const orders = await this.convexService.getUserOrders(userId);
      if (!orders) return null;

      const pendingStatuses = [
        'pending_payment',
        'paid',
        'processing',
        'shipped',
      ];
      const completedStatuses = ['delivered', 'completed'];

      return {
        totalOrders: orders.length,
        pendingOrders: orders.filter((o: { status: string }) =>
          pendingStatuses.includes(o.status),
        ).length,
        completedOrders: orders.filter((o: { status: string }) =>
          completedStatuses.includes(o.status),
        ).length,
        disputedOrders: orders.filter(
          (o: { status: string }) => o.status === 'disputed',
        ).length,
        recentOrders: orders
          .slice(0, 5)
          .map(
            (o: {
              _id: string;
              orderNumber: string;
              status: string;
              totalAmount: number;
            }) => ({
              _id: o._id,
              orderNumber: o.orderNumber,
              status: o.status,
              total: o.totalAmount,
            }),
          ),
      };
    } catch {
      return null;
    }
  }

  /**
   * Get comprehensive details for a specific order (for AI context)
   */
  private async getComprehensiveOrderContext(
    orderId: string,
    viewerRole: 'buyer' | 'seller',
  ): Promise<string> {
    try {
      const details =
        await this.convexService.getComprehensiveOrderDetails(orderId);
      if (!details) return '';

      const {
        order,
        buyer,
        seller,
        dispute,
        escrow,
        transactions,
        disputeMessages,
        prePurchaseMessages,
        timeline,
      } = details;

      let context = `\n\n=== COMPREHENSIVE ORDER DETAILS ===`;
      context += `\nOrder Number: #${order.orderNumber}`;
      context += `\nStatus: ${this.formatOrderStatus(order.status as string)}`;
      context += `\nPlaced on: ${new Date(
        order.createdAt as number,
      ).toLocaleDateString('en-ZM', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })}`;

      // Order items
      if (order.items && Array.isArray(order.items)) {
        context += `\n\nItems ordered (${order.items.length}):`;
        for (const item of order.items as Array<{
          title: string;
          price: number;
          quantity: number;
        }>) {
          context += `\n- ${item.title} (Qty: ${item.quantity}) - K${item.price.toLocaleString()}`;
        }
      }

      // Financial breakdown
      context += `\n\nFinancial Breakdown:`;
      context += `\n- Subtotal: K${(order.subtotal as number)?.toLocaleString()}`;
      context += `\n- Shipping: K${(order.shippingCost as number)?.toLocaleString()}`;
      if (order.platformFee) {
        context += `\n- Service Fee: K${(order.platformFee as number)?.toLocaleString()}`;
      }
      context += `\n- Total Paid: K${(order.totalAmount as number)?.toLocaleString()}`;

      // Parties involved
      context += `\n\nParties:`;
      context += `\n- Buyer: ${buyer ? `${(buyer as Record<string, string>).firstName} ${(buyer as Record<string, string>).lastName}` : 'Unknown'}`;
      context += `\n- Seller: ${seller ? `${(seller as Record<string, string>).firstName} ${(seller as Record<string, string>).lastName}` : 'Unknown'}`;
      context += `\n- You are the ${viewerRole} in this transaction.`;

      // Shipping address
      if (order.shippingAddress) {
        const addr = order.shippingAddress as Record<string, string>;
        context += `\n\nShipping Address:`;
        context += `\n${addr.street}, ${addr.city}, ${addr.province}, ${addr.country}`;
        context += `\nPhone: ${addr.phone}`;
      }

      // Payment/Transaction History
      if (transactions && transactions.length > 0) {
        context += `\n\nPayment History:`;
        for (const tx of transactions) {
          const statusEmoji =
            tx.status === 'successful'
              ? '✓'
              : tx.status === 'failed'
                ? '✗'
                : '⏳';
          context += `\n${statusEmoji} ${(tx.paymentMethod as string)?.replace('_', ' ')} payment of K${(tx.amount as number)?.toLocaleString()} - ${tx.status}`;
          if (tx.completedAt) {
            context += ` (${new Date(tx.completedAt as number).toLocaleDateString('en-ZM')})`;
          }
          if (tx.failureReason) {
            context += ` - Reason: ${tx.failureReason}`;
          }
        }
      }

      // Escrow Status
      if (escrow) {
        context += `\n\nEscrow Status: ${this.formatEscrowStatus(escrow.status as string)}`;
        context += `\n- Amount Held: K${(escrow.grossAmount as number)?.toLocaleString()}`;
        context += `\n- Seller Will Receive: K${(escrow.sellerAmount as number)?.toLocaleString()}`;
        if (escrow.releasedAt) {
          context += `\n- Released on: ${new Date(escrow.releasedAt as number).toLocaleDateString('en-ZM')}`;
        }
        if (escrow.refundAmount) {
          context += `\n- Refund Amount: K${(escrow.refundAmount as number)?.toLocaleString()}`;
        }
      }

      // Dispute Information (if any)
      if (dispute) {
        context += `\n\n=== DISPUTE INFORMATION ===`;
        context += `\nDispute Title: ${dispute.title}`;
        context += `\nCategory: ${this.formatDisputeCategory(dispute.category as string)}`;
        context += `\nStatus: ${this.formatDisputeStatus(dispute.status as string)}`;
        context += `\nDescription: ${dispute.description}`;
        context += `\nOpened on: ${new Date(
          dispute.createdAt as number,
        ).toLocaleDateString('en-ZM', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })}`;

        // Calculate dispute duration
        const disputeStart = new Date(dispute.createdAt as number);
        const resolution = dispute.resolution as
          | {
              resolvedAt?: number;
              type?: string;
              notes?: string;
              refundAmount?: number;
            }
          | undefined;
        const disputeEnd = resolution?.resolvedAt
          ? new Date(resolution.resolvedAt)
          : new Date();
        const durationDays = Math.ceil(
          (disputeEnd.getTime() - disputeStart.getTime()) /
            (1000 * 60 * 60 * 24),
        );

        if (dispute.status === 'resolved') {
          context += `\nDuration: ${durationDays} day(s) until resolution`;
        } else {
          context += `\nOpen for: ${durationDays} day(s)`;
        }

        // Resolution details
        if (resolution) {
          context += `\n\nResolution:`;
          context += `\n- Type: ${this.formatResolutionType(resolution.type || 'unknown')}`;
          context += `\n- Notes: ${resolution.notes || 'No notes provided'}`;
          if (resolution.refundAmount) {
            context += `\n- Refund Amount: K${resolution.refundAmount.toLocaleString()}`;
          }
          if (resolution.resolvedAt) {
            context += `\n- Resolved on: ${new Date(resolution.resolvedAt).toLocaleDateString('en-ZM')}`;
          }
        }

        // AI Analysis (if available)
        if (dispute.aiSummary) {
          context += `\n\nAI Analysis Summary: ${dispute.aiSummary}`;
        }

        // Evidence count
        if (dispute.evidence && Array.isArray(dispute.evidence)) {
          context += `\n\nEvidence Submitted: ${dispute.evidence.length} item(s)`;
        }
      }

      // Dispute Messages Summary
      if (disputeMessages && disputeMessages.length > 0) {
        context += `\n\nDispute Conversation (${disputeMessages.length} messages):`;
        const recentMessages = disputeMessages.slice(-5); // Last 5 messages
        for (const msg of recentMessages) {
          const sender = msg.isSystemMessage
            ? 'System'
            : msg.senderId === (buyer as Record<string, unknown>)?._id
              ? 'Buyer'
              : 'Seller';
          const preview = ((msg.content as string) || '').slice(0, 100);
          context += `\n- [${sender}]: ${preview}${((msg.content as string) || '').length > 100 ? '...' : ''}`;
        }
        if (disputeMessages.length > 5) {
          context += `\n... and ${disputeMessages.length - 5} more messages`;
        }
      }

      // Pre-purchase conversation
      if (prePurchaseMessages && prePurchaseMessages.length > 0) {
        context += `\n\nPre-Purchase Conversation (${prePurchaseMessages.length} messages):`;
        context += `\nThis shows what was discussed between buyer and seller before the purchase.`;
        const recentPrePurchase = prePurchaseMessages.slice(-3);
        for (const msg of recentPrePurchase) {
          const sender = msg.sender === 'buyer' ? 'Buyer' : 'Seller';
          const preview = (
            (msg.content as string) ||
            (msg.message as string) ||
            ''
          ).slice(0, 80);
          context += `\n- [${sender}]: ${preview}`;
        }
      }

      // Timeline
      if (timeline && timeline.length > 0) {
        context += `\n\nOrder Timeline:`;
        for (const event of timeline) {
          const date = new Date(event.timestamp).toLocaleDateString('en-ZM', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });
          context += `\n• ${date}: ${event.event}`;
          if (event.details) {
            context += ` - ${event.details}`;
          }
        }
      }

      return context;
    } catch (error) {
      console.error('Failed to get comprehensive order context:', error);
      return '';
    }
  }

  // Helper formatters
  private formatOrderStatus(status: string): string {
    const statusMap: Record<string, string> = {
      pending_payment: 'Pending Payment',
      paid: 'Paid',
      processing: 'Processing',
      shipped: 'Shipped',
      delivered: 'Delivered',
      completed: 'Completed',
      cancelled: 'Cancelled',
      disputed: 'Under Dispute',
    };
    return statusMap[status] || status;
  }

  private formatEscrowStatus(status: string): string {
    const statusMap: Record<string, string> = {
      held: 'Funds Held Securely',
      released: 'Funds Released to Seller',
      refunded: 'Funds Refunded to Buyer',
      disputed: 'Under Dispute Review',
      partially_refunded: 'Partially Refunded',
    };
    return statusMap[status] || status;
  }

  private formatDisputeCategory(category: string): string {
    const categoryMap: Record<string, string> = {
      not_received: 'Item Not Received',
      defective: 'Defective Item',
      not_as_described: 'Not As Described',
      other: 'Other Issue',
    };
    return categoryMap[category] || category;
  }

  private formatDisputeStatus(status: string): string {
    const statusMap: Record<string, string> = {
      open: 'Open - Awaiting Response',
      in_discussion: 'In Discussion',
      moderator_review: 'Under Moderator Review',
      resolved: 'Resolved',
      closed: 'Closed',
    };
    return statusMap[status] || status;
  }

  private formatResolutionType(type: string): string {
    const typeMap: Record<string, string> = {
      full_refund: 'Full Refund Issued',
      partial_refund: 'Partial Refund Issued',
      no_refund: 'No Refund (Issue Resolved)',
      mutual_agreement: 'Resolved by Mutual Agreement',
      replacement: 'Replacement Item Sent',
    };
    return typeMap[type] || type;
  }

  /**
   * Get user's listings summary
   */
  private async getUserListingsSummary(userId: string): Promise<{
    totalListings: number;
    activeListings: number;
    soldListings: number;
    totalViews: number;
  } | null> {
    try {
      const listings = await this.convexService.getUserListings(userId);
      if (!listings) return null;

      return {
        totalListings: listings.length,
        activeListings: listings.filter(
          (l: { status: string }) => l.status === 'active',
        ).length,
        soldListings: listings.filter(
          (l: { status: string }) => l.status === 'sold',
        ).length,
        totalViews: listings.reduce(
          (sum: number, l: { views: number }) => sum + (l.views || 0),
          0,
        ),
      };
    } catch {
      return null;
    }
  }

  async chat(
    message: string,
    conversationHistory: ChatMessage[] = [],
    context: ChatContext = {},
  ): Promise<ChatResult> {
    if (!this.aiService.isConfigured()) {
      return this.getFallbackResponse(message);
    }

    // Gather real-time data based on the message content
    const lowerMessage = message.toLowerCase();

    // Always fetch marketplace stats for context
    const marketplaceData = await this.getMarketplaceData();

    // Build comprehensive context
    let databaseContext = '';

    // Add marketplace overview
    if (marketplaceData) {
      databaseContext += `\n\n=== REAL-TIME MARKETPLACE DATA ===`;
      databaseContext += `\nTotal active products: ${marketplaceData.totalProducts}`;
      databaseContext += `\nTotal categories: ${marketplaceData.totalCategories}`;
      databaseContext += `\nPrice range: K${marketplaceData.priceRange.min.toLocaleString()} - K${marketplaceData.priceRange.max.toLocaleString()}`;

      databaseContext += `\n\nProducts by category (sorted by count):`;
      const sortedCategories = [...marketplaceData.productsByCategory].sort(
        (a, b) => b.count - a.count,
      );
      for (const cat of sortedCategories) {
        databaseContext += `\n- ${cat.name}: ${cat.count} product${cat.count !== 1 ? 's' : ''}`;
      }

      databaseContext += `\n\nAll current listings (${marketplaceData.recentProducts.length} products):`;
      for (const product of marketplaceData.recentProducts) {
        databaseContext += `\n- ${product.title} [Category: ${product.categoryName}] (K${product.price.toLocaleString()}, ${product.condition})`;
      }
    }

    // Search for products if the user is asking about specific items
    const searchTriggers = [
      'find',
      'search',
      'looking for',
      'show me',
      'any',
      'have',
      'list',
      'how many',
      'are there',
      'is there',
      'do you have',
      'got any',
      'available',
    ];
    const shouldSearch = searchTriggers.some((trigger) =>
      lowerMessage.includes(trigger),
    );

    // Also search if message contains known product categories
    const productKeywords = [
      'car',
      'cars',
      'vehicle',
      'bmw',
      'toyota',
      'honda',
      'phone',
      'laptop',
      'part',
      'parts',
      'engine',
      'brake',
      'tire',
      'battery',
      'electronics',
      'accessories',
    ];
    const containsProductKeyword = productKeywords.some((keyword) =>
      lowerMessage.includes(keyword),
    );

    if (shouldSearch || containsProductKeyword) {
      // Extract potential search terms - keep meaningful words
      let searchTerms = message
        .replace(
          /find|search|looking for|show me|do you have|are there|is there|how many|got any|available|listed|on the marketplace|in stock|for sale|\?|please|can you|could you|i want|i need|i'm looking/gi,
          '',
        )
        .trim();

      // If search terms are too short, use the detected product keyword
      if (searchTerms.length < 3) {
        const foundKeyword = productKeywords.find((kw) =>
          lowerMessage.includes(kw),
        );
        if (foundKeyword) searchTerms = foundKeyword;
      }

      if (searchTerms.length >= 2) {
        const searchResults = await this.searchProducts(searchTerms);
        if (searchResults.length > 0) {
          databaseContext += `\n\n=== SEARCH RESULTS for "${searchTerms}" (${searchResults.length} found) ===`;
          for (const result of searchResults) {
            const categoryLabel = result.categoryName
              ? ` [${result.categoryName}]`
              : '';
            databaseContext += `\n- ${result.title}${categoryLabel} (K${result.price.toLocaleString()}, ${result.condition})`;
          }
        } else {
          databaseContext += `\n\n=== SEARCH RESULTS for "${searchTerms}" ===`;
          databaseContext += `\nNo products found matching "${searchTerms}"`;
          databaseContext += `\nNote: Check the "All current listings" section above - the user may be asking about products listed under different names or categories.`;
        }
      }
    }

    // Add user-specific data if userId is provided
    let userContext = '';
    if (context.userId) {
      try {
        const user = await this.convexService.getUser(context.userId);
        if (user) {
          userContext += `\n\n=== CURRENT USER ===`;
          userContext += `\nName: ${user.firstName} ${user.lastName}`;
          userContext += `\nTotal purchases: ${user.totalPurchases || 0}`;
          userContext += `\nTotal sales: ${user.totalSales || 0}`;
          if (user.rating) userContext += `\nRating: ${user.rating}/5`;
        }

        // Get user's orders if asking about orders
        if (
          lowerMessage.includes('order') ||
          lowerMessage.includes('purchase') ||
          lowerMessage.includes('bought') ||
          lowerMessage.includes('dispute') ||
          lowerMessage.includes('delivery') ||
          lowerMessage.includes('shipped') ||
          lowerMessage.includes('refund') ||
          lowerMessage.includes('escrow')
        ) {
          const ordersSummary = await this.getUserOrdersSummary(context.userId);
          if (ordersSummary) {
            userContext += `\n\n=== USER'S ORDERS SUMMARY ===`;
            userContext += `\nTotal orders: ${ordersSummary.totalOrders}`;
            userContext += `\nPending: ${ordersSummary.pendingOrders}`;
            userContext += `\nCompleted: ${ordersSummary.completedOrders}`;
            userContext += `\nDisputed: ${ordersSummary.disputedOrders}`;

            // Check if user is asking about a specific order or "last order"
            const isAskingAboutLastOrder =
              lowerMessage.includes('last order') ||
              lowerMessage.includes('recent order') ||
              lowerMessage.includes('latest order') ||
              lowerMessage.includes('my order') ||
              (lowerMessage.includes('order') &&
                (lowerMessage.includes('how was') ||
                  lowerMessage.includes('what happened') ||
                  lowerMessage.includes('status') ||
                  lowerMessage.includes('dispute') ||
                  lowerMessage.includes('details') ||
                  lowerMessage.includes('tell me about')));

            if (
              isAskingAboutLastOrder &&
              ordersSummary.recentOrders.length > 0
            ) {
              // Get comprehensive details for the most recent order
              const lastOrder = ordersSummary.recentOrders[0];
              const comprehensiveContext =
                await this.getComprehensiveOrderContext(
                  lastOrder._id,
                  'buyer', // User is asking as buyer
                );
              userContext += comprehensiveContext;
            } else if (ordersSummary.recentOrders.length > 0) {
              userContext += `\n\nRecent orders:`;
              for (const order of ordersSummary.recentOrders) {
                userContext += `\n- #${order.orderNumber}: ${this.formatOrderStatus(order.status)} (K${order.total.toLocaleString()})`;
              }
              userContext += `\n\nFor detailed information about any order, ask about "my last order" or specify an order number.`;
            }
          }

          // Also check seller orders if user is a seller
          try {
            const sellerOrders = await this.convexService.getSellerOrders(
              context.userId,
            );
            if (sellerOrders && sellerOrders.length > 0) {
              userContext += `\n\n=== ORDERS RECEIVED (as seller) ===`;
              userContext += `\nTotal orders received: ${sellerOrders.length}`;

              const pendingSales = sellerOrders.filter(
                (o: Record<string, unknown>) =>
                  ['paid', 'processing', 'shipped'].includes(
                    o.status as string,
                  ),
              ).length;
              const completedSales = sellerOrders.filter(
                (o: Record<string, unknown>) =>
                  ['delivered', 'completed'].includes(o.status as string),
              ).length;
              const disputedSales = sellerOrders.filter(
                (o: Record<string, unknown>) => o.status === 'disputed',
              ).length;

              userContext += `\nPending fulfillment: ${pendingSales}`;
              userContext += `\nCompleted sales: ${completedSales}`;
              userContext += `\nDisputed orders: ${disputedSales}`;

              // If asking about sales-related question, provide more context
              if (
                lowerMessage.includes('sale') ||
                lowerMessage.includes('sold') ||
                lowerMessage.includes('customer') ||
                lowerMessage.includes('buyer')
              ) {
                const recentSales = sellerOrders.slice(0, 3);
                userContext += `\n\nRecent sales:`;
                for (const sale of recentSales) {
                  userContext += `\n- #${sale.orderNumber}: ${this.formatOrderStatus(sale.status as string)} (K${(sale.totalAmount as number)?.toLocaleString()})`;
                }
              }
            }
          } catch {
            // Ignore seller orders fetch errors
          }
        }

        // Get user's listings if asking about their products
        if (
          lowerMessage.includes('my listing') ||
          lowerMessage.includes('my product') ||
          lowerMessage.includes('selling') ||
          lowerMessage.includes('listed')
        ) {
          const listingsSummary = await this.getUserListingsSummary(
            context.userId,
          );
          if (listingsSummary) {
            userContext += `\n\n=== USER'S LISTINGS ===`;
            userContext += `\nTotal listings: ${listingsSummary.totalListings}`;
            userContext += `\nActive: ${listingsSummary.activeListings}`;
            userContext += `\nSold: ${listingsSummary.soldListings}`;
            userContext += `\nTotal views: ${listingsSummary.totalViews}`;
          }
        }
      } catch {
        // Ignore user fetch errors
      }
    }

    // Add product context if viewing a specific product
    let productContext = '';
    if (context.productId) {
      try {
        const product = await this.convexService.getProduct(context.productId);
        if (product) {
          productContext += `\n\n=== CURRENTLY VIEWING PRODUCT ===`;
          productContext += `\nTitle: ${product.title}`;
          productContext += `\nPrice: K${product.price.toLocaleString()}`;
          productContext += `\nCondition: ${product.condition}`;
          productContext += `\nDescription: ${product.description}`;
          productContext += `\nViews: ${product.views || 0}`;
          if (product.seller) {
            productContext += `\nSeller: ${product.seller.firstName} ${product.seller.lastName}`;
            if (product.seller.rating)
              productContext += ` (${product.seller.rating}/5 rating)`;
          }
        }
      } catch {
        // Ignore product fetch errors
      }
    }

    const systemPrompt = `You are an AI shopping assistant for Gettitonline, a trusted online store in Zambia for fashion, electronics, lifestyle essentials, and general products.

YOU HAVE FULL ACCESS TO THE MARKETPLACE DATABASE. Use the real-time data provided below to answer questions accurately and comprehensively.

Your capabilities:
1. Answer questions about available products with REAL data
2. Provide accurate counts, prices, and listings information
3. Help users find products across categories such as fashion, electronics, beauty, home, and everyday essentials
4. Answer COMPREHENSIVE questions about orders including:
   - Order status and timeline
   - Payment details and history
   - Dispute information (if any)
   - How disputes were resolved
   - Duration of disputes
   - Escrow status and fund movements
   - Communication history
5. Give personalized information based on user's account data
6. Explain the escrow system, disputes, and resolutions

Important information:
- Currency is ZMW (Zambian Kwacha), displayed as K (e.g., K500)
- All payments go through a secure escrow system
- Funds are held until delivery is confirmed or disputes are resolved
- Users can open disputes within 7 days of delivery
- Shipping is available nationwide in Zambia
- 5% service fee is included in prices for escrow protection

Guidelines:
- USE THE DATABASE DATA PROVIDED to give accurate, specific, detailed answers
- When users ask about orders, provide COMPREHENSIVE information including disputes, resolution, timeline
- When users ask "how was my order", give a full narrative including any issues and how they were resolved
- When users ask "how many", give the exact count from the data
- When users ask about products, reference actual listings
- Be helpful, friendly, conversational, and provide thorough information
- Address the user directly and personally (e.g., "Your order...", "You purchased...")
- If there was a dispute, explain what happened, how long it took, and how it was resolved
- If information isn't in the provided data, say so honestly
${databaseContext}
${userContext}
${productContext}
${context.currentScreen ? `\nUser is currently on: ${context.currentScreen}` : ''}

Respond in JSON format:
{
  "message": "Your response here - BE SPECIFIC with numbers and data",
  "suggestions": ["Optional follow-up suggestion 1", "Optional suggestion 2"],
  "actions": [
    { "type": "search", "label": "Search for brake pads", "payload": { "query": "brake pads" } }
  ]
}

The actions array is optional and should only be included when relevant.
Valid action types: "navigate", "search", "filter"`;

    const conversationText =
      conversationHistory.length > 0
        ? conversationHistory
            .map(
              (m) =>
                `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`,
            )
            .join('\n') + '\n'
        : '';

    const userMessage = `${conversationText}User: ${message}`;

    try {
      const result = await this.aiService.generateJson<ChatResult>(
        systemPrompt,
        userMessage,
        { temperature: 0.7, maxTokens: 1000 },
      );

      return {
        message:
          result.message ||
          'I apologize, but I could not process your request. Please try again.',
        suggestions: result.suggestions || [],
        actions: result.actions || [],
      };
    } catch (error) {
      console.error('Chat error:', error);
      return this.getFallbackResponse(message);
    }
  }

  async suggestQuickActions(currentScreen: string): Promise<string[]> {
    const screenSuggestions: Record<string, string[]> = {
      Home: [
        'How many products are listed?',
        'What categories are available?',
        'Show me the cheapest items',
        'What are the newest listings?',
      ],
      Browse: [
        'Filter by price range',
        'Show new arrivals only',
        'Find items near me',
        'Compare similar products',
      ],
      ProductDetail: [
        'Is this a good price?',
        'What shipping options are available?',
        'Tell me about the seller',
        'Are there similar products?',
      ],
      Cart: [
        'What is my total?',
        'Apply discount code',
        'Change shipping method',
        'Checkout help',
      ],
      Orders: [
        'Track my latest order',
        'How many orders do I have?',
        'Request a refund',
        'Contact the seller',
      ],
      Profile: [
        'How many items have I sold?',
        'What is my seller rating?',
        'Show my active listings',
        'How many views on my products?',
      ],
    };

    return screenSuggestions[currentScreen] || screenSuggestions.Home;
  }

  private getFallbackResponse(message: string): ChatResult {
    const lowerMessage = message.toLowerCase();

    if (lowerMessage.includes('track') || lowerMessage.includes('order')) {
      return {
        message:
          'To track your order, go to the Orders tab and select the order you want to track.',
        suggestions: ['View my orders', 'Contact support'],
        actions: [
          {
            type: 'navigate',
            label: 'Go to Orders',
            payload: { screen: 'Orders' },
          },
        ],
      };
    }

    if (lowerMessage.includes('how many') || lowerMessage.includes('count')) {
      return {
        message:
          "I'm currently unable to access the database. Please try again in a moment.",
        suggestions: ['Try again', 'Browse products'],
        actions: [
          { type: 'navigate', label: 'Browse', payload: { screen: 'Browse' } },
        ],
      };
    }

    return {
      message:
        "I'm here to help! I have access to the full marketplace database. Ask me about available products, prices, your orders, or anything else!",
      suggestions: [
        'How many products are listed?',
        'What are the newest listings?',
        'Show me cars',
        'Track my order',
      ],
    };
  }
}
