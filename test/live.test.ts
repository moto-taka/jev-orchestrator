import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../src/config.ts';
import { JevProvider } from '../src/decision/provider.ts';
for (const [provider, variable, model] of [['typesafe', 'TYPESAFE_API_KEY', 'jev-latest'], ['vercel', 'AI_GATEWAY_API_KEY', 'typesafe-ai/jev']] as const) {
  test(`LIVE opt-in: ${provider} harmless typed connection check`, { skip: process.env.JVO_LIVE_TESTS !== '1' || !process.env[variable], timeout: 45_000 }, async () => {
    const config = defaults().decision; config.provider = provider; config.model = model; config.retries = 0;
    const result = await new JevProvider(config, process.env[variable]!).evaluate('A connection test only. The supplied number is 2.', { check: { type: 'boolean', instructions: 'Is the supplied number equal to 2?' } });
    assert.equal(result.answers.check?.kind, 'boolean'); assert.equal(result.provider, provider);
  });
}
