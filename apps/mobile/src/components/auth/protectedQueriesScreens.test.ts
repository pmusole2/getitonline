import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import { resolveAccountAccess } from '../../../../../packages/shared/src/utils/accountAccess';
import {
  createControls,
  createHarness,
  fixture,
  findNodes,
  hasNode,
  pressButton,
  textOf,
  withFallback,
  type HarnessControls,
  type Props,
  type RenderedChild,
  type RenderResult,
} from '../../../../../tests/support/componentHarness';

// Protected screens that read the signed-in account must not request protected data until the account is ready.
// While Clerk is loaded but Convex is still authenticating, the account reads as loading: the screen shows a loading
// state and every protected request is skipped. A banned account, a failed sync, or a signed-out visitor gets the
// access notice and no protected request.

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const repoFile = (relativePath: string) => resolve(repoRoot, relativePath);

type Access = 'signed-out' | 'banned' | 'pending' | 'recovery' | 'ready';

interface ScreenCase {
  readonly label: string;
  readonly file: string;
  readonly role: string;
  readonly props: Props;
  readonly primary: string;
  readonly ready: Props;
  // Text only the ready content shows, and never the access notice. Undefined when the screen's header repeats the
  // notice title and no other content-only text is fixed, so only its requests and notices are checked.
  readonly success?: string;
}

function contentShown(nodes: readonly RenderedChild[], screen: ScreenCase): boolean {
  return screen.success !== undefined && textOf(nodes).includes(screen.success);
}

const navigation: Props = { goBack: () => undefined, navigate: () => undefined, replace: () => undefined };

const SCREENS: readonly ScreenCase[] = [
  {
    label: 'OrdersScreen',
    file: 'apps/mobile/src/screens/orders/OrdersScreen.tsx',
    role: 'user',
    props: {},
    primary: 'orders.getBuyerOrders',
    ready: { 'orders.getBuyerOrders': [] },
    success: 'Track your purchases',
  },
  {
    label: 'NotificationsScreen',
    file: 'apps/mobile/src/screens/notifications/NotificationsScreen.tsx',
    role: 'user',
    props: { navigation },
    primary: 'notifications.getUserNotifications',
    ready: { 'notifications.getUserNotifications': [] },
    success: "You're all caught up!",
  },
  {
    label: 'FavoritesScreen',
    file: 'apps/mobile/src/screens/favorites/FavoritesScreen.tsx',
    role: 'user',
    props: {},
    primary: 'favorites.getUserFavorites',
    ready: { 'favorites.getUserFavorites': [] },
    success: 'Saved products',
  },
  {
    label: 'ProfileScreen',
    file: 'apps/mobile/src/screens/profile/ProfileScreen.tsx',
    role: 'user',
    props: {},
    primary: 'favorites.getUserFavorites',
    ready: {
      'favorites.getUserFavorites': [],
      'notifications.getUserNotifications': [],
      'conversations.getUnreadConversationCount': 0,
      'wallet.getWalletBalance': fixture({ hasWallet: false, balance: 0 }),
    },
    success: 'member@example.invalid',
  },
  {
    label: 'AdminUsersScreen',
    file: 'apps/mobile/src/screens/admin/AdminUsersScreen.tsx',
    role: 'admin',
    props: { navigation },
    primary: 'users.getAllUsers',
    ready: {
      'users.getAllUsers': fixture({ items: [] }),
      'platform.getPlatformSettingsForAdmin': fixture({
        companySellerUserId: null,
        companyDisplayName: 'Fixture Company',
        companySeller: null,
      }),
    },
    success: 'Roles and account controls',
  },
  {
    label: 'AdminOrdersScreen',
    file: 'apps/mobile/src/screens/admin/AdminOrdersScreen.tsx',
    role: 'admin',
    props: { navigation },
    primary: 'orders.listOrdersForAdmin',
    ready: {},
    success: 'Admin marketplace orders',
  },
  {
    label: 'AdminCategoriesScreen',
    file: 'apps/mobile/src/screens/admin/AdminCategoriesScreen.tsx',
    role: 'admin',
    props: { navigation },
    primary: 'categories.getAllCategories',
    ready: {},
    success: 'Catalog structure',
  },
  {
    label: 'AdminDashboardScreen',
    file: 'apps/mobile/src/screens/admin/AdminDashboardScreen.tsx',
    role: 'admin',
    props: { navigation },
    primary: 'orders.getOrderStats',
    ready: {},
    success: 'Marketplace oversight',
  },
  {
    label: 'AdminTransactionsScreen',
    file: 'apps/mobile/src/screens/admin/AdminTransactionsScreen.tsx',
    role: 'admin',
    props: { navigation },
    primary: 'transactions.listTransactionsForAdmin',
    ready: {},
    success: 'Admin payment operations',
  },
  {
    label: 'AdminEscrowScreen',
    file: 'apps/mobile/src/screens/admin/AdminEscrowScreen.tsx',
    role: 'admin',
    props: { navigation },
    primary: 'escrow.listEscrowsForAdmin',
    ready: {},
    success: 'Admin funds in transit',
  },
  {
    label: 'AdminPromotionsScreen',
    file: 'apps/mobile/src/screens/admin/AdminPromotionsScreen.tsx',
    role: 'admin',
    props: { navigation },
    primary: 'promotions.listPromotionsForAdmin',
    ready: {},
  },
  {
    label: 'AdminStoresScreen',
    file: 'apps/mobile/src/screens/store/AdminStoresScreen.tsx',
    role: 'admin',
    props: { navigation },
    primary: 'vendors.listVendorStoresForAdmin',
    ready: {},
    success: 'Super Admin storefront tools',
  },
  {
    label: 'AdminDeliveryScreen',
    file: 'apps/mobile/src/screens/admin/AdminDeliveryScreen.tsx',
    role: 'admin',
    props: { navigation },
    primary: 'delivery.listDeliveryZones',
    ready: {},
  },
  {
    label: 'ListingReviewScreen',
    file: 'apps/mobile/src/screens/admin/ListingReviewScreen.tsx',
    role: 'admin',
    props: { navigation },
    primary: 'products.getPendingReviewListings',
    ready: {},
    success: 'Reviewer-Approver review queue',
  },
  {
    label: 'ConversationsListScreen',
    file: 'apps/mobile/src/screens/conversations/ConversationsListScreen.tsx',
    role: 'user',
    props: { navigation },
    primary: 'conversations.getUserConversations',
    ready: {},
  },
  {
    label: 'ConversationChatScreen',
    file: 'apps/mobile/src/screens/conversations/ConversationChatScreen.tsx',
    role: 'user',
    props: { route: { params: { conversationId: 'conversation_1' } }, navigation },
    primary: 'conversations.getConversation',
    ready: {},
  },
];

function record(controls: HarnessControls, name: string): void {
  controls.calls.push({ name, args: [] });
}

function auth(controls: HarnessControls, access: Access, role: string): Props {
  const account: Props = {
    _id: 'user_1',
    clerkId: 'clerk_1',
    email: 'member@example.invalid',
    firstName: 'Member',
    lastName: 'Fixture',
    role,
    isBanned: false,
  };
  const session: Props = {
    isLoading: false,
    isSignedIn: true,
    user: account,
    clerkUser: null,
    authSyncError: null,
    postAuthDestination: null,
    setPostAuthDestination: () => undefined,
    retryUserSync: () => record(controls, 'retryUserSync'),
    signOut: async () => record(controls, 'signOut'),
  };
  switch (access) {
    case 'signed-out':
      return { ...session, isSignedIn: false, user: null };
    case 'banned':
      return { ...session, user: { ...account, isBanned: true } };
    case 'pending':
      // Clerk is loaded and the account is signed in, but Convex has not authenticated, so AuthProvider reports loading.
      return { ...session, isLoading: true, user: null };
    case 'recovery':
      return { ...session, user: null, authSyncError: 'We could not finish setting up your account.' };
    case 'ready':
      return session;
  }
}

function openScreen(screen: ScreenCase, access: Access, queries: Props = screen.ready) {
  const controls = createControls();
  controls.auth = auth(controls, access, screen.role);
  controls.queries = queries;
  const harness = createHarness({
    controls,
    files: {
      [repoFile('apps/mobile/src/context/AuthProvider.tsx')]: withFallback({
        useAppAuth: () => {
          controls.hook('useContext');
          return controls.auth;
        },
      }),
    },
    packages: {
      '@gettitonline/shared': withFallback({ resolveAccountAccess }),
    },
  });
  const component = harness.load(repoFile(screen.file)).default;
  return {
    controls,
    render: (): RenderResult => harness.render(component, screen.props),
  };
}

const requested = (result: RenderResult) => result.queryCalls.filter((call) => call.args !== 'skip');

for (const screen of SCREENS) {
  describe(`${screen.label} protected queries`, () => {
    it('while the account is loading, no protected query runs and a loading state shows', () => {
      const result = openScreen(screen, 'pending').render();

      assert.ok(hasNode(result.tree, 'ActivityIndicator'), 'a loading state must show');
      assert.ok(
        result.queryCalls.every((call) => call.args === 'skip'),
        `every protected query must be skipped while loading, got ${JSON.stringify(result.queryCalls)}`,
      );
      assert.equal(requested(result).length, 0, 'no protected query may be requested');
      assert.ok(!contentShown(result.tree, screen), 'protected content must not show');
    });

    it('a signed-out visitor gets sign-in and no protected query', () => {
      const result = openScreen(screen, 'signed-out').render();

      assert.ok(textOf(result.tree).includes('Sign In'), textOf(result.tree));
      assert.equal(requested(result).length, 0, 'no protected query may be requested');
      assert.ok(!contentShown(result.tree, screen), 'protected content must not show');
    });

    it('a banned account gets the unavailable notice and no protected query', () => {
      const result = openScreen(screen, 'banned').render();

      assert.ok(textOf(result.tree).includes('Account unavailable'), textOf(result.tree));
      assert.equal(requested(result).length, 0, 'no protected query may be requested');
      assert.ok(!contentShown(result.tree, screen), 'protected content must not show');
    });

    it('a failed account sync gets the recovery notice with retry and no protected query', () => {
      const { controls, render } = openScreen(screen, 'recovery');
      const result = render();

      assert.ok(textOf(result.tree).includes('Account setup did not finish'), textOf(result.tree));
      assert.equal(requested(result).length, 0, 'no protected query may be requested');
      assert.ok(pressButton(result.tree, 'Try Again'), 'retry button');
      assert.ok(
        controls.calls.some((call) => call.name === 'retryUserSync'),
        'retry must re-run account sync',
      );
    });

    it('a ready account runs its protected query and shows the content', () => {
      const result = openScreen(screen, 'ready').render();
      const text = textOf(result.tree);

      assert.ok(
        requested(result).some((call) => call.name === screen.primary),
        `${screen.primary} must be requested for a ready account`,
      );
      if (screen.success !== undefined) {
        assert.ok(text.includes(screen.success), text);
      }
      assert.ok(!text.includes('Account unavailable'), text);
      assert.ok(!text.includes('Sign in to continue'), text);
    });

    it('losing access hides the content and stops protected queries', () => {
      const { controls, render } = openScreen(screen, 'ready');
      assert.ok(
        requested(render()).some((call) => call.name === screen.primary),
        'ready content must be requested first',
      );

      controls.auth = auth(controls, 'banned', screen.role);
      const lost = render();

      assert.ok(!contentShown(lost.tree, screen), 'content must not remain on screen');
      assert.ok(textOf(lost.tree).includes('Account unavailable'));
      assert.equal(requested(lost).length, 0, 'no protected query may be requested after access is lost');
    });
  });
}

// Actual AdminDashboard with every sibling query controlled through the existing harness.
const financeScreen = SCREENS.find((screen) => screen.label === 'AdminDashboardScreen');
assert.ok(financeScreen);

function financeQueries(summary: Props): Props {
  return {
    'orders.getOrderStats': { total: 0, totalRevenue: 0, processing: 0, completed: 0 },
    'escrow.getEscrowStats': { totalGrossHeld: 0, heldCount: 0, disputedCount: 0 },
    'disputes.getDisputeStats': { open: 0, moderatorReview: 0 },
    'transactions.getTransactionStats': {
      total: 0,
      totalVolume: 0,
      successful: 0,
      pending: 0,
      processing: 0,
      failed: 0,
      byPaymentMethod: { mobile_money: { volume: 0 }, card: { volume: 0 }, bank_transfer: { volume: 0 } },
    },
    'transactions.getPlatformFinancialSummary': summary,
    'disputes.getOpenDisputes': [],
    'products.getPendingReviewListings': [],
  };
}

function financeValues(value: number | null, complete = true, pending = 0): Props {
  return {
    totalGrossReceived: value,
    netPlatformProfit: value,
    heldInEscrow: value,
    refundedToBuyers: value,
    completeness: { complete, escrow: complete, fees: complete },
    review: { unprovenEscrows: complete ? 0 : 1, pendingEscrows: pending, unknownFeeOperations: complete ? 0 : 1 },
  };
}

function financeCardText(tree: readonly RenderedChild[], label: string): string {
  const cards = findNodes(tree, (node) => node.name === 'Surface' && textOf(node.children).startsWith(`${label} `));
  assert.equal(cards.length, 1, `${label} must render exactly one finance card`);
  return textOf(cards[0].children);
}

describe('C2b2: actual AdminDashboard finance', () => {
  it('nullable totals render unavailable and review with no fabricated K0 profit', () => {
    const result = openScreen(financeScreen, 'ready', financeQueries(financeValues(null, false))).render();
    const text = textOf(result.tree);
    assert.match(financeCardText(result.tree, 'Net Platform Profit'), /^Net Platform Profit Unavailable /);
    assert.match(text, /Financial summary needs review/);
    assert.match(text, /Provider fees are unknown/);
    assert.doesNotMatch(text, /Net Platform Profit\s*K0/);
    assert.doesNotMatch(text, /NaN|undefined|\[object Object\]/);
  });

  for (const value of [0, -1, 5]) {
    it(`known ${value} renders a legitimate finance value and truthful custody copy`, () => {
      const summary = { ...financeValues(5), netPlatformProfit: value };
      const result = openScreen(financeScreen, 'ready', financeQueries(summary)).render();
      const text = textOf(result.tree);
      assert.match(financeCardText(result.tree, 'Net Platform Profit'), new RegExp(`^Net Platform Profit K${value} `));
      assert.match(text, /Gross buyer funds in custody/);
      assert.match(text, /Earned fees after provider costs/);
      assert.doesNotMatch(text, /Financial summary needs review/);
    });
  }

  it('pending approval is explicit and access loss hides cached finance before restoration', () => {
    const { controls, render } = openScreen(financeScreen, 'ready', financeQueries(financeValues(null, false, 1)));
    assert.match(textOf(render().tree), /approval.*pending/i);
    for (const access of ['banned', 'signed-out', 'pending', 'recovery'] as const) {
      controls.auth = auth(controls, access, 'admin');
      const lost = render();
      assert.doesNotMatch(textOf(lost.tree), /Net Platform Profit|Gross buyer funds/);
      assert.equal(requested(lost).length, 0);
      controls.auth = auth(controls, 'ready', 'admin');
      assert.match(textOf(render().tree), /Net Platform Profit/);
    }
  });
});

for (const [field, label] of [
  ['totalGrossReceived', 'Gross Received'],
  ['netPlatformProfit', 'Net Platform Profit'],
  ['heldInEscrow', 'Held In Escrow'],
  ['refundedToBuyers', 'Refunded To Buyers'],
]) {
  it(`C2b2: AdminDashboard guards nullable ${field} independently`, () => {
    const summary = { ...financeValues(5, false), [field]: null };
    const result = openScreen(financeScreen, 'ready', financeQueries(summary)).render();
    const text = textOf(result.tree);
    assert.match(financeCardText(result.tree, label), new RegExp(`^${label} Unavailable `));
    assert.doesNotMatch(text, /NaN|undefined|\[object Object\]/);
  });
}
