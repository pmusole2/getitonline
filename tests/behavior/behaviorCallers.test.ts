import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resolveBehaviorEventSubject } from "../../packages/shared/src/utils/behaviorEventSession";
import {
  createControls,
  createHarness,
  fixture,
  withFallback,
  type Props,
  type HarnessControls,
} from "../support/componentHarness";

// Actual screen/page effects under controlled hooks, not a browser, websocket or live JWT test.
const root = fileURLToPath(new URL("../../", import.meta.url));
const file = (path: string) => resolve(root, path);
const CASES = [
  {
    file: "apps/mobile/src/screens/product/ProductDetailScreen.tsx",
    mobile: true,
    product: true,
  },
  {
    file: "apps/mobile/src/screens/browse/CategoryProductsScreen.tsx",
    mobile: true,
    product: false,
  },
  {
    file: "apps/web/src/app/(main)/product/[id]/page.tsx",
    mobile: false,
    product: true,
  },
  {
    file: "apps/web/src/app/(main)/browse/[slug]/page.tsx",
    mobile: false,
    product: false,
  },
] as const;
const product = fixture({
  _id: "products|p",
  sellerId: "users|seller",
  categoryId: "categories|c",
  title: "Public fixture",
  price: 100,
  quantity: 2,
  condition: "new",
  specifications: [],
  shippingOptions: [],
  images: [],
  variants: [],
  addOns: [],
  variantCombinations: [],
  variantAttributes: [],
  location: { city: "Lusaka" },
  seller: { isCompanyStore: false },
});

function session(subject: string | null, overrides: Props = {}): Props {
  return {
    isLoading: false,
    isSignedIn: subject !== null,
    syncFailed: false,
    authSyncError: null,
    clerkUser: subject ? { id: subject } : null,
    user: subject
      ? {
          _id: `users|${subject}`,
          clerkId: subject,
          role: "user",
          isBanned: false,
        }
      : null,
    ...overrides,
  };
}
function setSession(
  controls: HarnessControls,
  subject: string | null,
  overrides: Props = {},
) {
  controls.auth = session(subject, overrides);
  controls.convexAuth = { isLoading: false, isAuthenticated: subject !== null };
}
function open(target: (typeof CASES)[number], controls: HarnessControls) {
  controls.params = { id: "products|p", slug: "fixture" };
  controls.queries = {
    "products.getProduct": product,
    "categories.getCategoryBySlug": fixture({
      _id: "categories|c",
      name: "Category",
    }),
    "categories.getCategoryWithSubcategories": fixture({ subcategories: [] }),
    "products.getProductsByCategory": { items: [], hasMore: false },
    "categories.getSubcategories": [],
    "reviews.getProductReviews": [],
  };
  const harness = createHarness({
    controls,
    effects: true,
    aliases: { "@/": file("apps/web/src") },
    packages: {
      "@gettitonline/shared": withFallback({ resolveBehaviorEventSubject }),
    },
    files: {
      [file("apps/mobile/src/context/AuthProvider.tsx")]: withFallback({
        useAppAuth: () => {
          controls.hook("useContext");
          return controls.auth;
        },
      }),
      [file("apps/web/src/hooks/useAuth.ts")]: withFallback({
        useAuth: () => {
          controls.hook("useContext");
          return controls.auth;
        },
      }),
      [file("apps/mobile/src/context/GuestCartProvider.tsx")]: withFallback({
        useGuestCart: () => ({ addItem: () => undefined }),
      }),
      [file("apps/web/src/providers/GuestCartProvider.tsx")]: withFallback({
        useGuestCart: () => ({ addItem: () => undefined }),
      }),
    },
  });
  const component = harness.load(file(target.file)).default;
  return {
    harness,
    render: () =>
      harness.render(component, {
        route: {
          params: {
            productId: "products|p",
            categoryId: "categories|c",
            categoryName: "Category",
          },
        },
        navigation: { navigate: () => undefined, goBack: () => undefined },
      }),
  };
}
function events(controls: HarnessControls): Props[] {
  return controls.calls
    .filter(
      (call) => call.name === "mutation:notifications.recordBehaviorEvent",
    )
    .map((call) => call.args[0] as Props);
}

for (const target of CASES) {
  for (const subject of [null, "ada"] as const) {
    test(`${target.file}: ${subject ?? "guest"} events carry session assertion without acting ID`, async () => {
      const controls = createControls();
      setSession(controls, subject);
      const screen = open(target, controls);
      screen.render();
      await screen.harness.settle();
      assert.equal(events(controls).length, 1);
      assert.equal(events(controls)[0].expectedClerkId, subject);
      assert.ok(
        !Object.prototype.hasOwnProperty.call(events(controls)[0], "userId"),
      );
      screen.render();
      assert.equal(
        events(controls).length,
        1,
        "unrelated render must not duplicate views",
      );
    });
  }
  for (const state of [
    "pending",
    "recovery",
    "banned",
    "deleted",
    "mismatched-profile",
    "sdk-pending",
  ] as const) {
    test(`${target.file}: suppresses ${state} events while public data is requested`, async () => {
      const controls = createControls();
      setSession(controls, "ada");
      if (state === "pending") controls.auth.isLoading = true;
      if (state === "recovery")
        Object.assign(controls.auth, {
          isSignedIn: false,
          user: null,
          syncFailed: true,
          authSyncError: "Failed",
        });
      if (state === "banned")
        controls.auth.user = { clerkId: "ada", isBanned: true };
      if (state === "deleted")
        controls.auth.user = { clerkId: "ada", isBanned: false, deletedAt: 1 };
      if (state === "mismatched-profile")
        controls.auth.user = { clerkId: "bea", isBanned: false };
      if (state === "sdk-pending") controls.convexAuth.isLoading = true;
      const screen = open(target, controls);
      const result = screen.render();
      await screen.harness.settle();
      assert.equal(events(controls).length, 0);
      assert.ok(
        result.queryCalls.some(
          (call) =>
            call.args !== "skip" &&
            (call.name.startsWith("products.") ||
              call.name.startsWith("categories.")),
        ),
      );
      setSession(controls, "ada");
      screen.render();
      assert.equal(
        events(controls).length,
        1,
        "restored eligible session records a view",
      );
    });
  }
  if (target.product) {
    for (const next of [
      "bea",
      null,
      "pending",
      "banned",
      "recovery",
    ] as const) {
      test(`${target.file}: obsolete dwell cleanup is dropped on ${next ?? "sign-out"}`, () => {
        const controls = createControls();
        setSession(controls, "ada");
        const now = Date.now;
        let time = 1000;
        Date.now = () => time;
        try {
          const screen = open(target, controls);
          screen.render();
          controls.calls = [];
          time = 3000;
          if (next === "pending") controls.auth.isLoading = true;
          else if (next === "banned")
            controls.auth.user = { clerkId: "ada", isBanned: true };
          else if (next === "recovery")
            Object.assign(controls.auth, {
              syncFailed: true,
              authSyncError: "Failed",
            });
          else setSession(controls, next);
          screen.render();
          assert.equal(
            events(controls).filter(
              (event) => event.eventType === "product_time_spent",
            ).length,
            0,
          );
        } finally {
          Date.now = now;
        }
      });
    }
    for (const duration of [500, 2000]) {
      test(`${target.file}: same-session unmount records dwell only after one second (${duration})`, () => {
        const controls = createControls();
        setSession(controls, "ada");
        const now = Date.now;
        let time = 1000;
        Date.now = () => time;
        try {
          const screen = open(target, controls);
          screen.render();
          controls.calls = [];
          time += duration;
          screen.harness.render(() => null);
          const dwell = events(controls).filter(
            (event) => event.eventType === "product_time_spent",
          );
          assert.equal(dwell.length, duration >= 1000 ? 1 : 0);
          if (dwell.length) assert.equal(dwell[0].expectedClerkId, "ada");
        } finally {
          Date.now = now;
        }
      });
    }
  }
}
