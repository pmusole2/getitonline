/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as cart from "../cart.js";
import type * as categories from "../categories.js";
import type * as conversations from "../conversations.js";
import type * as delivery from "../delivery.js";
import type * as disputes from "../disputes.js";
import type * as escrow from "../escrow.js";
import type * as favorites from "../favorites.js";
import type * as http from "../http.js";
import type * as lib_clerkWebhook from "../lib/clerkWebhook.js";
import type * as lib_platform from "../lib/platform.js";
import type * as loyalty from "../loyalty.js";
import type * as messages from "../messages.js";
import type * as notifications from "../notifications.js";
import type * as orders from "../orders.js";
import type * as platform from "../platform.js";
import type * as products from "../products.js";
import type * as promotions from "../promotions.js";
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
  cart: typeof cart;
  categories: typeof categories;
  conversations: typeof conversations;
  delivery: typeof delivery;
  disputes: typeof disputes;
  escrow: typeof escrow;
  favorites: typeof favorites;
  http: typeof http;
  "lib/clerkWebhook": typeof lib_clerkWebhook;
  "lib/platform": typeof lib_platform;
  loyalty: typeof loyalty;
  messages: typeof messages;
  notifications: typeof notifications;
  orders: typeof orders;
  platform: typeof platform;
  products: typeof products;
  promotions: typeof promotions;
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
