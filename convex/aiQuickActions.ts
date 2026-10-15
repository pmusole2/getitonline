import { v } from "convex/values";
import { query } from "./_generated/server";

// Pinkie's quick actions: fixed suggestions for each screen, copied from the legacy suggestQuickActions in
// apps/api/src/ai/services/chat.service.ts. No account, no provider call, and no database read, so guests can call it.
// A Map keeps a screen name such as "constructor" from matching an inherited property; it falls back to Home, as before.

const HOME = [
  "How many products are listed?",
  "What categories are available?",
  "Show me the cheapest items",
  "What are the newest listings?",
];

const SCREEN_SUGGESTIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ["Home", HOME],
  ["Browse", ["Filter by price range", "Show new arrivals only", "Find items near me", "Compare similar products"]],
  [
    "ProductDetail",
    [
      "Is this a good price?",
      "What shipping options are available?",
      "Tell me about the seller",
      "Are there similar products?",
    ],
  ],
  ["Cart", ["What is my total?", "Apply discount code", "Change shipping method", "Checkout help"]],
  ["Orders", ["Track my latest order", "How many orders do I have?", "Request a refund", "Contact the seller"]],
  [
    "Profile",
    [
      "How many items have I sold?",
      "What is my seller rating?",
      "Show my active listings",
      "How many views on my products?",
    ],
  ],
]);

export const getQuickActions = query({
  args: { currentScreen: v.optional(v.string()) },
  handler: async (_ctx, args): Promise<string[]> => {
    const suggestions = SCREEN_SUGGESTIONS.get(args.currentScreen ?? "") ?? HOME;
    return [...suggestions];
  },
});
