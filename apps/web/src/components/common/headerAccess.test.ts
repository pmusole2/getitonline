import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, URL } from "node:url";

import { resolveAccountAccess } from "../../../../../packages/shared/src/utils/accountAccess";
import {
  createControls,
  createHarness,
  textOf,
  withFallback,
  type HarnessControls,
  type Props,
  type RenderResult,
} from "../../../../../tests/support/componentHarness";

// Renders the real Header under controlled auth. Header is part of every page's layout, so a protected query it
// issues for an account that is not ready either reaches the server, which rejects it, or throws during render.

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const repoFile = (relativePath: string) => resolve(repoRoot, relativePath);
const webSource = repoFile("apps/web/src");

const PROTECTED_QUERIES: readonly string[] = [
  "cart.getCartCount",
  "notifications.getUnreadCount",
  "vendors.getMyVendorProfile",
];

type Access = "signed-out" | "pending" | "recovery" | "banned" | "ready";

function account(role: string, isBanned: boolean): Props {
  return {
    _id: "user_1",
    clerkId: "clerk_1",
    role,
    isBanned,
    email: "member@example.invalid",
    firstName: "Member",
    lastName: "Fixture",
  };
}

function authFor(access: Access): Props {
  const session: Props = {
    isLoading: false,
    isSignedIn: true,
    syncFailed: false,
    user: account("user", false),
    clerkUser: null,
    signOut: async () => undefined,
  };
  switch (access) {
    case "signed-out":
      return { ...session, isSignedIn: false, user: null };
    case "pending":
      return { ...session, isLoading: true, user: null };
    case "recovery":
      return { ...session, isSignedIn: false, syncFailed: true, user: null };
    case "banned":
      return { ...session, user: account("admin", true) };
    case "ready":
      return session;
  }
}

function openHeader(access: Access, guestCount = 0) {
  const controls: HarnessControls = createControls();
  controls.auth = authFor(access);
  const harness = createHarness({
    controls,
    aliases: { "@/": webSource },
    files: {
      [repoFile("apps/web/src/hooks/useAuth.ts")]: withFallback({
        useAuth: () => controls.auth,
      }),
      [repoFile("apps/web/src/providers/GuestCartProvider.tsx")]: withFallback({
        useGuestCart: () => ({ summary: { itemCount: guestCount } }),
      }),
    },
    packages: {
      "@gettitonline/shared": withFallback({ resolveAccountAccess }),
    },
  });
  const Header = harness.load(
    repoFile("apps/web/src/components/common/Header.tsx"),
  ).Header;
  return {
    render: (): RenderResult => harness.render(Header, {}),
  };
}

// Protected calls that reach the server: every call except those skipped.
function issuedProtectedQueries(result: RenderResult): string[] {
  return result.queryCalls
    .filter(
      (call) => PROTECTED_QUERIES.includes(call.name) && call.args !== "skip",
    )
    .map((call) => call.name);
}

describe("Header protected queries", () => {
  it("a banned account issues none of its protected queries", () => {
    const result = openHeader("banned").render();

    assert.deepEqual(
      issuedProtectedQueries(result),
      [],
      "cart, notification, and profile queries must wait for a ready account",
    );
  });

  it("pending, recovering, and signed-out visitors issue none of their protected queries", () => {
    for (const access of ["pending", "recovery", "signed-out"] as const) {
      assert.deepEqual(
        issuedProtectedQueries(openHeader(access).render()),
        [],
        access,
      );
    }
  });

  it("a signed-out visitor keeps the guest cart count", () => {
    const result = openHeader("signed-out", 3).render();

    assert.ok(textOf(result.tree).includes("3"), textOf(result.tree));
  });

  it("a ready account is served all of its protected queries", () => {
    const issued = issuedProtectedQueries(openHeader("ready").render());

    assert.deepEqual([...issued].sort(), [...PROTECTED_QUERIES].sort());
  });
});
