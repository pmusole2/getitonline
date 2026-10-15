import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, URL } from "node:url";

// Source guards for the two web pages that run a Pinkie call. The photo is checked before it is decoded and encoded within
// the backend limit, and each continuation after the call checks the account is still the active one.

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (relativePath: string) =>
  readFileSync(resolve(repoRoot, relativePath), "utf8");

const homePage = read("apps/web/src/app/(main)/page.tsx");
const reviewPage = read(
  "apps/web/src/app/(admin)/admin/products/review/page.tsx",
);

function functionBody(source: string, start: string): string {
  const begin = source.indexOf(start);
  assert.ok(begin >= 0, `${start} is present`);
  const next = source.indexOf("\n  };", begin);
  return source.slice(begin, next);
}

describe("web visual search and review continuations", () => {
  it("the photo is refused by type and size before it is decoded, and encoded within the backend limit", () => {
    const preparation = functionBody(
      homePage,
      "async function fileToSearchDataUrl",
    );
    const check = preparation.indexOf("assertVisualSearchFile(file)");
    const decode = preparation.indexOf("new Image()");

    assert.ok(check >= 0, "the file is checked");
    assert.ok(decode > check, "the file is checked before it is decoded");
    assert.match(
      preparation,
      /encodeVisualSearchImage\(/,
      "the photo is encoded within the limit",
    );
    assert.match(
      preparation,
      /drawImage\(image, 0, 0, size\.width, size\.height\)/,
      "the drawn size is the bounded size",
    );
  });

  it("the home visual search checks the account after the call before it navigates", () => {
    const handler = functionBody(homePage, "const runImageSearch");
    const call = handler.indexOf("await ai.visualSearch(");
    const check = handler.indexOf("ai.isCurrent()", call);
    const navigate = handler.indexOf("router.push(");

    assert.ok(
      call >= 0 && check > call,
      "the account is checked after the call",
    );
    assert.ok(
      navigate > check,
      "the account is checked before the search navigates",
    );
  });

  it("the review moderation checks the account after the call and clears only its own busy mark", () => {
    const handler = functionBody(reviewPage, "const handleAiModeration");
    const call = handler.indexOf("await ai.moderateListing(");
    const check = handler.indexOf("ai.isCurrent()", call);

    assert.ok(
      call >= 0 && check > call,
      "the account is checked after the call",
    );
    assert.match(
      handler,
      /setRunningAiFor\(\(current\) =>\s*current === listing\._id \? null : current,?\s*\)/,
      "the busy mark is cleared only for this listing",
    );
  });
});
