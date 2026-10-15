import { query } from "./_generated/server";
import { describeAiConfiguration, type AiConfiguration } from "./lib/aiProvider";

// Truthful AI configuration health. It reports environment presence only, so it never calls the provider. The legacy
// Railway /ai/health route returned a hardcoded `aiConfigured: true`; this query replaces that with a real check.
export const getAiHealth = query({
  args: {},
  handler: async (): Promise<AiConfiguration> => describeAiConfiguration(process.env),
});
