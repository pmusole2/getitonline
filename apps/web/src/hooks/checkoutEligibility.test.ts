import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { anyApi, getFunctionName } from "convex/server";

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

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const file = (path: string) => resolve(root, path);
const user = {
  _id: "users|ada",
  clerkId: "ada",
  role: "user",
  isBanned: false,
};
function auth(extra: Props = {}): Props {
  return {
    user,
    isLoading: false,
    isSignedIn: true,
    syncFailed: false,
    retrySync: () => undefined,
    signOut: async () => undefined,
    ...extra,
  };
}
function open(extra: Props = {}) {
  const controls = createControls();
  controls.auth = auth(extra);
  controls.queries = {
    "cart.getCart": fixture({
      subtotal: 100,
      items: [
        {
          product: {
            _id: "products|p",
            title: "Fixture item",
            images: [],
            price: 100,
            categoryId: "categories|c",
          },
          quantity: 1,
          shippingCost: 0,
        },
      ],
    }),
    "cart.getCartBySeller": [
      fixture({
        sellerId: "users|seller",
        sellerName: "Fixture Seller",
        subtotal: 100,
        items: [],
      }),
    ],
    "cart.validateCart": { valid: true, issues: [] },
    "wallet.getWallet": fixture({ balance: 100 }),
    "promotions.validatePromoCode": {
      valid: true,
      promoCodeId: "promoCodes|p",
      code: "TEST",
      title: "Fixture promo",
      discountAmount: 10,
    },
  };
  // This page harness models commit ordering, not concurrent React. Keep its SDK client stable;
  // walletCheckout.test.ts separately exercises the actual React/Convex lifecycle and deferred transport.
  const client = {
    query: async (
      reference: Parameters<typeof getFunctionName>[0],
      args: unknown,
    ) => {
      const name = getFunctionName(reference).replace(":", ".");
      controls.calls.push({ name: `query:${name}`, args: [args] });
      controls.queryCalls.push({ name, args });
      return controls.queries[name];
    },
    mutation: async () => {
      throw new Error("No purchase approved by this page fixture");
    },
    action: async () => null,
  };
  const harness = createHarness({
    controls,
    convexApi: { api: anyApi },
    effects: true,
    aliases: { "@/": file("apps/web/src") },
    files: {
      [file("apps/web/src/hooks/useAuth.ts")]: withFallback({
        useAuth: () => {
          controls.hook("useContext");
          return controls.auth;
        },
      }),
      [file("apps/web/src/providers/GuestCartProvider.tsx")]: withFallback({
        useGuestCart: () => ({
          isHydrated: true,
          isMerging: false,
          hasPendingMerge: false,
        }),
      }),
    },
    packages: {
      "convex/react": {
        useConvex: () => {
          controls.hook("useConvex");
          return client;
        },
        useQuery: (
          reference: Parameters<typeof getFunctionName>[0],
          args: unknown,
        ) => {
          controls.hook("useQuery");
          const name = getFunctionName(reference).replace(":", ".");
          controls.queryCalls.push({ name, args });
          const value = args === "skip" ? undefined : controls.queries[name];
          if (value instanceof Error) {
            throw value;
          }
          return value;
        },
        useQueries: (
          requests: Record<
            string,
            { query: Parameters<typeof getFunctionName>[0]; args: unknown }
          >,
        ) => {
          controls.hook("useQueries");
          return Object.fromEntries(
            Object.entries(requests).map(([key, request]) => {
              const name = getFunctionName(request.query).replace(":", ".");
              controls.queryCalls.push({ name, args: request.args });
              return [key, controls.queries[name]];
            }),
          );
        },
      },
      "@gettitonline/shared": withFallback({ resolveAccountAccess }),
      sonner: withFallback({
        toast: {
          success: (...args: unknown[]) =>
            controls.calls.push({ name: "toast.success", args }),
          error: (...args: unknown[]) =>
            controls.calls.push({ name: "toast.error", args }),
        },
      }),
    },
  });
  const component = harness.load(
    file("apps/web/src/app/(main)/checkout/page.tsx"),
  ).default;
  return { controls, harness, render: () => harness.render(component) };
}
for (const [label, extra, expected] of [
  ["signed out", { isSignedIn: false, user: null }, "Sign In"],
  ["banned", { user: { ...user, isBanned: true } }, "Account unavailable"],
  ["deleted cache", { user: { ...user, deletedAt: 1 } }, "Account unavailable"],
  [
    "recovery",
    { user: null, isSignedIn: false, syncFailed: true },
    "Account setup did not finish",
  ],
  ["signed-out cache", { isSignedIn: false }, "Sign In"],
] as const) {
  test(`web checkout ${label} does not initiate protected sibling queries`, () => {
    const screen = open(extra);
    const result = screen.render();
    assert.equal(
      result.queryCalls.filter((call) => call.args !== "skip").length,
      0,
    );
    assert.ok(textOf(result.tree).includes(expected), textOf(result.tree));
    assert.ok(!hasNode(result.tree, "Skeleton"));
  });
}

test("web checkout sign-in preserves the checkout return destination", () => {
  const screen = open({ isSignedIn: false, user: null });
  const result = screen.render();
  assert.ok(
    findNodes(
      result.tree,
      (node) => node.props.href === "/sign-in?redirect_url=%2Fcheckout",
    ).length > 0,
  );
});

test("web checkout promo caller omits acting ID, preserving quote resources and unavailable-payment gating", async () => {
  const screen = open();
  let tree = screen.render().tree;
  const input = findNodes(
    tree,
    (node) => node.props.placeholder === "Enter code",
  )[0];
  assert.ok(input && typeof input.props.onChange === "function");
  input.props.onChange({ target: { value: " test " } });
  tree = screen.render().tree;
  assert.ok(pressButton(tree, "Apply", "onClick"));
  await screen.harness.settle();
  const call = screen.controls.calls.find(
    (call) => call.name === "query:promotions.validatePromoCode",
  );
  assert.deepEqual(call?.args[0], {
    code: "test",
    subtotal: 100,
    categoryIds: ["categories|c"],
    productIds: ["products|p"],
  });
  assert.ok(
    textOf(screen.render().tree).includes(
      "Payments are temporarily unavailable",
    ),
  );
  assert.ok(
    !screen.controls.calls.some((call) => call.name.startsWith("mutation:")),
  );
});

test("web checkout access loss clears form state and obsolete promo completions", async () => {
  const screen = open();
  let complete: ((value: unknown) => void) | undefined;
  screen.controls.queries["promotions.validatePromoCode"] = new Promise(
    (resolve) => {
      complete = resolve;
    },
  );
  const input = findNodes(
    screen.render().tree,
    (node) => node.props.placeholder === "Enter code",
  )[0];
  assert.ok(input && typeof input.props.onChange === "function");
  input.props.onChange({ target: { value: "old-session" } });
  assert.ok(pressButton(screen.render().tree, "Apply", "onClick"));
  screen.controls.auth = auth({ isSignedIn: false, user: null });
  assert.ok(textOf(screen.render().tree).includes("Sign In"));
  assert.ok(complete);
  complete({
    valid: true,
    promoCodeId: "promoCodes|p",
    code: "OLD",
    title: "Old promo",
    discountAmount: 10,
  });
  await screen.harness.settle();
  assert.ok(
    !screen.controls.calls.some((call) => call.name === "toast.success"),
  );
  screen.controls.auth = auth({
    user: { ...user, _id: "users|bea", clerkId: "bea" },
  });
  const restored = screen.render();
  assert.equal(
    findNodes(
      restored.tree,
      (node) => node.props.placeholder === "Enter code",
    )[0]?.props.value,
    "",
  );
});

test("web checkout direct account switch discards pending promo errors and drafts", async () => {
  const screen = open();
  let fail: ((error: Error) => void) | undefined;
  screen.controls.queries["promotions.validatePromoCode"] = new Promise(
    (_resolve, reject) => {
      fail = reject;
    },
  );
  const input = findNodes(
    screen.render().tree,
    (node) => node.props.placeholder === "Enter code",
  )[0];
  assert.ok(input && typeof input.props.onChange === "function");
  input.props.onChange({ target: { value: "ada-promo" } });
  assert.ok(pressButton(screen.render().tree, "Apply", "onClick"));
  screen.controls.auth = auth({
    user: { ...user, _id: "users|bea", clerkId: "bea" },
  });
  const switched = screen.render();
  assert.equal(
    findNodes(
      switched.tree,
      (node) => node.props.placeholder === "Enter code",
    )[0]?.props.value,
    "",
  );
  assert.ok(fail);
  fail(new Error("obsolete account eligibility failure"));
  await screen.harness.settle();
  assert.ok(!screen.controls.calls.some((call) => call.name === "toast.error"));
  assert.ok(
    !textOf(screen.render().tree).includes(
      "obsolete account eligibility failure",
    ),
  );
});

test("web checkout loading keeps protected siblings skipped and shows only the account loading state", () => {
  const screen = open({ isLoading: true });
  const result = screen.render();
  assert.equal(
    result.queryCalls.filter((call) => call.args !== "skip").length,
    0,
  );
  assert.ok(hasNode(result.tree, "Skeleton"));
  assert.ok(!textOf(result.tree).includes("Place Order"));
});
