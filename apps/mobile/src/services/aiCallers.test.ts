import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';

// Source guards for the Pinkie migration. Every mobile AI caller must use the Convex-backed AI actions, and must not
// reach the Railway routes. The retired generic client must not initialize through live wallet helpers or the barrel.

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), 'utf8');

const migratedCallers = [
  'apps/mobile/src/components/ui/AIAssistant.tsx',
  'apps/mobile/src/screens/browse/SearchScreen.tsx',
  'apps/mobile/src/hooks/useAIRecommendations.ts',
  'apps/mobile/src/screens/admin/ListingReviewScreen.tsx',
  'apps/mobile/src/screens/disputes/ChatScreen.tsx',
  'apps/mobile/src/screens/disputes/DisputeDetailScreen.tsx',
];

test('the mobile AI callers use the Convex-backed actions and no Railway route', () => {
  for (const file of migratedCallers) {
    const source = read(file);
    assert.match(source, /useAiActions/, `${file} uses the AI actions hook`);
    assert.doesNotMatch(
      source,
      /apiService\.(chat|getRecommendations|getSimilarProducts|visualSearch|moderateListing|isReachable|checkHealth|rephraseMessage|analyzeDispute|generateResolutionMessage|getResponseSuggestions)\b/,
      `${file} calls no Railway AI method`,
    );
    assert.doesNotMatch(source, /\brequestAI\b/, `${file} has no Railway request helper`);
    assert.doesNotMatch(source, /['"`]\/ai\//, `${file} names no /ai/ route`);
    assert.doesNotMatch(source, /EXPO_PUBLIC_API_URL/, `${file} reads no API URL`);
  }
});

test('the generic client is absent and live service owners retain no removed AI or transport capability', () => {
  assert.equal(
    existsSync(resolve(repoRoot, 'apps/mobile/src/services/api.ts')),
    false,
    'the generic client is retired',
  );
  const api = read('apps/mobile/src/services/wallet.ts') + read('apps/mobile/src/services/index.ts');
  assert.doesNotMatch(
    api,
    /(?:import|export)[\s\S]*?from\s*['"]\.\/api['"]/,
    'no import or re-export of retired transport',
  );
  assert.doesNotMatch(
    api,
    /\b(?:apiService|ApiServiceError|walletService|WalletService)\b/,
    'no generic client or obsolete wallet capability',
  );

  for (const method of ['chat', 'getRecommendations', 'getSimilarProducts', 'visualSearch', 'moderateListing']) {
    assert.doesNotMatch(api, new RegExp(`async ${method}\\(`), `${method} stays absent from live services`);
  }
  for (const type of [
    'ChatRequest',
    'ChatResponse',
    'VisualSearchRequest',
    'ModerateListingRequest',
    'ModerateListingResponse',
  ]) {
    assert.doesNotMatch(api, new RegExp(`interface ${type}\\b`), `${type} stays absent from live services`);
  }

  for (const method of [
    'rephraseMessage',
    'analyzeDispute',
    'generateResolutionMessage',
    'getResponseSuggestions',
    'checkHealth',
    'isReachable',
    'requestAI',
  ]) {
    assert.doesNotMatch(api, new RegExp(`\\b${method}\\(`), `${method} stays absent from live services`);
  }
  for (const type of [
    'RephraseMessageRequest',
    'AnalyzeDisputeRequest',
    'GenerateResolutionMessageRequest',
    'RephraseResponse',
    'DisputeAnalysisResponse',
    'ApiHealthResponse',
  ]) {
    assert.doesNotMatch(api, new RegExp(`interface ${type}\\b`), `${type} stays absent from live services`);
  }
  assert.doesNotMatch(api, /requireAIConsent/, 'live services do not check AI consent for a removed call');
  assert.doesNotMatch(
    api,
    /EXPO_PUBLIC_API_URL|['"`]\/(?:wallet|payments|ai)\//,
    'no legacy URL setting or transport route',
  );
});

test('the services index no longer re-exports the removed AI types', () => {
  const index = read('apps/mobile/src/services/index.ts');

  for (const removed of [
    'GetRecommendationsRequest',
    'GetSimilarProductsRequest',
    'ChatRequest',
    'RecommendationsResponse',
    'ChatResponse',
    'RephraseMessageRequest',
    'AnalyzeDisputeRequest',
    'GenerateResolutionMessageRequest',
    'RephraseResponse',
    'DisputeAnalysisResponse',
    'ApiHealthResponse',
  ]) {
    assert.doesNotMatch(index, new RegExp(`\\b${removed}\\b`), `${removed} is no longer re-exported`);
  }
});

function loadService(relativePath: string): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  const code = ts.transpileModule(read(relativePath), {
    fileName: relativePath,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(
    code,
    {
      exports,
      require: (name: string): never => assert.fail(`Service load reached runtime import ${name}`),
      fetch: (): never => assert.fail('Service load reached HTTP transport'),
      console: { log: (): never => assert.fail('Service load logged initialization') },
      process: { env: {} },
    },
    { filename: relativePath },
  );

  return exports;
}

test('actual wallet helpers and service barrel load with no runtime import, initialization or transport', () => {
  const wallet = loadService('apps/mobile/src/services/wallet.ts');
  const index = loadService('apps/mobile/src/services/index.ts');
  assert.deepEqual(Object.keys(index), [], 'the payment adapter is type-only');

  const invoke = (name: string, ...args: unknown[]): unknown => {
    const helper = wallet[name];
    assert.ok(typeof helper === 'function', `${name} is still a consumed helper`);

    return Reflect.apply(helper, undefined, args);
  };
  assert.equal(invoke('formatWalletAmount', 1250.5), 'K1,250.50');
  assert.equal(invoke('getTransactionTypeLabel', 'refund'), 'Refunded');
  assert.equal(invoke('getTransactionSourceLabel', 'top_up_card'), 'Card Top-up');
  assert.equal(invoke('getTransactionSourceLabel', 'custom_source'), 'custom source');
  assert.equal(invoke('getTransactionIcon', 'debit', 'purchase'), 'shopping');
  assert.equal(invoke('getTransactionIcon', 'credit', 'withdrawal_mobile_money'), 'bank-transfer-out');
  assert.equal(invoke('getTransactionColor', 'credit', 'completed'), '#10B981');
  assert.equal(invoke('getTransactionColor', 'debit', 'failed'), '#EF4444');
  assert.equal(invoke('getTransactionColor', 'credit', 'pending'), '#F59E0B');
});
