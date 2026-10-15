import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createControls,
  createHarness,
  fixture,
  hasNode,
  textOf,
  withFallback,
  type Props,
} from "../../../../tests/support/componentHarness";

// Runs the real admin delivery page with a controlled useAuth. The backend refuses includeInactive for non-admins, so the
// inactive-inclusive queries must be skipped until the signed-in user is known to be an admin.
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const file = (path: string) => resolve(root, path);
const PAGE = "apps/web/src/app/(admin)/admin/delivery/page.tsx";
const QUERIES = [
  "delivery.listDeliveryZones",
  "delivery.listDeliveryMethods",
] as const;

function auth(overrides: Props = {}): Props {
  return {
    isLoading: false,
    isSignedIn: true,
    syncFailed: false,
    user: fixture({
      _id: "users|admin",
      clerkId: "admin",
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

function open(initial: Props) {
  const controls = createControls();
  controls.auth = auth(initial);
  controls.queries = {
    "delivery.listDeliveryZones": [],
    "delivery.listDeliveryMethods": [],
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
  });
  const component = harness.load(file(PAGE)).default;
  return {
    render: () => harness.render(component, {}),
  };
}

function argsByQuery(calls: ReadonlyArray<{ name: string; args: unknown }>) {
  return Object.fromEntries(
    QUERIES.map((name) => [
      name,
      calls.filter((call) => call.name === name).map((call) => call.args),
    ]),
  );
}

test("a non-admin signed-in user gets skip for both delivery queries, never includeInactive", () => {
  const result = open({
    user: fixture({
      _id: "users|mod",
      clerkId: "mod",
      role: "moderator",
      isBanned: false,
      deletedAt: undefined,
    }),
  }).render();

  assert.deepEqual(argsByQuery(result.queryCalls), {
    "delivery.listDeliveryZones": ["skip"],
    "delivery.listDeliveryMethods": ["skip"],
  });
  assert.ok(
    textOf(result.tree).includes("Access Restricted"),
    textOf(result.tree),
  );
  assert.ok(
    !hasNode(result.tree, "Skeleton"),
    "a skipped query must not show the loading skeleton",
  );
});

test("an admin requests both delivery queries with includeInactive: true", () => {
  const result = open({}).render();

  assert.deepEqual(argsByQuery(result.queryCalls), {
    "delivery.listDeliveryZones": [{ includeInactive: true }],
    "delivery.listDeliveryMethods": [{ includeInactive: true }],
  });
});

test("while the user is loading both delivery queries are skipped, even if the cached role is admin", () => {
  const result = open({ isLoading: true }).render();

  assert.deepEqual(argsByQuery(result.queryCalls), {
    "delivery.listDeliveryZones": ["skip"],
    "delivery.listDeliveryMethods": ["skip"],
  });
});
