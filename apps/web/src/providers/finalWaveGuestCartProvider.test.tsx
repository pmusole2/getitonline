import assert from "node:assert/strict";
import Module from "node:module";
import { dirname } from "node:path";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import * as React from "react";
import { act, createElement } from "react";
import { getFunctionName } from "convex/server";
import {
  GETTITONLINE_GUEST_CART_STORAGE_KEY,
  type GuestCartItem,
} from "@gettitonline/shared";

import type * as ProviderModule from "./GuestCartProvider";
import { api } from "../../../../convex/_generated/api";
import { ConvexClientDouble } from "../../../../tests/support/convexSubjectClientDouble";
import type { MountedRoot } from "../../../../tests/support/realReactRender";
import {
  clerk,
  mountWithClient,
  resetDoubles,
  server,
  settleTasks,
  subject,
} from "../../../../tests/support/convexSubjectHarness";

// Renders the real web GuestCartProvider with the real convex/react hooks and ConvexProviderWithClerk. The auth hook and
// the toast library are stand-ins. localStorage is an in-memory store on the rendered window, and the server records every
// mergeGuestCart call it receives.

const providersDir = __dirname;
// Signed-out by default. A signed-in cart merges on mount and clears its lines after a successful merge, so the edit tests
// stay signed out and only the merge tests sign in.
const authState: { isSignedIn: boolean } = { isSignedIn: false };

const requireUnpatched = Module.prototype.require;
Module.prototype.require = function requireWithStubs(
  this: Module,
  id: string,
): unknown {
  if (id === "@/hooks/useAuth") {
    return {
      useAuth: () => ({
        user: { _id: "user_guest_cart" },
        isSignedIn: authState.isSignedIn,
      }),
    };
  }
  if (id === "sonner" && dirname(this.filename) === providersDir) {
    return { toast: { success: () => undefined, error: () => undefined } };
  }
  return requireUnpatched.call(this, id);
};

// The app compiles this provider with the automatic JSX runtime, but the test runner compiles it with the classic one, which
// reads React from the global scope. The test provides that global, so the provider renders as it does in the app.
Reflect.set(globalThis, "React", React);

let GuestCartProvider: typeof ProviderModule.GuestCartProvider;
let useGuestCart: typeof ProviderModule.useGuestCart;
before(async () => {
  ({ GuestCartProvider, useGuestCart } = await import("./GuestCartProvider"));
});

type CartView = ReturnType<typeof ProviderModule.useGuestCart>;
const latest: { current: CartView | null } = { current: null };

// Probes hand their view here, so no render assigns to a variable outside the component.
function record(view: CartView): void {
  latest.current = view;
}

function Probe() {
  record(useGuestCart());
  return null;
}

function cart(): CartView {
  if (!latest.current) {
    throw new Error("the provider has not rendered");
  }
  return latest.current;
}

const mergeGuestCart = getFunctionName(api.cart.mergeGuestCart);
const KEY = GETTITONLINE_GUEST_CART_STORAGE_KEY;

interface MemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function memoryStorage(): MemoryStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

let storage = memoryStorage();

// Records the argument of each merge call, in order.
const merges: { items: { productId: string; quantity: number }[] }[] = [];

function guestItem(
  productId: string,
  quantity: number,
  productStock = 500,
): GuestCartItem {
  return {
    productId,
    quantity,
    selectedShipping: { name: "Standard", price: 0 },
    product: {
      _id: productId,
      sellerId: "seller_1",
      sellerName: "Seller One",
      title: "Desk lamp",
      price: 10,
      images: [],
      quantity: productStock,
      status: "active",
      shippingOptions: [{ name: "Standard", price: 0, estimatedDays: "3" }],
    },
    addedAt: 1,
  };
}

// Mounts the provider with the seeded storage on the window, and waits for hydration to finish.
async function mountCart(): Promise<MountedRoot> {
  const client = new ConvexClientDouble(
    "https://guest-cart-web-test.example.invalid",
  );
  const root = mountWithClient(client);
  Reflect.set(Reflect.get(globalThis, "window"), "localStorage", storage);
  await root.render(
    createElement(GuestCartProvider, null, createElement(Probe)),
  );
  await act(async () => {
    await settleTasks();
  });
  return root;
}

describe("web GuestCartProvider keeps local quantities within the backend limit", () => {
  beforeEach(() => {
    resetDoubles();
    latest.current = null;
    merges.length = 0;
    authState.isSignedIn = false;
    storage = memoryStorage();
    clerk.user = subject("clerk_cart_web");
    server.mutations.set(mergeGuestCart, async (args: unknown) => {
      merges.push(args as { items: { productId: string; quantity: number }[] });
      return { mergedCount: 1, skipped: [] };
    });
  });

  afterEach(() => {
    latest.current = null;
  });

  it("addItem with quantity 150 stores 99", async () => {
    const root = await mountCart();

    await act(async () => {
      cart().addItem(guestItem("p1", 150));
    });

    assert.deepEqual(
      cart().items.map((line) => line.quantity),
      [99],
    );
    await root.unmount();
  });

  it("adding the same product repeatedly clamps the line at 99", async () => {
    const root = await mountCart();

    await act(async () => {
      cart().addItem(guestItem("p1", 60));
    });
    await act(async () => {
      cart().addItem(guestItem("p1", 60));
    });
    await act(async () => {
      cart().addItem(guestItem("p1", 60));
    });

    assert.deepEqual(
      cart().items.map((line) => line.quantity),
      [99],
      "repeated adds stop at the cap",
    );
    await root.unmount();
  });

  it("updateQuantity with 150 stores 99", async () => {
    const root = await mountCart();
    await act(async () => {
      cart().addItem(guestItem("p1", 1));
    });

    await act(async () => {
      cart().updateQuantity("p1", 150);
    });

    assert.deepEqual(
      cart().items.map((line) => line.quantity),
      [99],
    );
    await root.unmount();
  });

  for (const value of [Number.NaN, 0, -3]) {
    it(`updateQuantity with ${value} removes the line`, async () => {
      const root = await mountCart();
      await act(async () => {
        cart().addItem(guestItem("p1", 2));
      });

      await act(async () => {
        cart().updateQuantity("p1", value);
      });

      assert.deepEqual(
        cart().items,
        [],
        "the line is removed, not stored with an invalid quantity",
      );
      await root.unmount();
    });
  }

  it("a legacy persisted line with quantity 150 is merged once, as 99", async () => {
    authState.isSignedIn = true;
    storage.setItem(KEY, JSON.stringify([guestItem("p1", 150)]));
    const root = await mountCart();
    await act(async () => {
      await settleTasks();
    });

    assert.equal(merges.length, 1, "the cart is merged exactly once");
    assert.deepEqual(
      merges[0]?.items.map((line) => line.quantity),
      [99],
      "the merge payload carries the clamped quantity",
    );
    await root.unmount();
  });

  it("a stored cart with an invalid line sends nothing to the server", async () => {
    authState.isSignedIn = true;
    const invalid = { ...guestItem("p1", 1), quantity: 0 };
    storage.setItem(KEY, JSON.stringify([guestItem("p2", 2), invalid]));
    const root = await mountCart();
    await act(async () => {
      await settleTasks();
    });

    assert.deepEqual(
      merges,
      [],
      "no line from a cart with an invalid entry is sent",
    );
    await root.unmount();
  });
});
