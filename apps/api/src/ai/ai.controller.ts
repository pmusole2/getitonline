import { Controller, Post, Body, Get, Query, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { RecommendationsService } from './services/recommendations.service';
import { MessageRephraseService } from './services/message-rephrase.service';
import { DisputeAnalysisService } from './services/dispute-analysis.service';
import { ChatService } from './services/chat.service';
import { ListingModerationService } from './services/listing-moderation.service';
import { AiService } from './ai.service';
import { GetRecommendationsDto, GetSimilarProductsDto, RecommendationsResponseDto } from './dto/recommendations.dto';
import { RephraseMessageDto, RephraseResponseDto } from './dto/message-rephrase.dto';
import { AnalyzeDisputeDto, GenerateResolutionMessageDto, DisputeAnalysisResponseDto } from './dto/dispute-analysis.dto';
import { ChatRequestDto, ChatResponseDto, SuggestResponsesDto, QuickActionsDto } from './dto/chat.dto';
import { ListingModerationResponseDto, ModerateListingDto } from './dto/listing-moderation.dto';
import { VisualSearchDto, VisualSearchResponseDto } from './dto/visual-search.dto';
import { ConvexService } from '../convex/convex.service';

@ApiTags('AI')
@Controller('ai')
export class AiController {
  constructor(
    private readonly recommendationsService: RecommendationsService,
    private readonly messageRephraseService: MessageRephraseService,
    private readonly disputeAnalysisService: DisputeAnalysisService,
    private readonly chatService: ChatService,
    private readonly listingModerationService: ListingModerationService,
    private readonly aiService: AiService,
    private readonly convexService: ConvexService,
  ) {}

  @Post('moderate-listing')
  @ApiOperation({ summary: 'Run advisory AI moderation on a listing and store the result' })
  @ApiResponse({ status: 200, type: ListingModerationResponseDto })
  async moderateListing(
    @Body() dto: ModerateListingDto,
  ): Promise<ListingModerationResponseDto> {
    try {
      const reviewer = await this.convexService.getUser(dto.reviewerId);
      if (!reviewer) {
        throw new HttpException('Reviewer not found', HttpStatus.NOT_FOUND);
      }

      if (reviewer.role !== 'admin' && reviewer.role !== 'moderator') {
        throw new HttpException('Only staff reviewers can run AI moderation', HttpStatus.FORBIDDEN);
      }

      const result = await this.listingModerationService.moderateListing({
        title: dto.title,
        description: dto.description,
        price: dto.price,
        quantity: dto.quantity,
        imageUrls: dto.imageUrls,
        categoryName: dto.categoryName,
      });

      await this.convexService.storeListingModerationResult({
        productId: dto.productId,
        reviewerId: dto.reviewerId,
        status: result.status,
        summary: result.summary,
        flags: result.flags,
      });

      return result;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        'Failed to moderate listing',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('recommendations')
  @ApiOperation({ summary: 'Get personalized product recommendations for a user' })
  @ApiResponse({ status: 200, type: RecommendationsResponseDto })
  async getRecommendations(
    @Body() dto: GetRecommendationsDto,
  ): Promise<RecommendationsResponseDto> {
    try {
      // Fetch user data and products from Convex
      const [user, products, categories, behaviorSummary] = await Promise.all([
        this.convexService.getUser(dto.userId),
        this.convexService.getActiveProducts(50),
        this.convexService.getCategories(),
        this.convexService.getUserBehaviorSummary(dto.userId),
      ]);

      if (!user) {
        throw new HttpException('User not found', HttpStatus.NOT_FOUND);
      }

      // Filter out the user's own products - don't recommend items they listed
      const otherUsersProducts = products.filter(
        (p: { sellerId: string }) => p.sellerId !== dto.userId
      );

      const categoryNameById = new Map<string, string>();
      const addCategoryNames = (categoryItems: Array<{ _id: string; name: string; subcategories?: unknown[] }>) => {
        for (const category of categoryItems) {
          categoryNameById.set(category._id, category.name);
          const subcategories = Array.isArray(category.subcategories)
            ? (category.subcategories as Array<{ _id: string; name: string; classifications?: unknown[] }>)
            : [];
          for (const subcategory of subcategories) {
            categoryNameById.set(subcategory._id, subcategory.name);
            const classifications = Array.isArray(subcategory.classifications)
              ? (subcategory.classifications as Array<{ _id: string; name: string }>)
              : [];
            for (const classification of classifications) {
              categoryNameById.set(classification._id, classification.name);
            }
          }
        }
      };
      addCategoryNames(categories ?? []);
      const categoryLabels = (ids: string[] | undefined) =>
        (ids ?? []).map((id) => categoryNameById.get(id) ?? id);

      const userContext = {
        interests: categoryLabels(user.interests),
        recentlyViewed: categoryLabels(behaviorSummary.recentlyViewedCategoryIds),
        purchaseHistory: categoryLabels(behaviorSummary.purchaseCategoryIds),
      };

      const formattedProducts = otherUsersProducts.map((p: { _id: string; title: string; categoryId: string; subcategoryId?: string; price: number; condition: string }) => ({
        id: p._id,
        title: p.title,
        category: p.categoryId,
        subcategory: p.subcategoryId,
        price: p.price,
        condition: p.condition,
      }));

      return await this.recommendationsService.getPersonalizedRecommendations(
        userContext,
        formattedProducts,
        dto.limit || 10,
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        'Failed to generate recommendations',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('visual-search')
  @ApiOperation({ summary: 'Generate product search terms from a captured image' })
  @ApiResponse({ status: 200, type: VisualSearchResponseDto })
  async visualSearch(
    @Body() dto: VisualSearchDto,
  ): Promise<VisualSearchResponseDto> {
    try {
      return await this.aiService.generateVisualSearchTerms(dto.imageDataUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      throw new HttpException(
        message.includes('OpenAI is not configured')
          ? 'Visual search is not configured'
          : 'Failed to analyze image search',
        message.includes('OpenAI is not configured')
          ? HttpStatus.SERVICE_UNAVAILABLE
          : HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('similar-products')
  @ApiOperation({ summary: 'Get similar products for a given product' })
  @ApiResponse({ status: 200, type: [String] })
  async getSimilarProducts(
    @Body() dto: GetSimilarProductsDto,
  ): Promise<string[]> {
    try {
      const [product, allProducts] = await Promise.all([
        this.convexService.getProduct(dto.productId),
        this.convexService.getActiveProducts(30),
      ]);

      if (!product) {
        throw new HttpException('Product not found', HttpStatus.NOT_FOUND);
      }

      const formattedProduct = {
        id: product._id,
        title: product.title,
        category: product.categoryId,
        subcategory: product.subcategoryId,
        price: product.price,
        condition: product.condition,
      };

      const formattedProducts = allProducts.map((p: any) => ({
        id: p._id,
        title: p.title,
        category: p.categoryId,
        subcategory: p.subcategoryId,
        price: p.price,
        condition: p.condition,
      }));

      return await this.recommendationsService.getSimilarProducts(
        formattedProduct,
        formattedProducts,
        dto.limit || 5,
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        'Failed to find similar products',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('rephrase-message')
  @ApiOperation({ summary: 'Analyze and rephrase a message for professionalism' })
  @ApiResponse({ status: 200, type: RephraseResponseDto })
  async rephraseMessage(
    @Body() dto: RephraseMessageDto,
  ): Promise<RephraseResponseDto> {
    try {
      return await this.messageRephraseService.analyzeAndRephrase(
        dto.message,
        {
          senderRole: dto.senderRole,
          disputeContext: dto.disputeContext,
        },
      );
    } catch (error) {
      throw new HttpException(
        'Failed to analyze message',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('analyze-dispute')
  @ApiOperation({ summary: 'Analyze a dispute and provide resolution suggestions' })
  @ApiResponse({ status: 200, type: DisputeAnalysisResponseDto })
  async analyzeDispute(
    @Body() dto: AnalyzeDisputeDto,
  ): Promise<DisputeAnalysisResponseDto> {
    try {
      // Fetch dispute data from Convex
      const disputeData = await this.convexService.getDisputeForAnalysis(dto.disputeId);

      if (!disputeData) {
        throw new HttpException('Dispute not found', HttpStatus.NOT_FOUND);
      }

      const dispute = {
        title: disputeData.dispute.title,
        description: disputeData.dispute.description,
        category: disputeData.dispute.category as 'not_received' | 'defective' | 'not_as_described' | 'other',
        orderAmount: disputeData.order?.totalAmount || 0,
        orderDate: new Date(disputeData.order?.createdAt || Date.now()).toISOString(),
        productTitle: disputeData.order?.items?.[0]?.title || 'Unknown Product',
      };

      interface DisputeMessage {
        senderRole: string;
        content: string;
        timestamp: number;
      }

      const conversation = disputeData.messages.map((m: DisputeMessage) => ({
        sender: m.senderRole as 'buyer' | 'seller' | 'moderator',
        message: m.content,
        timestamp: new Date(m.timestamp).toISOString(),
      }));

      // Fetch pre-purchase conversation history if available
      let prePurchaseConversation: Array<{
        sender: 'buyer' | 'seller';
        message: string;
        timestamp: string;
      }> = [];

      // Get product and buyer IDs from order/dispute to fetch pre-purchase messages
      const productId = disputeData.order?.items?.[0]?.productId;
      const buyerId = disputeData.buyer?._id;

      if (productId && buyerId) {
        try {
          const prePurchaseHistory = await this.convexService.getProductConversationHistory(
            productId,
            buyerId,
          );

          if (prePurchaseHistory && prePurchaseHistory.messages) {
            prePurchaseConversation = prePurchaseHistory.messages.map((m) => ({
              sender: m.sender,
              message: m.content,
              timestamp: new Date(m.timestamp).toISOString(),
            }));
          }
        } catch (error) {
          console.warn('Could not fetch pre-purchase conversation:', error);
          // Continue without pre-purchase conversation
        }
      }

      const analysis = await this.disputeAnalysisService.analyzeDispute(
        dispute,
        conversation,
        disputeData.evidenceCount,
        dto.viewerRole, // Pass viewer role for personalization
        prePurchaseConversation, // Pass pre-purchase messages to analyzer
      );

      // Save analysis back to Convex
      await this.convexService.updateDisputeAiAnalysis(
        dto.disputeId,
        analysis.summary,
        analysis.suggestedResolutions.map(r => r.description),
      );

      return analysis;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        'Failed to analyze dispute',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('generate-resolution-message')
  @ApiOperation({ summary: 'Generate a resolution message for a dispute' })
  @ApiResponse({ status: 200, type: String })
  async generateResolutionMessage(
    @Body() dto: GenerateResolutionMessageDto,
  ): Promise<{ message: string }> {
    try {
      const message = await this.disputeAnalysisService.suggestResolutionMessage(
        dto.resolutionType,
        {
          title: dto.disputeTitle,
          description: '',
          category: dto.category,
          orderAmount: dto.orderAmount,
          orderDate: new Date().toISOString(),
          productTitle: dto.productTitle,
        },
        dto.refundAmount,
      );

      return { message };
    } catch (error) {
      throw new HttpException(
        'Failed to generate resolution message',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('chat')
  @ApiOperation({ summary: 'General AI chat with Pinkie, the shopping assistant' })
  @ApiResponse({ status: 200, type: ChatResponseDto })
  async chat(
    @Body() dto: ChatRequestDto,
  ): Promise<ChatResponseDto> {
    try {
      return await this.chatService.chat(
        dto.message,
        dto.conversationHistory || [],
        dto.context || {},
      );
    } catch (error) {
      throw new HttpException(
        'Failed to process chat message',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('suggest-responses')
  @ApiOperation({ summary: 'Get response suggestions for dispute conversations' })
  @ApiResponse({ status: 200, type: [String] })
  async suggestResponses(
    @Body() dto: SuggestResponsesDto,
  ): Promise<string[]> {
    try {
      return await this.messageRephraseService.suggestResponse(
        dto.conversationHistory.map(m => ({
          sender: m.sender as 'buyer' | 'seller' | 'moderator',
          message: m.message,
        })),
        dto.respondAs,
        dto.disputeContext,
      );
    } catch (error) {
      throw new HttpException(
        'Failed to generate response suggestions',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('quick-actions')
  @ApiOperation({ summary: 'Get quick action suggestions based on current screen' })
  @ApiResponse({ status: 200, type: [String] })
  async getQuickActions(
    @Query('currentScreen') currentScreen: string,
  ): Promise<string[]> {
    return this.chatService.suggestQuickActions(currentScreen || 'Home');
  }

  @Get('health')
  @ApiOperation({ summary: 'Check AI service health' })
  async checkHealth() {
    return {
      status: 'ok',
      aiConfigured: true, // Will be checked in service
      timestamp: new Date().toISOString(),
    };
  }
}
