import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

@Injectable()
export class AiService implements OnModuleInit {
  private openai: OpenAI;
  private model: string;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const apiKey = this.configService.get<string>('openai.apiKey');
    if (!apiKey) {
      console.warn('OpenAI API key not configured. AI features will be disabled.');
      return;
    }

    this.openai = new OpenAI({ apiKey });
    this.model = this.configService.get<string>('openai.model') || 'gpt-4o-mini';
  }

  isConfigured(): boolean {
    return !!this.openai;
  }

  async chat(
    systemPrompt: string,
    userMessage: string,
    options?: {
      temperature?: number;
      maxTokens?: number;
    },
  ): Promise<string> {
    if (!this.openai) {
      throw new Error('OpenAI is not configured');
    }

    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 1000,
    });

    return response.choices[0]?.message?.content || '';
  }

  async chatWithHistory(
    systemPrompt: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    options?: {
      temperature?: number;
      maxTokens?: number;
    },
  ): Promise<string> {
    if (!this.openai) {
      throw new Error('OpenAI is not configured');
    }

    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 1000,
    });

    return response.choices[0]?.message?.content || '';
  }

  async generateJson<T>(
    systemPrompt: string,
    userMessage: string,
    options?: {
      temperature?: number;
      maxTokens?: number;
    },
  ): Promise<T> {
    const response = await this.chat(
      systemPrompt + '\n\nRespond ONLY with valid JSON, no markdown or explanation.',
      userMessage,
      options,
    );

    try {
      // Try to extract JSON from the response
      const jsonMatch = response.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as T;
      }
      return JSON.parse(response) as T;
    } catch {
      throw new Error(`Failed to parse AI response as JSON: ${response}`);
    }
  }

  async generateVisualSearchTerms(imageDataUrl: string): Promise<{ query: string; terms: string[] }> {
    if (!this.openai) {
      throw new Error('OpenAI is not configured');
    }

    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content:
            'You generate concise product marketplace search terms from images. Return JSON only.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Identify the main sellable product in this image for an online marketplace search. Return {"query":"short search phrase","terms":["term"]}. Avoid color-only or background-only terms.',
            },
            {
              type: 'image_url',
              image_url: {
                url: imageDataUrl,
                detail: 'low',
              },
            },
          ],
        },
      ],
      temperature: 0.2,
      max_tokens: 180,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content || '{}';

    try {
      const parsed = JSON.parse(content) as {
        query?: unknown;
        terms?: unknown;
      };
      const terms = Array.isArray(parsed.terms)
        ? parsed.terms
            .filter((term): term is string => typeof term === 'string')
            .map((term) => term.trim())
            .filter(Boolean)
            .slice(0, 8)
        : [];
      const query =
        typeof parsed.query === 'string' && parsed.query.trim()
          ? parsed.query.trim()
          : terms.join(' ');

      return {
        query,
        terms,
      };
    } catch {
      throw new Error(`Failed to parse visual search response: ${content}`);
    }
  }
}
