import { Injectable } from '@nestjs/common';
import { AiService } from '../ai.service';
import {
  ASSISTANT_IDENTITY_PROMPT,
  ASSISTANT_NAME,
  GHOSTWRITING_RULE,
} from '../assistant-identity';

interface RephraseResult {
  original: string;
  rephrased: string;
  isProfessional: boolean;
  issues: string[];
  suggestions: string[];
}

@Injectable()
export class MessageRephraseService {
  constructor(private aiService: AiService) {}

  async analyzeAndRephrase(
    message: string,
    context: {
      senderRole: 'buyer' | 'seller' | 'moderator';
      disputeContext?: string;
    },
  ): Promise<RephraseResult> {
    if (!this.aiService.isConfigured()) {
      return {
        original: message,
        rephrased: message,
        isProfessional: true,
        issues: [],
        suggestions: [],
      };
    }

    // Quick check for very short or clearly professional messages
    if (message.length < 20) {
      return {
        original: message,
        rephrased: message,
        isProfessional: true,
        issues: [],
        suggestions: [],
      };
    }

    const systemPrompt = `You are ${ASSISTANT_NAME}, a professional communication assistant for an online marketplace dispute resolution system.
${ASSISTANT_IDENTITY_PROMPT}
For the rephrased version only: ${GHOSTWRITING_RULE}
Your job is to:
1. Analyze messages for professionalism and constructiveness
2. Identify any issues (hostile language, threats, profanity, unconstructive criticism)
3. Suggest a rephrased version that maintains the sender's intent but is more professional and constructive
4. Help facilitate productive dispute resolution

The sender is a ${context.senderRole} in this dispute.
${context.disputeContext ? `Dispute context: ${context.disputeContext}` : ''}

Return a JSON object with:
- original: the original message
- rephrased: a more professional version (or same if already professional)
- isProfessional: boolean indicating if the original was already professional
- issues: array of issues found (empty if professional)
- suggestions: array of tips for better communication (1-2 tips)

Be helpful but not preachy. Only suggest rephrasing if there are genuine issues.
Cultural note: This is for Zambia, so be culturally appropriate.`;

    const userMessage = `Please analyze this message:\n\n"${message}"`;

    try {
      const result = await this.aiService.generateJson<RephraseResult>(
        systemPrompt,
        userMessage,
        { temperature: 0.3 },
      );

      return {
        original: message,
        rephrased: result.rephrased || message,
        isProfessional: result.isProfessional ?? true,
        issues: result.issues || [],
        suggestions: result.suggestions || [],
      };
    } catch (error) {
      console.error('Message rephrase failed:', error);
      return {
        original: message,
        rephrased: message,
        isProfessional: true,
        issues: [],
        suggestions: [],
      };
    }
  }

  async suggestResponse(
    conversationHistory: Array<{
      sender: 'buyer' | 'seller' | 'moderator';
      message: string;
    }>,
    respondAs: 'buyer' | 'seller' | 'moderator',
    disputeContext: string,
  ): Promise<string[]> {
    if (!this.aiService.isConfigured()) {
      return [];
    }

    const systemPrompt = `You are ${ASSISTANT_NAME}, helping a ${respondAs} respond to a dispute conversation in a Zambian online marketplace.
${ASSISTANT_IDENTITY_PROMPT}
${GHOSTWRITING_RULE}
Generate 2-3 professional response suggestions that could help resolve the dispute.

Keep responses:
- Professional and respectful
- Constructive and solution-oriented
- Culturally appropriate for Zambia
- Concise (1-2 sentences each)

Return a JSON array of string suggestions.`;

    const conversationText = conversationHistory
      .map((m) => `${m.sender.toUpperCase()}: ${m.message}`)
      .join('\n');

    const userMessage = `Dispute: ${disputeContext}

Conversation:
${conversationText}

Suggest ${respondAs === 'moderator' ? '3' : '2'} professional responses for the ${respondAs}.`;

    try {
      return await this.aiService.generateJson<string[]>(
        systemPrompt,
        userMessage,
        { temperature: 0.7 },
      );
    } catch {
      return [];
    }
  }
}
