import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

// Source guards for the web's Pinkie callers. Both must go through the Convex AI actions behind the consent gate, must
// not reach the Railway API, and must send the moderation request with the product id only.

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (relativePath: string) =>
  readFileSync(resolve(repoRoot, relativePath), "utf8");

const homePage = read("apps/web/src/app/(main)/page.tsx");
const reviewPage = read(
  "apps/web/src/app/(admin)/admin/products/review/page.tsx",
);
const aiActions = read("apps/web/src/hooks/useAiActions.ts");
const consentGate = read("apps/web/src/hooks/useAiConsentGate.tsx");
const consentDialog = read("apps/web/src/components/ai/AiConsentDialog.tsx");

test("both web callers use the AI actions behind the consent gate", () => {
  for (const [name, source] of [
    ["home page", homePage],
    ["listing review page", reviewPage],
  ] as const) {
    assert.match(source, /useAiActions\(\)/, `${name} uses the AI actions`);
    assert.match(
      source,
      /useAiConsentGate\(ai\.subject\)/,
      `${name} gates the call on consent for its account`,
    );
    assert.match(
      source,
      /aiGate\.consentDialog/,
      `${name} shows the disclosure before the first call`,
    );
    assert.doesNotMatch(source, /\bfetch\(/, `${name} makes no raw fetch`);
    assert.doesNotMatch(
      source,
      /['"`]\/ai\//,
      `${name} names no Railway /ai/ route`,
    );
    assert.doesNotMatch(
      source,
      /NEXT_PUBLIC_API_URL/,
      `${name} reads no API URL`,
    );
  }
});

test("the moderation call sends only the product id", () => {
  assert.match(
    reviewPage,
    /ai\.moderateListing\(\{ productId: listing\._id \}\)/,
  );
  const handler = reviewPage.slice(
    reviewPage.indexOf("const handleAiModeration"),
    reviewPage.indexOf("\n  return ("),
  );
  assert.doesNotMatch(
    handler,
    /imageUrls|description:|price:|quantity:|categoryName/,
    "no listing content leaves the page",
  );
});

test("the visual search call sends the photo and reads the typed result", () => {
  assert.match(homePage, /ai\.visualSearch\(\{ imageDataUrl \}\)/);
  assert.match(
    homePage,
    /aiFailureMessage\(error\)/,
    "refusals show their copy",
  );
});

test("the web AI actions use the Convex actions and a browser-stored guest session", () => {
  assert.match(aiActions, /api\.aiDiscovery\.visualSearch/);
  assert.match(aiActions, /api\.aiModeration\.moderateListing/);
  assert.match(aiActions, /createAiRequests\(/);
  assert.match(aiActions, /getOrCreateGuestSessionId\(/);
  assert.match(
    aiActions,
    /browserStore/,
    "guest id and consent use the browser store",
  );
  assert.match(
    read("apps/web/src/hooks/aiConsentGate.ts"),
    /window\.localStorage/,
  );
  assert.match(aiActions, /isAiConsentAllowed\(/);
  assert.doesNotMatch(aiActions, /\bfetch\(/);
});

test("the consent gate checks consent before running and stores acceptance for the captured subject", () => {
  assert.match(consentGate, /decideAiConsent\(/);
  assert.match(
    consentGate,
    /acceptAiConsent\(browserStore, current\.subject\)/,
  );
});

test("the disclosure says what is sent to the AI provider for each feature", () => {
  assert.match(consentDialog, /OpenAI/);
  assert.match(consentDialog, /photo you choose/);
  assert.match(
    consentDialog,
    /stored title, description, price, quantity, and category/,
  );
  assert.match(consentDialog, /Not now/);
  assert.match(consentDialog, /Allow/);
});
