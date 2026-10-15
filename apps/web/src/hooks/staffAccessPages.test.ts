import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
  type Props,
} from "../../../../tests/support/componentHarness";

// Actual route/layout/Header components with controlled hooks; no live Clerk, browser or deployed query transport.
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const file = (path: string) => resolve(root, path);
const adminRoot = "apps/web/src/app/(admin)/admin/";
const PAGES = [
  {
    file: "page.tsx",
    queries: [
      "orders.getOrderStats",
      "escrow.getEscrowStats",
      "disputes.getDisputeStats",
      "products.getPendingReviewListings",
      "disputes.getOpenDisputes",
    ],
    success: "Total Orders",
  },
  {
    file: "users/page.tsx",
    queries: ["users.getAllUsers", "platform.getPlatformSettingsForAdmin"],
    success: "User Management",
  },
  {
    file: "promotions/page.tsx",
    queries: [
      "promotions.listPromoCodesForAdmin",
      "promotions.listPromotionBannersForAdmin",
      "notifications.listNotificationCampaignsForAdmin",
      "categories.getParentCategories",
    ],
    success: "Promotions",
  },
  {
    file: "vendors/page.tsx",
    queries: ["vendors.getPendingApplications"],
    success: "Vendor Applications",
  },
] as const;

function auth(overrides: Props = {}): Props {
  return {
    isLoading: false,
    isSignedIn: true,
    syncFailed: false,
    user: fixture({
      _id: "users|admin",
      clerkId: "admin",
      firstName: "Ada",
      lastName: "Admin",
      email: "admin@example.invalid",
      role: "admin",
      isBanned: false,
      deletedAt: undefined,
    }),
    clerkUser: null,
    retrySync: () => undefined,
    signOut: async () => undefined,
    ...overrides,
  };
}
function open(path: string, initial: Props = {}) {
  const controls = createControls();
  controls.auth = auth(initial);
  controls.queries = {
    "orders.getOrderStats": fixture({ total: 10 }),
    "escrow.getEscrowStats": fixture({ totalGrossHeld: 0, heldCount: 0 }),
    "disputes.getDisputeStats": fixture({ open: 0 }),
    "products.getPendingReviewListings": [],
    "disputes.getOpenDisputes": [],
    "users.getAllUsers": { items: [] },
    "platform.getPlatformSettingsForAdmin": fixture({
      companyDisplayName: "Fixture Store",
      companySeller: null,
      companySellerUserId: null,
    }),
    "promotions.listPromoCodesForAdmin": [],
    "promotions.listPromotionBannersForAdmin": [],
    "notifications.listNotificationCampaignsForAdmin": [],
    "categories.getParentCategories": [],
    "vendors.getPendingApplications": [],
    "notifications.getUnreadCount": 0,
  };
  const harness = createHarness({
    controls,
    aliases: { "@/": file("apps/web/src") },
    files: {
      [file("apps/web/src/hooks/useAuth.ts")]: withFallback({
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
  const component = harness.load(file(path)).default;
  return {
    controls,
    harness,
    render: (props: Props = {}) => harness.render(component, props),
  };
}
const denied = [
  ["signed-out", { isSignedIn: false, user: null }, "Sign In"],
  [
    "banned admin",
    { user: { _id: "users|admin", role: "admin", isBanned: true } },
    "Account unavailable",
  ],
  [
    "banned moderator",
    { user: { _id: "users|mod", role: "moderator", isBanned: true } },
    "Account unavailable",
  ],
  [
    "cached deleted",
    {
      user: {
        _id: "users|admin",
        role: "admin",
        isBanned: false,
        deletedAt: 1,
      },
    },
    "Account unavailable",
  ],
  [
    "recovery",
    { isSignedIn: false, user: null, syncFailed: true },
    "Account setup did not finish",
  ],
  ["missing account", { user: null }, "Account setup did not finish"],
  ["signed-out cached profile", { isSignedIn: false }, "Sign In"],
] as const;

for (const page of PAGES) {
  for (const [state, override, copy] of denied) {
    test(`${page.file}: ${state} does not request or display private data`, () => {
      const screen = open(adminRoot + page.file, override);
      const result = screen.render();
      assert.equal(
        result.queryCalls.filter((call) => call.args !== "skip").length,
        0,
      );
      assert.ok(textOf(result.tree).includes(copy), textOf(result.tree));
      assert.ok(
        !hasNode(result.tree, "Skeleton"),
        "settled access denial is not query loading",
      );
    });
  }
  test(`${page.file}: pending auth requests nothing, then eligible admin loads normally`, () => {
    const screen = open(adminRoot + page.file, { isLoading: true });
    const pending = screen.render();
    assert.equal(
      pending.queryCalls.filter((call) => call.args !== "skip").length,
      0,
    );
    assert.ok(hasNode(pending.tree, "Skeleton"));
    screen.controls.auth = auth();
    const ready = screen.render();
    assert.deepEqual(
      ready.queryCalls
        .filter((call) => call.args !== "skip")
        .map((call) => call.name)
        .sort(),
      [...page.queries].sort(),
    );
    assert.ok(textOf(ready.tree).includes(page.success), textOf(ready.tree));
  });
  test(`${page.file}: moderator requests no administrator-only data`, () => {
    const screen = open(adminRoot + page.file, {
      user: fixture({
        _id: "users|mod",
        role: "moderator",
        isBanned: false,
        deletedAt: undefined,
      }),
    });
    const result = screen.render();
    const requested = result.queryCalls
      .filter((call) => call.args !== "skip")
      .map((call) => call.name)
      .sort();
    if (page.file === "page.tsx") {
      assert.deepEqual(requested, [
        "disputes.getOpenDisputes",
        "products.getPendingReviewListings",
      ]);
      assert.ok(textOf(result.tree).includes("Review workspace"));
      assert.ok(
        findNodes(
          result.tree,
          (node) => node.props.href === "/admin/products/review",
        ).length > 0,
      );
    } else {
      assert.deepEqual(requested, []);
      assert.ok(textOf(result.tree).includes("Access Restricted"));
      assert.ok(!hasNode(result.tree, "Skeleton"));
    }
  });
  test(`${page.file}: actual requested query loading clears on completed empty data`, () => {
    const screen = open(adminRoot + page.file);
    const name = page.queries[0];
    const value = screen.controls.queries[name];
    screen.controls.queries[name] = undefined;
    const loading = screen.render();
    assert.ok(hasNode(loading.tree, "Skeleton"));
    assert.ok(
      loading.queryCalls.some(
        (call) => call.name === name && call.args !== "skip",
      ),
    );
    screen.controls.queries[name] = value;
    assert.ok(textOf(screen.render().tree).includes(page.success));
  });
  test(`${page.file}: access loss removes cached private content and restoration preserves hook order`, () => {
    const screen = open(adminRoot + page.file);
    screen.render();
    for (const [, override, copy] of denied) {
      screen.controls.auth = auth(override);
      const deniedResult = screen.render();
      assert.equal(
        deniedResult.queryCalls.filter((call) => call.args !== "skip").length,
        0,
      );
      assert.ok(textOf(deniedResult.tree).includes(copy));
      screen.controls.auth = auth();
      assert.ok(textOf(screen.render().tree).includes(page.success));
    }
  });

  test(`${page.file}: role downgrade stops administrator queries before restriction UI`, () => {
    const screen = open(adminRoot + page.file);
    screen.render();
    screen.controls.auth = auth({
      user: fixture({
        _id: "users|admin",
        role: "moderator",
        isBanned: false,
        deletedAt: undefined,
      }),
    });
    const result = screen.render();
    assert.ok(
      !result.queryCalls.some(
        (call) =>
          call.args !== "skip" &&
          ![
            "products.getPendingReviewListings",
            "disputes.getOpenDisputes",
          ].includes(call.name),
      ),
    );
    assert.ok(
      textOf(result.tree).includes(
        page.file === "page.tsx" ? "Review workspace" : "Access Restricted",
      ),
    );
    screen.controls.auth = auth();
    assert.ok(textOf(screen.render().tree).includes(page.success));
  });
}

for (const [state, override, copy] of denied) {
  test(`layout ${state} mounts neither actual Header nor protected child`, () => {
    const screen = open(adminRoot + "layout.tsx", override);
    const child = screen.harness.load(
      file(adminRoot + "users/page.tsx"),
    ).default;
    const result = screen.render({ children: { type: child, props: {} } });
    assert.equal(
      result.queryCalls.filter((call) => call.args !== "skip").length,
      0,
    );
    assert.ok(textOf(result.tree).includes(copy), textOf(result.tree));
  });
}
test("ready moderator layout keeps reviewer Header and route access", () => {
  const screen = open(adminRoot + "layout.tsx", {
    user: fixture({
      _id: "users|mod",
      role: "moderator",
      isBanned: false,
      deletedAt: undefined,
    }),
  });
  const result = screen.render({ children: "Reviewer child" });
  assert.deepEqual(
    result.queryCalls
      .filter((call) => call.args !== "skip")
      .map((call) => call.name)
      .sort(),
    ["disputes.getOpenDisputes", "notifications.getUnreadCount"],
  );
  assert.ok(textOf(result.tree).includes("Reviewer child"));
});
test("staff recovery controls invoke retry and sign-out", () => {
  const screen = open(adminRoot + "users/page.tsx", {
    user: null,
    syncFailed: true,
  });
  screen.controls.auth.retrySync = () =>
    screen.controls.calls.push({ name: "retry", args: [] });
  screen.controls.auth.signOut = async () =>
    screen.controls.calls.push({ name: "signOut", args: [] });
  const result = screen.render();
  assert.ok(pressButton(result.tree, "Try again", "onClick"));
  assert.ok(pressButton(result.tree, "Sign out", "onClick"));
  assert.deepEqual(
    screen.controls.calls.map((call) => call.name),
    ["retry", "signOut"],
  );
});
