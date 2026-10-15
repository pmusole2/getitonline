import assert from "node:assert/strict";
import test from "node:test";

import {
  isHttpsStoreUrl,
  readClientGateContract,
  resolveClientGate,
  resolvePaymentAvailability,
} from "./clientGate";

const storeUrl = "https://apps.apple.com/app/id1234567890";

// The complete public contract that getClientGate returns. A blocking decision needs every field to be well-formed.
const blocking = {
  updateRequired: true,
  minimumBuild: 9,
  storeUrl,
  paymentsEnabled: true,
};

test("a well-formed gate result that requires an update blocks with its https store link", () => {
  assert.deepEqual(resolveClientGate(blocking), {
    status: "update-required",
    storeUrl,
  });
});

test("an update-required gate without a store link still blocks, with no link to offer", () => {
  assert.deepEqual(resolveClientGate({ ...blocking, storeUrl: null }), {
    status: "update-required",
    storeUrl: null,
  });
});

test("a current build passes the gate without a store link", () => {
  assert.deepEqual(
    resolveClientGate({ ...blocking, updateRequired: false, storeUrl }),
    { status: "ok", storeUrl: null },
  );
});

test("missing, null, or non-object gate results fail open", () => {
  for (const result of [
    undefined,
    null,
    "updateRequired",
    1,
    true,
    [],
    [blocking],
  ]) {
    assert.deepEqual(resolveClientGate(result), {
      status: "ok",
      storeUrl: null,
    });
  }
});

test("an object without a strict boolean true updateRequired fails open", () => {
  for (const result of [
    {},
    { ...blocking, updateRequired: undefined },
    { ...blocking, updateRequired: "true" },
    { ...blocking, updateRequired: 1 },
    { ...blocking, updateRequired: "yes" },
    { ...blocking, updateRequired: {} },
  ]) {
    assert.deepEqual(
      resolveClientGate(result),
      { status: "ok", storeUrl: null },
      JSON.stringify(result),
    );
  }
});

test("a blocking result with a malformed minimumBuild fails open", () => {
  for (const minimumBuild of [
    "invalid",
    "9",
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 2,
    null,
    undefined,
    {},
  ]) {
    assert.deepEqual(
      resolveClientGate({ ...blocking, minimumBuild }),
      { status: "ok", storeUrl: null },
      String(minimumBuild),
    );
  }
});

test("a blocking result with a non-boolean paymentsEnabled fails open", () => {
  for (const paymentsEnabled of ["false", 0, 1, null, undefined, {}]) {
    assert.deepEqual(
      resolveClientGate({ ...blocking, paymentsEnabled }),
      { status: "ok", storeUrl: null },
      String(paymentsEnabled),
    );
  }
});

test("a blocking result whose storeUrl is neither a string nor null fails open", () => {
  for (const value of [42, {}, [], true, undefined]) {
    assert.deepEqual(
      resolveClientGate({ ...blocking, storeUrl: value }),
      { status: "ok", storeUrl: null },
      String(value),
    );
  }
});

test("the reviewed malformed response with an invalid minimumBuild does not block launch", () => {
  assert.deepEqual(
    resolveClientGate({
      updateRequired: true,
      minimumBuild: "invalid",
      paymentsEnabled: false,
      storeUrl: null,
    }),
    { status: "ok", storeUrl: null },
  );
});

test("a minimumBuild of zero is a valid non-negative integer", () => {
  assert.deepEqual(resolveClientGate({ ...blocking, minimumBuild: 0 }), {
    status: "update-required",
    storeUrl,
  });
});

test("a string that is not an https URL is blocked without a store link", () => {
  for (const url of [
    "http://apps.apple.com/app/id1",
    "javascript:alert(1)",
    "https://",
    "https:/apps.apple.com/app/id1",
    "HTTPS://apps.apple.com/app/id1",
    " https://apps.apple.com/app/id1",
    "https://apps.apple.com/app/id1 extra",
    "play.google.com/store/apps",
    "",
  ]) {
    assert.deepEqual(
      resolveClientGate({ ...blocking, storeUrl: url }),
      { status: "update-required", storeUrl: null },
      url,
    );
  }
});

test("a store link with an invalid port is never returned", () => {
  assert.equal(isHttpsStoreUrl("https://example.com:99999/app"), false);
  assert.equal(isHttpsStoreUrl("https://example.com:abc/app"), false);
});

test("a store link with embedded credentials is never returned", () => {
  assert.equal(isHttpsStoreUrl("https://user:secret@example.com/app"), false);
  assert.equal(isHttpsStoreUrl("https://user@example.com/app"), false);
});

test("javascript:, http:, and relative store links are never returned", () => {
  assert.equal(isHttpsStoreUrl("javascript:alert(1)"), false);
  assert.equal(isHttpsStoreUrl("http://apps.apple.com/app/id1"), false);
  assert.equal(isHttpsStoreUrl("/app/id1"), false);
  assert.equal(isHttpsStoreUrl("//apps.apple.com/app/id1"), false);
});

test("store links with whitespace, control characters, or backslashes are never returned", () => {
  for (const url of [
    "https://apps.apple.com/app id1",
    "https://apps.apple.com/app\tid1",
    "https://apps.apple.com/app\nid1",
    "https://apps.apple.com/app\u0000id1",
    "https:\\\\apps.apple.com\\app",
  ]) {
    assert.equal(isHttpsStoreUrl(url), false, JSON.stringify(url));
  }
});

test("empty and non-string store links are never returned", () => {
  for (const url of ["", "   ", 42, null, undefined]) {
    assert.equal(isHttpsStoreUrl(url), false, String(url));
  }
});

test("a non-ASCII host is never returned, even where URL parsing would accept it", () => {
  assert.equal(isHttpsStoreUrl("https://bücher.example/app"), false);
  assert.equal(isHttpsStoreUrl("https://ｅxample.com/app"), false);
});

test("valid https store links with a path and a query are returned", () => {
  assert.equal(isHttpsStoreUrl(storeUrl), true);
  assert.equal(
    isHttpsStoreUrl(
      "https://play.google.com/store/apps/details?id=com.example",
    ),
    true,
  );
});

test("https store links are recognized by isHttpsStoreUrl", () => {
  assert.equal(isHttpsStoreUrl(undefined), false);
  assert.equal(isHttpsStoreUrl("http://play.google.com/store"), false);
});

test("payments are available only when paymentsEnabled is strictly true", () => {
  assert.equal(
    resolvePaymentAvailability({ paymentsEnabled: true }),
    "available",
  );
});

test("payments stay unavailable for false, missing, and truthy-but-not-true values", () => {
  for (const result of [
    { paymentsEnabled: false },
    {},
    { paymentsEnabled: "true" },
    { paymentsEnabled: 1 },
    { paymentsEnabled: {} },
    { paymentsEnabled: null },
    true,
    "available",
    1,
    [],
    null,
    undefined,
    new Error("query failed"),
  ]) {
    assert.equal(
      resolvePaymentAvailability(result),
      "unavailable",
      JSON.stringify(result),
    );
  }
});

test("a malformed gate result reads as null, so a client can tell it apart from a valid current build", () => {
  assert.equal(readClientGateContract(null), null);
  assert.equal(readClientGateContract({ ...blocking, minimumBuild: -1 }), null);
  assert.equal(
    readClientGateContract({ ...blocking, paymentsEnabled: "true" }),
    null,
  );
  assert.equal(
    readClientGateContract({ ...blocking, updateRequired: "true" }),
    null,
  );
});

test("a valid gate result reads as its contract, with a store link only when it is https", () => {
  assert.deepEqual(readClientGateContract(blocking), {
    updateRequired: true,
    minimumBuild: 9,
    storeUrl,
  });
  assert.deepEqual(
    readClientGateContract({
      ...blocking,
      storeUrl: "http://apps.apple.com/app/id1",
    }),
    { updateRequired: true, minimumBuild: 9, storeUrl: null },
  );
  assert.deepEqual(
    readClientGateContract({
      ...blocking,
      updateRequired: false,
      storeUrl: null,
    }),
    {
      updateRequired: false,
      minimumBuild: 9,
      storeUrl: null,
    },
  );
});
