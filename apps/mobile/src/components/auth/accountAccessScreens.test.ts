import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import { resolveAccountAccess } from '../../../../../packages/shared/src/utils/accountAccess';
import {
  createControls,
  createHarness,
  fixture,
  hasNode,
  pressButton,
  textOf,
  withFallback,
  type HarnessControls,
  type Props,
  type RenderResult,
} from '../../../../../tests/support/componentHarness';

// Renders the real protected screens with controlled auth and query state. A protected screen must not mount
// its content, and so must not request protected data, unless the account is ready. A skipped query is not a
// request. Hook order is checked by the harness on every render.

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const repoFile = (relativePath: string) => resolve(repoRoot, relativePath);

type Access = 'signed-out' | 'banned' | 'banned-staff' | 'pending' | 'recovery' | 'ready';

interface ScreenCase {
  readonly label: string;
  readonly file: string;
  readonly gate: string;
  readonly role: string;
  readonly props: Props;
  readonly primary: string;
  readonly ready: Props;
  readonly success: string;
  readonly absent: { readonly query: string; readonly value: unknown; readonly expect: string };
}

const navigation: Props = { goBack: () => undefined, navigate: () => undefined, replace: () => undefined };
const storefront = fixture({ companySellerUserId: 'seller_company', name: 'Fixture Store' });

const order = {
  _id: 'order_1',
  orderNumber: 'ORD-20260101-AB12CD34',
  buyerId: 'user_1',
  sellerId: 'seller_1',
  status: 'paid',
  items: [],
  subtotal: 100,
  shippingCost: 0,
  platformFee: 5,
  totalAmount: 105,
  sellerPayout: 95,
  createdAt: 1767225600000,
  shippingAddress: {
    street: '1 Test Road',
    city: 'Lusaka',
    province: 'Lusaka',
    country: 'Zambia',
    phone: '+260000000000',
  },
};

const product = {
  _id: 'product_1',
  sellerId: 'seller_company',
  title: 'Fixture Product',
  status: 'approved',
  price: 100,
  quantity: 1,
  images: [],
  createdAt: 1767225600000,
  updatedAt: 1767225600000,
};

const SCREENS: readonly ScreenCase[] = [
  {
    label: 'OrderDetailScreen',
    file: 'apps/mobile/src/screens/orders/OrderDetailScreen.tsx',
    gate: 'OrderDetailScreen',
    role: 'user',
    props: { route: { params: { orderId: 'order_1' } }, navigation },
    primary: 'orders.getOrder',
    ready: {
      'orders.getOrder': fixture(order),
      'escrow.getEscrowByOrder': null,
      'disputes.getDisputeByOrder': null,
      'delivery.getOrderTrackingEvents': [],
      'delivery.getOrderReturnRequests': [],
      'reviews.canReviewOrder': false,
      'reviews.getReviewByOrder': null,
    },
    success: 'AB12CD34',
    absent: { query: 'orders.getOrder', value: null, expect: 'Order not found' },
  },
  {
    label: 'CreateDisputeScreen',
    file: 'apps/mobile/src/screens/disputes/CreateDisputeScreen.tsx',
    gate: 'CreateDisputeScreen',
    role: 'user',
    props: { route: { params: { orderId: 'order_1' } }, navigation },
    primary: 'orders.getOrder',
    ready: { 'orders.getOrder': fixture(order) },
    success: order.orderNumber,
    absent: { query: 'orders.getOrder', value: null, expect: 'Order not found' },
  },
  {
    label: 'SellScreen',
    file: 'apps/mobile/src/screens/product/SellScreen.tsx',
    gate: 'SellScreen',
    role: 'user',
    props: {},
    primary: 'vendors.getMyVendorProfile',
    ready: { 'platform.getStorefront': storefront, 'vendors.getMyVendorProfile': null },
    success: 'Apply to sell on Gettitonline',
    absent: { query: 'vendors.getMyVendorProfile', value: null, expect: 'Apply to sell on Gettitonline' },
  },
  {
    label: 'WorkspaceScreen',
    file: 'apps/mobile/src/screens/workspace/WorkspaceScreen.tsx',
    gate: 'WorkspaceScreen',
    role: 'catalog_manager',
    props: {},
    primary: 'vendors.getMyVendorProfile',
    ready: {
      'vendors.getMyVendorProfile': null,
      'platform.getStorefront': storefront,
      'products.getManagedCatalogProducts': [],
    },
    success: 'Seller, staff, and admin operations',
    absent: { query: 'vendors.getMyVendorProfile', value: null, expect: 'Seller, staff, and admin operations' },
  },
  {
    label: 'CreateProductScreen',
    file: 'apps/mobile/src/screens/product/CreateProductScreen.tsx',
    gate: 'CreateProductScreen',
    role: 'catalog_manager',
    props: { navigation },
    primary: 'vendors.getMyVendorProfile',
    ready: {
      'vendors.getMyVendorProfile': null,
      'platform.getStorefront': storefront,
      'categories.getCategoriesTree': [],
    },
    success: 'Product Images',
    absent: { query: 'vendors.getMyVendorProfile', value: null, expect: 'Product Images' },
  },
  {
    label: 'EditProductScreen',
    file: 'apps/mobile/src/screens/product/EditProductScreen.tsx',
    gate: 'EditProductScreen',
    role: 'catalog_manager',
    props: { route: { params: { productId: 'product_1' } }, navigation },
    primary: 'products.getProduct',
    ready: {
      'products.getProduct': fixture(product),
      'vendors.getMyVendorProfile': null,
      'categories.getCategoriesTree': [],
    },
    success: 'Pricing & Inventory',
    absent: { query: 'products.getProduct', value: null, expect: 'Product not found' },
  },
  {
    label: 'SellerOperationsScreen',
    file: 'apps/mobile/src/screens/workspace/SellerOperationsScreen.tsx',
    gate: 'SellerOperationsScreen',
    role: 'catalog_manager',
    props: { navigation },
    primary: 'orders.getManagedCatalogOrders',
    ready: {
      'vendors.getMyVendorProfile': null,
      'platform.getStorefront': storefront,
      'categories.getCategoriesTree': [],
      'products.getManagedCatalogProducts': [],
      'orders.getManagedCatalogOrders': [],
      'escrow.getSellerPendingEscrow': fixture({ totalPending: 0 }),
      'reviews.getSellerReviews': [],
      'delivery.getReturnRequests': [],
    },
    success: 'Listings, orders, payouts',
    absent: { query: 'vendors.getMyVendorProfile', value: null, expect: 'Listings, orders, payouts' },
  },
];

function record(controls: HarnessControls, name: string): void {
  controls.calls.push({ name, args: [] });
}

function auth(controls: HarnessControls, access: Access, role: string): Props {
  const account = (isBanned: boolean, accountRole: string): Props => ({
    _id: 'user_1',
    clerkId: 'clerk_1',
    email: 'member@example.invalid',
    firstName: 'Member',
    lastName: 'Fixture',
    role: accountRole,
    isBanned,
  });
  const session: Props = {
    isLoading: false,
    isSignedIn: true,
    user: account(false, role),
    clerkUser: { id: 'clerk_1' },
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
      return { ...session, user: account(true, role) };
    case 'banned-staff':
      return { ...session, user: account(true, 'admin') };
    case 'pending':
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
  describe(`${screen.label} access`, () => {
    it('settled signed-out visitors get sign-in and no protected request', () => {
      const result = openScreen(screen, 'signed-out').render();
      const text = textOf(result.tree);

      assert.ok(text.includes('Sign In'), text);
      assert.equal(requested(result).length, 0, 'no protected query may be requested');
      assert.ok(!text.includes(screen.success), 'protected content must not show');
    });

    it('banned accounts get the unavailable state and no protected request', () => {
      const result = openScreen(screen, 'banned').render();
      const text = textOf(result.tree);

      assert.ok(text.includes('Account unavailable'), text);
      assert.equal(requested(result).length, 0, 'no protected query may be requested');
      assert.ok(!text.includes(screen.success), 'protected content must not show');
    });

    it('banned staff accounts get the same unavailable state', () => {
      const result = openScreen(screen, 'banned-staff').render();
      const text = textOf(result.tree);

      assert.ok(text.includes('Account unavailable'), text);
      assert.equal(requested(result).length, 0, 'no protected query may be requested');
      assert.ok(!text.includes(screen.success), 'protected content must not show');
    });

    it('pending authentication shows loading and requests nothing', () => {
      const result = openScreen(screen, 'pending').render();

      assert.ok(hasNode(result.tree, 'ActivityIndicator'), 'loading indicator');
      assert.equal(requested(result).length, 0, 'no protected query may be requested');
      assert.ok(!textOf(result.tree).includes(screen.success), 'protected content must not show');
    });

    it('failed account recovery offers retry and sign-out and requests nothing', () => {
      const { controls, render } = openScreen(screen, 'recovery');
      const result = render();
      const text = textOf(result.tree);

      assert.ok(text.includes('Account setup did not finish'), text);
      assert.equal(requested(result).length, 0, 'no protected query may be requested');
      assert.ok(pressButton(result.tree, 'Try Again'), 'retry button');
      assert.ok(
        controls.calls.some((call) => call.name === 'retryUserSync'),
        'retry must re-run account sync',
      );
    });

    it('an eligible user sees loading only while the protected query is pending', () => {
      const { render } = openScreen(screen, 'ready', { ...screen.ready, [screen.primary]: undefined });
      const result = render();

      assert.ok(hasNode(result.tree, 'ActivityIndicator'), 'loading indicator');
      assert.ok(
        requested(result).some((call) => call.name === screen.primary),
        'the protected query must be requested before it can be loading',
      );
      assert.ok(!textOf(result.tree).includes(screen.success), 'content must wait for the query');
    });

    it('an eligible user with a missing record sees the absent state, not loading', () => {
      const { render } = openScreen(screen, 'ready', {
        ...screen.ready,
        [screen.absent.query]: screen.absent.value,
      });
      const result = render();

      assert.ok(!hasNode(result.tree, 'ActivityIndicator'), 'a missing record is not loading');
      assert.ok(textOf(result.tree).includes(screen.absent.expect), textOf(result.tree));
    });

    it('an eligible user with a successful query sees the content and no access notice', () => {
      const result = openScreen(screen, 'ready').render();
      const text = textOf(result.tree);

      assert.ok(text.includes(screen.success), text);
      assert.ok(!text.includes('Account unavailable'), text);
      assert.ok(!text.includes('Account setup did not finish'), text);
    });

    it('losing access hides cached content, and restoring access brings it back', () => {
      const { controls, render } = openScreen(screen, 'ready');
      assert.ok(textOf(render().tree).includes(screen.success));
      assert.ok(controls.queries[screen.primary] !== undefined, 'the cached result is still present');

      controls.auth = auth(controls, 'banned', screen.role);
      const lost = render();
      assert.ok(!textOf(lost.tree).includes(screen.success), 'cached content must not remain on screen');
      assert.ok(textOf(lost.tree).includes('Account unavailable'));
      assert.equal(requested(lost).length, 0, 'no protected query may be requested after access is lost');

      controls.auth = auth(controls, 'ready', screen.role);
      const restored = render();
      assert.ok(textOf(restored.tree).includes(screen.success), 'content returns when access is restored');
      assert.ok(requested(restored).some((call) => call.name === screen.primary));
    });

    it('the access gate runs the same hooks in every access state', () => {
      const { controls, render } = openScreen(screen, 'signed-out');
      const traces: Array<readonly string[] | undefined> = [];
      for (const access of ['signed-out', 'banned', 'pending', 'recovery', 'ready'] as const) {
        controls.auth = auth(controls, access, screen.role);
        traces.push(render().hookTraces.get(screen.gate));
      }

      const [expected] = traces;
      assert.ok(expected !== undefined && expected.length > 0, 'the gate must record its hooks');
      for (const trace of traces) {
        assert.deepEqual(trace, expected);
      }
    });
  });
}
