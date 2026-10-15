import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React, { act, createElement, type ReactNode } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as ConvexReact from "convex/react";
import * as Radix from "@radix-ui/react-alert-dialog";
import { getFunctionName } from "convex/server";
import * as ordersModule from "../../../../convex/orders";
import { createDb, createCtx } from "../../../../tests/support/convexFakeDb";
import { invokeFakeFunction } from "../../../../tests/support/convexFakeActionCtx";
import { format } from "date-fns";
import { api } from "../../../../convex/_generated/api";
import * as shared from "../../../../packages/shared/src/index";
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
const USER = {
  _id: "users|buyer",
  clerkId: "buyer",
  role: "user",
  isBanned: false,
};
const ORDER = {
  _id: "orders|1",
  buyerId: USER._id,
  sellerId: "users|seller",
  orderNumber: "ORD-1",
  status: "delivered",
  items: [],
  createdAt: 1,
  subtotal: 100,
  shippingCost: 0,
  platformFee: 5,
  sellerPayout: 100,
  totalAmount: 105,
  shippingAddress: {
    street: "Street",
    city: "Lusaka",
    province: "Lusaka",
    country: "Zambia",
    phone: "0971234567",
  },
};

function deferred() {
  let resolvePromise: (value: unknown) => void = () => undefined;
  let rejectPromise: (error: Error) => void = () => undefined;
  const promise = new Promise<unknown>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function text(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(text).join("");
  }
  if (React.isValidElement<{ children?: unknown }>(value)) {
    return text(value.props.children);
  }
  return "";
}

function rig(status = "delivered", strictRoot = false) {
  const controls = createControls();
  let access: Props = { status: "ready", user: USER };
  let resource = ORDER._id;
  let order: Props = { ...ORDER, status };
  const buttons = new Map<string, Props>();
  const dialogs: { open: boolean; props: Props }[] = [];
  const messages: { kind: string; message: string }[] = [];
  const strings: string[] = [];
  const statusLines: string[] = [];
  const calls: { name: string; args: unknown }[] = [];
  const implementations = new Map<string, (args: unknown) => unknown>();
  const host = (name: string) =>
    function Host(props: Props): ReactNode {
      if (name === "Button") {
        buttons.set(text(props.children), props);
      }
      return createElement(
        name === "Button" ? "button" : "div",
        name === "Button"
          ? { onClick: props.onClick, disabled: props.disabled, ref: props.ref }
          : null,
        props.children as ReactNode,
      );
    };
  const ui = new Proxy(
    {},
    {
      get: (_target, key) => (key === "__esModule" ? true : host(String(key))),
    },
  );
  function Dialog(props: Props): ReactNode {
    const [open, setOpen] = React.useState(false);
    dialogs.push({
      open: typeof props.open === "boolean" ? props.open : open,
      props,
    });
    return createElement(
      Radix.Root,
      {
        ...props,
        onOpenChange: (next: boolean): void => {
          setOpen(next);
          if (typeof props.onOpenChange === "function") {
            props.onOpenChange(next);
          }
        },
      },
      props.children as ReactNode,
    );
  }
  function Action(props: Props): ReactNode {
    return createElement(
      Radix.Action,
      {
        ...props,
        ref: (node: object | null): void => {
          if (!node) {
            return;
          }
          const key = Object.keys(node).find((name) =>
            name.startsWith("__reactProps$"),
          );
          assert.ok(key);
          buttons.set(`action:${text(props.children)}`, Reflect.get(node, key));
        },
      },
      props.children as ReactNode,
    );
  }
  const files: Record<string, Props> = {
    [file("apps/web/src/hooks/useAccountAccess.ts")]: {
      useAccountAccess: () => access,
    },
    [file("apps/web/src/components/common/AccountAccessNotice.tsx")]: {
      AccountAccessNotice: host("Notice"),
    },
    [file("apps/web/src/components/ui/alert-dialog.tsx")]: {
      AlertDialog: Dialog,
      AlertDialogTrigger: Radix.Trigger,
      AlertDialogAction: Action,
      // Native Action and Cancel both use Dialog.Close. Content/focus/portal are outside the minimal DOM boundary.
      AlertDialogCancel: Action,
      AlertDialogContent: host("Content"),
      AlertDialogDescription: host("Description"),
      AlertDialogFooter: host("Footer"),
      AlertDialogHeader: host("Header"),
      AlertDialogTitle: host("Title"),
    },
  };
  for (const name of [
    "button",
    "badge",
    "card",
    "separator",
    "skeleton",
    "breadcrumb",
  ]) {
    files[file(`apps/web/src/components/ui/${name}.tsx`)] = ui;
  }
  const trace = (
    kind: "jsx" | "jsxs",
    ...args: Parameters<typeof jsxRuntime.jsx>
  ): ReturnType<typeof jsxRuntime.jsx> => {
    const input: unknown = args[1];
    assert.ok(typeof input === "object" && input !== null);
    const props: Props = { ...input };
    const propsKey = props.key;
    delete props.key;
    strings.push(text(props.children));
    if (args[0] === "p" && props.role === "status") {
      statusLines.push(text(props.children));
    }
    return jsxRuntime[kind](
      args[0],
      props,
      args[2] ??
        (typeof propsKey === "string" || typeof propsKey === "number"
          ? propsKey
          : undefined),
    );
  };
  const harness = createHarness({
    controls,
    files,
    aliases: { "@/": file("apps/web/src") },
    convexApi: { api },
    packages: {
      react: React,
      "react/jsx-runtime": {
        ...jsxRuntime,
        jsx: (...args: Parameters<typeof jsxRuntime.jsx>) =>
          trace("jsx", ...args),
        jsxs: (...args: Parameters<typeof jsxRuntime.jsxs>) =>
          trace("jsxs", ...args),
      },
      "convex/react": ConvexReact,
      "@gettitonline/shared": shared,
      "lucide-react": ui,
      "next/link": { __esModule: true, default: host("Link") },
      "next/navigation": {
        useParams: () => ({ id: resource }),
        useRouter: () => ({
          push: (path: string) => calls.push({ name: "navigate", args: path }),
        }),
      },
      "date-fns": { format },
      sonner: {
        toast: {
          success: (message: string) =>
            messages.push({ kind: "success", message }),
          error: (message: string) => messages.push({ kind: "error", message }),
        },
      },
    },
  });
  const page = harness.load(
    file("apps/web/src/app/(main)/orders/[id]/page.tsx"),
  ).default as React.ComponentType;
  const convex = createFakeConvexClient({ "orders:getOrder": order });
  const transport = async (
    ref: Parameters<typeof getFunctionName>[0],
    args: unknown,
  ): Promise<unknown> => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    return implementations.get(name)?.(args);
  };
  Object.assign(convex.client, { mutation: transport });
  let client: object = convex.client;
  const mounted = mountUnderConvex(convex, { strictRoot });
  const provider: {
    ConvexProvider(props: {
      client: object;
      children?: ReactNode;
    }): ReactNode | Promise<ReactNode>;
  } = ConvexReact;
  const render = async (
    child: ReactNode = createElement(page),
  ): Promise<void> => {
    buttons.clear();
    dialogs.length = 0;
    strings.length = 0;
    statusLines.length = 0;
    await mounted.render(
      createElement(provider.ConvexProvider, { client }, child),
    );
  };
  const project = async (patch: Props): Promise<void> => {
    order = { ...order, ...patch };
    await act(async () => convex.deliver("orders:getOrder", order));
    await render();
  };
  const click = async (label: string): Promise<void> => {
    const button = buttons.get(label);
    assert.ok(button, [...buttons.keys()].join(","));
    await invoke(button.onClick);
  };
  return {
    render,
    project,
    click,
    mounted,
    convex,
    buttons,
    dialogs,
    strings,
    statusLines,
    calls,
    messages,
    implementations,
    page,
    setAccess: (value: Props): void => {
      access = value;
    },
    setResource: (value: string): void => {
      resource = value;
    },
    replaceClient: (): void => {
      const next = createFakeConvexClient({ "orders:getOrder": order });
      Object.assign(next.client, { mutation: transport });
      client = next.client;
    },
  };
}

async function invoke(callback: unknown): Promise<void> {
  assert.ok(typeof callback === "function");
  const event = {
    defaultPrevented: false,
    preventDefault(): void {
      this.defaultPrevented = true;
    },
  };
  await act(async () => {
    await Reflect.apply(callback, undefined, [event]);
  });
}
const complete = "action:Complete Order";
const cancel = "action:Cancel Order";
async function open(
  r: ReturnType<typeof rig>,
  cancelling = false,
): Promise<void> {
  await r.render();
  await r.click(cancelling ? "Cancel Order" : "Complete & Release Payment");
  await r.render();
}

for (const cancelling of [false, true]) {
  for (const outcome of [
    "review",
    "applied",
    "missing",
    "malformed",
    "error",
  ]) {
    test(`real web ${cancelling ? "cancel" : "complete"}: ${outcome} respects native close and financial truth`, async () => {
      const r = rig(cancelling ? "paid" : "delivered");
      r.implementations.set(
        cancelling ? "orders:cancelOrder" : "orders:completeOrder",
        () => {
          if (outcome === "error") {
            throw new Error("transport failed");
          }
          if (outcome === "missing") {
            return null;
          }
          if (outcome === "malformed") {
            return {
              ...ORDER,
              _id: "orders|foreign",
              status: cancelling ? "cancelled" : "completed",
              accountingOutcome: "applied",
            };
          }
          return {
            ...ORDER,
            status:
              outcome === "review"
                ? cancelling
                  ? "paid"
                  : "delivered"
                : cancelling
                  ? "cancelled"
                  : "completed",
            accountingOutcome: outcome,
          };
        },
      );
      try {
        await open(r, cancelling);
        await r.click(cancelling ? cancel : complete);
        await r.render();
        assert.equal(
          r.messages.filter((m) => m.kind === "success").length,
          outcome === "applied" ? 1 : 0,
        );
        assert.equal(
          r.dialogs.some((d) => d.open),
          outcome !== "applied",
          "review/error must retain actual controlled dialog",
        );
        if (outcome === "review") {
          assert.match(r.messages.map((m) => m.message).join(" "), /review/i);
        }
        if (outcome === "applied" && cancelling) {
          assert.match(r.messages[0].message, /marketplace wallet/i);
        }
        assert.ok(!r.calls.some((c) => c.name === "navigate"));
        if (outcome !== "applied") {
          if (cancelling) {
            assert.deepEqual(r.calls, [
              { name: "orders:cancelOrder", args: { orderId: ORDER._id } },
            ]);
            assert.deepEqual(r.statusLines, [
              outcome === "review"
                ? "Accounting review pending. Cancellation and refund are not confirmed."
                : outcome === "error"
                  ? "transport failed"
                  : "Cancellation and refund were not confirmed. Please check the order or contact support.",
            ]);
          }
          await r.click(cancelling ? "action:Keep Order" : "action:Cancel");
          await r.render();
          assert.ok(!r.dialogs.some((d) => d.open));
        }
      } finally {
        await r.mounted.unmount();
      }
    });
  }
}

for (const actor of [
  USER,
  { ...USER, _id: "users|admin", clerkId: "admin", role: "admin" },
]) {
  test(`real web ${actor.role === "admin" ? "admin" : "buyer"} cancellation names the buyer wallet in description and applied feedback`, async () => {
    const r = rig("paid");
    r.setAccess({ status: "ready", user: actor });
    r.implementations.set("orders:cancelOrder", () => ({
      ...ORDER,
      status: "cancelled",
      accountingOutcome: "applied",
    }));
    try {
      await open(r, true);
      const description = r.strings.find((value) =>
        value.startsWith("Cancellation may require accounting review."),
      );
      assert.ok(description);
      if (actor.role === "admin") {
        assert.notEqual(actor._id, ORDER.buyerId);
      }
      await r.click(cancel);
      await r.render();
      assert.deepEqual(r.calls, [
        { name: "orders:cancelOrder", args: { orderId: ORDER._id } },
      ]);
      assert.ok(!r.dialogs.some((dialog) => dialog.open));
      assert.deepEqual(
        {
          descriptionNamesBuyer:
            /credited to the buyer's marketplace wallet/i.test(description),
          messages: r.messages,
        },
        {
          descriptionNamesBuyer: true,
          messages: [
            {
              kind: "success",
              message:
                "Order cancelled. Refund credited to the buyer's marketplace wallet.",
            },
          ],
        },
      );
    } finally {
      await r.mounted.unmount();
    }
  });
}

test("real web stock-only server cancellation has no refund promise or refund claim", async () => {
  const r = rig("pending_payment");
  r.implementations.set("orders:cancelOrder", () => ({
    ...ORDER,
    status: "cancelled",
  }));
  try {
    await open(r, true);
    assert.ok(
      !r.strings.join(" ").includes("will cancel your order and refund"),
    );
    await r.click(cancel);
    await r.render();
    assert.deepEqual(r.messages, [
      { kind: "success", message: "Order cancelled. No payment was moved." },
    ]);
    assert.ok(!r.dialogs.some((d) => d.open));
  } finally {
    await r.mounted.unmount();
  }
});

for (const cancelling of [false, true]) {
  for (const before of [false, true]) {
    test(`real web owned ${cancelling ? "cancel" : "complete"} expected status ${before ? "before" : "after"} reply retains feedback and unlocks`, async () => {
      const r = rig(cancelling ? "paid" : "delivered", true);
      const wait = deferred();
      r.implementations.set(
        cancelling ? "orders:cancelOrder" : "orders:completeOrder",
        () => wait.promise,
      );
      try {
        await open(r, cancelling);
        const callback = r.buttons.get(cancelling ? cancel : complete)?.onClick;
        await act(async () => {
          assert.ok(typeof callback === "function");
          assert.ok(typeof callback === "function");
          void Reflect.apply(callback, undefined, [
            { preventDefault: () => undefined },
          ]);
        });
        await act(async () => {
          assert.ok(typeof callback === "function");
          void Reflect.apply(callback, undefined, [
            { preventDefault: () => undefined },
          ]);
        });
        assert.equal(
          r.calls.length,
          1,
          "captured duplicate cannot submit twice",
        );
        if (before) {
          await r.project({ status: cancelling ? "cancelled" : "completed" });
        }
        await act(async () =>
          wait.resolve({
            ...ORDER,
            status: cancelling ? "cancelled" : "completed",
            accountingOutcome: "applied",
          }),
        );
        if (!before) {
          await r.project({ status: cancelling ? "cancelled" : "completed" });
        }
        await r.render();
        assert.equal(r.messages.filter((m) => m.kind === "success").length, 1);
        assert.ok(!r.dialogs.some((d) => d.open));
      } finally {
        await r.mounted.unmount();
      }
    });
  }
}

for (const loss of [
  "access",
  "resource",
  "role",
  "client",
  "aba",
  "status",
  "unmount",
]) {
  test(`real web captured financial callback permanently retired by ${loss}`, async () => {
    const r = rig();
    try {
      await open(r);
      const callback = r.buttons.get(complete)?.onClick;
      if (loss === "access") {
        r.setAccess({ status: "banned", user: null });
        await r.render();
        r.setAccess({ status: "ready", user: USER });
      }
      if (loss === "resource" || loss === "aba") {
        r.setResource("orders|2");
        await r.project({ _id: "orders|2" });
        if (loss === "aba") {
          r.setResource(ORDER._id);
          await r.project({ _id: ORDER._id });
        }
      }
      if (loss === "role") {
        r.setAccess({ status: "ready", user: { ...USER, role: "admin" } });
      }
      if (loss === "client") {
        r.replaceClient();
      }
      if (loss === "status") {
        await r.project({ status: "disputed" });
      }
      if (loss === "unmount") {
        await r.mounted.unmount();
        await invoke(callback);
        assert.equal(r.calls.length, 0);
        return;
      }
      await r.render();
      await invoke(callback);
      assert.equal(r.calls.length, 0);
      assert.equal(r.messages.length, 0);
    } finally {
      if (loss !== "unmount") {
        await r.mounted.unmount();
      }
    }
  });
}

for (const loss of [
  "access",
  "resource",
  "role",
  "client",
  "aba",
  "status",
  "unmount",
]) {
  for (const rejects of [false, true]) {
    test(`real web late ${rejects ? "error" : "applied"} cannot affect ${loss} replacement`, async () => {
      const r = rig();
      const wait = deferred();
      r.implementations.set("orders:completeOrder", () => wait.promise);
      let unmounted = false;
      try {
        await open(r);
        await r.click(complete);
        if (loss === "access") {
          r.setAccess({ status: "recovery", user: null });
          await r.render();
          r.setAccess({ status: "ready", user: USER });
        }
        if (loss === "resource" || loss === "aba") {
          r.setResource("orders|2");
          await r.project({ _id: "orders|2" });
          if (loss === "aba") {
            r.setResource(ORDER._id);
            await r.project({ _id: ORDER._id });
          }
        }
        if (loss === "role") {
          r.setAccess({ status: "ready", user: { ...USER, role: "admin" } });
        }
        if (loss === "client") {
          r.replaceClient();
        }
        if (loss === "status") {
          await r.project({ status: "disputed" });
        }
        if (loss === "unmount") {
          await r.mounted.unmount();
          unmounted = true;
        } else {
          await r.render();
        }
        await act(async () => {
          if (rejects) {
            wait.reject(new Error("old transport failure"));
          } else {
            wait.resolve({
              ...ORDER,
              status: "completed",
              accountingOutcome: "applied",
            });
          }
        });
        assert.equal(r.messages.length, 0);
        assert.equal(r.calls.length, 1);
      } finally {
        if (!unmounted) {
          await r.mounted.unmount();
        }
      }
    });
  }
}

test("real web old finally cannot unlock a newer owned cancellation", async () => {
  const r = rig();
  const old = deferred();
  const newer = deferred();
  r.implementations.set("orders:completeOrder", () => old.promise);
  r.implementations.set("orders:cancelOrder", () => newer.promise);
  try {
    await open(r);
    await r.click(complete);
    r.setResource("orders|2");
    await r.project({ _id: "orders|2", status: "paid" });
    await r.click("Cancel Order");
    await r.render();
    await r.click(cancel);
    await r.render();
    await act(async () => old.reject(new Error("old failure")));
    await r.render();
    assert.equal(r.buttons.get(cancel)?.disabled, true);
    assert.equal(r.messages.length, 0);
    await act(async () =>
      newer.resolve({
        ...ORDER,
        _id: "orders|2",
        status: "cancelled",
        accountingOutcome: "review",
      }),
    );
    await r.render();
    assert.equal(r.buttons.get(cancel)?.disabled, false);
    assert.ok(r.dialogs.some((d) => d.open));
    assert.match(r.messages[0].message, /review/i);
  } finally {
    await r.mounted.unmount();
  }
});

test("real web own target then reversal retires completion through status ABA", async () => {
  const r = rig();
  const wait = deferred();
  r.implementations.set("orders:completeOrder", () => wait.promise);
  try {
    await open(r);
    await r.click(complete);
    await r.project({ status: "completed" });
    await r.project({ status: "delivered" });
    await act(async () =>
      wait.resolve({
        ...ORDER,
        status: "completed",
        accountingOutcome: "applied",
      }),
    );
    assert.equal(r.messages.length, 0);
  } finally {
    await r.mounted.unmount();
  }
});

for (const denied of [
  "loading",
  "signed-out",
  "banned",
  "deleted",
  "recovery",
]) {
  test(`real web ${denied} skips protected order reads`, async () => {
    const r = rig();
    r.setAccess({ status: denied, user: null });
    try {
      await r.render();
      assert.ok(
        !r.convex.lifecycle.some((name) =>
          name.startsWith("subscribe:orders:"),
        ),
      );
      assert.equal(r.buttons.size, 0);
    } finally {
      await r.mounted.unmount();
    }
  });
}

test("real web delivery transition is business-only and cannot unlock newer completion", async () => {
  const r = rig("shipped");
  const wait = deferred();
  const release = deferred();
  r.implementations.set("orders:confirmDelivery", () => wait.promise);
  r.implementations.set("orders:completeOrder", () => release.promise);
  try {
    await r.render();
    const callback = r.buttons.get("Confirm Delivery")?.onClick;
    await act(async () => {
      assert.ok(typeof callback === "function");
      assert.ok(typeof callback === "function");
      void Reflect.apply(callback, undefined, []);
    });
    await r.project({ status: "delivered" });
    assert.equal(r.buttons.get("Complete & Release Payment")?.disabled, true);
    await act(async () => wait.resolve({ ...ORDER, status: "delivered" }));
    await r.render();
    assert.match(r.messages[0].message, /Delivery confirmed/);
    assert.equal(r.buttons.get("Complete & Release Payment")?.disabled, false);
    await r.click("Complete & Release Payment");
    await r.render();
    await r.click(complete);
    await r.render();
    assert.equal(r.buttons.get(complete)?.disabled, true);
    await act(async () =>
      release.resolve({ ...ORDER, accountingOutcome: "review" }),
    );
  } finally {
    await r.mounted.unmount();
  }
});

test("registered stock-only cancel producer → real web consumer confirms cancellation without money", async () => {
  const r = rig("pending_payment");
  const db = createDb({
    users: [
      {
        ...USER,
        firstName: "Buyer",
        lastName: "Fixture",
        email: "buyer@example.invalid",
        isVerified: true,
      },
    ],
    orders: [{ ...ORDER, status: "pending_payment" }],
    escrow: [],
    transactions: [],
    walletTransactions: [],
    paymentOperations: [],
    products: [],
    notifications: [],
  });
  r.implementations.set("orders:cancelOrder", (args) =>
    invokeFakeFunction(ordersModule.cancelOrder, createCtx(db, "buyer"), args),
  );
  try {
    await open(r, true);
    await r.click(cancel);
    await r.render();
    assert.equal(db.tables.orders?.[0]?.status, "cancelled");
    assert.equal(db.tables.walletTransactions?.length, 0);
    assert.deepEqual(r.messages, [
      { kind: "success", message: "Order cancelled. No payment was moved." },
    ]);
  } finally {
    await r.mounted.unmount();
  }
});

test("real web speculative role render cannot retire committed completion callback", async () => {
  const r = rig();
  const never = new Promise<void>(() => undefined);
  let suspend = false;
  function Suspender(): ReactNode {
    if (suspend) {
      throw never;
    }
    return null;
  }
  const tree = (): ReactNode =>
    createElement(
      React.Suspense,
      { fallback: null },
      createElement(r.page),
      createElement(Suspender),
    );
  r.implementations.set("orders:completeOrder", () => ({
    ...ORDER,
    status: "completed",
    accountingOutcome: "applied",
  }));
  try {
    await r.render(tree());
    await r.click("Complete & Release Payment");
    await r.render(tree());
    const callback = r.buttons.get(complete)?.onClick;
    r.setAccess({ status: "ready", user: { ...USER, role: "admin" } });
    suspend = true;
    await act(async () => {
      React.startTransition(() => {
        void r.render(tree());
      });
    });
    await invoke(callback);
    assert.equal(r.calls.length, 1);
    assert.match(r.messages[0].message, /Order completed/);
  } finally {
    await r.mounted.unmount();
  }
});

test("real web account A→B→A permanently retires a captured and in-flight completion", async () => {
  const r = rig();
  const wait = deferred();
  r.implementations.set("orders:completeOrder", () => wait.promise);
  try {
    await open(r);
    const captured = r.buttons.get(complete)?.onClick;
    await r.click(complete);
    r.setAccess({
      status: "ready",
      user: { ...USER, _id: "users|b", clerkId: "b", role: "admin" },
    });
    await r.render();
    r.setAccess({ status: "ready", user: USER });
    await r.render();
    await invoke(captured);
    await act(async () =>
      wait.resolve({
        ...ORDER,
        status: "completed",
        accountingOutcome: "applied",
      }),
    );
    assert.equal(
      r.calls.filter((call) => call.name === "orders:completeOrder").length,
      1,
    );
    assert.equal(r.messages.length, 0);
  } finally {
    await r.mounted.unmount();
  }
});
