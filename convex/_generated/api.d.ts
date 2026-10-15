/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ai from "../ai.js";
import type * as aiData from "../aiData.js";
import type * as aiDiscovery from "../aiDiscovery.js";
import type * as aiDiscoveryData from "../aiDiscoveryData.js";
import type * as aiDisputes from "../aiDisputes.js";
import type * as aiDisputesData from "../aiDisputesData.js";
import type * as aiHealth from "../aiHealth.js";
import type * as aiModeration from "../aiModeration.js";
import type * as aiModerationData from "../aiModerationData.js";
import type * as aiQuickActions from "../aiQuickActions.js";
import type * as aiUsage from "../aiUsage.js";
import type * as appConfig from "../appConfig.js";
import type * as cart from "../cart.js";
import type * as categories from "../categories.js";
import type * as checkoutCollection from "../checkoutCollection.js";
import type * as checkoutQuote from "../checkoutQuote.js";
import type * as conversations from "../conversations.js";
import type * as delivery from "../delivery.js";
import type * as disputes from "../disputes.js";
import type * as escrow from "../escrow.js";
import type * as favorites from "../favorites.js";
import type * as http from "../http.js";
import type * as lib_aiChatPolicy from "../lib/aiChatPolicy.js";
import type * as lib_aiDiscoveryPolicy from "../lib/aiDiscoveryPolicy.js";
import type * as lib_aiDisputePolicy from "../lib/aiDisputePolicy.js";
import type * as lib_aiGate from "../lib/aiGate.js";
import type * as lib_aiModerationPolicy from "../lib/aiModerationPolicy.js";
import type * as lib_clerkWebhook from "../lib/clerkWebhook.js";
import type * as lib_platform from "../lib/platform.js";
import type * as lencoWebhook from "../lencoWebhook.js";
import type * as lencoWebhookData from "../lencoWebhookData.js";
import type * as loyalty from "../loyalty.js";
import type * as messages from "../messages.js";
import type * as notifications from "../notifications.js";
import type * as orders from "../orders.js";
import type * as paymentInboxPolling from "../paymentInboxPolling.js";
import type * as paymentOperations from "../paymentOperations.js";
import type * as paymentPolling from "../paymentPolling.js";
import type * as paymentReconciliation from "../paymentReconciliation.js";
import type * as paymentReconciliationData from "../paymentReconciliationData.js";
import type * as platform from "../platform.js";
import type * as products from "../products.js";
import type * as promotions from "../promotions.js";
import type * as providerSettlement from "../providerSettlement.js";
import type * as providerOperations from "../providerOperations.js";
import type * as reviews from "../reviews.js";
import type * as seed from "../seed.js";
import type * as storage from "../storage.js";
import type * as taxonomySeed from "../taxonomySeed.js";
import type * as transactions from "../transactions.js";
import type * as users from "../users.js";
import type * as vendors from "../vendors.js";
import type * as wallet from "../wallet.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ai: typeof ai;
  aiData: typeof aiData;
  aiDiscovery: typeof aiDiscovery;
  aiDiscoveryData: typeof aiDiscoveryData;
  aiDisputes: typeof aiDisputes;
  aiDisputesData: typeof aiDisputesData;
  aiHealth: typeof aiHealth;
  aiModeration: typeof aiModeration;
  aiModerationData: typeof aiModerationData;
  aiQuickActions: typeof aiQuickActions;
  aiUsage: typeof aiUsage;
  appConfig: typeof appConfig;
  cart: typeof cart;
  categories: typeof categories;
  checkoutCollection: typeof checkoutCollection;
  checkoutQuote: typeof checkoutQuote;
  conversations: typeof conversations;
  delivery: typeof delivery;
  disputes: typeof disputes;
  escrow: typeof escrow;
  favorites: typeof favorites;
  http: typeof http;
  "lib/aiChatPolicy": typeof lib_aiChatPolicy;
  "lib/aiDiscoveryPolicy": typeof lib_aiDiscoveryPolicy;
  "lib/aiDisputePolicy": typeof lib_aiDisputePolicy;
  "lib/aiGate": typeof lib_aiGate;
  "lib/aiModerationPolicy": typeof lib_aiModerationPolicy;
  "lib/clerkWebhook": typeof lib_clerkWebhook;
  "lib/platform": typeof lib_platform;
  lencoWebhook: typeof lencoWebhook;
  lencoWebhookData: typeof lencoWebhookData;
  loyalty: typeof loyalty;
  messages: typeof messages;
  notifications: typeof notifications;
  orders: typeof orders;
  paymentInboxPolling: typeof paymentInboxPolling;
  paymentOperations: typeof paymentOperations;
  paymentPolling: typeof paymentPolling;
  paymentReconciliation: typeof paymentReconciliation;
  paymentReconciliationData: typeof paymentReconciliationData;
  platform: typeof platform;
  products: typeof products;
  promotions: typeof promotions;
  providerOperations: typeof providerOperations;
  providerSettlement: typeof providerSettlement;
  reviews: typeof reviews;
  seed: typeof seed;
  storage: typeof storage;
  taxonomySeed: typeof taxonomySeed;
  transactions: typeof transactions;
  users: typeof users;
  vendors: typeof vendors;
  wallet: typeof wallet;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
