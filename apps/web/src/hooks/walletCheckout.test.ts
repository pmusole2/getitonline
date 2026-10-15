import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React, { act, createElement, type ReactNode } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as ConvexReact from "convex/react";
import { getFunctionName } from "convex/server";

import * as quoteModule from "../../../../convex/checkoutQuote";
import * as purchaseModule from "../../../../convex/paymentOperations";
import * as statusModule from "../../../../convex/paymentReconciliation";
import {
  createDb,
  createCtx,
  type Row,
} from "../../../../tests/support/convexFakeDb";
import { invokeFakeFunction } from "../../../../tests/support/convexFakeActionCtx";
import {
  browserCheckoutStorage,
  type CheckoutStorage,
} from "../lib/walletCheckoutState";
import * as shared from "../../../../packages/shared/src/index";
import { api } from "../../../../convex/_generated/api";
import {
  createControls,
  createHarness,
  type Props,
} from "../../../../tests/support/componentHarness";
import {
  createFakeConvexClient,
  mountUnderConvex,
} from "../../../../tests/support/realReactRender";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const file = (path: string): string => resolve(root, path);
const ADDRESS = {
  street: "Street",
  city: "Lusaka",
  province: "Lusaka",
  country: "Zambia",
  phone: "0971234567",
};
const USER = {
  _id: "users|ada",
  clerkId: "ada",
  role: "user",
  isBanned: false,
  address: ADDRESS,
  phone: ADDRESS.phone,
};
const AVAILABILITY = getFunctionName(api.appConfig.getPaymentAvailability);
const QUOTE = getFunctionName(api.checkoutQuote.quoteCheckout);
const PURCHASE = getFunctionName(api.paymentOperations.purchaseWithWallet);
const STATUS = getFunctionName(api.paymentReconciliation.getStatus);
const REFRESH = getFunctionName(api.paymentReconciliation.refresh);
const providers: {
  ConvexProvider(props: {
    client: object;
    children?: ReactNode;
  }): ReactNode | Promise<ReactNode>;
} = ConvexReact;
const canonical = {
  currency: "ZMW",
  source: "cart",
  quoteKey: "quote-1",
  inputIdentity: "input-1",
  subtotalCents: 29,
  promoCents: 0,
  loyaltyCents: 0,
  discountCents: 0,
  discountedSubtotalCents: 29,
  shippingCents: 0,
  platformFeeCents: 1,
  sellerPayoutCents: 29,
  totalAmountCents: 30,
  shippingAddress: ADDRESS,
  delivery: {
    name: "Seller shipping",
    code: "fallback",
    methodType: "product_fallback",
  },
  lines: [
    {
      productId: "products|p",
      sellerId: "users|seller",
      cartItemId: "cartItems|a",
      title: "Canonical lamp",
      quantity: 1,
      baseCents: 29,
      unitCents: 29,
      lineTotalCents: 29,
      optionPairs: [],
      addOns: [],
      customizationKey: "one",
    },
  ],
  sellers: [
    {
      sellerId: "users|seller",
      subtotalCents: 29,
      promoCents: 0,
      loyaltyCents: 0,
      discountCents: 0,
      discountedSubtotalCents: 29,
      shippingCents: 0,
      platformFeeCents: 1,
      sellerPayoutCents: 29,
      totalAmountCents: 30,
    },
  ],
  cartItemIds: ["cartItems|a"],
};

function memory(): CheckoutStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
    removeItem: (key: string): void => {
      values.delete(key);
    },
  };
}

function pageRig(
  options: {
    country?: string;
    available?: boolean;
    actualGuest?: boolean;
  } = {},
) {
  const controls = createControls();
  let user = {
    ...USER,
    address: { ...ADDRESS, country: options.country ?? "Zambia" },
  };
  const guest = {
    isHydrated: true,
    isMerging: false,
    hasPendingMerge: false,
    mergeFailed: false,
  };
  const calls: { name: string; args: unknown }[] = [];
  const nodes = new Map<string, Props>();
  const inputs = new Map<string, Props>();
  const groups = new Map<string, Props>();
  const strings: string[] = [];
  const implementations = new Map<string, (args: unknown) => unknown>();
  const host = (name: string) =>
    function Host(props: Props): ReactNode {
      if (name === "Button") {
        nodes.set(
          String(React.Children.toArray(props.children as ReactNode).join("")),
          props,
        );
      }
      if (name === "RadioGroup") {
        groups.set(String(props["aria-label"]), props);
      }
      for (const child of React.Children.toArray(props.children as ReactNode)) {
        if (typeof child === "string") {
          strings.push(child);
        }
      }
      if (name === "Input") {
        inputs.set(String(props.id ?? props.placeholder), props);
      }
      return createElement("div", null, props.children as ReactNode);
    };
  const ui = new Proxy(
    {},
    {
      get: (_target, name) =>
        name === "__esModule" ? true : host(String(name)),
    },
  );
  const files: Record<string, Props> = {
    [file("apps/web/src/hooks/useAccountAccess.ts")]: {
      useAccountAccess: () => ({ status: "ready", user }),
    },
    [file("apps/web/src/providers/GuestCartProvider.tsx")]: {
      useGuestCart: () => guest,
    },
  };
  if (options.actualGuest) {
    delete files[file("apps/web/src/providers/GuestCartProvider.tsx")];
    files[file("apps/web/src/hooks/useAuth.ts")] = {
      useAuth: () => ({ user, isSignedIn: true }),
    };
  }
  for (const name of [
    "button",
    "input",
    "label",
    "card",
    "separator",
    "skeleton",
    "radio-group",
    "select",
    "breadcrumb",
    "accordion",
  ]) {
    files[file(`apps/web/src/components/ui/${name}.tsx`)] = ui;
  }
  const capture = (children: unknown): void => {
    if (typeof children === "string") {
      strings.push(children);
    } else if (Array.isArray(children)) {
      children.forEach(capture);
    }
  };
  const traceJsx = (
    ...args: Parameters<typeof jsxRuntime.jsx>
  ): ReturnType<typeof jsxRuntime.jsx> => {
    const props: unknown = args[1];
    if (typeof props === "object" && props !== null && "children" in props) {
      capture(props.children);
    }
    return jsxRuntime.jsx(...args);
  };
  const harness = createHarness({
    controls,
    files,
    aliases: { "@/": file("apps/web/src") },
    convexApi: { api },
    packages: {
      react: React,
      "react/jsx-runtime": { ...jsxRuntime, jsx: traceJsx, jsxs: traceJsx },
      "convex/react": ConvexReact,
      "@gettitonline/shared": shared,
      "lucide-react": ui,
      "next/link": { __esModule: true, default: host("Link") },
      sonner: { toast: { success: () => undefined, error: () => undefined } },
    },
  });
  const page = harness.load(file("apps/web/src/app/(main)/checkout/page.tsx"))
    .default as React.ComponentType;
  const convex = createFakeConvexClient({
    [AVAILABILITY]: { paymentsEnabled: options.available ?? true },
    "cart:getCart": {
      subtotal: 900,
      itemCount: 1,
      items: [
        {
          _id: "cartItems|a",
          product: {
            _id: "products|p",
            title: "Untrusted preview",
            price: 900,
            images: [],
            weightKg: 0,
            categoryId: "categories|c",
          },
          quantity: 1,
        },
      ],
    },
    "cart:getCartBySeller": [
      {
        sellerId: "users|seller",
        sellerName: "Friendly Store",
        items: [],
        subtotal: 900,
      },
    ],
    "cart:validateCart": { isValid: true, issues: [] },
    "wallet:getWallet": { balance: 0.3 },
    "delivery:calculateDeliveryQuote": [],
    "delivery:listDeliveryMethods": [],
    [QUOTE]: { ok: true, quote: canonical },
  });
  const transport = async (
    ref: Parameters<typeof getFunctionName>[0],
    args: unknown,
  ): Promise<unknown> => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    if (implementations.has(name)) {
      return await implementations.get(name)?.(args);
    }
    if (name === PURCHASE) {
      throw new Error("response lost");
    }
    return null;
  };
  Object.assign(convex.client, {
    query: transport,
    mutation: transport,
    action: transport,
  });
  const watches: { name: string; args: unknown }[] = [];
  const watch = Reflect.get(convex.client, "watchQuery");
  assert.equal(typeof watch, "function");
  Object.assign(convex.client, {
    watchQuery(ref: Parameters<typeof getFunctionName>[0], args: unknown) {
      watches.push({ name: getFunctionName(ref), args });
      return Reflect.apply(watch, convex.client, [ref, args]);
    },
  });
  const mounted = mountUnderConvex(convex);
  const storage = memory();
  Reflect.set(window, "localStorage", storage);
  const Provider = options.actualGuest
    ? (harness.load(file("apps/web/src/providers/GuestCartProvider.tsx"))
        .GuestCartProvider as React.ComponentType<{ children?: ReactNode }>)
    : null;
  const render = async (): Promise<void> => {
    nodes.clear();
    inputs.clear();
    groups.clear();
    strings.length = 0;
    const element = createElement(page);
    await mounted.render(
      Provider ? createElement(Provider, null, element) : element,
    );
  };
  return {
    convex,
    mounted,
    calls,
    nodes,
    inputs,
    groups,
    strings,
    storage,
    guest,
    render,
    implementations,
    watches,
    setCountry: (country: string): void => {
      user = { ...user, address: { ...user.address, country } };
    },
  };
}

// These fail against the paused page through real React and convex/react: the canonical quote is never consumed,
// and a saved blank country is silently replaced with Zambia with no correction control.
test("real checkout exposes an editable missing country instead of inferring one", async () => {
  const rig = pageRig({ country: "" });
  try {
    await rig.render();
    assert.equal(rig.inputs.get("country")?.value, "");
    assert.equal(typeof rig.inputs.get("country")?.onChange, "function");
  } finally {
    await rig.mounted.unmount();
  }
});

test("real checkout reviews canonical cents before one wallet purchase; previews cannot authorize it", async () => {
  const rig = pageRig();
  try {
    await rig.render();
    const approve = [...rig.nodes]
      .filter(([text]) => text.includes("Approve"))
      .at(-1)?.[1];
    assert.ok(approve, "canonical quote needs explicit approval");
    await act(async () => {
      Reflect.apply(approve.onClick as () => void, undefined, []);
    });
    const pay = [...rig.nodes].find(([text]) =>
      text.includes("Pay K 0.30"),
    )?.[1];
    assert.ok(
      pay,
      "pay label uses 30 canonical cents, not preview K900 plus a local fee",
    );
    assert.equal(pay.disabled, false);
    await act(async () => {
      Reflect.apply(pay.onClick as () => void, undefined, []);
    });
    assert.equal(rig.calls.filter((call) => call.name === PURCHASE).length, 1);
    assert.equal(
      rig.calls.filter((call) => ![PURCHASE, STATUS].includes(call.name))
        .length,
      0,
    );
  } finally {
    await rig.mounted.unmount();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Options = import("./useWalletCheckout").WalletCheckoutOptions;
type Checkout = ReturnType<
  typeof import("./useWalletCheckout").useWalletCheckout
>;
const OWNER = "ada/users|ada";
const KEY = "@gettit/web-wallet-checkout/v1/ada%2Fusers%7Cada";
const RECORD = {
  version: 1,
  kind: "wallet_purchase",
  requestId: "checkout_retained",
};
const RAW = JSON.stringify(RECORD);
const success = (requestId = RECORD.requestId) => ({
  result: "found",
  operationId: "paymentOperations|one",
  requestId,
  requestIdentity: "server-owned",
  kind: "wallet_purchase",
  status: "succeeded",
  providerStatus: "not_applicable",
  application: "applied",
  accountingApplied: true,
  reviewNeeded: false,
  amountCents: 30,
  quoteKey: canonical.quoteKey,
  source: "cart",
  orderIds: ["orders|one"],
  feeCents: null,
});

function hookRig(
  extra: Partial<Options> = {},
  initialRaw?: string,
  strictRoot = false,
) {
  const storage = memory();
  if (initialRaw !== undefined) {
    storage.values.set(KEY, initialRaw);
  }
  let options: Options = {
    owner: OWNER,
    selectors: { source: "cart", shippingAddress: ADDRESS },
    cartIdentity: "cart-one",
    mergeReady: true,
    available: true,
    balance: 0.3,
    storage,
    ...extra,
  };
  const calls: { name: string; args: unknown }[] = [];
  const implementations = new Map<string, (args: unknown) => unknown>([
    [
      PURCHASE,
      () => {
        throw new Error("lost response");
      },
    ],
    [STATUS, () => null],
    [REFRESH, () => null],
  ]);
  const convex = createFakeConvexClient({
    [QUOTE]: { ok: true, quote: canonical },
  });
  const transport = async (
    ref: Parameters<typeof getFunctionName>[0],
    args: unknown,
  ): Promise<unknown> => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    const implementation = implementations.get(name);
    if (!implementation) {
      throw new Error(`Unexpected financial call ${name}`);
    }
    return await implementation(args);
  };
  Object.assign(convex.client, {
    query: transport,
    mutation: transport,
    action: transport,
  });
  const harness = createHarness({
    controls: createControls(),
    convexApi: { api },
    aliases: { "@/": file("apps/web/src") },
    packages: {
      react: React,
      "react/jsx-runtime": jsxRuntime,
      "convex/react": ConvexReact,
    },
  });
  const useCheckout = harness.load(
    file("apps/web/src/hooks/useWalletCheckout.ts"),
  ).useWalletCheckout as typeof import("./useWalletCheckout").useWalletCheckout;
  let latest: Checkout | undefined;
  const report = (value: Checkout): void => {
    latest = value;
  };
  const never = new Promise<void>(() => undefined);
  function Probe({
    value,
    suspend,
  }: {
    value: Options;
    suspend?: boolean;
  }): null {
    report(useCheckout(value));
    if (suspend) {
      throw never;
    }
    return null;
  }
  const mounted = mountUnderConvex(convex, { strictRoot });
  let activeClient = convex.client;
  const render = async (
    patch: Partial<Options> = {},
    suspend = false,
  ): Promise<void> => {
    options = { ...options, ...patch };
    await mounted.render(
      createElement(
        providers.ConvexProvider,
        { client: activeClient },
        createElement(
          React.Suspense,
          { fallback: null },
          createElement(Probe, { value: options, suspend }),
        ),
      ),
    );
  };
  const view = (): Checkout => {
    assert.ok(latest);
    return latest;
  };
  const approve = async (): Promise<void> => {
    await act(async () => {
      view().approve();
    });
  };
  const submit = async (): Promise<void> => {
    await act(async () => {
      await view().submit();
    });
  };
  const refresh = async (): Promise<void> => {
    await act(async () => {
      await view().refresh();
    });
  };
  return {
    convex,
    mounted,
    storage,
    calls,
    implementations,
    render,
    view,
    approve,
    submit,
    refresh,
    Probe,
    getOptions: () => options,
    setClient: (client: object): void => {
      activeClient = client;
    },
  };
}

test("duplicate captured submits claim once and persist only an opaque identity before SDK dispatch", async () => {
  const rig = hookRig();
  const result = deferred<unknown>();
  rig.implementations.set(PURCHASE, () => result.promise);
  try {
    await rig.render();
    await rig.approve();
    const submit = rig.view().submit;
    let first!: Promise<void>;
    await act(async () => {
      first = submit();
      void submit();
    });
    assert.equal(rig.calls.filter((call) => call.name === PURCHASE).length, 1);
    const purchase = rig.calls.find((call) => call.name === PURCHASE)?.args;
    assert.ok(
      typeof purchase === "object" &&
        purchase !== null &&
        "requestId" in purchase,
    );
    const raw = rig.storage.values.get(KEY);
    assert.ok(raw);
    const persisted: unknown = JSON.parse(raw);
    assert.deepEqual(persisted, {
      version: 1,
      kind: "wallet_purchase",
      requestId: purchase.requestId,
    });
    assert.deepEqual(Object.keys(purchase).sort(), [
      "expectedQuoteKey",
      "requestId",
      "shippingAddress",
      "source",
    ]);
    result.reject(new Error("network lost"));
    await act(async () => {
      await first;
    });
    assert.ok(rig.view().retained);
    assert.equal(rig.view().outcome, "held");
  } finally {
    await rig.mounted.unmount();
  }
});

for (const [label, patch] of [
  [
    "address",
    {
      selectors: {
        source: "cart",
        shippingAddress: { ...ADDRESS, street: "Another" },
      },
    },
  ],
  ["cart generation", { cartIdentity: "cart-two" }],
  ["guest pending", { mergeReady: false }],
  ["availability", { available: false }],
] satisfies [string, Partial<Options>][]) {
  test(`deferred persistence retires ${label} approval and never dispatches its captured submit`, async () => {
    const rig = hookRig();
    const saved = deferred<void>();
    rig.storage.setItem = (key, value) => {
      rig.storage.values.set(key, value);
      return saved.promise;
    };
    try {
      await rig.render();
      await rig.approve();
      let pending!: Promise<void>;
      await act(async () => {
        pending = rig.view().submit();
      });
      await rig.render(patch);
      await act(async () => {
        saved.resolve();
        await pending;
      });
      assert.equal(
        rig.calls.filter((call) => call.name === PURCHASE).length,
        0,
      );
      assert.equal(rig.storage.values.size, 1);
      assert.equal(rig.view().canSubmit, false);
    } finally {
      await rig.mounted.unmount();
    }
  });
}

test("equal-total quote changes require new approval; equivalent display projections preserve approval", async () => {
  const rig = hookRig();
  try {
    await rig.render();
    await rig.approve();
    const old = rig.view().submit;
    await act(async () => {
      rig.convex.deliver(QUOTE, {
        ok: true,
        quote: {
          ...canonical,
          lines: canonical.lines.map((line) => ({
            ...line,
            title: "New display name",
          })),
        },
      });
    });
    assert.equal(rig.view().approved, true);
    await act(async () => {
      rig.convex.deliver(QUOTE, {
        ok: true,
        quote: { ...canonical, quoteKey: "same-total-new-key" },
      });
    });
    assert.equal(rig.view().approved, false);
    await act(async () => {
      await old();
    });
    assert.equal(rig.calls.length, 0);
    await rig.approve();
    await rig.submit();
    assert.equal(rig.calls.filter((call) => call.name === PURCHASE).length, 1);
  } finally {
    await rig.mounted.unmount();
  }
});

for (const label of [
  "ABA",
  "access loss",
  "client replacement",
  "unmount",
] as const) {
  test(`${label} permanently retires a pending persistence owner and old callbacks`, async () => {
    const rig = hookRig({}, undefined, true);
    const saved = deferred<void>();
    rig.storage.setItem = (key, value) => {
      rig.storage.values.set(key, value);
      return saved.promise;
    };
    let unmounted = false;
    try {
      await rig.render();
      await rig.approve();
      const oldSubmit = rig.view().submit;
      let pending!: Promise<void>;
      await act(async () => {
        pending = oldSubmit();
      });
      if (label === "ABA") {
        await rig.render({ owner: "bea/users|bea" });
        await rig.render({ owner: OWNER });
      }
      if (label === "access loss") {
        await rig.render({ owner: null });
      }
      if (label === "unmount") {
        await rig.mounted.unmount();
        unmounted = true;
      }
      if (label === "client replacement") {
        const other = createFakeConvexClient({
          [QUOTE]: { ok: true, quote: canonical },
        });
        rig.setClient(other.client);
        await rig.render();
      }
      await act(async () => {
        saved.resolve();
        await pending;
        await oldSubmit();
      });
      assert.equal(
        rig.calls.filter((call) => call.name === PURCHASE).length,
        0,
      );
      assert.equal(rig.storage.values.get(KEY) !== undefined, true);
    } finally {
      if (!unmounted) {
        await rig.mounted.unmount();
      }
    }
  });
}

for (const [label, status] of [
  ["null", null],
  ["ambiguous", { result: "review", reason: "ambiguous_request" }],
  ["review before accounting history", { ...success(), reviewNeeded: true }],
  ["application review", { ...success(), application: "review" }],
  ["unknown", { ...success(), status: "unknown", application: "pending" }],
  [
    "pending",
    {
      ...success(),
      status: "reserved",
      application: "pending",
      accountingApplied: false,
    },
  ],
  ["unapplied accounting", { ...success(), accountingApplied: false }],
  ["no captured quote", { ...success(), quoteKey: null }],
  ["no captured orders", { ...success(), orderIds: [] }],
  ["failed plus applied", { ...success(), status: "failed" }],
  ["cancelled plus applied", { ...success(), status: "cancelled" }],
  ["foreign request", success("checkout_other")],
  ["wrong kind", { ...success(), kind: "top_up_collection" }],
  ["wrong source", { ...success(), source: "pending_orders" }],
] as const) {
  test(`remount ${label} proof retains the exact token and blocks new purchases even with payments OFF`, async () => {
    const rig = hookRig(
      {
        available: false,
        selectors: null,
        cartIdentity: "empty",
        mergeReady: false,
      },
      RAW,
    );
    rig.implementations.set(STATUS, () => status);
    rig.implementations.set(REFRESH, () => status);
    try {
      await rig.render();
      assert.equal(rig.storage.values.get(KEY), RAW);
      assert.equal(rig.view().canSubmit, false);
      assert.notEqual(rig.view().outcome, "success");
      await rig.refresh();
      assert.deepEqual(rig.calls, [
        { name: STATUS, args: { requestId: RECORD.requestId } },
        { name: REFRESH, args: { requestId: RECORD.requestId } },
      ]);
      assert.equal(rig.storage.values.get(KEY), RAW);
    } finally {
      await rig.mounted.unmount();
    }
  });
}

test("current matching terminal server proof retires an opaque reload record without reconstructing purchase args", async () => {
  const rig = hookRig({ available: false, selectors: null }, RAW);
  rig.implementations.set(STATUS, () => success());
  try {
    await rig.render();
    assert.equal(rig.view().outcome, "success");
    assert.equal(rig.storage.values.size, 0);
    assert.equal(rig.calls.filter((call) => call.name === PURCHASE).length, 0);
    assert.ok(
      rig.calls.every(
        (call) =>
          call.name === STATUS &&
          JSON.stringify(call.args) === '{"requestId":"checkout_retained"}',
      ),
    );
  } finally {
    await rig.mounted.unmount();
  }
});

test("a newer retained record arriving during terminal verification cannot be erased", async () => {
  const rig = hookRig({}, RAW);
  let reads = 0;
  const newer = JSON.stringify({ ...RECORD, requestId: "checkout_newer" });
  rig.implementations.set(STATUS, () => {
    reads++;
    if (reads === 2) {
      rig.storage.values.set(KEY, newer);
    }
    return success();
  });
  try {
    await rig.render();
    assert.equal(rig.storage.values.get(KEY), newer);
    assert.notEqual(rig.view().outcome, "success");
  } finally {
    await rig.mounted.unmount();
  }
});

for (const [label, after] of [
  ["null", null],
  ["review", { ...success(), reviewNeeded: true }],
] as const) {
  test(`proof changing to ${label} after deletion restores the SAME token and holds`, async () => {
    const rig = hookRig({}, RAW);
    let reads = 0;
    rig.implementations.set(STATUS, () => (++reads < 3 ? success() : after));
    try {
      await rig.render();
      assert.equal(rig.storage.values.get(KEY), RAW);
      assert.notEqual(rig.view().outcome, "success");
    } finally {
      await rig.mounted.unmount();
    }
  });
}

test("failed removal after native deletion restores the same retained token", async () => {
  const rig = hookRig({}, RAW);
  rig.implementations.set(STATUS, () => success());
  rig.storage.removeItem = (key) => {
    rig.storage.values.delete(key);
    throw new Error("host acknowledgement lost");
  };
  try {
    await rig.render();
    assert.equal(rig.storage.values.get(KEY), RAW);
    assert.notEqual(rig.view().outcome, "success");
  } finally {
    await rig.mounted.unmount();
  }
});

test("an initiation with a different quote cannot replace the approved quote authority", async () => {
  const rig = hookRig();
  rig.implementations.set(PURCHASE, (args) => {
    assert.ok(typeof args === "object" && args !== null && "requestId" in args);
    rig.implementations.set(STATUS, () => ({
      ...success(String(args.requestId)),
      quoteKey: "wrong-quote",
    }));
    return {
      ok: true,
      operationId: "paymentOperations|one",
      status: "succeeded",
      quoteKey: "wrong-quote",
      orderIds: ["orders|one"],
      requestIdentity: "server",
      totalAmountCents: 30,
      walletTransactionId: "walletTransactions|one",
    };
  });
  try {
    await rig.render();
    await rig.approve();
    await rig.submit();
    assert.notEqual(rig.view().outcome, "success");
    assert.equal(rig.storage.values.size, 1);
  } finally {
    await rig.mounted.unmount();
  }
});

for (const [label, value] of [
  ["blank country", { ...ADDRESS, country: " " }],
  ["blank phone", { ...ADDRESS, phone: " " }],
  ["blank street", { ...ADDRESS, street: "" }],
  ["blank city", { ...ADDRESS, city: "" }],
  ["blank province", { ...ADDRESS, province: "" }],
]) {
  test(`five-field address rejects ${label} before quote or approval`, async () => {
    assert.ok(typeof value === "object");
    const rig = hookRig({
      selectors: { source: "cart", shippingAddress: value },
    });
    try {
      await rig.render();
      await rig.approve();
      await rig.submit();
      assert.equal(rig.view().canSubmit, false);
      assert.equal(rig.calls.length, 0);
      assert.ok(!rig.convex.lifecycle.includes(`subscribe:${QUOTE}`));
    } finally {
      await rig.mounted.unmount();
    }
  });
}

for (const [label, balance, sufficient] of [
  ["exact 29 cents", 0.29, true],
  ["exact 57 cents", 0.57, true],
  ["one cent short", 0.28, false],
  ["third decimal", 0.291, false],
  ["unsafe", 90071992547409.92, false],
] as const) {
  test(`wallet sufficiency uses exact decimal cents: ${label}`, async () => {
    const rig = hookRig({ balance });
    try {
      await act(async () => {
        rig.convex.deliver(QUOTE, {
          ok: true,
          quote: { ...canonical, totalAmountCents: 29 },
        });
      });
      await rig.render();
      await rig.approve();
      assert.equal(rig.view().canSubmit, sufficient);
    } finally {
      await rig.mounted.unmount();
    }
  });
}

for (const raw of [
  "bad json",
  "{}",
  JSON.stringify({ ...RECORD, quoteKey: "must-not-persist" }),
  JSON.stringify({ ...RECORD, kind: "checkout_collection" }),
]) {
  test(`malformed retained record fails closed without overwriting it: ${raw}`, async () => {
    const rig = hookRig({}, raw);
    try {
      await rig.render();
      await rig.approve();
      await rig.submit();
      assert.equal(rig.calls.length, 0);
      assert.equal(rig.storage.values.get(KEY), raw);
      assert.equal(rig.view().canSubmit, false);
      assert.ok(rig.view().error);
    } finally {
      await rig.mounted.unmount();
    }
  });
}

for (const boundary of ["read", "write", "crypto"] as const) {
  test(`secure ${boundary} failure sends no purchase and remains blocked`, async () => {
    const rig = hookRig();
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "crypto",
    );
    try {
      if (boundary === "read") {
        rig.storage.getItem = () => {
          throw new Error("denied");
        };
      }
      await rig.render();
      await rig.approve();
      if (boundary === "write") {
        rig.storage.setItem = () => {
          throw new Error("quota");
        };
      }
      if (boundary === "crypto") {
        Object.defineProperty(globalThis, "crypto", {
          value: undefined,
          configurable: true,
        });
      }
      await rig.submit();
      assert.equal(
        rig.calls.filter((call) => call.name === PURCHASE).length,
        0,
      );
      assert.equal(rig.view().canSubmit, false);
      assert.ok(rig.view().error);
    } finally {
      if (cryptoDescriptor) {
        Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
      }
      await rig.mounted.unmount();
    }
  });
}

test("response loss remount looks up only the exact request and never repeats a purchase", async () => {
  const first = hookRig();
  await first.render();
  await first.approve();
  await first.submit();
  const raw = first.storage.values.get(KEY);
  assert.ok(raw);
  await first.mounted.unmount();
  const second = hookRig({}, raw);
  try {
    await second.render();
    await second.approve();
    await second.submit();
    const record: unknown = JSON.parse(raw);
    assert.ok(
      typeof record === "object" && record !== null && "requestId" in record,
    );
    assert.deepEqual(second.calls, [
      { name: STATUS, args: { requestId: record.requestId } },
    ]);
    assert.equal(second.storage.values.get(KEY), raw);
  } finally {
    await second.mounted.unmount();
  }
});

test("backend quote_mismatch retires only its token and requires explicit new approval at the changed key", async () => {
  const rig = hookRig();
  rig.implementations.set(PURCHASE, () => ({
    ok: false,
    code: "quote_mismatch",
    quote: { ...canonical, quoteKey: "new-key" },
  }));
  try {
    await rig.render();
    await rig.approve();
    await rig.submit();
    assert.equal(rig.view().quote?.quoteKey, "new-key");
    assert.equal(rig.view().approved, false);
    assert.equal(rig.storage.values.size, 0);
    await rig.submit();
    assert.equal(rig.calls.filter((call) => call.name === PURCHASE).length, 1);
    await rig.approve();
    assert.equal(rig.view().canSubmit, true);
    await rig.submit();
    assert.equal(rig.calls.filter((call) => call.name === PURCHASE).length, 2);
  } finally {
    await rig.mounted.unmount();
  }
});

test("access loss during deferred deletion restores the same opaque token and retires the old completion", async () => {
  const rig = hookRig({}, RAW);
  const removed = deferred<void>();
  rig.storage.removeItem = (key) => {
    rig.storage.values.delete(key);
    return removed.promise;
  };
  rig.implementations.set(STATUS, () => success());
  try {
    await rig.render();
    assert.equal(rig.storage.values.size, 0);
    await rig.render({ owner: null });
    await act(async () => {
      removed.resolve();
      await Promise.resolve();
    });
    assert.equal(rig.storage.values.get(KEY), RAW);
    assert.notEqual(rig.view().outcome, "success");
  } finally {
    await rig.mounted.unmount();
  }
});

test("suspended speculative render cannot publish selectors or retire committed approval", async () => {
  const rig = hookRig();
  try {
    await rig.render();
    await rig.approve();
    const committedSubmit = rig.view().submit;
    await act(async () => {
      React.startTransition(() => {
        void rig.render(
          {
            selectors: {
              source: "cart",
              shippingAddress: { ...ADDRESS, street: "Never committed" },
            },
          },
          true,
        );
      });
    });
    await act(async () => {
      await committedSubmit();
    });
    assert.equal(rig.calls.filter((call) => call.name === PURCHASE).length, 1);
    const sent = rig.calls.find((call) => call.name === PURCHASE)?.args;
    assert.ok(
      typeof sent === "object" && sent !== null && "shippingAddress" in sent,
    );
    assert.deepEqual(sent.shippingAddress, ADDRESS);
  } finally {
    await rig.mounted.unmount();
  }
});

test("real page retains recovery with OFF payments and an empty cart", async () => {
  const rig = pageRig({ available: false });
  rig.storage.values.set(KEY, RAW);
  await act(async () => {
    rig.convex.deliver("cart:getCart", {
      subtotal: 0,
      items: [],
      itemCount: 0,
    });
  });
  try {
    await rig.render();
    assert.ok(rig.strings.includes("Retained wallet checkout"));
    assert.ok(rig.strings.includes("Browse Products"));
    assert.deepEqual(rig.calls, [
      { name: STATUS, args: { requestId: RECORD.requestId } },
    ]);
  } finally {
    await rig.mounted.unmount();
  }
});

for (const state of ["hydrating", "merging", "pending", "failed"] as const) {
  test(`real page guest ${state} blocks approval and offers actionable state`, async () => {
    const rig = pageRig();
    if (state === "hydrating") {
      rig.guest.isHydrated = false;
    }
    if (state === "merging") {
      rig.guest.isMerging = true;
    }
    if (state === "pending") {
      rig.guest.hasPendingMerge = true;
    }
    if (state === "failed") {
      rig.guest.mergeFailed = true;
    }
    try {
      await rig.render();
      assert.ok(
        ![...rig.nodes.keys()].some((text) => text.includes("Approve")),
      );
      assert.equal(
        rig.calls.filter((call) => call.name === PURCHASE).length,
        0,
      );
      if (state === "failed") {
        assert.ok(rig.nodes.has("Reload to retry cart sync"));
      }
    } finally {
      await rig.mounted.unmount();
    }
  });
}

test("real delivery documents bind pickup zone/active point and method changes retire point approval", async () => {
  const rig = pageRig();
  const pickup = {
    _id: "deliveryMethods|pickup",
    isActive: true,
    zoneId: "deliveryZones|east",
    type: "pickup",
    name: "East pickup",
  };
  const standard = {
    _id: "deliveryMethods|standard",
    isActive: true,
    type: "standard",
    name: "Courier",
  };
  await act(async () => {
    rig.convex.deliver("delivery:listDeliveryMethods", [pickup, standard]);
    rig.convex.deliver("delivery:calculateDeliveryQuote", [
      { methodId: pickup._id, name: pickup.name, type: "pickup" },
      { methodId: standard._id, name: standard.name, type: "standard" },
    ]);
    rig.convex.deliver("delivery:listPickupPoints", [
      {
        _id: "pickupPoints|active",
        zoneId: "deliveryZones|east",
        name: "Active counter",
        isActive: true,
      },
      { _id: "pickupPoints|inactive", name: "Closed counter", isActive: false },
    ]);
  });
  try {
    await rig.render();
    const methods = rig.groups.get("Delivery method");
    assert.ok(methods);
    await act(async () => {
      Reflect.apply(
        methods.onValueChange as (value: string) => void,
        undefined,
        [pickup._id],
      );
    });
    assert.ok(
      rig.watches.some(
        (call) =>
          call.name === "delivery:listPickupPoints" &&
          JSON.stringify(call.args) === '{"zoneId":"deliveryZones|east"}',
      ),
    );
    assert.ok(
      rig.watches
        .filter((call) => call.name === "delivery:calculateDeliveryQuote")
        .every((call) => !Object.keys(call.args as object).includes("zoneId")),
    );
    const points = rig.groups.get("Pickup point");
    assert.ok(points);
    assert.equal(points.value, "");
    assert.ok(!rig.strings.includes("Closed counter"));
    await act(async () => {
      Reflect.apply(
        points.onValueChange as (value: string) => void,
        undefined,
        ["pickupPoints|inactive"],
      );
    });
    assert.ok(
      [...rig.nodes].filter(([text]) => text.includes("Approve")).at(-1)?.[1]
        .disabled,
    );
    await act(async () => {
      Reflect.apply(
        points.onValueChange as (value: string) => void,
        undefined,
        ["pickupPoints|active"],
      );
    });
    await act(async () => {
      rig.convex.deliver(QUOTE, {
        ok: true,
        quote: {
          ...canonical,
          quoteKey: "pickup-quote",
          delivery: {
            name: pickup.name,
            code: "PICKUP",
            methodType: "pickup",
            methodId: pickup._id,
            pickupPointId: "pickupPoints|active",
          },
        },
      });
    });
    assert.ok(
      rig.watches.some(
        (call) =>
          call.name === QUOTE &&
          JSON.stringify(call.args).includes(
            '"pickupPointId":"pickupPoints|active"',
          ) &&
          JSON.stringify(call.args).includes(
            '"deliveryMethodId":"deliveryMethods|pickup"',
          ),
      ),
    );
    const approve = [...rig.nodes]
      .filter(([text]) => text.includes("Approve"))
      .at(-1)?.[1];
    assert.ok(approve);
    await act(async () => {
      Reflect.apply(approve.onClick as () => void, undefined, []);
    });
    const oldPay = [...rig.nodes].find(([text]) => text.includes("Pay K"))?.[1];
    assert.ok(oldPay);
    await act(async () => {
      Reflect.apply(
        methods.onValueChange as (value: string) => void,
        undefined,
        [standard._id],
      );
    });
    await act(async () => {
      Reflect.apply(oldPay.onClick as () => void, undefined, []);
    });
    assert.equal(rig.calls.filter((call) => call.name === PURCHASE).length, 0);
    await act(async () => {
      Reflect.apply(
        methods.onValueChange as (value: string) => void,
        undefined,
        [pickup._id],
      );
    });
    assert.equal(rig.groups.get("Pickup point")?.value, "");
  } finally {
    await rig.mounted.unmount();
  }
});

function backendFixture() {
  const user = (id: string): Row => ({
    _id: `users|${id}`,
    clerkId: id,
    role: "user",
    isBanned: false,
    email: `${id}@example.invalid`,
    firstName: id,
    lastName: "Fixture",
    isVerified: true,
    totalSales: 0,
    totalPurchases: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  const product = (id: string, seller: string): Row => ({
    _id: `products|${id}`,
    sellerId: `users|${seller}`,
    title: id,
    description: "Fixture",
    price: 100,
    images: [],
    condition: "good",
    status: "active",
    quantity: 10,
    categoryId: "categories|one",
    shippingOptions: [{ name: "Free", price: 0 }],
    views: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  const lamp = product("lamp", "seller");
  lamp.variantCombinations = [
    {
      id: "red",
      sku: "RED",
      attributes: [{ name: "Color", value: "Red" }],
      price: 120,
      stock: 5,
      status: "active",
    },
    {
      id: "blue",
      sku: "BLUE",
      attributes: [{ name: "Color", value: "Blue" }],
      price: 130,
      stock: 5,
      status: "active",
    },
  ];
  lamp.addOns = [{ name: "Gift wrap", price: 5, isRequired: false }];
  const line = (id: string, variant: string): Row => ({
    _id: `cartItems|${id}`,
    userId: "users|buyer",
    productId: "products|lamp",
    quantity: 1,
    selectedShipping: { name: "Free", price: 999 },
    selectedVariant: {
      variantId: variant,
      sku: variant.toUpperCase(),
      attributes: [{ name: "Color", value: variant }],
      price: 1,
    },
    selectedAddOns: [{ name: "Gift wrap", price: 999 }],
    createdAt: 1,
    updatedAt: 1,
  });
  return createDb({
    users: [user("buyer"), user("seller"), user("second")],
    vendorProfiles: ["seller", "second"].map((id) => ({
      _id: `vendorProfiles|${id}`,
      ownerUserId: `users|${id}`,
      status: "approved",
      storeName: id,
      slug: id,
    })),
    platformSettings: [
      {
        _id: "platformSettings|one",
        key: "singleton",
        companySellerUserId: "users|company",
        companyDisplayName: "Marketplace",
      },
    ],
    appConfig: [
      {
        _id: "appConfig|one",
        key: "singleton",
        paymentsEnabled: true,
        minimumBuilds: { ios: 1, android: 1 },
        updatedAt: 1,
      },
    ],
    products: [lamp, product("cap", "second")],
    wallets: [
      {
        _id: "wallets|buyer",
        userId: "users|buyer",
        balance: 378,
        pendingBalance: 0,
        totalEarned: 0,
        totalSpent: 0,
        totalWithdrawn: 0,
        isActive: true,
        isFrozen: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    cartItems: [
      line("red", "red"),
      line("blue", "blue"),
      {
        _id: "cartItems|cap",
        userId: "users|buyer",
        productId: "products|cap",
        quantity: 1,
        selectedShipping: { name: "Free", price: 0 },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    deliveryZones: [],
    deliveryMethods: [],
    pickupPoints: [],
    promoCodes: [],
    promoCodeRedemptions: [],
    loyaltyAccounts: [],
    loyaltyTransactions: [],
    orders: [],
    escrow: [],
    transactions: [],
    walletTransactions: [],
    paymentOperations: [],
    paymentAccounts: [],
    notifications: [],
    behaviorEvents: [],
  });
}

test("actual hook → registered quote/purchase/status conserves canonical multi-seller custom lines in one debit and never clears newer cart rows", async () => {
  const db = backendFixture();
  const selectors = { source: "cart", shippingAddress: ADDRESS };
  const quoted = await invokeFakeFunction(
    quoteModule.quoteCheckout,
    createCtx(db, "buyer"),
    selectors,
  );
  const rig = hookRig({ owner: "buyer/users|buyer", balance: 378 });
  await act(async () => {
    rig.convex.deliver(QUOTE, quoted);
  });
  rig.implementations.set(PURCHASE, async (args) => {
    const result = await invokeFakeFunction(
      purchaseModule.purchaseWithWallet,
      createCtx(db, "buyer"),
      args,
    );
    db.tables.cartItems.push({
      _id: "cartItems|newer",
      userId: "users|buyer",
      productId: "products|cap",
      quantity: 1,
      selectedShipping: { name: "Free", price: 0 },
      createdAt: 2,
      updatedAt: 2,
    });
    return result;
  });
  rig.implementations.set(STATUS, (args) =>
    invokeFakeFunction(statusModule.getStatus, createCtx(db, "buyer"), args),
  );
  try {
    await rig.render();
    assert.equal(rig.view().quote?.lines.length, 3);
    assert.equal(rig.view().quote?.sellers.length, 2);
    assert.deepEqual(
      rig
        .view()
        .quote?.lines.filter((line) => line.title === "lamp")
        .map((line) => line.unitCents)
        .sort(),
      [12500, 13500],
    );
    assert.equal(rig.view().quote?.totalAmountCents, 37800);
    await rig.approve();
    await rig.submit();
    assert.equal(db.tables.paymentOperations.length, 1);
    assert.equal(db.tables.orders.length, 2);
    assert.equal(db.tables.wallets[0].balance, 0);
    assert.equal(
      db.tables.walletTransactions.filter(
        (row) => row.type === "debit" && row.source === "purchase",
      ).length,
      1,
    );
    assert.deepEqual(
      db.tables.cartItems.map((row) => row._id),
      ["cartItems|newer"],
    );
    assert.equal(rig.calls.filter((call) => call.name === PURCHASE).length, 1);
    assert.ok(
      rig.calls.every((call) => [PURCHASE, STATUS].includes(call.name)),
    );
    assert.equal(rig.view().outcome, "success");
    assert.equal(rig.storage.values.size, 0);
  } finally {
    await rig.mounted.unmount();
  }
});

for (const outcome of ["success", "failure"] as const) {
  test(`actual deferred GuestCartProvider ${outcome} gates the page and never approves a pre-merge subset`, async () => {
    const rig = pageRig({ actualGuest: true });
    const merge = deferred<unknown>();
    const MERGE = getFunctionName(api.cart.mergeGuestCart);
    rig.implementations.set(MERGE, () => merge.promise);
    rig.storage.values.set(
      shared.GETTITONLINE_GUEST_CART_STORAGE_KEY,
      JSON.stringify([
        {
          productId: "products|guest",
          quantity: 2,
          selectedShipping: { name: "Free", price: 0 },
          addedAt: 1,
          product: {
            _id: "products|guest",
            sellerId: "users|seller",
            sellerName: "Friendly Store",
            title: "Guest lamp",
            price: 10,
            images: [],
            quantity: 5,
            status: "active",
            shippingOptions: [{ name: "Free", price: 0, estimatedDays: "3" }],
          },
        },
      ]),
    );
    try {
      await rig.render();
      assert.equal(rig.calls.filter((call) => call.name === MERGE).length, 1);
      assert.ok(
        ![...rig.nodes.keys()].some((text) => text.includes("Approve")),
      );
      assert.equal(
        rig.calls.filter((call) => call.name === PURCHASE).length,
        0,
      );
      if (outcome === "success") {
        await act(async () => {
          rig.convex.deliver("wallet:getWallet", { balance: 0.91 });
          rig.convex.deliver(QUOTE, {
            ok: true,
            quote: {
              ...canonical,
              quoteKey: "merged-cart",
              subtotalCents: 87,
              discountedSubtotalCents: 87,
              sellerPayoutCents: 87,
              platformFeeCents: 4,
              totalAmountCents: 91,
              sellers: [
                {
                  ...canonical.sellers[0],
                  subtotalCents: 87,
                  discountedSubtotalCents: 87,
                  sellerPayoutCents: 87,
                  platformFeeCents: 4,
                  totalAmountCents: 91,
                },
              ],
              cartItemIds: ["cartItems|a", "cartItems|guest"],
              lines: [
                ...canonical.lines,
                {
                  ...canonical.lines[0],
                  cartItemId: "cartItems|guest",
                  title: "Merged guest lamp",
                  customizationKey: "guest",
                  quantity: 2,
                  lineTotalCents: 58,
                },
              ],
            },
          });
          merge.resolve({ mergedCount: 2, skipped: [] });
        });
        assert.equal(
          rig.storage.values.has(shared.GETTITONLINE_GUEST_CART_STORAGE_KEY),
          false,
        );
        const approve = [...rig.nodes]
          .filter(([text]) => text.includes("Approve"))
          .at(-1)?.[1];
        assert.ok(approve);
        assert.equal(approve.disabled, false);
        const place = rig.nodes.get("Place Order");
        assert.ok(place);
        assert.equal(place.disabled, true);
        assert.ok(rig.strings.includes("Merged guest lamp"));
        await act(async () => {
          Reflect.apply(approve.onClick as () => void, undefined, []);
        });
        const pay = rig.nodes.get("Pay K 0.91");
        assert.ok(pay);
        assert.equal(pay.disabled, false);
      } else {
        await act(async () => {
          merge.reject(new Error("merge failed"));
        });
        assert.ok(rig.nodes.has("Reload to retry cart sync"));
        assert.ok(
          ![...rig.nodes.keys()].some((text) => text.includes("Approve")),
        );
        assert.equal(
          rig.storage.values.has(shared.GETTITONLINE_GUEST_CART_STORAGE_KEY),
          true,
        );
      }
      assert.equal(
        rig.calls.filter((call) => call.name === PURCHASE).length,
        0,
      );
    } finally {
      await rig.mounted.unmount();
    }
  });
}

for (const retirement of ["draft", "address", "cart"] as const) {
  for (const completion of ["success", "error"] as const) {
    test(`same-owner promo ${completion} is retired by ${retirement} change`, async () => {
      const rig = pageRig();
      const pending = deferred<unknown>();
      rig.implementations.set(
        getFunctionName(api.promotions.validatePromoCode),
        () => pending.promise,
      );
      try {
        await rig.render();
        const change = rig.inputs.get("promoCode")?.onChange;
        assert.equal(typeof change, "function");
        await act(async () => {
          Reflect.apply(change as (event: unknown) => void, undefined, [
            { target: { value: "OLD" } },
          ]);
        });
        const apply = rig.nodes.get("Apply");
        assert.ok(apply);
        await act(async () => {
          Reflect.apply(apply.onClick as () => void, undefined, []);
        });
        if (retirement === "draft") {
          await act(async () => {
            Reflect.apply(change as (event: unknown) => void, undefined, [
              { target: { value: "NEW" } },
            ]);
          });
        }
        if (retirement === "address") {
          await act(async () => {
            Reflect.apply(
              rig.inputs.get("street")?.onChange as (event: unknown) => void,
              undefined,
              [{ target: { value: "New street" } }],
            );
          });
        }
        if (retirement === "cart") {
          await act(async () => {
            rig.convex.deliver("cart:getCart", {
              subtotal: 900,
              itemCount: 2,
              items: [
                {
                  _id: "cartItems|a",
                  product: {
                    _id: "products|p",
                    price: 900,
                    images: [],
                    weightKg: 0,
                    categoryId: "categories|c",
                  },
                  quantity: 2,
                },
              ],
            });
          });
        }
        await act(async () => {
          if (completion === "success") {
            pending.resolve({
              valid: true,
              code: "OLD",
              title: "Old promo success",
              promoCodeId: "promoCodes|old",
              discountAmount: 5,
            });
          } else {
            pending.reject(new Error("Old promo error"));
          }
        });
        assert.ok(!rig.strings.includes("Old promo success"));
        assert.ok(!rig.strings.includes("Failed to apply promo code"));
        if (retirement === "draft") {
          assert.equal(rig.inputs.get("promoCode")?.value, "NEW");
        }
        assert.equal(
          rig.calls.filter((call) => call.name === PURCHASE).length,
          0,
        );
      } finally {
        await rig.mounted.unmount();
      }
    });
  }
}

test("equivalent profile rerenders preserve the edited country and explicit address choice", async () => {
  const rig = pageRig();
  try {
    await rig.render();
    await act(async () => {
      Reflect.apply(
        rig.inputs.get("country")?.onChange as (event: unknown) => void,
        undefined,
        [{ target: { value: "Edited country" } }],
      );
    });
    rig.setCountry("Zambia");
    await rig.render();
    assert.equal(rig.inputs.get("country")?.value, "Edited country");
  } finally {
    await rig.mounted.unmount();
  }
});

test("status errors retain owned identity and an explicit refresh error cannot authorize a new purchase", async () => {
  const rig = hookRig({}, RAW);
  rig.implementations.set(STATUS, () => {
    throw new Error("not visible");
  });
  rig.implementations.set(REFRESH, () => {
    throw new Error("unavailable");
  });
  try {
    await rig.render();
    await rig.refresh();
    await rig.approve();
    await rig.submit();
    assert.equal(rig.storage.values.get(KEY), RAW);
    assert.equal(rig.view().outcome, "held");
    assert.ok(rig.view().error);
    assert.ok(rig.calls.every((call) => [STATUS, REFRESH].includes(call.name)));
  } finally {
    await rig.mounted.unmount();
  }
});

test("same-context proof must match the captured operation and complete order set", async () => {
  const rig = hookRig();
  rig.implementations.set(PURCHASE, (args) => {
    assert.ok(typeof args === "object" && args !== null && "requestId" in args);
    rig.implementations.set(STATUS, () => ({
      ...success(String(args.requestId)),
      orderIds: ["orders|different"],
    }));
    return {
      ok: true,
      operationId: "paymentOperations|one",
      status: "succeeded",
      quoteKey: canonical.quoteKey,
      orderIds: ["orders|one"],
      requestIdentity: "server",
      totalAmountCents: 30,
      walletTransactionId: "walletTransactions|one",
    };
  });
  try {
    await rig.render();
    await rig.approve();
    await rig.submit();
    assert.notEqual(rig.view().outcome, "success");
    assert.equal(rig.storage.values.size, 1);
  } finally {
    await rig.mounted.unmount();
  }
});

test("a late old status finally cannot release a newer owner work claim", async () => {
  const rig = hookRig({}, RAW);
  const oldStatus = deferred<unknown>();
  rig.implementations.set(STATUS, () => oldStatus.promise);
  const purchase = deferred<unknown>();
  rig.implementations.set(PURCHASE, () => purchase.promise);
  try {
    await rig.render();
    await rig.render({ owner: "bea/users|bea" });
    await rig.approve();
    let pending!: Promise<void>;
    await act(async () => {
      pending = rig.view().submit();
    });
    assert.equal(rig.view().busy, true);
    await act(async () => {
      oldStatus.resolve(success());
      await Promise.resolve();
    });
    assert.equal(rig.view().busy, true);
    assert.equal(rig.storage.values.get(KEY), RAW);
    await act(async () => {
      await rig.view().submit();
    });
    assert.equal(rig.calls.filter((call) => call.name === PURCHASE).length, 1);
    await act(async () => {
      purchase.reject(new Error("response lost"));
      await pending;
    });
    assert.equal(rig.view().busy, false);
  } finally {
    await rig.mounted.unmount();
  }
});

test("canonical page preserves repeated customized lines and joins readable sellers by canonical ID", async () => {
  const rig = pageRig();
  await act(async () => {
    rig.convex.deliver(QUOTE, {
      ok: true,
      quote: {
        ...canonical,
        subtotalCents: 94,
        discountedSubtotalCents: 94,
        sellerPayoutCents: 94,
        shippingCents: 10,
        platformFeeCents: 5,
        totalAmountCents: 109,
        cartItemIds: ["cartItems|a", "cartItems|b", "cartItems|c"],
        lines: [
          {
            ...canonical.lines[0],
            title: "Red lamp",
            unitCents: 36,
            lineTotalCents: 36,
            optionPairs: [{ name: "Size", value: "Large", deltaCents: 2 }],
            addOns: [{ name: "Gift wrap", priceCents: 5 }],
            fallbackShipping: { name: "Courier", priceCents: 10 },
          },
          {
            ...canonical.lines[0],
            cartItemId: "cartItems|b",
            customizationKey: "blue",
            title: "Blue lamp",
          },
          {
            ...canonical.lines[0],
            sellerId: "users|unknown",
            cartItemId: "cartItems|c",
            title: "Second seller item",
          },
        ],
        sellers: [
          {
            ...canonical.sellers[0],
            subtotalCents: 65,
            discountedSubtotalCents: 65,
            sellerPayoutCents: 65,
            shippingCents: 10,
            platformFeeCents: 3,
            totalAmountCents: 78,
          },
          {
            ...canonical.sellers[0],
            sellerId: "users|unknown",
            platformFeeCents: 2,
            totalAmountCents: 31,
          },
        ],
      },
    });
  });
  try {
    await rig.render();
    for (const text of [
      "Friendly Store",
      "Seller",
      "Red lamp",
      "Blue lamp",
      "Second seller item",
      "Gift wrap",
      "Large",
      "Courier",
    ]) {
      assert.ok(rig.strings.includes(text), text);
    }
    assert.ok(!rig.strings.includes("users|unknown"));
    assert.ok(!rig.strings.includes("Untrusted preview"));
  } finally {
    await rig.mounted.unmount();
  }
});

test("an identity arriving during the pre-persistence read is never overwritten or charged", async () => {
  const rig = hookRig();
  const read = deferred<string | null>();
  const nativeRead = rig.storage.getItem;
  let delayed = false;
  try {
    await rig.render();
    await rig.approve();
    rig.storage.getItem = (key) => {
      if (!delayed) {
        delayed = true;
        return read.promise;
      }
      return nativeRead(key);
    };
    let pending!: Promise<void>;
    await act(async () => {
      pending = rig.view().submit();
    });
    rig.storage.values.set(KEY, RAW);
    await act(async () => {
      read.resolve(null);
      await pending;
    });
    assert.equal(rig.storage.values.get(KEY), RAW);
    assert.equal(rig.calls.filter((call) => call.name === PURCHASE).length, 0);
  } finally {
    await rig.mounted.unmount();
  }
});

test("OFF then ON cannot revive a captured previously approved submit callback", async () => {
  const rig = hookRig();
  try {
    await rig.render();
    await rig.approve();
    const old = rig.view().submit;
    await rig.render({ available: false });
    await rig.render({ available: true });
    await act(async () => {
      await old();
    });
    assert.equal(rig.view().approved, false);
    assert.equal(rig.calls.length, 0);
    await rig.approve();
    await rig.submit();
    assert.equal(rig.calls.filter((call) => call.name === PURCHASE).length, 1);
  } finally {
    await rig.mounted.unmount();
  }
});

test("native deletion compares the exact token synchronously after the last awaited read", async () => {
  const native = memory();
  native.values.set(KEY, RAW);
  const rig = hookRig({ storage: browserCheckoutStorage });
  Reflect.set(window, "localStorage", native);
  const newer = JSON.stringify({
    ...RECORD,
    requestId: "checkout_newer_native",
  });
  let reads = 0;
  native.getItem = (key) => {
    const value = native.values.get(key) ?? null;
    if (++reads === 3) {
      queueMicrotask(() => native.values.set(KEY, newer));
    }
    return value;
  };
  rig.implementations.set(STATUS, () => success());
  try {
    await rig.render();
    assert.equal(native.values.get(KEY), newer);
    assert.notEqual(rig.view().outcome, "success");
  } finally {
    await rig.mounted.unmount();
  }
});

test("pickup discovery uses an empty public selector when the genuine method has no zone", async () => {
  const rig = pageRig();
  await act(async () => {
    rig.convex.deliver("delivery:listDeliveryMethods", [
      {
        _id: "deliveryMethods|global",
        name: "Global pickup",
        type: "pickup",
        isActive: true,
      },
    ]);
    rig.convex.deliver("delivery:calculateDeliveryQuote", [
      {
        methodId: "deliveryMethods|global",
        name: "Global pickup",
        type: "pickup",
      },
    ]);
    rig.convex.deliver("delivery:listPickupPoints", []);
  });
  try {
    await rig.render();
    const method = rig.groups.get("Delivery method");
    assert.ok(method);
    await act(async () => {
      Reflect.apply(
        method.onValueChange as (value: string) => void,
        undefined,
        ["deliveryMethods|global"],
      );
    });
    assert.ok(
      rig.watches.some(
        (call) =>
          call.name === "delivery:listPickupPoints" &&
          JSON.stringify(call.args) === "{}",
      ),
    );
    const approval = [...rig.nodes]
      .filter(([text]) => text.includes("Approve"))
      .at(-1)?.[1];
    assert.equal(approval?.disabled, true);
    assert.equal(rig.calls.filter((call) => call.name === PURCHASE).length, 0);
  } finally {
    await rig.mounted.unmount();
  }
});

for (const transition of ["ABA", "remount"] as const) {
  test(`${transition} during deferred record retirement keeps the same local identity held before the old clear acknowledges`, async () => {
    const rig = hookRig({}, RAW);
    const removed = deferred<void>();
    rig.storage.removeItem = (key) => {
      rig.storage.values.delete(key);
      return removed.promise;
    };
    rig.implementations.set(STATUS, () => success());
    rig.implementations.set(REFRESH, () => success());
    try {
      await rig.render();
      if (transition === "ABA") {
        await rig.render({ owner: "bea/users|bea" });
        await rig.render({ owner: OWNER });
      } else {
        await rig.mounted.render(null);
        await rig.render();
      }
      assert.equal(rig.view().retained?.record.requestId, RECORD.requestId);
      assert.equal(rig.view().canApprove, false);
      await rig.approve();
      await rig.submit();
      assert.equal(
        rig.calls.filter((call) => call.name === PURCHASE).length,
        0,
      );
      await act(async () => {
        removed.resolve();
        await Promise.resolve();
      });
      assert.equal(rig.storage.values.get(KEY), RAW);
      assert.notEqual(rig.view().outcome, "success");
      await rig.refresh();
      assert.equal(rig.view().outcome, "success");
      assert.equal(rig.storage.values.size, 0);
    } finally {
      await rig.mounted.unmount();
    }
  });
}

// These cases catch lost compensation holds and holds that cannot be retired by current foreground work.
// The next distinct cart is genuinely quoted/funded; storage and transport are the controlled boundaries.
for (const [transition, changedProof, failure] of [
  ["remount", "review", "write"],
  ["ABA", "null", "read"],
  ["remount", "unknown", "unconfirmed write"],
  ["ABA", "error", "write"],
] as const) {
  test(`failed native compensation (${failure}, ${changedProof}) retains identity through ${transition} and explicit recovery`, async () => {
    const db = backendFixture();
    db.tables.wallets[0].balance = 483;
    const selectors = { source: "cart", shippingAddress: ADDRESS };
    const quoted = await invokeFakeFunction(
      quoteModule.quoteCheckout,
      createCtx(db, "buyer"),
      selectors,
    );
    assert.ok(
      typeof quoted === "object" &&
        quoted !== null &&
        "ok" in quoted &&
        quoted.ok === true &&
        "quote" in quoted &&
        typeof quoted.quote === "object" &&
        quoted.quote !== null &&
        "quoteKey" in quoted.quote &&
        typeof quoted.quote.quoteKey === "string",
    );
    await invokeFakeFunction(
      purchaseModule.purchaseWithWallet,
      createCtx(db, "buyer"),
      {
        ...selectors,
        requestId: RECORD.requestId,
        expectedQuoteKey: quoted.quote.quoteKey,
      },
    );
    const funding = [...db.tables.walletTransactions];
    db.tables.cartItems.push({
      _id: "cartItems|next",
      userId: "users|buyer",
      productId: "products|cap",
      quantity: 1,
      selectedShipping: { name: "Free", price: 0 },
      createdAt: 2,
      updatedAt: 2,
    });
    const next = await invokeFakeFunction(
      quoteModule.quoteCheckout,
      createCtx(db, "buyer"),
      selectors,
    );
    assert.ok(
      typeof next === "object" &&
        next !== null &&
        "ok" in next &&
        next.ok === true &&
        "quote" in next &&
        typeof next.quote === "object" &&
        next.quote !== null &&
        "totalAmountCents" in next.quote,
    );
    assert.equal(next.quote.totalAmountCents, 10500);
    assert.equal(db.tables.wallets[0].balance, 105);

    const native = memory();
    const key = "@gettit/web-wallet-checkout/v1/buyer%2Fusers%7Cbuyer";
    native.values.set(key, RAW);
    const rig = hookRig({
      owner: "buyer/users|buyer",
      balance: 105,
      storage: browserCheckoutStorage,
    });
    Reflect.set(window, "localStorage", native);
    rig.convex.deliver(QUOTE, next);
    rig.implementations.set(PURCHASE, (args) =>
      invokeFakeFunction(
        purchaseModule.purchaseWithWallet,
        createCtx(db, "buyer"),
        args,
      ),
    );
    let reads = 0;
    let recovered = false;
    const status = async (args: unknown) => {
      if (++reads >= 3 && !recovered) {
        if (changedProof === "review") {
          // Evidence fault and later restoration are strictly in-memory fixture operations.
          db.tables.walletTransactions.splice(0);
        } else if (changedProof === "null") {
          return null;
        } else if (changedProof === "error") {
          throw new Error("status unavailable");
        } else {
          const original = await invokeFakeFunction(
            statusModule.getStatus,
            createCtx(db, "buyer"),
            args,
          );
          assert.ok(
            typeof original === "object" &&
              original !== null &&
              "result" in original &&
              original.result === "found",
          );
          return {
            ...original,
            status: "unknown",
            application: "pending",
            accountingApplied: false,
          };
        }
      }
      return await invokeFakeFunction(
        statusModule.getStatus,
        createCtx(db, "buyer"),
        args,
      );
    };
    rig.implementations.set(STATUS, status);
    rig.implementations.set(REFRESH, status);
    const compensation = deferred<void>();
    let denied = true;
    native.getItem = (name) => {
      if (failure === "read" && denied && !native.values.has(key)) {
        compensation.resolve();
        throw new Error("native read denied");
      }
      return native.values.get(name) ?? null;
    };
    native.setItem = (name, value) => {
      compensation.resolve();
      if (denied) {
        if (failure === "unconfirmed write") {
          return;
        }
        throw new Error("native write denied");
      }
      native.values.set(name, value);
    };
    try {
      await rig.render();
      await act(async () => {
        await compensation.promise;
      });
      assert.equal(reads, 3);
      assert.equal(native.values.has(key), false);
      assert.equal(rig.view().retained?.record.requestId, RECORD.requestId);
      assert.notEqual(rig.view().outcome, "success");
      if (transition === "ABA") {
        await rig.render({ owner: "bea/users|bea" });
        await rig.render({ owner: "buyer/users|buyer" });
      } else {
        await rig.mounted.render(null);
        await rig.render();
      }
      assert.equal(rig.view().retained?.record.requestId, RECORD.requestId);
      assert.equal(rig.view().canApprove, false);
      await rig.approve();
      await rig.submit();
      await rig.refresh();
      assert.equal(rig.view().retained?.record.requestId, RECORD.requestId);
      assert.notEqual(rig.view().outcome, "success");

      // Even current success cannot forget an absent token while host confirmation still fails.
      recovered = true;
      db.tables.walletTransactions.splice(
        0,
        db.tables.walletTransactions.length,
        ...funding,
      );
      await rig.refresh();
      assert.equal(rig.view().retained?.record.requestId, RECORD.requestId);
      assert.notEqual(rig.view().outcome, "success");
      assert.equal(rig.view().canApprove, false);
      assert.ok(rig.view().error);
      assert.equal(db.tables.paymentOperations.length, 1);
      assert.equal(db.tables.wallets[0].balance, 105);
      assert.equal(
        rig.calls.filter((call) => call.name === PURCHASE).length,
        0,
      );

      denied = false;
      await rig.refresh();
      assert.equal(rig.view().outcome, "success");
      assert.equal(rig.view().retained, null);
      assert.equal(native.values.has(key), false);
      assert.equal(rig.view().canApprove, true);
      assert.equal(rig.view().canSubmit, false);
      assert.ok(
        rig.calls.every(
          (call) =>
            [STATUS, REFRESH].includes(call.name) &&
            JSON.stringify(call.args) === '{"requestId":"checkout_retained"}',
        ),
      );
      assert.equal(
        rig.calls.filter((call) => call.name === PURCHASE).length,
        0,
      );
    } finally {
      await rig.mounted.unmount();
    }
  });
}

test("an old deferred compensation cannot release the hold or overwrite a newer raw identity", async () => {
  const native = memory();
  native.values.set(KEY, RAW);
  const written = deferred<void>();
  const acknowledged = deferred<void>();
  const storage: CheckoutStorage = {
    ...browserCheckoutStorage,
    setItem: (key, raw) => {
      browserCheckoutStorage.setItem(key, raw);
      written.resolve();
      return acknowledged.promise;
    },
  };
  const rig = hookRig({ storage });
  Reflect.set(window, "localStorage", native);
  let reads = 0;
  rig.implementations.set(STATUS, () => (++reads < 3 ? success() : null));
  rig.implementations.set(REFRESH, () => success());
  const newer = JSON.stringify({
    ...RECORD,
    requestId: "checkout_newer_compensation",
  });
  try {
    await rig.render();
    await act(async () => {
      await written.promise;
    });
    await rig.mounted.render(null);
    await rig.render();
    // The prior native write has applied, but its acknowledgement is still in flight.
    const removalCount = rig.calls.filter(
      (call) => call.name === STATUS,
    ).length;
    await rig.refresh();
    assert.equal(native.values.get(KEY), RAW);
    assert.equal(
      rig.calls.filter((call) => call.name === STATUS).length,
      removalCount,
    );
    native.values.set(KEY, newer);
    await act(async () => {
      acknowledged.resolve();
      await Promise.resolve();
    });
    await rig.mounted.render(null);
    await rig.render();
    assert.equal(rig.view().retained?.record.requestId, RECORD.requestId);
    await rig.refresh();
    assert.equal(native.values.get(KEY), newer);
    assert.notEqual(rig.view().outcome, "success");
    assert.ok(rig.view().error);
    await rig.approve();
    await rig.submit();
    assert.equal(rig.calls.filter((call) => call.name === PURCHASE).length, 0);

    // Simulate host recovery only in the test fixture; production never erases the newer token.
    native.values.delete(KEY);
    rig.implementations.set(STATUS, () => success());
    await rig.refresh();
    assert.equal(rig.view().outcome, "success");
    assert.equal(native.values.size, 0);
  } finally {
    await rig.mounted.unmount();
  }
});

test("failed compensation after access loss retains the returning owner and cannot unlock newer owner work", async () => {
  const native = memory();
  native.values.set(KEY, RAW);
  const removed = deferred<void>();
  const compensated = deferred<void>();
  let delay = true;
  let denied = true;
  const storage: CheckoutStorage = {
    ...browserCheckoutStorage,
    removeItem: (key, raw) => {
      browserCheckoutStorage.removeItem(key, raw);
      if (delay) {
        delay = false;
        return removed.promise;
      }
    },
  };
  const rig = hookRig({ storage });
  Reflect.set(window, "localStorage", native);
  native.setItem = (key, raw) => {
    if (key === KEY && denied) {
      compensated.resolve();
      throw new Error("native write denied");
    }
    native.values.set(key, raw);
  };
  rig.implementations.set(STATUS, () => success());
  rig.implementations.set(REFRESH, () => success());
  const purchase = deferred<unknown>();
  rig.implementations.set(PURCHASE, () => purchase.promise);
  try {
    await rig.render();
    assert.equal(native.values.has(KEY), false);
    await rig.render({ owner: null });
    await rig.render({ owner: "bea/users|bea" });
    await rig.approve();
    let pending!: Promise<void>;
    await act(async () => {
      pending = rig.view().submit();
    });
    assert.equal(rig.view().busy, true);
    await act(async () => {
      removed.resolve();
      await compensated.promise;
    });
    assert.equal(rig.view().busy, true);
    await rig.submit();
    assert.equal(rig.calls.filter((call) => call.name === PURCHASE).length, 1);
    await act(async () => {
      purchase.reject(new Error("response lost"));
      await pending;
    });
    await rig.render({ owner: OWNER });
    assert.equal(rig.view().retained?.record.requestId, RECORD.requestId);
    assert.equal(rig.view().canApprove, false);
    denied = false;
    await rig.refresh();
    assert.equal(rig.view().outcome, "success");
    assert.equal(native.values.has(KEY), false);
    assert.equal(
      native.values.size,
      1,
      "the newer owner's unresolved checkout is untouched",
    );
    assert.equal(rig.calls.filter((call) => call.name === PURCHASE).length, 1);
  } finally {
    await rig.mounted.unmount();
  }
});
