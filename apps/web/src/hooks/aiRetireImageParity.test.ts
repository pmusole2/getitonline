import assert from "node:assert/strict";
import test from "node:test";

import {
  isSupportedImageDataUrl,
  MAX_IMAGE_DATA_URL_LENGTH,
} from "../../../../convex/lib/aiProvider";
import { isVisualSearchDataUrl } from "../../../../packages/shared/src/ai/aiSearchImage";

// The client must accept exactly what the backend accepts, or a photo the client sends is refused by the server.
// The backend function is imported directly, so the rule compared here is the one that runs in production.

interface ParityCase {
  readonly name: string;
  readonly value: string;
  readonly accepted: boolean;
}

const PAYLOAD_PREFIX = "data:image/jpeg;base64,";
// The longest payload that is a whole number of groups of four and still within the backend limit.
const LONGEST_PAYLOAD =
  Math.floor((MAX_IMAGE_DATA_URL_LENGTH - PAYLOAD_PREFIX.length) / 4) * 4;

const cases: readonly ParityCase[] = [
  {
    name: "a four-character group",
    value: `${PAYLOAD_PREFIX}AAAA`,
    accepted: true,
  },
  { name: "one trailing pad", value: `${PAYLOAD_PREFIX}AAA=`, accepted: true },
  { name: "two trailing pads", value: `${PAYLOAD_PREFIX}AA==`, accepted: true },
  {
    name: "the full alphabet and + and /",
    value: `${PAYLOAD_PREFIX}AB+/`,
    accepted: true,
  },
  {
    name: "every supported image type",
    value: "data:image/webp;base64,AAAA",
    accepted: true,
  },
  { name: "a png", value: "data:image/png;base64,QUJD", accepted: true },
  { name: "a gif", value: "data:image/gif;base64,AAAA", accepted: true },
  {
    name: "length 3, not a multiple of 4",
    value: `${PAYLOAD_PREFIX}AAA`,
    accepted: false,
  },
  {
    name: "length 5, not a multiple of 4",
    value: `${PAYLOAD_PREFIX}AAAAA`,
    accepted: false,
  },
  {
    name: "length 3 with one pad",
    value: `${PAYLOAD_PREFIX}AA=`,
    accepted: false,
  },
  {
    name: "length 5 with two pads",
    value: `${PAYLOAD_PREFIX}AAA==`,
    accepted: false,
  },
  { name: "length 6", value: `${PAYLOAD_PREFIX}AAAAAA`, accepted: false },
  {
    name: "padding in the middle",
    value: `${PAYLOAD_PREFIX}AA=A`,
    accepted: false,
  },
  { name: "three pads", value: `${PAYLOAD_PREFIX}A===`, accepted: false },
  { name: "only pads", value: `${PAYLOAD_PREFIX}====`, accepted: false },
  {
    name: "a pad before data",
    value: `${PAYLOAD_PREFIX}=AAA`,
    accepted: false,
  },
  { name: "an empty payload", value: PAYLOAD_PREFIX, accepted: false },
  {
    name: "a newline in the payload",
    value: `${PAYLOAD_PREFIX}AAAA\n`,
    accepted: false,
  },
  {
    name: "a character outside the alphabet",
    value: `${PAYLOAD_PREFIX}AA!A`,
    accepted: false,
  },
  {
    name: "an unsupported image type",
    value: "data:image/bmp;base64,AAAA",
    accepted: false,
  },
  {
    name: "an uppercase scheme",
    value: "DATA:image/jpeg;base64,AAAA",
    accepted: false,
  },
  {
    name: "a parameter before base64",
    value: "data:image/jpeg;charset=utf-8;base64,AAAA",
    accepted: false,
  },
  { name: "not base64 at all", value: "data:image/jpeg,AAAA", accepted: false },
  {
    name: "the longest valid payload under the length limit",
    value: `${PAYLOAD_PREFIX}${"A".repeat(LONGEST_PAYLOAD)}`,
    accepted: true,
  },
  {
    name: "one group over the length limit",
    value: `${PAYLOAD_PREFIX}${"A".repeat(LONGEST_PAYLOAD + 4)}`,
    accepted: false,
  },
];

for (const scenario of cases) {
  test(`parity: ${scenario.name} is ${scenario.accepted ? "accepted" : "refused"} by both the client and the backend`, () => {
    assert.equal(
      isSupportedImageDataUrl(scenario.value),
      scenario.accepted,
      "the backend rule",
    );
    assert.equal(
      isVisualSearchDataUrl(scenario.value),
      scenario.accepted,
      "the client rule",
    );
  });
}
