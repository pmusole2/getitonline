import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Milestone 1: these functions take the acting user from the verified Clerk token.
// Caller-supplied actor IDs must not be accepted as arguments, and the body must
// call the shared access guard with the expected roles.
const BOUND: Array<{ file: string; name: string; guard: string; forbiddenArgs: string[] }> = [
  { file: 'users.ts', name: 'upsertUser', guard: 'token', forbiddenArgs: ['clerkId'] },
  { file: 'users.ts', name: 'updateUserRole', guard: 'requireRole(ctx, ["admin"])', forbiddenArgs: ['adminId'] },
  { file: 'users.ts', name: 'toggleUserBan', guard: 'requireRole(ctx, ["admin"])', forbiddenArgs: ['adminId'] },
  { file: 'users.ts', name: 'getAllUsers', guard: 'requireRole(ctx, ["admin"])', forbiddenArgs: ['adminId'] },
  {
    file: 'platform.ts',
    name: 'getPlatformSettingsForAdmin',
    guard: 'requireRole(ctx, ["admin"])',
    forbiddenArgs: ['adminId'],
  },
  {
    file: 'wallet.ts',
    name: 'freezeWallet',
    guard: 'requireRole(ctx, ["admin"])',
    forbiddenArgs: ['adminId'],
  },
  {
    file: 'wallet.ts',
    name: 'unfreezeWallet',
    guard: 'requireRole(ctx, ["admin"])',
    forbiddenArgs: ['adminId'],
  },
  { file: 'orders.ts', name: 'completeOrder', guard: 'requireUser(ctx)', forbiddenArgs: ['buyerId'] },
  { file: 'orders.ts', name: 'cancelOrder', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  {
    file: 'disputes.ts',
    name: 'resolveDispute',
    guard: 'requireRole(ctx, ["moderator", "admin"])',
    forbiddenArgs: ['moderatorId'],
  },
  { file: 'disputes.ts', name: 'buyerResolveDispute', guard: 'requireUser(ctx)', forbiddenArgs: ['buyerId'] },
  { file: 'loyalty.ts', name: 'redeemPoints', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'cart.ts', name: 'getCart', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'cart.ts', name: 'addToCart', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'cart.ts', name: 'mergeGuestCart', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'cart.ts', name: 'updateCartQuantity', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'cart.ts', name: 'updateCartShipping', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'cart.ts', name: 'removeFromCart', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'cart.ts', name: 'clearCart', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'cart.ts', name: 'getCartCount', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'cart.ts', name: 'validateCart', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'cart.ts', name: 'getCartBySeller', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'favorites.ts', name: 'addFavorite', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'favorites.ts', name: 'removeFavorite', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'favorites.ts', name: 'toggleFavorite', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'favorites.ts', name: 'isFavorited', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'favorites.ts', name: 'getUserFavorites', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'favorites.ts', name: 'getFavoritesCount', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'favorites.ts', name: 'clearFavorites', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'wallet.ts', name: 'getWalletBalance', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'wallet.ts', name: 'getWalletTransactions', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'wallet.ts', name: 'getWalletActivity', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'wallet.ts', name: 'createWallet', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'wallet.ts', name: 'canPayWithWallet', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'wallet.ts', name: 'ensureWallet', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'wallet.ts', name: 'getWallet', guard: 'requireSelfOr(ctx, args.userId, ["admin"])', forbiddenArgs: [] },
  { file: 'reviews.ts', name: 'createReview', guard: 'requireUser(ctx)', forbiddenArgs: ['reviewerId'] },
  { file: 'reviews.ts', name: 'canReviewOrder', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'reviews.ts', name: 'getUserWrittenReviews', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'reviews.ts', name: 'deleteReview', guard: 'requireRole(ctx, ["admin"])', forbiddenArgs: ['adminId'] },
  { file: 'notifications.ts', name: 'getUserBehaviorSummary', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'notifications.ts', name: 'upsertNotificationDevice', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'notifications.ts', name: 'getUserNotifications', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'notifications.ts', name: 'markAsRead', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'notifications.ts', name: 'markAllAsRead', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'notifications.ts', name: 'getUnreadCount', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'notifications.ts', name: 'deleteNotification', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'notifications.ts', name: 'deleteAllNotifications', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'messages.ts', name: 'sendMessage', guard: 'requireUser(ctx)', forbiddenArgs: ['senderId'] },
  { file: 'messages.ts', name: 'getMessages', guard: 'requireUser(ctx)', forbiddenArgs: ['userId', 'viewerUserId'] },
  {
    file: 'messages.ts',
    name: 'getMessagesPaginated',
    guard: 'requireUser(ctx)',
    forbiddenArgs: ['userId', 'viewerUserId'],
  },
  {
    file: 'messages.ts',
    name: 'getMessageCount',
    guard: 'requireUser(ctx)',
    forbiddenArgs: ['userId', 'viewerUserId'],
  },
  { file: 'messages.ts', name: 'getLastMessage', guard: 'requireUser(ctx)', forbiddenArgs: ['userId', 'viewerUserId'] },
  {
    file: 'messages.ts',
    name: 'getMessagesForAnalysis',
    guard: 'requireUser(ctx)',
    forbiddenArgs: ['userId', 'viewerUserId'],
  },
  {
    file: 'messages.ts',
    name: 'updateMessageWithRephrase',
    guard: 'requireUser(ctx)',
    forbiddenArgs: ['senderId', 'userId'],
  },
  { file: 'users.ts', name: 'updateProfile', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'users.ts', name: 'updateInterests', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'users.ts', name: 'getPreferences', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'users.ts', name: 'updatePreferences', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'users.ts', name: 'updateThemeMode', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'users.ts', name: 'getUser', guard: 'requireUser(ctx)', forbiddenArgs: ['viewerId', 'adminId'] },
  { file: 'users.ts', name: 'getUsersByRole', guard: 'requireRole(ctx, ["admin"])', forbiddenArgs: ['adminId'] },
  { file: 'orders.ts', name: 'getBuyerOrders', guard: 'requireUser(ctx)', forbiddenArgs: ['buyerId'] },
  { file: 'orders.ts', name: 'confirmDelivery', guard: 'requireUser(ctx)', forbiddenArgs: ['buyerId'] },
  { file: 'orders.ts', name: 'updateOrderStatus', guard: 'requireUser(ctx)', forbiddenArgs: ['userId'] },
  { file: 'orders.ts', name: 'addTrackingInfo', guard: 'requireUser(ctx)', forbiddenArgs: ['sellerId'] },
  { file: 'orders.ts', name: 'markAsShipped', guard: 'requireUser(ctx)', forbiddenArgs: ['sellerId'] },
  { file: 'delivery.ts', name: 'addOrderTrackingEvent', guard: 'requireUser(ctx)', forbiddenArgs: ['actorUserId'] },
  { file: 'delivery.ts', name: 'getOrderTrackingEvents', guard: 'requireUser(ctx)', forbiddenArgs: ['viewerUserId'] },
  { file: 'delivery.ts', name: 'requestReturn', guard: 'requireUser(ctx)', forbiddenArgs: ['buyerId'] },
  { file: 'delivery.ts', name: 'reviewReturnRequest', guard: 'requireUser(ctx)', forbiddenArgs: ['actorUserId'] },
  { file: 'delivery.ts', name: 'getReturnRequests', guard: 'requireUser(ctx)', forbiddenArgs: ['viewerUserId'] },
  { file: 'delivery.ts', name: 'getOrderReturnRequests', guard: 'requireUser(ctx)', forbiddenArgs: ['viewerUserId'] },
  // Staff guards: the token-derived actor is checked. The adminId/reviewerId arguments are still
  // accepted for client compatibility but ignored; removing them is a separate client change.
  { file: 'transactions.ts', name: 'listTransactionsForAdmin', guard: 'ensureAdminActor(ctx)', forbiddenArgs: [] },
  { file: 'transactions.ts', name: 'getTransactionStats', guard: 'ensureAdminActor(ctx)', forbiddenArgs: [] },
  { file: 'transactions.ts', name: 'getPlatformFinancialSummary', guard: 'ensureAdminActor(ctx)', forbiddenArgs: [] },
  { file: 'platform.ts', name: 'updatePlatformSettings', guard: 'ensureAdminActor(ctx)', forbiddenArgs: [] },
  { file: 'categories.ts', name: 'createCategory', guard: 'ensureAdminActor(ctx)', forbiddenArgs: [] },
  { file: 'categories.ts', name: 'deleteCategory', guard: 'ensureAdminActor(ctx)', forbiddenArgs: [] },
  { file: 'taxonomySeed.ts', name: 'seedPrdRetailTaxonomy', guard: 'ensureAdminActor(ctx)', forbiddenArgs: [] },
  { file: 'products.ts', name: 'reviewListing', guard: 'ensureReviewerActor(ctx)', forbiddenArgs: [] },
  { file: 'products.ts', name: 'createProduct', guard: 'requireUser(ctx)', forbiddenArgs: ['actorUserId'] },
  { file: 'products.ts', name: 'updateProduct', guard: 'requireUser(ctx)', forbiddenArgs: ['actorUserId'] },
  { file: 'products.ts', name: 'submitForReview', guard: 'requireUser(ctx)', forbiddenArgs: ['actorUserId'] },
  { file: 'products.ts', name: 'deleteProduct', guard: 'requireUser(ctx)', forbiddenArgs: ['actorUserId'] },
  { file: 'products.ts', name: 'markAsSold', guard: 'requireUser(ctx)', forbiddenArgs: ['actorUserId'] },
  { file: 'products.ts', name: 'getMyListings', guard: 'requireUser(ctx)', forbiddenArgs: ['actorUserId'] },
  { file: 'products.ts', name: 'getProduct', guard: 'optionalUser(ctx)', forbiddenArgs: ['viewerUserId'] },
  { file: 'products.ts', name: 'getProductsBySeller', guard: 'optionalUser(ctx)', forbiddenArgs: ['viewerUserId'] },
  {
    file: 'products.ts',
    name: 'getManagedCatalogProducts',
    guard: 'ensureCatalogActor(ctx)',
    forbiddenArgs: ['actorUserId'],
  },
  { file: 'vendors.ts', name: 'getVendorStorefront', guard: 'optionalUser(ctx)', forbiddenArgs: ['viewerUserId'] },
  { file: 'vendors.ts', name: 'submitApplication', guard: 'requireUser(ctx)', forbiddenArgs: ['ownerUserId'] },
  { file: 'vendors.ts', name: 'getMyVendorProfile', guard: 'requireUser(ctx)', forbiddenArgs: ['ownerUserId'] },
  { file: 'orders.ts', name: 'getOrder', guard: 'requireUser(ctx)', forbiddenArgs: ['userId', 'viewerUserId'] },
  { file: 'orders.ts', name: 'getOrderByNumber', guard: 'requireUser(ctx)', forbiddenArgs: ['userId', 'viewerUserId'] },
  { file: 'orders.ts', name: 'getSellerOrders', guard: 'requireUser(ctx)', forbiddenArgs: ['userId', 'viewerUserId'] },
  {
    file: 'orders.ts',
    name: 'getManagedCatalogOrders',
    guard: 'ensureCatalogActor(ctx)',
    forbiddenArgs: ['actorUserId'],
  },
  // Disputes: the actor is the verified user. `sellerId` stays on getSellerDisputes as a lookup key, and the handler
  // checks it against the actor, so it is not forbidden here.
  {
    file: 'disputes.ts',
    name: 'createDispute',
    guard: 'requireUser(ctx)',
    forbiddenArgs: ['buyerId', 'userId'],
  },
  {
    file: 'disputes.ts',
    name: 'getDispute',
    guard: 'requireUser(ctx)',
    forbiddenArgs: ['userId', 'viewerUserId'],
  },
  {
    file: 'disputes.ts',
    name: 'getDisputeByOrder',
    guard: 'requireUser(ctx)',
    forbiddenArgs: ['userId', 'viewerUserId'],
  },
  {
    file: 'disputes.ts',
    name: 'getBuyerDisputes',
    guard: 'requireUser(ctx)',
    forbiddenArgs: ['buyerId', 'userId'],
  },
  {
    file: 'disputes.ts',
    name: 'getSellerDisputes',
    guard: 'requireUser(ctx)',
    forbiddenArgs: ['userId', 'viewerUserId'],
  },
  {
    file: 'disputes.ts',
    name: 'updateDisputeStatus',
    guard: 'requireUser(ctx)',
    forbiddenArgs: ['userId'],
  },
  {
    file: 'disputes.ts',
    name: 'addEvidence',
    guard: 'requireUser(ctx)',
    forbiddenArgs: ['userId'],
  },
];

const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

function functionBlock(source: string, name: string): string {
  const start = source.search(new RegExp(`export const ${name} = (mutation|query)\\(`));
  assert.notEqual(start, -1, `${name} must be an exported public function`);
  const end = source.indexOf('\n});\n', start);
  assert.notEqual(end, -1, `${name} block must close`);
  return source.slice(start, end);
}

test('bound functions are public and guarded by the token-derived actor', () => {
  for (const { file, name, guard, forbiddenArgs } of BOUND) {
    const block = functionBlock(read(file), name);
    if (guard !== 'token') {
      assert.ok(block.includes(guard), `${file}:${name} must call ${guard}`);
    } else {
      assert.ok(block.includes('ctx.auth.getUserIdentity()'), `${file}:${name} must read the Clerk identity`);
    }
    const argsBlock = block.slice(0, block.indexOf('handler:'));
    for (const arg of forbiddenArgs) {
      assert.doesNotMatch(argsBlock, new RegExp(`\\b${arg}\\s*:`), `${file}:${name} must not accept ${arg}`);
    }
  }
});

// Source text misses validators declared outside the function body (for example vendorApplicationArgs), so the
// registered validator is read too. Convex serialises it with exportArgs(). This is a schema check only: it does
// not deploy, and it does not verify a Clerk token. The handler tests cover behaviour.
test('registered argument schemas do not accept caller-supplied actor IDs', async () => {
  for (const { file, name, forbiddenArgs } of BOUND) {
    const argNames = await registeredArgNames(file, name);
    for (const arg of forbiddenArgs) {
      assert.ok(!argNames.includes(arg), `${file}:${name} must not register ${arg} as an argument`);
    }
  }
});

async function registeredArgNames(file: string, name: string): Promise<string[]> {
  const loaded: unknown = await import(`./${file.replace(/\.ts$/, '')}`);
  assert.ok(isRecord(loaded), `${file} must load as a module`);
  const registered: unknown = loaded[name];
  assert.ok(hasExportArgs(registered), `${file}:${name} must be a registered Convex function`);
  const schema: unknown = JSON.parse(registered.exportArgs());
  assert.ok(
    isRecord(schema) && schema.type === 'object' && isRecord(schema.value),
    `${file}:${name} must declare an object validator`,
  );
  return Object.keys(schema.value);
}

function hasExportArgs(value: unknown): value is { exportArgs: () => string } {
  return (
    (typeof value === 'function' || typeof value === 'object') &&
    value !== null &&
    'exportArgs' in value &&
    typeof value.exportArgs === 'function'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

test('the Clerk webhook uses the internal sync, not the public self-sync', () => {
  const http = read('http.ts');
  assert.doesNotMatch(http, /api\.users\.upsertUser/);
  assert.match(http, /internal\.users\.upsertUserFromClerkWebhook/);
});

// Returns the argument text of the call starting at `openParen`, up to its matching `)`.
function callArguments(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i += 1) {
    if (source[i] === '(') {
      depth += 1;
    }
    if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openParen, i + 1);
      }
    }
  }
  assert.fail('unterminated call');
}

test('clients do not send caller-supplied actor IDs to bound functions', () => {
  const clientFiles = [
    '../apps/mobile/src/screens/admin/AdminUsersScreen.tsx',
    '../apps/web/src/app/(admin)/admin/users/page.tsx',
    '../apps/mobile/src/screens/store/AdminStoresScreen.tsx',
    '../apps/mobile/src/screens/orders/OrderDetailScreen.tsx',
    '../apps/web/src/app/(main)/orders/[id]/page.tsx',
    '../apps/mobile/src/screens/disputes/DisputeDetailScreen.tsx',
    '../apps/mobile/src/screens/cart/CheckoutScreen.tsx',
    '../apps/mobile/src/context/AuthProvider.tsx',
    '../apps/web/src/hooks/useAuth.ts',
    '../apps/mobile/src/screens/browse/BrowseScreen.tsx',
    '../apps/mobile/src/screens/cart/CartScreen.tsx',
    '../apps/mobile/src/screens/cart/CheckoutScreen.tsx',
    '../apps/mobile/src/screens/favorites/FavoritesScreen.tsx',
    '../apps/mobile/src/screens/home/HomeScreen.tsx',
    '../apps/mobile/src/screens/product/ProductDetailScreen.tsx',
    '../apps/mobile/src/screens/profile/ProfileScreen.tsx',
    '../apps/mobile/src/context/GuestCartProvider.tsx',
    '../apps/web/src/app/(main)/cart/page.tsx',
    '../apps/web/src/app/(main)/checkout/page.tsx',
    '../apps/web/src/app/(main)/favorites/page.tsx',
    '../apps/web/src/app/(main)/product/[id]/page.tsx',
    '../apps/web/src/components/common/Header.tsx',
    '../apps/web/src/components/product/ProductCard.tsx',
    '../apps/web/src/providers/GuestCartProvider.tsx',
    '../apps/mobile/src/screens/disputes/ChatScreen.tsx',
    '../apps/mobile/src/screens/disputes/DisputesListScreen.tsx',
    '../apps/mobile/src/screens/notifications/NotificationsScreen.tsx',
    '../apps/mobile/src/screens/home/HomeScreen.tsx',
    '../apps/mobile/src/screens/profile/ProfileScreen.tsx',
    '../apps/mobile/src/screens/profile/SellerProfileScreen.tsx',
    '../apps/mobile/src/hooks/useWallet.ts',
    '../apps/mobile/src/hooks/usePushNotifications.ts',
    '../apps/web/src/app/(main)/wallet/page.tsx',
    '../apps/web/src/components/admin/layout/AdminHeader.tsx',
    '../apps/web/src/app/(main)/sell/page.tsx',
    '../apps/web/src/app/(main)/sell/new/page.tsx',
    '../apps/web/src/app/(main)/sell/orders/page.tsx',
    '../apps/web/src/app/(main)/profile/page.tsx',
    '../apps/web/src/app/(main)/seller/[id]/page.tsx',
    '../apps/mobile/src/screens/workspace/WorkspaceScreen.tsx',
    '../apps/mobile/src/screens/workspace/SellerOperationsScreen.tsx',
    '../apps/mobile/src/screens/product/SellScreen.tsx',
    '../apps/mobile/src/screens/product/CreateProductScreen.tsx',
    '../apps/mobile/src/screens/product/EditProductScreen.tsx',
    '../apps/mobile/src/screens/orders/OrdersScreen.tsx',
    '../apps/mobile/src/navigation/RootNavigator.tsx',
    '../apps/mobile/src/screens/disputes/CreateDisputeScreen.tsx',
    '../apps/mobile/src/screens/profile/EditProfileScreen.tsx',
    '../apps/mobile/src/context/ThemeProvider.tsx',
  ];
  for (const file of clientFiles) {
    const source = read(file);
    for (const { name, forbiddenArgs } of BOUND) {
      // Mutations: `const x = useMutation(api.mod.name)` then `x({ ... })` calls.
      const mutationRef = new RegExp(
        `(?:const|let)\\s+(\\w+)\\s*=\\s*useMutation\\(\\s*api\\.\\w+\\.${name}\\s*\\)`,
        'g',
      );
      let ref: RegExpExecArray | null;
      while ((ref = mutationRef.exec(source))) {
        const variable = ref[1] ?? '';
        const callPattern = new RegExp(`\\b${variable}\\(`, 'g');
        let call: RegExpExecArray | null;
        while ((call = callPattern.exec(source))) {
          const args = callArguments(source, call.index + variable.length);
          for (const arg of forbiddenArgs) {
            assert.doesNotMatch(args, new RegExp(`\\b${arg}\\s*:`), `${file}: ${name} call must not pass ${arg}`);
          }
        }
      }
      // Queries: `useQuery(api.mod.name, args)` up to the skip sentinel.
      const queryRef = new RegExp(`useQuery\\(\\s*api\\.\\w+\\.${name}\\s*,`, 'g');
      let q: RegExpExecArray | null;
      while ((q = queryRef.exec(source))) {
        const tail = source.slice(q.index, source.indexOf('skip', q.index) + 4);
        for (const arg of forbiddenArgs) {
          assert.doesNotMatch(tail, new RegExp(`\\b${arg}\\s*:`), `${file}: ${name} query must not pass ${arg}`);
        }
      }
    }
  }
});

test('conversations are guarded by the strict request-user check', () => {
  const source = read('conversations.ts');
  const start = source.indexOf('async function assertRequestUser(');
  assert.notEqual(start, -1);
  const body = source.slice(start, source.indexOf('\n}\n', start));
  assert.ok(body.includes('requireUser(ctx)'), 'assertRequestUser must require a verified user');
  assert.doesNotMatch(body, /!== null/, 'anonymous callers must not pass the check');
});
