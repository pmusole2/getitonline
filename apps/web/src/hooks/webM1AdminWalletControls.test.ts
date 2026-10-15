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
  pressButton,
  textOf,
  withFallback,
  type HarnessControls,
  type Props,
} from "../../../../tests/support/componentHarness";

// The real admin users page, with the account chain controlled through useAuth. Wallet calls are recorded by the
// harness, so each assertion checks the exact arguments the Convex validators accept.

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const usersPage = resolve(
  root,
  "apps/web/src/app/(admin)/admin/users/page.tsx",
);
const FREEZE = "mutation:wallet.freezeWallet";
const UNFREEZE = "mutation:wallet.unfreezeWallet";

type Role = "admin" | "moderator" | "catalog_manager" | "user";

function adminAccount(id: string, role: Role = "admin"): Props {
  return fixture({
    _id: `users|${id}`,
    clerkId: id,
    firstName: "Ada",
    lastName: id,
    email: `${id}@example.invalid`,
    role,
    isBanned: false,
    deletedAt: undefined,
  });
}

function auth(overrides: Props = {}): Props {
  return {
    isLoading: false,
    isSignedIn: true,
    syncFailed: false,
    user: adminAccount("admin"),
    clerkUser: null,
    retrySync: () => undefined,
    signOut: async () => undefined,
    ...overrides,
  };
}

const LISTED_USERS = [
  {
    _id: "users|u1",
    firstName: "Una",
    lastName: "User",
    email: "u1@example.invalid",
    role: "user",
    isBanned: false,
  },
  {
    _id: "users|u2",
    firstName: "Vic",
    lastName: "Other",
    email: "u2@example.invalid",
    role: "user",
    isBanned: false,
  },
];

function open(initial: Props = {}) {
  const controls: HarnessControls = createControls();
  controls.auth = auth(initial);
  controls.queries = {
    "users.getAllUsers": { items: LISTED_USERS },
    "platform.getPlatformSettingsForAdmin": fixture({
      companyDisplayName: "Fixture Store",
      companySeller: null,
      companySellerUserId: null,
    }),
    "wallet.getWallet": undefined,
  };
  controls.mutations["wallet.freezeWallet"] = async () => ({ success: true });
  controls.mutations["wallet.unfreezeWallet"] = async () => ({ success: true });
  const harness = createHarness({
    controls,
    effects: true,
    aliases: { "@/": resolve(root, "apps/web/src") },
    files: {
      [resolve(root, "apps/web/src/hooks/useAuth.ts")]: withFallback({
        useAuth: () => {
          controls.hook("useContext");
          return controls.auth;
        },
      }),
    },
    packages: {
      "@gettitonline/shared": withFallback({ resolveAccountAccess }),
      sonner: withFallback({
        toast: withFallback({
          success: (message: unknown) =>
            controls.calls.push({ name: "toast.success", args: [message] }),
          error: (message: unknown) =>
            controls.calls.push({ name: "toast.error", args: [message] }),
        }),
      }),
    },
  });
  const component = harness.load(usersPage).default;
  return {
    controls,
    harness,
    render: (props: Props = {}) => harness.render(component, props),
  };
}

// Two renders: the first lets selection state take effect, the second shows it.
function selectUser(screen: ReturnType<typeof open>, label: string) {
  screen.render();
  const result = screen.render();
  assert.ok(pressButton(result.tree, label, "onClick"), `no ${label} action`);
  return screen.render();
}

function mutationCalls(
  screen: ReturnType<typeof open>,
  name: string,
): readonly unknown[][] {
  return screen.controls.calls
    .filter((call) => call.name === name)
    .map((call) => [...call.args]);
}

// Reports whether a button with this exact label is rendered, without calling its handler.
function hasLabel(
  tree: Parameters<typeof findNodes>[0],
  label: string,
): boolean {
  return (
    findNodes(
      tree,
      (node) =>
        typeof node.props.onClick === "function" &&
        textOf(node.children) === label,
    ).length > 0
  );
}

function walletFor(overrides: Props): Props {
  return fixture({
    _id: "wallets|w1",
    userId: "users|u1",
    balance: 0,
    isActive: true,
    isFrozen: false,
    ...overrides,
  });
}

function reasonInput(tree: Parameters<typeof findNodes>[0]) {
  const [input] = findNodes(
    tree,
    (node) => node.name === "input" && node.props.id === "wallet-freeze-reason",
  );
  return input;
}

function setReason(screen: ReturnType<typeof open>, value: string): void {
  const input = reasonInput(screen.render().tree);
  const change = input?.props.onChange;
  assert.equal(typeof change, "function", "the freeze reason input must exist");
  Reflect.apply(change as () => void, undefined, [{ target: { value } }]);
}

test("admin: each user row offers a Wallet action that requests that user's wallet", () => {
  const screen = open();
  const result = selectUser(screen, "Wallet");

  assert.ok(
    result.queryCalls.some(
      (call) =>
        call.name === "wallet.getWallet" &&
        JSON.stringify(call.args) === JSON.stringify({ userId: "users|u1" }),
    ),
    "the first row (Una) must request wallet users|u1",
  );
  assert.ok(textOf(result.tree).includes("Wallet Controls"));
});

test("admin: an active wallet shows Freeze, and the trigger alone calls no mutation", async () => {
  const screen = open();
  screen.controls.queries["wallet.getWallet"] = walletFor({ isFrozen: false });
  const result = selectUser(screen, "Wallet");

  assert.ok(hasLabel(result.tree, "Freeze wallet"));
  assert.ok(!hasLabel(result.tree, "Unfreeze wallet"));
  assert.ok(pressButton(result.tree, "Freeze wallet", "onClick"));
  await screen.harness.settle();
  assert.deepEqual(
    mutationCalls(screen, FREEZE),
    [],
    "opening the freeze step must not freeze the wallet",
  );
});

test("admin: confirmed freeze calls freezeWallet with exactly walletId and the trimmed reason", async () => {
  const screen = open();
  screen.controls.queries["wallet.getWallet"] = walletFor({ isFrozen: false });
  selectUser(screen, "Wallet");
  pressButton(screen.render().tree, "Freeze wallet", "onClick");
  setReason(screen, "  Chargeback review  ");
  const result = screen.render();
  assert.ok(pressButton(result.tree, "Confirm freeze", "onClick"));
  await screen.harness.settle();

  assert.deepEqual(mutationCalls(screen, FREEZE), [
    [{ walletId: "wallets|w1", reason: "Chargeback review" }],
  ]);
  assert.deepEqual(mutationCalls(screen, UNFREEZE), []);
});

test("admin: a confirmation with an empty reason calls nothing", async () => {
  const screen = open();
  screen.controls.queries["wallet.getWallet"] = walletFor({ isFrozen: false });
  selectUser(screen, "Wallet");
  pressButton(screen.render().tree, "Freeze wallet", "onClick");
  setReason(screen, "   ");
  pressButton(screen.render().tree, "Confirm freeze", "onClick");
  await screen.harness.settle();

  assert.deepEqual(mutationCalls(screen, FREEZE), []);
});

test("admin: a frozen wallet shows Frozen with its reason and Unfreeze calls unfreezeWallet with only walletId", async () => {
  const screen = open();
  screen.controls.queries["wallet.getWallet"] = walletFor({
    isFrozen: true,
    freezeReason: "Chargeback review",
  });
  const result = selectUser(screen, "Wallet");

  assert.ok(textOf(result.tree).includes("Frozen"));
  assert.ok(textOf(result.tree).includes("Chargeback review"));
  assert.ok(!hasLabel(result.tree, "Freeze wallet"));
  assert.ok(pressButton(result.tree, "Unfreeze wallet", "onClick"));
  await screen.harness.settle();

  assert.deepEqual(mutationCalls(screen, UNFREEZE), [
    [{ walletId: "wallets|w1" }],
  ]);
  assert.deepEqual(mutationCalls(screen, FREEZE), []);
});

test("admin: a failed freeze shows the server message and does not report success", async () => {
  const screen = open();
  screen.controls.queries["wallet.getWallet"] = walletFor({ isFrozen: false });
  screen.controls.mutations["wallet.freezeWallet"] = async () => {
    throw new Error("Only administrators can freeze wallets");
  };
  selectUser(screen, "Wallet");
  pressButton(screen.render().tree, "Freeze wallet", "onClick");
  setReason(screen, "Fraud review");
  pressButton(screen.render().tree, "Confirm freeze", "onClick");
  await screen.harness.settle();

  assert.deepEqual(
    screen.controls.calls
      .filter((call) => call.name.startsWith("toast."))
      .map((call) => [call.name, call.args]),
    [["toast.error", ["Only administrators can freeze wallets"]]],
  );
});

test("admin: a successful freeze is reflected by the wallet's frozen state from the server", async () => {
  const screen = open();
  screen.controls.queries["wallet.getWallet"] = walletFor({ isFrozen: false });
  selectUser(screen, "Wallet");
  pressButton(screen.render().tree, "Freeze wallet", "onClick");
  setReason(screen, "Fraud review");
  pressButton(screen.render().tree, "Confirm freeze", "onClick");
  await screen.harness.settle();
  screen.controls.queries["wallet.getWallet"] = walletFor({
    isFrozen: true,
    freezeReason: "Fraud review",
  });
  const result = screen.render();

  assert.ok(textOf(result.tree).includes("Frozen"));
  assert.ok(hasLabel(result.tree, "Unfreeze wallet"));
  assert.ok(!hasLabel(result.tree, "Freeze wallet"));
});

test("admin: a user with no wallet yet has no freeze action", () => {
  const screen = open();
  screen.controls.queries["wallet.getWallet"] = null;
  const result = selectUser(screen, "Wallet");

  assert.ok(textOf(result.tree).includes("No wallet yet"));
  assert.ok(!hasLabel(result.tree, "Freeze wallet"));
  assert.ok(!hasLabel(result.tree, "Unfreeze wallet"));
});

test("admin switch: a previously selected wallet is discarded when the admin account changes", () => {
  const screen = open();
  screen.controls.queries["wallet.getWallet"] = walletFor({ isFrozen: false });
  selectUser(screen, "Wallet");
  screen.controls.auth = auth({ user: adminAccount("second") });
  const result = screen.render();

  assert.ok(
    !result.queryCalls.some(
      (call) => call.name === "wallet.getWallet" && call.args !== "skip",
    ),
    "the new admin must not inherit the previous admin's wallet selection",
  );
  assert.ok(!textOf(result.tree).includes("Wallet Controls"));
});

for (const role of ["moderator", "catalog_manager", "user"] as const) {
  test(`${role}: no wallet action, no wallet query, and no freeze mutation can be triggered`, async () => {
    const screen = open({ user: adminAccount("nonadmin", role) });
    screen.controls.queries["wallet.getWallet"] = walletFor({
      isFrozen: false,
    });
    const result = screen.render();

    assert.ok(textOf(result.tree).includes("Access Restricted"));
    assert.ok(!hasLabel(result.tree, "Wallet"));
    assert.ok(!hasLabel(result.tree, "Freeze wallet"));
    assert.ok(!hasLabel(result.tree, "Unfreeze wallet"));
    assert.ok(
      !result.queryCalls.some(
        (call) => call.name === "wallet.getWallet" && call.args !== "skip",
      ),
    );
    await screen.harness.settle();
    assert.deepEqual(mutationCalls(screen, FREEZE), []);
    assert.deepEqual(mutationCalls(screen, UNFREEZE), []);
  });
}
