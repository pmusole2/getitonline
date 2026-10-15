import assert from "node:assert/strict";
import test from "node:test";

import {
  VISUAL_SEARCH_MAX_DATA_URL_LENGTH,
  VISUAL_SEARCH_MAX_EDGE,
  VISUAL_SEARCH_MAX_SOURCE_BYTES,
  VisualSearchImageError,
  assertVisualSearchFile,
  encodeVisualSearchImage,
  isVisualSearchDataUrl,
  visualSearchSize,
} from "./aiSearchImage";

const PREFIX = "data:image/jpeg;base64,";

// A fake encoder that makes a data URL whose length is set by the test, and records every size and quality it was asked for.
// The payload is a whole number of base64 groups, as a real encoder's output is, so it passes the backend's structural check.
function fakeEncoder(lengthAt: (quality: number) => number) {
  const attempts: { width: number; height: number; quality: number }[] = [];
  const encode = (size: { width: number; height: number }, quality: number) => {
    attempts.push({ ...size, quality });
    return (
      PREFIX +
      "A".repeat(Math.floor((lengthAt(quality) - PREFIX.length) / 4) * 4)
    );
  };
  return { encode, attempts };
}

test("a file over 10 MB or not an image is refused before any decoding", () => {
  assert.doesNotThrow(() =>
    assertVisualSearchFile({
      size: VISUAL_SEARCH_MAX_SOURCE_BYTES,
      type: "image/png",
    }),
  );
  assert.throws(
    () =>
      assertVisualSearchFile({
        size: VISUAL_SEARCH_MAX_SOURCE_BYTES + 1,
        type: "image/png",
      }),
    (error: unknown) =>
      error instanceof VisualSearchImageError && /10 MB/.test(error.message),
  );
  assert.throws(
    () => assertVisualSearchFile({ size: 10, type: "text/plain" }),
    (error: unknown) =>
      error instanceof VisualSearchImageError && /image/.test(error.message),
  );
});

test("both edges are bounded, so a tall or wide photo never exceeds the maximum edge", () => {
  assert.deepEqual(visualSearchSize({ width: 300, height: 2000 }), {
    width: Math.round((300 * VISUAL_SEARCH_MAX_EDGE) / 2000),
    height: VISUAL_SEARCH_MAX_EDGE,
  });
  assert.deepEqual(visualSearchSize({ width: 4000, height: 1000 }), {
    width: VISUAL_SEARCH_MAX_EDGE,
    height: 128,
  });
  assert.deepEqual(
    visualSearchSize({ width: 200, height: 100 }),
    { width: 200, height: 100 },
    "small photos are not enlarged",
  );
  assert.deepEqual(
    visualSearchSize({ width: 1, height: 100000 }),
    { width: 1, height: VISUAL_SEARCH_MAX_EDGE },
    "never zero",
  );
});

test("a tall photo is encoded at the bounded size, and a result within the backend limit is returned as is", () => {
  const { encode, attempts } = fakeEncoder(() => 40_000);

  const url = encodeVisualSearchImage({ width: 300, height: 2000 }, encode);

  assert.equal(url.startsWith(PREFIX), true);
  assert.ok(url.length <= VISUAL_SEARCH_MAX_DATA_URL_LENGTH);
  assert.equal(
    attempts.length,
    1,
    "one encode is enough when the first result fits",
  );
  assert.equal(attempts[0].height, VISUAL_SEARCH_MAX_EDGE);
});

test("a result over the backend limit is re-encoded at lower quality until it fits", () => {
  const { encode, attempts } = fakeEncoder((quality) =>
    quality > 0.5 ? 600_000 : 300_000,
  );

  const url = encodeVisualSearchImage({ width: 1000, height: 1000 }, encode);

  assert.ok(
    url.length <= VISUAL_SEARCH_MAX_DATA_URL_LENGTH,
    "the returned value is within the limit",
  );
  const qualities = attempts.map((attempt) => attempt.quality);
  assert.ok(qualities.length > 1, "more than one encode was needed");
  assert.deepEqual(
    qualities,
    [...qualities].sort((a, b) => b - a),
    "quality only goes down",
  );
});

test("when no quality fits, the photo is refused with a clear message, never sent", () => {
  const { encode } = fakeEncoder(() => VISUAL_SEARCH_MAX_DATA_URL_LENGTH + 27);

  assert.throws(
    () => encodeVisualSearchImage({ width: 1000, height: 1000 }, encode),
    (error: unknown) =>
      error instanceof VisualSearchImageError &&
      /smaller photo/.test(error.message),
  );
});

test("a data URL that is not a base64 image is never returned as a search image", () => {
  assert.equal(isVisualSearchDataUrl(`${PREFIX}AAAA`), true);
  assert.equal(isVisualSearchDataUrl("data:image/png;base64,AAAA"), true);
  assert.equal(isVisualSearchDataUrl("data:image/webp;base64,AAAA"), true);
  assert.equal(
    isVisualSearchDataUrl("data:text/html;base64,AAAA"),
    false,
    "a text payload is refused",
  );
  assert.equal(
    isVisualSearchDataUrl("data:image/jpeg;base64,AA AA"),
    false,
    "a space is not base64",
  );
  assert.equal(
    isVisualSearchDataUrl(
      PREFIX + "A".repeat(VISUAL_SEARCH_MAX_DATA_URL_LENGTH),
    ),
    false,
    "over the limit",
  );
  const { encode } = fakeEncoder(() => 1000);
  const encodeHtml = (
    size: { width: number; height: number },
    quality: number,
  ) => (quality > 0 ? "data:text/html;base64,AAAA" : encode(size, quality));
  assert.throws(
    () => encodeVisualSearchImage({ width: 10, height: 10 }, encodeHtml),
    (error: unknown) => error instanceof VisualSearchImageError,
  );
});
