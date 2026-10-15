import assert from "node:assert/strict";
import test from "node:test";

import { resolveAccountAccess } from "./accountAccess";

const signedIn = { isLoading: false, isSignedIn: true, syncFailed: false };
const activeUser = { isBanned: false };
const bannedUser = { isBanned: true };

test("pending authentication stays loading, even when an account is cached", () => {
  assert.equal(
    resolveAccountAccess({ ...signedIn, isLoading: true, user: activeUser }),
    "loading",
  );
  assert.equal(
    resolveAccountAccess({
      isLoading: true,
      isSignedIn: false,
      syncFailed: false,
      user: null,
    }),
    "loading",
  );
});

test("a visitor with no session is settled as signed out", () => {
  assert.equal(
    resolveAccountAccess({
      isLoading: false,
      isSignedIn: false,
      syncFailed: false,
      user: null,
    }),
    "signed-out",
  );
});

test("a cached account is never ready once the session is gone", () => {
  assert.equal(
    resolveAccountAccess({
      isLoading: false,
      isSignedIn: false,
      syncFailed: false,
      user: activeUser,
    }),
    "signed-out",
  );
});

test("a signed-in visitor without an account record enters recovery", () => {
  assert.equal(resolveAccountAccess({ ...signedIn, user: null }), "recovery");
});

test("a failed account sync enters recovery, including where the web hook reports signed out", () => {
  assert.equal(
    resolveAccountAccess({
      isLoading: false,
      isSignedIn: false,
      syncFailed: true,
      user: null,
    }),
    "recovery",
  );
  assert.equal(
    resolveAccountAccess({ ...signedIn, syncFailed: true, user: null }),
    "recovery",
  );
});

test("an active account is ready", () => {
  assert.equal(
    resolveAccountAccess({ ...signedIn, user: activeUser }),
    "ready",
  );
});

test("a banned account is unavailable", () => {
  assert.equal(
    resolveAccountAccess({ ...signedIn, user: bannedUser }),
    "unavailable",
  );
});

test("a loaded account keeps its access when a sync error is also recorded", () => {
  assert.equal(
    resolveAccountAccess({ ...signedIn, syncFailed: true, user: activeUser }),
    "ready",
  );
});

test("a cached deleted profile is unavailable even without a ban marker", () => {
  assert.equal(
    resolveAccountAccess({
      ...signedIn,
      user: { ...activeUser, deletedAt: 1 },
    }),
    "unavailable",
  );
});
