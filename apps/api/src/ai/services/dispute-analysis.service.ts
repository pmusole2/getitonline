import { Injectable } from '@nestjs/common';
import { AiService } from '../ai.service';
import {
  ASSISTANT_IDENTITY_PROMPT,
  ASSISTANT_NAME,
  GHOSTWRITING_RULE,
} from '../assistant-identity';

interface DisputeDetails {
  title: string;
  description: string;
  category: 'not_received' | 'defective' | 'not_as_described' | 'other';
  orderAmount: number;
  orderDate: string;
  productTitle: string;
}

interface ConversationMessage {
  sender: 'buyer' | 'seller' | 'moderator';
  message: string;
  timestamp: string;
}

type ViewerRole = 'buyer' | 'seller' | 'moderator';

interface DisputeAnalysis {
  summary: string;
  keyPoints: {
    yourClaims: string[];
    theirClaims: string[];
    buyerClaims: string[];
    sellerClaims: string[];
  };
  sentiment: {
    yours: 'cooperative' | 'frustrated' | 'hostile' | 'neutral';
    theirs: 'cooperative' | 'frustrated' | 'hostile' | 'neutral';
    buyer: 'cooperative' | 'frustrated' | 'hostile' | 'neutral';
    seller: 'cooperative' | 'frustrated' | 'hostile' | 'neutral';
  };
  suggestedResolutions: Array<{
    type: 'full_refund' | 'partial_refund' | 'no_refund' | 'replacement' | 'mutual_agreement';
    description: string;
    fairnessScore: number; // 1-10
  }>;
  recommendedAction: string;
  riskLevel: 'low' | 'medium' | 'high';
  additionalNotes: string;
  viewerRole: ViewerRole;
}

@Injectable()
export class DisputeAnalysisService {
  constructor(private aiService: AiService) {}

  async analyzeDispute(
    dispute: DisputeDetails,
    conversation: ConversationMessage[],
    evidenceCount: number,
    viewerRole: ViewerRole = 'moderator',
    prePurchaseConversation?: Array<{ sender: 'buyer' | 'seller'; message: string; timestamp: string }>,
  ): Promise<DisputeAnalysis> {
    if (!this.aiService.isConfigured()) {
      return this.getDefaultAnalysis(dispute, viewerRole);
    }

    // Personalize the prompt based on who's viewing
    const viewerContext = this.getViewerContext(viewerRole);

    const systemPrompt = `You are ${ASSISTANT_NAME}, an expert dispute resolution assistant for an online marketplace in Zambia.
${ASSISTANT_IDENTITY_PROMPT}
${viewerContext.roleDescription}

Guidelines:
1. ${viewerContext.toneGuideline}
2. Base your analysis on evidence and facts presented
3. Consider Zambian consumer protection norms
4. Currency is ZMW (Zambian Kwacha)
5. Be helpful and constructive in your suggestions
6. Consider pre-purchase conversations - these show what was discussed before the sale and can reveal:
   - Promises made by the seller
   - Questions asked by the buyer
   - Potential misunderstandings
   - Evidence of intent

IMPORTANT: Address the ${viewerRole} directly using "you/your" language. When referring to the other party, use "${viewerRole === 'buyer' ? 'the seller' : viewerRole === 'seller' ? 'the buyer' : 'each party'}".
${viewerRole !== 'moderator' ? `\nRemember: You are speaking TO the ${viewerRole}, so use second person ("you") for their perspective.` : ''}

Return a JSON object with:
- summary: 2-3 sentence summary addressing the ${viewerRole} directly (use "you" for the ${viewerRole}'s actions/claims)
- keyPoints: {
    yourClaims: string[] (the ${viewerRole}'s claims, phrased as "You stated...", "Your concern is..."),
    theirClaims: string[] (the other party's claims, phrased as "They claim...", "Their position is...")
  }
- sentiment: {
    yours: 'cooperative'|'frustrated'|'hostile'|'neutral' (${viewerRole}'s apparent sentiment),
    theirs: same (other party's sentiment)
  }
- suggestedResolutions: array of { type, description (personalized advice for the ${viewerRole}), fairnessScore (1-10) }
- recommendedAction: specific next step for the ${viewerRole} to take
- riskLevel: 'low'|'medium'|'high' (based on escalation potential)
- additionalNotes: any other relevant observations for the ${viewerRole}`;

    const conversationText = conversation
      .map((m) => `[${m.timestamp}] ${m.sender.toUpperCase()}: ${m.message}`)
      .join('\n');

    // Format pre-purchase conversation if available
    const prePurchaseText = prePurchaseConversation && prePurchaseConversation.length > 0
      ? prePurchaseConversation
          .map((m) => `[${m.timestamp}] ${m.sender.toUpperCase()}: ${m.message}`)
          .join('\n')
      : null;

    const userMessage = `DISPUTE DETAILS:
- Title: ${dispute.title}
- Category: ${dispute.category}
- Description: ${dispute.description}
- Product: ${dispute.productTitle}
- Order Amount: K${dispute.orderAmount}
- Order Date: ${dispute.orderDate}
- Evidence Items: ${evidenceCount}
${prePurchaseText ? `
PRE-PURCHASE CONVERSATION (messages before the sale):
${prePurchaseText}

This shows the communication between buyer and seller BEFORE the purchase was made.
` : ''}
DISPUTE CONVERSATION HISTORY:
${conversationText || 'No messages yet'}

Please provide a comprehensive analysis.`;

    try {
      interface AiDisputeResponse {
        summary?: string;
        keyPoints?: {
          yourClaims?: string[];
          theirClaims?: string[];
        };
        sentiment?: {
          yours?: 'cooperative' | 'frustrated' | 'hostile' | 'neutral';
          theirs?: 'cooperative' | 'frustrated' | 'hostile' | 'neutral';
        };
        suggestedResolutions?: Array<{
          type: 'full_refund' | 'partial_refund' | 'no_refund' | 'replacement' | 'mutual_agreement';
          description: string;
          fairnessScore: number;
        }>;
        recommendedAction?: string;
        riskLevel?: 'low' | 'medium' | 'high';
        additionalNotes?: string;
      }

      const result = await this.aiService.generateJson<AiDisputeResponse>(
        systemPrompt,
        userMessage,
        { temperature: 0.3, maxTokens: 1500 },
      );

      // Map personalized claims back to buyer/seller format for storage
      const yourClaims = result.keyPoints?.yourClaims || [];
      const theirClaims = result.keyPoints?.theirClaims || [];

      return {
        summary: result.summary || 'Analysis pending',
        keyPoints: {
          yourClaims,
          theirClaims,
          // Also provide original buyer/seller labels for reference
          buyerClaims: viewerRole === 'buyer' ? yourClaims : theirClaims,
          sellerClaims: viewerRole === 'seller' ? yourClaims : theirClaims,
        },
        sentiment: {
          yours: result.sentiment?.yours || 'neutral',
          theirs: result.sentiment?.theirs || 'neutral',
          buyer: viewerRole === 'buyer' ? (result.sentiment?.yours || 'neutral') : (result.sentiment?.theirs || 'neutral'),
          seller: viewerRole === 'seller' ? (result.sentiment?.yours || 'neutral') : (result.sentiment?.theirs || 'neutral'),
        },
        suggestedResolutions: result.suggestedResolutions || [],
        recommendedAction: result.recommendedAction || 'Review case details',
        riskLevel: result.riskLevel || 'medium',
        additionalNotes: result.additionalNotes || '',
        viewerRole,
      };
    } catch (error) {
      console.error('Dispute analysis failed:', error);
      return this.getDefaultAnalysis(dispute, viewerRole);
    }
  }

  private getViewerContext(viewerRole: ViewerRole): {
    roleDescription: string;
    toneGuideline: string;
  } {
    switch (viewerRole) {
      case 'buyer':
        return {
          roleDescription: 'You are helping a BUYER understand their dispute situation. Speak directly to them as if having a conversation.',
          toneGuideline: 'Be empathetic to the buyer\'s concerns while remaining fair and objective',
        };
      case 'seller':
        return {
          roleDescription: 'You are helping a SELLER understand their dispute situation. Speak directly to them as if having a conversation.',
          toneGuideline: 'Be understanding of the seller\'s position while acknowledging the buyer\'s concerns',
        };
      case 'moderator':
      default:
        return {
          roleDescription: 'You are providing an objective analysis for a marketplace moderator reviewing this dispute.',
          toneGuideline: 'Be impartial - consider both buyer and seller perspectives equally',
        };
    }
  }

  async generateModeratorBrief(
    dispute: DisputeDetails,
    conversation: ConversationMessage[],
    analysis: DisputeAnalysis,
  ): Promise<string> {
    if (!this.aiService.isConfigured()) {
      return this.getDefaultBrief(dispute, analysis);
    }

    const systemPrompt = `You are ${ASSISTANT_NAME}, preparing a brief for a moderator reviewing a dispute.
${ASSISTANT_IDENTITY_PROMPT}
Write a clear, actionable brief that helps them quickly understand and resolve the case.
Be concise but thorough. Use bullet points where appropriate.
Currency is ZMW (Zambian Kwacha).`;

    const userMessage = `Create a moderator brief for:

Dispute: ${dispute.title}
Category: ${dispute.category}
Amount: K${dispute.orderAmount}
Product: ${dispute.productTitle}

Analysis Summary: ${analysis.summary}

Buyer Claims: ${analysis.keyPoints.buyerClaims.join('; ')}
Seller Claims: ${analysis.keyPoints.sellerClaims.join('; ')}

Recommended Action: ${analysis.recommendedAction}
Risk Level: ${analysis.riskLevel}

Message Count: ${conversation.length}
Buyer Sentiment: ${analysis.sentiment.buyer}
Seller Sentiment: ${analysis.sentiment.seller}`;

    try {
      return await this.aiService.chat(
        systemPrompt,
        userMessage,
        { temperature: 0.3, maxTokens: 800 },
      );
    } catch {
      return this.getDefaultBrief(dispute, analysis);
    }
  }

  async suggestResolutionMessage(
    resolutionType: 'full_refund' | 'partial_refund' | 'no_refund',
    dispute: DisputeDetails,
    refundAmount?: number,
  ): Promise<string> {
    if (!this.aiService.isConfigured()) {
      return this.getDefaultResolutionMessage(resolutionType, dispute, refundAmount);
    }

    const systemPrompt = `You are ${ASSISTANT_NAME}, drafting a professional, empathetic resolution message that a moderator will send for a marketplace dispute.
${ASSISTANT_IDENTITY_PROMPT}
${GHOSTWRITING_RULE}
The message should:
1. Acknowledge both parties' concerns
2. Clearly state the decision and reasoning
3. Explain next steps
4. Maintain platform professionalism
5. Be culturally appropriate for Zambia

Keep it concise (3-4 paragraphs max).`;

    const refundInfo =
      resolutionType === 'full_refund'
        ? `Full refund of K${dispute.orderAmount}`
        : resolutionType === 'partial_refund'
          ? `Partial refund of K${refundAmount}`
          : 'No refund';

    const userMessage = `Write a resolution message for:

Dispute: ${dispute.title}
Category: ${dispute.category}
Decision: ${refundInfo}
Product: ${dispute.productTitle}
Original Amount: K${dispute.orderAmount}`;

    try {
      return await this.aiService.chat(
        systemPrompt,
        userMessage,
        { temperature: 0.5, maxTokens: 500 },
      );
    } catch {
      return this.getDefaultResolutionMessage(resolutionType, dispute, refundAmount);
    }
  }

  private getDefaultAnalysis(dispute: DisputeDetails, viewerRole: ViewerRole = 'moderator'): DisputeAnalysis {
    const isBuyer = viewerRole === 'buyer';
    const isSeller = viewerRole === 'seller';

    const yourClaims = isBuyer
      ? [dispute.description]
      : isSeller
        ? ['Awaiting your response']
        : [dispute.description];

    const theirClaims = isBuyer
      ? ['Awaiting seller response']
      : isSeller
        ? [dispute.description]
        : ['Awaiting seller response'];

    const summary = viewerRole === 'moderator'
      ? `Dispute regarding "${dispute.productTitle}" - ${dispute.category.replace('_', ' ')}. Review required.`
      : isBuyer
        ? `Your dispute regarding "${dispute.productTitle}" is under review. Here's a summary of the situation.`
        : `A dispute has been raised regarding "${dispute.productTitle}". Here's what you need to know.`;

    return {
      summary,
      keyPoints: {
        yourClaims,
        theirClaims,
        buyerClaims: [dispute.description],
        sellerClaims: ['Awaiting seller response'],
      },
      sentiment: {
        yours: 'neutral',
        theirs: 'neutral',
        buyer: 'neutral',
        seller: 'neutral',
      },
      suggestedResolutions: [
        {
          type: 'mutual_agreement',
          description: viewerRole === 'moderator'
            ? 'Encourage both parties to reach an agreement'
            : 'Try to reach an agreement with the other party through the chat',
          fairnessScore: 7,
        },
      ],
      recommendedAction: viewerRole === 'moderator'
        ? 'Review evidence and conversation before deciding'
        : 'Review the conversation and consider responding to move towards a resolution',
      riskLevel: 'medium',
      additionalNotes: 'AI analysis unavailable - manual review required',
      viewerRole,
    };
  }

  private getDefaultBrief(dispute: DisputeDetails, analysis: DisputeAnalysis): string {
    return `
## Moderator Brief

**Dispute:** ${dispute.title}
**Category:** ${dispute.category.replace('_', ' ')}
**Amount:** K${dispute.orderAmount}
**Product:** ${dispute.productTitle}

### Summary
${analysis.summary}

### Recommended Action
${analysis.recommendedAction}

### Risk Level
${analysis.riskLevel.toUpperCase()}

---
*Please review all evidence before making a decision.*
    `.trim();
  }

  private getDefaultResolutionMessage(
    resolutionType: string,
    dispute: DisputeDetails,
    refundAmount?: number,
  ): string {
    const amount = resolutionType === 'full_refund'
      ? dispute.orderAmount
      : refundAmount || 0;

    if (resolutionType === 'no_refund') {
      return `Dear Buyer and Seller,

After careful review of this dispute regarding "${dispute.productTitle}", we have determined that a refund is not warranted in this case.

Both parties are encouraged to use this as a learning experience for future transactions.

Thank you for your patience during this process.

Best regards,
Gettitonline Support`;
    }

    return `Dear Buyer and Seller,

After careful review of this dispute regarding "${dispute.productTitle}", we have decided to issue a ${resolutionType === 'full_refund' ? 'full' : 'partial'} refund of K${amount}.

The refund will be processed within 3-5 business days.

Thank you for your patience during this process.

Best regards,
Gettitonline Support`;
  }
}
