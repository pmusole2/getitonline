import { Injectable } from '@nestjs/common';
import { AiService } from '../ai.service';

export interface ListingModerationInput {
  title: string;
  description: string;
  price: number;
  quantity: number;
  imageUrls: string[];
  categoryName?: string;
}

export interface ListingModerationResult {
  status: 'clear' | 'flagged' | 'error';
  summary: string;
  flags: string[];
}

@Injectable()
export class ListingModerationService {
  constructor(private readonly aiService: AiService) {}

  async moderateListing(
    listing: ListingModerationInput,
  ): Promise<ListingModerationResult> {
    if (!this.aiService.isConfigured()) {
      return {
        status: 'error',
        summary: 'AI moderation is unavailable because OpenAI is not configured.',
        flags: ['ai_unavailable'],
      };
    }

    const systemPrompt = `You are an ecommerce listing moderation assistant.
Review submitted listings for factual clarity, suspicious claims, weak image coverage, obvious spam, policy risk, and overall trustworthiness.
Respond with JSON matching:
{
  "status": "clear" | "flagged" | "error",
  "summary": string,
  "flags": string[]
}

Guidance:
- Use "clear" when the listing looks acceptable for manual approval.
- Use "flagged" when staff should inspect issues before approval.
- Keep flags short, snake_case tokens.
- Consider image quality heuristics from the image count and whether URLs are present, since you are not visually inspecting the actual image pixels in this workflow.`;

    try {
      return await this.aiService.generateJson<ListingModerationResult>(
        systemPrompt,
        JSON.stringify(
          {
            ...listing,
            imageCount: listing.imageUrls.length,
            hasImages: listing.imageUrls.length > 0,
          },
          null,
          2,
        ),
        { temperature: 0.2, maxTokens: 400 },
      );
    } catch {
      return {
        status: 'error',
        summary: 'AI moderation failed. Manual review is still required.',
        flags: ['ai_request_failed'],
      };
    }
  }
}
