import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, URL } from "node:url";

import { resolveAccountAccess } from "../../../../packages/shared/src/utils/accountAccess";
import {
  createControls,
  createHarness,
  findNodes,
  fixture,
  hasNode,
  pressButton,
  textOf,
  withFallback,
  type HarnessControls,
  type Props,
  type RenderResult,
} from "../../../../tests/support/componentHarness";

// Renders the real protected pages with controlled auth and query state. A protected page must not mount its
// content, and so must not request protected data, unless the account is ready. A skipped query is not a request.

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const repoFile = (relativePath: string) => resolve(repoRoot, relativePath);
const webSource = repoFile("apps/web/src");

type Access =
  | "signed-out"
  | "banned"
  | "banned-staff"
  | "pending"
  | "recovery"
  | "ready";

interface PageCase {
  readonly label: string;
  readonly file: string;
  readonly role: string;
  readonly params: Props;
  readonly primary: string;
  readonly ready: Props;
  readonly success: string;
  readonly absent: {
    readonly query: string;
    readonly value: unknown;
    readonly expect: string;
  };
  readonly signedOutCopy: string;
}

const order = {
  _id: "order_1",
  orderNumber: "ORD-20260101-AB12CD34",
  buyerId: "user_1",
  sellerId: "seller_1",
  status: "paid",
  items: [],
  subtotal: 100,
  shippingCost: 0,
  platformFee: 5,
  totalAmount: 105,
  sellerPayout: 95,
  createdAt: 1767225600000,
  shippingAddress: {
    street: "1 Test Road",
    city: "Lusaka",
    province: "Lusaka",
    country: "Zambia",
    phone: "+260000000000",
  },
};

const PAGES: readonly PageCase[] = [
  {
    label: "OrderDetailPage",
    file: "apps/web/src/app/(main)/orders/[id]/page.tsx",
    role: "user",
    params: { id: "order_1" },
    primary: "orders.getOrder",
    ready: { "orders.getOrder": fixture(order) },
    success: order.orderNumber,
    absent: {
      query: "orders.getOrder",
      value: null,
      expect: "Order Not Found",
    },
    signedOutCopy: "Please sign in to view this order",
  },
  {
    label: "SellDashboardPage",
    file: "apps/web/src/app/(main)/sell/page.tsx",
    role: "catalog_manager",
    params: {},
    primary: "products.getManagedCatalogProducts",
    ready: {
      "vendors.getMyVendorProfile": null,
      "products.getManagedCatalogProducts": [],
      "orders.getManagedCatalogOrders": [],
    },
    success: "Action Needed",
    absent: {
      query: "vendors.getMyVendorProfile",
      value: null,
      expect: "Action Needed",
    },
    signedOutCopy: "Sign in to apply as a vendor or manage your listings.",
  },
  {
    label: "CreateListingPage",
    file: "apps/web/src/app/(main)/sell/new/page.tsx",
    role: "catalog_manager",
    params: {},
    primary: "vendors.getMyVendorProfile",
    ready: {
      "vendors.getMyVendorProfile": null,
      "categories.getParentCategories": [],
    },
    success: "Create a New Listing",
    absent: {
      query: "vendors.getMyVendorProfile",
      value: null,
      expect: "Create a New Listing",
    },
    signedOutCopy: "Please sign in to create a listing",
  },
  {
    label: "SellerOrdersPage",
    file: "apps/web/src/app/(main)/sell/orders/page.tsx",
    role: "catalog_manager",
    params: {},
    primary: "orders.getManagedCatalogOrders",
    ready: { "orders.getManagedCatalogOrders": [] },
    success: "No sales yet",
    absent: {
      query: "orders.getManagedCatalogOrders",
      value: [],
      expect: "No sales yet",
    },
    signedOutCopy: "Please sign in to view your orders",
  },
];

function record(controls: HarnessControls, name: string): void {
  controls.calls.push({ name, args: [] });
}

function auth(controls: HarnessControls, access: Access, role: string): Props {
  const account = (isBanned: boolean, accountRole: string): Props => ({
    _id: "user_1",
    clerkId: "clerk_1",
    email: "member@example.invalid",
    firstName: "Member",
    lastName: "Fixture",
    role: accountRole,
    isBanned,
  });
  const session: Props = {
    isLoading: false,
    isSignedIn: true,
    syncFailed: false,
    user: account(false, role),
    clerkUser: null,
    signOut: async () => record(controls, "signOut"),
    retrySync: () => record(controls, "retrySync"),
  };
  switch (access) {
    case "signed-out":
      return { ...session, isSignedIn: false, user: null };
    case "banned":
      return { ...session, user: account(true, role) };
    case "banned-staff":
      return { ...session, user: account(true, "admin") };
    case "pending":
      return { ...session, isLoading: true, user: null };
    case "recovery":
      return { ...session, isSignedIn: false, syncFailed: true, user: null };
    case "ready":
      return session;
  }
}

function openPage(page: PageCase, access: Access, queries: Props = page.ready) {
  const controls = createControls();
  controls.auth = auth(controls, access, page.role);
  controls.queries = queries;
  controls.params = page.params;
  const harness = createHarness({
    controls,
    aliases: { "@/": webSource },
    files: {
      [repoFile("apps/web/src/hooks/useAuth.ts")]: withFallback({
        useAuth: () => {
          controls.hook("useContext");
          return controls.auth;
        },
      }),
    },
    packages: {
      "@gettitonline/shared": withFallback({ resolveAccountAccess }),
    },
  });
  const component = harness.load(repoFile(page.file)).default;
  return {
    controls,
    render: (): RenderResult => harness.render(component, {}),
  };
}

const requested = (result: RenderResult) =>
  result.queryCalls.filter((call) => call.args !== "skip");
const linksTo = (result: RenderResult, href: string) =>
  findNodes(result.tree, (node) => node.props.href === href).length > 0;

for (const page of PAGES) {
  describe(`${page.label} access`, () => {
    it("settled signed-out visitors get sign-in and no protected request", () => {
      const result = openPage(page, "signed-out").render();
      const text = textOf(result.tree);

      assert.ok(text.includes(page.signedOutCopy), text);
      assert.ok(linksTo(result, "/sign-in"), "sign-in link");
      assert.equal(
        requested(result).length,
        0,
        "no protected query may be requested",
      );
      assert.ok(
        !hasNode(result.tree, "Skeleton"),
        "a settled signed-out visitor is not loading",
      );
      assert.ok(
        !text.includes(page.success),
        "protected content must not show",
      );
    });

    it("banned accounts get the unavailable state, can sign out, and request nothing", () => {
      const { controls, render } = openPage(page, "banned");
      const result = render();
      const text = textOf(result.tree);

      assert.ok(text.includes("Account unavailable"), text);
      assert.equal(
        requested(result).length,
        0,
        "no protected query may be requested",
      );
      assert.ok(
        !hasNode(result.tree, "Skeleton"),
        "an unavailable account is not loading",
      );
      assert.ok(
        !text.includes(page.success),
        "protected content must not show",
      );
      assert.ok(
        pressButton(result.tree, "Sign out", "onClick"),
        "sign-out action",
      );
      assert.ok(controls.calls.some((call) => call.name === "signOut"));
    });

    it("banned staff accounts get the same unavailable state", () => {
      const result = openPage(page, "banned-staff").render();
      const text = textOf(result.tree);

      assert.ok(text.includes("Account unavailable"), text);
      assert.equal(
        requested(result).length,
        0,
        "no protected query may be requested",
      );
      assert.ok(
        !text.includes(page.success),
        "protected content must not show",
      );
    });

    it("pending authentication shows loading and requests nothing", () => {
      const result = openPage(page, "pending").render();

      assert.ok(hasNode(result.tree, "Skeleton"), "loading skeleton");
      assert.equal(
        requested(result).length,
        0,
        "no protected query may be requested",
      );
      assert.ok(
        !textOf(result.tree).includes(page.success),
        "protected content must not show",
      );
    });

    it("failed account recovery offers retry and sign-out and requests nothing", () => {
      const { controls, render } = openPage(page, "recovery");
      const result = render();
      const text = textOf(result.tree);

      assert.ok(text.includes("Account setup did not finish"), text);
      assert.equal(
        requested(result).length,
        0,
        "no protected query may be requested",
      );
      assert.ok(
        pressButton(result.tree, "Try again", "onClick"),
        "retry action",
      );
      assert.ok(
        controls.calls.some((call) => call.name === "retrySync"),
        "retry must re-run account sync",
      );
    });

    it("an eligible user sees loading only while the protected query is pending", () => {
      const { render } = openPage(page, "ready", {
        ...page.ready,
        [page.primary]: undefined,
      });
      const result = render();

      assert.ok(hasNode(result.tree, "Skeleton"), "loading skeleton");
      assert.ok(
        requested(result).some((call) => call.name === page.primary),
        "the protected query must be requested before it can be loading",
      );
      assert.ok(
        !textOf(result.tree).includes(page.success),
        "content must wait for the query",
      );
    });

    it("an eligible user with a missing record sees the absent state, not loading", () => {
      const { render } = openPage(page, "ready", {
        ...page.ready,
        [page.absent.query]: page.absent.value,
      });
      const result = render();

      assert.ok(
        !hasNode(result.tree, "Skeleton"),
        "a missing record is not loading",
      );
      assert.ok(
        textOf(result.tree).includes(page.absent.expect),
        textOf(result.tree),
      );
    });

    it("an eligible user with a successful query sees the content and no access notice", () => {
      const result = openPage(page, "ready").render();
      const text = textOf(result.tree);

      assert.ok(text.includes(page.success), text);
      assert.ok(!text.includes("Account unavailable"), text);
      assert.ok(!text.includes("Account setup did not finish"), text);
    });

    it("losing access hides cached content, and restoring access brings it back", () => {
      const { controls, render } = openPage(page, "ready");
      assert.ok(textOf(render().tree).includes(page.success));
      assert.ok(
        controls.queries[page.primary] !== undefined,
        "the cached result is still present",
      );

      controls.auth = auth(controls, "banned", page.role);
      const lost = render();
      assert.ok(
        !textOf(lost.tree).includes(page.success),
        "cached content must not remain on screen",
      );
      assert.ok(textOf(lost.tree).includes("Account unavailable"));
      assert.equal(
        requested(lost).length,
        0,
        "no protected query may be requested after access is lost",
      );

      controls.auth = auth(controls, "ready", page.role);
      const restored = render();
      assert.ok(
        textOf(restored.tree).includes(page.success),
        "content returns when access is restored",
      );
      assert.ok(requested(restored).some((call) => call.name === page.primary));
    });

    it("the page gate runs the same hooks in every access state", () => {
      const { controls, render } = openPage(page, "signed-out");
      const traces: Array<readonly string[] | undefined> = [];
      for (const access of [
        "signed-out",
        "banned",
        "pending",
        "recovery",
        "ready",
      ] as const) {
        controls.auth = auth(controls, access, page.role);
        traces.push(render().hookTraces.get(page.label));
      }

      const [expected] = traces;
      assert.ok(
        expected !== undefined && expected.length > 0,
        "the page must record its hooks",
      );
      for (const trace of traces) {
        assert.deepEqual(trace, expected);
      }
    });
  });
}
