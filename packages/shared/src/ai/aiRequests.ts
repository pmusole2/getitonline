// Shared orchestration for every Pinkie call a client makes. Each call, in order:
//   1. checks consent for the subject active when the call starts, before anything else is read or sent;
//   2. refuses guests from account-only actions without a provider call;
//   3. attaches the current consent version, and a session id only for a guest;
//   4. sends the call through the transport the client supplies;
//   5. discards the result if the active subject changed while the call was in flight;
//   6. validates the result from `unknown`, and throws a typed AiRequestError for every refusal or failure.
// Nothing here knows about React, Convex, or storage. Clients bind the transport and the dependencies.
import { AI_CONSENT_VERSION, type AiSubject } from "./aiConsent";
import {
  AiResultError,
  parseChatResult,
  parseDisputeAnalysisResult,
  parseModerationResult,
  parseRecommendationsResult,
  parseRephraseResult,
  parseResolutionResult,
  parseSimilarProductsResult,
  parseSuggestionsResult,
  parseVisualSearchResult,
  type AiRefusalCode,
  type ChatReply,
  type ChatTurn,
  type DisputeAnalysisReply,
  type ModerationReply,
  type RecommendationsReply,
  type RephraseReply,
  type ResolutionMessageReply,
  type SimilarProductsReply,
  type SuggestionsReply,
  type VisualSearchReply,
} from "./aiResults";

export type AiRequestCode = AiRefusalCode | "account_changed";

export class AiRequestError extends Error {
  readonly code: AiRequestCode;

  constructor(code: AiRequestCode) {
    super(`AI request refused: ${code}`);
    this.name = "AiRequestError";
    this.code = code;
  }
}

export interface ChatTransportArgs {
  message: string;
  consentVersion: number;
  conversationHistory?: ChatTurn[];
  sessionId?: string;
  currentScreen?: string;
  productId?: string;
}

// The transport passes these to the Convex actions. Each returns the raw result, which is validated here.
export interface AiTransport {
  chat(args: ChatTransportArgs): Promise<unknown>;
  getRecommendations(args: {
    consentVersion: number;
    limit?: number;
    cartProductIds?: string[];
  }): Promise<unknown>;
  similarProducts(args: {
    productId: string;
    consentVersion: number;
    limit?: number;
    sessionId?: string;
  }): Promise<unknown>;
  visualSearch(args: {
    imageDataUrl: string;
    consentVersion: number;
    sessionId?: string;
  }): Promise<unknown>;
  moderateListing(args: {
    productId: string;
    consentVersion: number;
  }): Promise<unknown>;
}

export type DisputeResolutionType =
  | "full_refund"
  | "partial_refund"
  | "no_refund";

// The dispute calls send the dispute id and their own input only. The backend derives the account, side, and role.
export interface DisputeTransport {
  rephraseMessage(args: {
    disputeId: string;
    message: string;
    consentVersion: number;
  }): Promise<unknown>;
  suggestResponses(args: {
    disputeId: string;
    consentVersion: number;
  }): Promise<unknown>;
  analyzeDispute(args: {
    disputeId: string;
    consentVersion: number;
  }): Promise<unknown>;
  generateResolutionMessage(args: {
    disputeId: string;
    resolutionType: DisputeResolutionType;
    refundAmount?: number;
    consentVersion: number;
  }): Promise<unknown>;
}

export interface AiRequestDeps {
  transport: AiTransport;
  hasConsent: (subject: AiSubject) => Promise<boolean>;
  // Read at the start and again at each checkpoint. A different generation means the active subject changed in between,
  // even when it changed back to the same subject value.
  currentSubject: () => AiSubjectState;
  guestSessionId: () => Promise<string>;
}

// The active subject and a counter that advances on every switch. A changed subject with the same value is still a change.
// The consent, session, and account checks every call goes through, whichever transport the call uses.
export type AiGateDeps = Omit<AiRequestDeps, "transport">;

export interface DisputeRequestDeps extends AiGateDeps {
  transport: DisputeTransport;
}

export interface ChatInput {
  message: string;
  conversationHistory?: ChatTurn[];
  currentScreen?: string;
  productId?: string;
}

export interface AiRequests {
  chat(input: ChatInput): Promise<ChatReply>;
  getRecommendations(input: {
    limit?: number;
    cartProductIds?: string[];
  }): Promise<RecommendationsReply>;
  similarProducts(input: {
    productId: string;
    limit?: number;
  }): Promise<SimilarProductsReply>;
  visualSearch(input: { imageDataUrl: string }): Promise<VisualSearchReply>;
  moderateListing(input: { productId: string }): Promise<ModerationReply>;
}

export interface DisputeRequests {
  rephraseMessage(input: {
    disputeId: string;
    message: string;
  }): Promise<RephraseReply>;
  suggestResponses(input: { disputeId: string }): Promise<SuggestionsReply>;
  analyzeDispute(input: { disputeId: string }): Promise<DisputeAnalysisReply>;
  generateResolutionMessage(input: {
    disputeId: string;
    resolutionType: DisputeResolutionType;
    refundAmount?: number;
  }): Promise<ResolutionMessageReply>;
}

interface Admission {
  state: AiSubjectState;
  sessionId: string | null;
}

// The active subject and a counter that advances on every switch. A switch back to an earlier subject is still a change.
export interface AiSubjectState {
  readonly subject: AiSubject;
  readonly generation: number;
}

// The next state once the active subject is read. The same subject keeps its state, and any other subject advances it.
export function advanceSubjectState(
  previous: AiSubjectState,
  subject: AiSubject,
): AiSubjectState {
  return previous.subject === subject
    ? previous
    : { subject, generation: previous.generation + 1 };
}

// The state a client reports after its owner unmounts. No live subject state has generation -1, so every checkpoint that
// reads it refuses the call as account_changed, including a reply that was already in flight.
export function retiredSubjectState(state: AiSubjectState): AiSubjectState {
  return { subject: state.subject, generation: -1 };
}

// Binds an action to the subject state that was active when the action was created (`bound`). Once the active state has
// changed, the action refuses before any consent check, session read, or transport call. `currentSubject` is read only when
// the action runs, so a client never reads its live state while rendering.
// Refuses when the current subject is not the one a caller was created for. Clients call it first thing in each action.
export function assertSubjectCurrent(
  bound: AiSubjectState,
  current: AiSubjectState,
): void {
  if (current.generation !== bound.generation) {
    throw new AiRequestError("account_changed");
  }
}

export function bindToSubject<Args extends unknown[], Result>(
  bound: AiSubjectState,
  currentSubject: () => AiSubjectState,
  action: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    assertSubjectCurrent(bound, currentSubject());
    return action(...args);
  };
}

function createGate(deps: AiGateDeps) {
  // Every checkpoint compares the generation with the one read at call start. A switch at any checkpoint ends the call
  // before its next step, so a result can never reach the account that became active after the call began.
  function assertUnchanged(start: AiSubjectState): void {
    if (deps.currentSubject().generation !== start.generation) {
      throw new AiRequestError("account_changed");
    }
  }

  // Consent comes first, so a refused request reads and sends nothing. A guest's session id is read only after consent.
  async function admit(requireAccount: boolean): Promise<Admission> {
    const state = deps.currentSubject();
    const subject = state.subject;
    const consented = await deps.hasConsent(subject);
    assertUnchanged(state);
    if (!consented) {
      throw new AiRequestError("consent_required");
    }
    if (requireAccount && subject === "guest") {
      throw new AiRequestError("account_required");
    }
    let sessionId: string | null = null;
    if (subject === "guest") {
      sessionId = await deps.guestSessionId();
      assertUnchanged(state);
    }
    return { state, sessionId };
  }

  // Sends one call and returns its validated result. A result from a previous subject is discarded, whether it
  // succeeded or failed. A result that does not match the contract becomes `unavailable`, never a partial value.
  async function settle<T>(
    start: AiSubjectState,
    request: () => Promise<unknown>,
    parse: (raw: unknown) => T,
  ): Promise<T> {
    // The last check before dispatch. Nothing awaits between this check and the transport call.
    assertUnchanged(start);
    let raw: unknown;
    try {
      raw = await request();
    } catch {
      throw new AiRequestError(
        deps.currentSubject().generation === start.generation
          ? "unavailable"
          : "account_changed",
      );
    }
    assertUnchanged(start);
    try {
      return parse(raw);
    } catch (error: unknown) {
      if (error instanceof AiResultError) {
        throw new AiRequestError("unavailable");
      }
      throw error;
    }
  }

  return { admit, settle };
}

export function createAiRequests(deps: AiRequestDeps): AiRequests {
  const { admit, settle } = createGate(deps);

  return {
    async chat(input) {
      const { state, sessionId } = await admit(false);
      const args: ChatTransportArgs = {
        message: input.message,
        consentVersion: AI_CONSENT_VERSION,
      };
      if (sessionId !== null) args.sessionId = sessionId;
      if (input.conversationHistory !== undefined)
        args.conversationHistory = input.conversationHistory;
      if (input.currentScreen !== undefined)
        args.currentScreen = input.currentScreen;
      if (input.productId !== undefined) args.productId = input.productId;

      const result = await settle(
        state,
        () => deps.transport.chat(args),
        parseChatResult,
      );
      if (!result.ok) throw new AiRequestError(result.code);
      return result;
    },

    async getRecommendations(input) {
      const { state } = await admit(true);
      const args: {
        consentVersion: number;
        limit?: number;
        cartProductIds?: string[];
      } = {
        consentVersion: AI_CONSENT_VERSION,
      };
      if (input.limit !== undefined) args.limit = input.limit;
      if (input.cartProductIds !== undefined)
        args.cartProductIds = input.cartProductIds;

      const result = await settle(
        state,
        () => deps.transport.getRecommendations(args),
        parseRecommendationsResult,
      );
      if (!result.ok) throw new AiRequestError(result.code);
      return result;
    },

    async similarProducts(input) {
      const { state, sessionId } = await admit(false);
      const args: {
        productId: string;
        consentVersion: number;
        limit?: number;
        sessionId?: string;
      } = {
        productId: input.productId,
        consentVersion: AI_CONSENT_VERSION,
      };
      if (input.limit !== undefined) args.limit = input.limit;
      if (sessionId !== null) args.sessionId = sessionId;

      const result = await settle(
        state,
        () => deps.transport.similarProducts(args),
        parseSimilarProductsResult,
      );
      if (!result.ok) throw new AiRequestError(result.code);
      return result;
    },

    async visualSearch(input) {
      const { state, sessionId } = await admit(false);
      const args: {
        imageDataUrl: string;
        consentVersion: number;
        sessionId?: string;
      } = {
        imageDataUrl: input.imageDataUrl,
        consentVersion: AI_CONSENT_VERSION,
      };
      if (sessionId !== null) args.sessionId = sessionId;

      const result = await settle(
        state,
        () => deps.transport.visualSearch(args),
        parseVisualSearchResult,
      );
      if (!result.ok) throw new AiRequestError(result.code);
      return result;
    },

    async moderateListing(input) {
      const { state } = await admit(true);
      // Only the product id leaves the client. The backend reads the stored listing itself.
      const args = {
        productId: input.productId,
        consentVersion: AI_CONSENT_VERSION,
      };

      const result = await settle(
        state,
        () => deps.transport.moderateListing(args),
        parseModerationResult,
      );
      if (!result.ok) throw new AiRequestError(result.code);
      return result;
    },
  };
}

// Dispute calls are account-only. A guest is refused before any call, and nothing else leaves the client.
export function createDisputeRequests(
  deps: DisputeRequestDeps,
): DisputeRequests {
  const { admit, settle } = createGate(deps);

  return {
    async rephraseMessage(input) {
      const { state } = await admit(true);
      const args = {
        disputeId: input.disputeId,
        message: input.message,
        consentVersion: AI_CONSENT_VERSION,
      };

      const result = await settle(
        state,
        () => deps.transport.rephraseMessage(args),
        parseRephraseResult,
      );
      if (!result.ok) throw new AiRequestError(result.code);
      return result;
    },

    async suggestResponses(input) {
      const { state } = await admit(true);
      const args = {
        disputeId: input.disputeId,
        consentVersion: AI_CONSENT_VERSION,
      };

      const result = await settle(
        state,
        () => deps.transport.suggestResponses(args),
        parseSuggestionsResult,
      );
      if (!result.ok) throw new AiRequestError(result.code);
      return result;
    },

    async analyzeDispute(input) {
      const { state } = await admit(true);
      const args = {
        disputeId: input.disputeId,
        consentVersion: AI_CONSENT_VERSION,
      };

      const result = await settle(
        state,
        () => deps.transport.analyzeDispute(args),
        parseDisputeAnalysisResult,
      );
      if (!result.ok) throw new AiRequestError(result.code);
      return result;
    },

    async generateResolutionMessage(input) {
      const { state } = await admit(true);
      const args: {
        disputeId: string;
        resolutionType: DisputeResolutionType;
        refundAmount?: number;
        consentVersion: number;
      } = {
        disputeId: input.disputeId,
        resolutionType: input.resolutionType,
        consentVersion: AI_CONSENT_VERSION,
      };
      if (input.refundAmount !== undefined)
        args.refundAmount = input.refundAmount;

      const result = await settle(
        state,
        () => deps.transport.generateResolutionMessage(args),
        parseResolutionResult,
      );
      if (!result.ok) throw new AiRequestError(result.code);
      return result;
    },
  };
}
