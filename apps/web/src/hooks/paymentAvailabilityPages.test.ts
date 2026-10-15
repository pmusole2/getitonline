import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as React from "react";
import * as ConvexReact from "convex/react";
import { anyApi, getFunctionName } from "convex/server";

import { resolveAccountAccess } from "../../../../packages/shared/src/utils/accountAccess";
import { resolvePaymentAvailability } from "../../../../packages/shared/src/utils/clientGate";
import {
  createControls,
  createHarness,
  findNodes,
  fixture,
  textOf,
  withFallback,
} from "../../../../tests/support/componentHarness";
import {
  createFakeConvexClient,
  deliver,
  mountUnderConvex,
} from "../../../../tests/support/realReactRender";

// Runs the real web checkout page with controlled auth, cart, and payment-availability query results.
// A loading, null, failed (Error), or malformed availability result must leave the place-order action disabled.
// A failed query must show the unavailable message instead of replacing the page with the error screen.
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const file = (path: string) => resolve(root, path);
const availabilityKey = "appConfig.getPaymentAvailability";
const unavailableMessage = "Payments are temporarily unavailable";
const user = {
  _id: "users|ada",
  clerkId: "ada",
  role: "user",
  isBanned: false,
};

function open(availability: unknown) {
  const controls = createControls();
  controls.auth = {
    user,
    isLoading: false,
    isSignedIn: true,
    syncFailed: false,
    retrySync: () => undefined,
    signOut: async () => undefined,
  };
  controls.queries = {
    [availabilityKey]: availability,
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
      "@gettitonline/shared": withFallback({
        resolveAccountAccess,
        resolvePaymentAvailability,
      }),
      sonner: withFallback({
        toast: {
          success: () => undefined,
          error: () => undefined,
        },
      }),
    },
  });
  const page = harness.load(
    file("apps/web/src/app/(main)/checkout/page.tsx"),
  ).default;
  return { render: () => harness.render(page) };
}

function placeOrderButtons(tree: Parameters<typeof findNodes>[0]) {
  return findNodes(
    tree,
    (node) =>
      node.name === "Button" && textOf(node.children).includes("Place Order"),
  );
}

for (const [label, availability] of [
  ["loading", undefined],
  ["a null result", null],
  ["a failed query", new Error("server unavailable")],
  ["a malformed result", { paymentsEnabled: "true" }],
  ["payments switched off", { paymentsEnabled: false }],
] as const) {
  test(`web checkout says payments are unavailable and disables placing an order when ${label}`, () => {
    const result = open(availability).render();
    assert.ok(
      textOf(result.tree).includes(unavailableMessage),
      textOf(result.tree),
    );
    const [button] = placeOrderButtons(result.tree);
    assert.ok(button, textOf(result.tree));
    assert.equal(button.props.disabled, true);
  });
}

test("web checkout availability alone cannot approve or enable a purchase", () => {
  const result = open({ paymentsEnabled: true }).render();
  const [button] = placeOrderButtons(result.tree);
  assert.ok(button, textOf(result.tree));
  assert.equal(button.props.disabled, true);
});

test("web checkout drops the unavailable message when payments are available", () => {
  const result = open({ paymentsEnabled: true }).render();
  assert.ok(!textOf(result.tree).includes(unavailableMessage));
});

// Real React and convex/react, with the hook loaded from source. The result arrives through the real watch protocol.
const realAvailabilityName = "appConfig:getPaymentAvailability";

function mountRealAvailability() {
  const harness = createHarness({
    controls: createControls(),
    convexApi: { api: anyApi },
    packages: {
      react: React,
      "convex/react": ConvexReact,
      "@gettitonline/shared": withFallback({ resolvePaymentAvailability }),
    },
  });
  const usePaymentAvailability = harness.load(
    file("apps/web/src/hooks/usePaymentAvailability.ts"),
  ).usePaymentAvailability as () => string;
  // Each render reports its value through a callback, so the test sees every render and the component stays pure.
  const values: string[] = [];
  function Probe({ report }: { report: (value: string) => void }): null {
    report(usePaymentAvailability());
    return null;
  }
  return { Probe, values, report: (value: string) => values.push(value) };
}
test("the real useQueries reads web payment availability without a render loop, and a parent re-render keeps it", async () => {
  const { Probe, values, report } = mountRealAvailability();
  const convex = createFakeConvexClient();
  const mounted = mountUnderConvex(convex);
  await mounted.render(React.createElement(Probe, { report }));
  assert.equal(values.at(-1), "unavailable");
  await deliver(convex, realAvailabilityName, { paymentsEnabled: true });
  assert.equal(values.at(-1), "available");
  await mounted.render(React.createElement(Probe, { report }));
  assert.equal(values.at(-1), "available");
  assert.ok(values.length <= 4, `rendered ${values.length} times`);
  assert.deepEqual(convex.lifecycle, [`subscribe:${realAvailabilityName}`]);
  await mounted.unmount();
});

test("the real useQueries keeps web payments unavailable when the availability query fails", async () => {
  const { Probe, values, report } = mountRealAvailability();
  const convex = createFakeConvexClient({
    [realAvailabilityName]: { paymentsEnabled: true },
  });
  const mounted = mountUnderConvex(convex);
  await mounted.render(React.createElement(Probe, { report }));
  assert.equal(values.at(-1), "available");
  await deliver(convex, realAvailabilityName, new Error("server unavailable"));
  assert.equal(values.at(-1), "unavailable");
  await mounted.unmount();
});
