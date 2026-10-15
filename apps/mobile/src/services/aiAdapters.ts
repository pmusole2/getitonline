// Maps the typed results of Pinkie's Convex actions to the shapes the mobile screens already use. The results are already
// validated by the shared parsers, so these functions only reshape them and pick the copy a user sees for a refusal.
import {
  AI_REFUSAL_COPY,
  AiRequestError,
  aiFailureMessage,
  hasQuotationMark,
  type AiRequestCode,
  type ChatReply,
  type DisputeAnalysisReply,
  type ModerationReply,
  type RecommendationsReply,
  type RephraseReply,
  type ResolutionMessageReply,
  type Sentiment,
  type SimilarProductsReply,
  type SuggestionsReply,
  type VisualSearchReply,
} from '@gettitonline/shared';

export { AI_REFUSAL_COPY };
export const aiErrorMessage = aiFailureMessage;

// Dispute calls get their own copy for the two refusals whose shared copy names a listing or moderation.
const DISPUTE_REFUSAL_COPY: Partial<Record<AiRequestCode, string>> = {
  not_found: 'This dispute could not be found. It may have been removed.',
  forbidden: 'AI help for a dispute is only available to its parties and reviewers.',
};

export function disputeFailureMessage(error: unknown): string | null {
  if (error instanceof AiRequestError) {
    return DISPUTE_REFUSAL_COPY[error.code] ?? aiFailureMessage(error);
  }
  return aiFailureMessage(error);
}

export type ChatSource = ChatReply['source'];

export interface ChatResponseAction {
  type: 'navigate' | 'search' | 'filter';
  label: string;
  payload: Record<string, string>;
}

export interface ChatResponse {
  message: string;
  source: ChatSource;
  suggestions?: string[];
  actions: ChatResponseAction[];
}

export interface RecommendationsResponse {
  productIds: string[];
  reasoning: string;
  source: RecommendationsReply['source'];
}

export interface VisualSearchResponse {
  query: string;
  terms: string[];
  source: VisualSearchReply['source'];
}

export interface ModerateListingResponse {
  status: ModerationReply['status'];
  summary: string;
  flags: string[];
  saved: boolean;
  source: ModerationReply['source'];
}

function adaptChatAction(action: ChatReply['actions'][number]): ChatResponseAction {
  if (action.type === 'navigate') {
    return { type: 'navigate', label: action.label, payload: { screen: action.payload.screen } };
  }
  return { type: 'search', label: action.label, payload: { query: action.payload.query } };
}

export function adaptChat(reply: ChatReply): ChatResponse {
  return {
    message: reply.reply,
    source: reply.source,
    actions: reply.actions.map(adaptChatAction),
  };
}

export function adaptRecommendations(reply: RecommendationsReply): RecommendationsResponse {
  return { productIds: reply.productIds, reasoning: reply.reasoning, source: reply.source };
}

export function adaptSimilarProducts(reply: SimilarProductsReply): string[] {
  return reply.productIds;
}

export function adaptVisualSearch(reply: VisualSearchReply): VisualSearchResponse {
  return { query: reply.query, terms: reply.terms, source: reply.source };
}

export function adaptModerateListing(reply: ModerationReply): ModerateListingResponse {
  return {
    status: reply.status,
    summary: reply.summary,
    flags: reply.flags,
    saved: reply.saved,
    source: reply.source,
  };
}

// What a rephrase means for the draft. A suggestion is offered only when the backend rewrote the text. An unchanged
// draft is kept as the user wrote it, with the reason when the reason is quotation marks.
export type RephraseOutcome = { kind: 'suggested'; text: string } | { kind: 'kept'; message: string };

const UNCHANGED_COPY = 'Your message was left as written.';
const UNCHANGED_QUOTED_COPY =
  'Your message was left as written. Messages with quotation marks are never changed, so quoted text stays exactly as you wrote it.';
const NO_CHANGE_COPY = 'No changes were suggested. Your message was left as written.';

export function adaptRephrase(reply: RephraseReply, draft: string): RephraseOutcome {
  if (reply.source === 'unchanged') {
    return { kind: 'kept', message: hasQuotationMark(draft) ? UNCHANGED_QUOTED_COPY : UNCHANGED_COPY };
  }
  // The backend trims the draft before it asks the model, so an ai rewrite is compared with the trimmed draft. An unchanged
  // draft comes back byte-identical and is never compared, so it needs no trimming here.
  if (reply.rephrased === draft.trim()) {
    return { kind: 'kept', message: NO_CHANGE_COPY };
  }
  return { kind: 'suggested', text: reply.rephrased };
}

export function adaptSuggestions(reply: SuggestionsReply): string[] {
  return reply.suggestions;
}

interface DisputeAnalysisShared {
  summary: string;
  suggestedResolutions: DisputeAnalysisReply['suggestedResolutions'];
  recommendedAction: string;
  riskLevel: DisputeAnalysisReply['riskLevel'];
  additionalNotes: string;
}

// A participant sees their own side only. A reviewer sees both sides, each in its own column.
export type DisputeAnalysisView =
  | (DisputeAnalysisShared & {
      viewer: 'participant';
      side: 'buyer' | 'seller';
      yourClaims: string[];
      theirClaims: string[];
      yourSentiment: Sentiment;
      theirSentiment: Sentiment;
    })
  | (DisputeAnalysisShared & {
      viewer: 'reviewer';
      buyerClaims: string[];
      sellerClaims: string[];
      buyerSentiment: Sentiment;
      sellerSentiment: Sentiment;
    });

export function adaptDisputeAnalysis(reply: DisputeAnalysisReply): DisputeAnalysisView {
  const shared: DisputeAnalysisShared = {
    summary: reply.summary,
    suggestedResolutions: reply.suggestedResolutions,
    recommendedAction: reply.recommendedAction,
    riskLevel: reply.riskLevel,
    additionalNotes: reply.additionalNotes,
  };
  if (reply.viewerRole === 'moderator') {
    return {
      viewer: 'reviewer',
      ...shared,
      buyerClaims: reply.keyPoints.buyerClaims,
      sellerClaims: reply.keyPoints.sellerClaims,
      buyerSentiment: reply.sentiment.buyer,
      sellerSentiment: reply.sentiment.seller,
    };
  }
  return {
    viewer: 'participant',
    side: reply.viewerRole,
    ...shared,
    yourClaims: reply.keyPoints.yourClaims,
    theirClaims: reply.keyPoints.theirClaims,
    yourSentiment: reply.sentiment.yours,
    theirSentiment: reply.sentiment.theirs,
  };
}

export function adaptResolutionMessage(reply: ResolutionMessageReply): string {
  return reply.message;
}
