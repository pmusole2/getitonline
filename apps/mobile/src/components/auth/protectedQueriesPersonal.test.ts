import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import { resolveAccountAccess } from '../../../../../packages/shared/src/utils/accountAccess';
import {
  createControls,
  createHarness,
  fixture,
  textOf,
  withFallback,
  type HarnessControls,
  type Props,
  type RenderResult,
} from '../../../../../tests/support/componentHarness';

// Some screens are public and show to guests, but read one personal query for the signed-in account. That query may
// run only for a ready account. The screen itself stays public: a guest or a banned account sees the screen, with no
// access notice and no personal request.

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const repoFile = (relativePath: string) => resolve(repoRoot, relativePath);

type Access = 'signed-out' | 'banned' | 'pending' | 'ready';

interface PersonalCase {
  readonly label: string;
  readonly file: string;
  readonly exportName: 'default' | 'RootNavigator';
  readonly props: Props;
  readonly personal: string;
  readonly ready: Props;
}

const navigation: Props = { goBack: () => undefined, navigate: () => undefined, replace: () => undefined };

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

const CASES: readonly PersonalCase[] = [
  {
    label: 'HomeScreen',
    file: 'apps/mobile/src/screens/home/HomeScreen.tsx',
    exportName: 'default',
    props: { navigation },
    personal: 'cart.getCart',
    ready: { 'cart.getCart': fixture({ itemCount: 0, items: [] }), 'notifications.getUserNotifications': [] },
  },
  {
    label: 'BrowseScreen',
    file: 'apps/mobile/src/screens/browse/BrowseScreen.tsx',
    exportName: 'default',
    props: { navigation },
    personal: 'cart.getCart',
    ready: { 'cart.getCart': fixture({ itemCount: 0, items: [] }) },
  },
  {
    label: 'CartScreen',
    file: 'apps/mobile/src/screens/cart/CartScreen.tsx',
    exportName: 'default',
    props: { navigation },
    personal: 'cart.getCart',
    ready: { 'cart.getCart': fixture({ itemCount: 0, items: [] }) },
  },
  {
    label: 'ProductDetailScreen',
    file: 'apps/mobile/src/screens/product/ProductDetailScreen.tsx',
    exportName: 'default',
    props: { route: { params: { productId: 'product_1' } }, navigation },
    personal: 'favorites.isFavorited',
    ready: {
      'products.getProduct': fixture({ ...product, condition: 'new', specifications: [], variantCombinations: [] }),
      'favorites.isFavorited': false,
    },
  },
  {
    label: 'RootNavigator',
    file: 'apps/mobile/src/navigation/RootNavigator.tsx',
    exportName: 'RootNavigator',
    props: {},
    personal: 'vendors.getMyVendorProfile',
    ready: { 'vendors.getMyVendorProfile': null },
  },
];

function record(controls: HarnessControls, name: string): void {
  controls.calls.push({ name, args: [] });
}

function auth(controls: HarnessControls, access: Access): Props {
  const account: Props = {
    _id: 'user_1',
    clerkId: 'clerk_1',
    email: 'member@example.invalid',
    firstName: 'Member',
    lastName: 'Fixture',
    role: 'user',
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
      return { ...session, isLoading: true, user: null };
    case 'ready':
      return session;
  }
}

function openScreen(screenCase: PersonalCase, access: Access, queries: Props = screenCase.ready) {
  const controls = createControls();
  controls.auth = auth(controls, access);
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
      // The guest cart is local state, not a protected request, so these tests stub it as empty.
      [repoFile('apps/mobile/src/context/GuestCartProvider.tsx')]: withFallback({
        useGuestCart: () => {
          controls.hook('useContext');
          return {
            items: [],
            summary: { itemCount: 0, subtotal: 0 },
            isHydrated: true,
            hasPendingMerge: false,
            updateQuantity: () => undefined,
            removeItem: () => undefined,
            clear: () => undefined,
          };
        },
      }),
    },
    packages: {
      '@gettitonline/shared': withFallback({ resolveAccountAccess }),
    },
  });
  const component = harness.load(repoFile(screenCase.file))[screenCase.exportName];
  return {
    controls,
    render: (): RenderResult => harness.render(component, screenCase.props),
  };
}

const personalRequests = (result: RenderResult, name: string) =>
  result.queryCalls.filter((call) => call.name === name && call.args !== 'skip');

for (const screenCase of CASES) {
  describe(`${screenCase.label} personal query`, () => {
    it('a guest sees the public screen and sends no personal request', () => {
      const result = openScreen(screenCase, 'signed-out').render();

      assert.ok(
        !textOf(result.tree).includes('Sign in to continue'),
        'the public screen must not be replaced by a notice',
      );
      assert.equal(personalRequests(result, screenCase.personal).length, 0, 'no personal query may be requested');
    });

    it('while the account is loading, the personal query is skipped and the public screen stays up', () => {
      const result = openScreen(screenCase, 'pending').render();

      assert.ok(
        !textOf(result.tree).includes('Sign in to continue'),
        'the public screen must not be replaced by a notice',
      );
      assert.equal(personalRequests(result, screenCase.personal).length, 0, 'no personal query may be requested');
    });

    it('a banned account sends no personal request', () => {
      const result = openScreen(screenCase, 'banned').render();

      assert.equal(personalRequests(result, screenCase.personal).length, 0, 'no personal query may be requested');
      assert.ok(
        !textOf(result.tree).includes('Sign in to continue'),
        'the public screen must not be replaced by a notice',
      );
    });

    it('a ready account requests its personal query', () => {
      const result = openScreen(screenCase, 'ready').render();

      assert.ok(
        personalRequests(result, screenCase.personal).length > 0,
        `${screenCase.personal} must be requested for a ready account`,
      );
    });
  });
}
