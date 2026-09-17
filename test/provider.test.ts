import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, JevProvider, withRetries, ProviderError } from '../src/decision/provider.ts';
import { defaults } from '../src/config.ts';
import type { Question } from '../src/types.ts';
const questions: Record<string, Question> = { yes: { type: 'boolean', instructions: 'Is it true?' }, action: { type: 'choice', instructions: 'Choose', criteria: { a: 'A', b: 'B' } }, level: { type: 'score', instructions: 'Rate', criteria: ['Low', 'Medium', 'High'] } };
function official(): any { return { model: 'jev-fixed-test', answers: { yes: { type: 'noul', noul: 0.9 }, action: { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 }, confidence: 0.7 }, level: { type: 'score', score: 1.2, legend: { 0: 'Low', 1: 'Medium', 2: 'High' }, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 }, confidence: 0.4 } }, usage: { input_tokens: 100, output_tokens: 10 } }; }
test('TypeSafe choice, weighted score and noul normalize with evidence intact', () => {
  const e = normalize(official(), questions, 'typesafe', 'jev-latest');
  assert.deepEqual(e.answers.yes, { kind: 'boolean', probability: 0.9 }); assert.equal(e.resolvedModel, 'jev-fixed-test'); assert.equal(e.usage.inputTotal, 100);
  assert.equal(e.answers.level?.kind === 'score' && e.answers.level.value, 1.2);
});
test('Gateway uses boolean probability and per-question metadata confidence', () => {
  const r = official(); r.answers.yes = { type: 'boolean', probability: 0.9 }; delete r.answers.action.confidence; delete r.answers.level.confidence;
  r.providerMetadata = { typesafe: { confidence: { action: 0.65 } } }; r.usage = { inputTokens: 42, outputTokens: 3 };
  const result = normalize(r, questions, 'vercel', 'typesafe-ai/jev');
  assert.equal(result.answers.action?.kind === 'choice' && result.answers.action.confidence, 0.65);
  assert.equal(result.answers.level?.kind === 'score' && result.answers.level.confidence, undefined);
  assert.equal(result.usage.inputTotal, 42);
});
for (const [name, mutate] of Object.entries({
  'unknown selected candidate': (r: any) => { r.answers.action.choice = 'evil'; },
  'missing probability distribution': (r: any) => { delete r.answers.action.probabilities; },
  'probabilities not normalized': (r: any) => { r.answers.action.probabilities.a = 0.2; },
  'out of range boolean': (r: any) => { r.answers.yes.noul = 1.1; },
  'missing answer': (r: any) => { delete r.answers.yes; },
  'legend changed': (r: any) => { r.answers.level.legend[0] = 'Unexpected'; },
  'score inconsistent with probabilities': (r: any) => { r.answers.level.score = 0; },
  'NaN confidence': (r: any) => { r.answers.action.confidence = NaN; },
})) test(`provider rejects ${name}`, () => { const r = official(); mutate(r); assert.throws(() => normalize(r, questions, 'typesafe', 'jev-latest')); });
test('official transport sends typed schema to exact endpoint and bearer credential', async () => {
  const config = defaults().decision; let captured: any;
  const fake: typeof fetch = async (url, init) => { captured = { url, init }; return new Response(JSON.stringify(official())); };
  await new JevProvider(config, 'test-key', fake).evaluate({ task: 'test' }, questions);
  assert.equal(captured.url, 'https://api.typesafe.ai/v1/systemone');
  const body = JSON.parse(captured.init.body); assert.equal(body.model, 'jev-latest'); assert.equal(body.questions.yes.type, 'noul'); assert.equal(captured.init.headers.authorization, 'Bearer test-key'); assert.equal(captured.init.redirect, 'error');
});
test('Gateway HTTP transport matches the evaluation v4 protocol, not chat completions', async () => {
  const config = defaults().decision; config.provider = 'vercel'; config.model = 'typesafe-ai/jev'; let captured: any;
  const fake: typeof fetch = async (url, init) => { captured = { url, init }; const r = official(); r.answers.yes = { type: 'boolean', probability: 0.9 }; return new Response(JSON.stringify(r)); };
  await new JevProvider(config, 'test-key', fake).evaluate('state', questions);
  assert.equal(captured.url, 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model'); assert.equal(captured.init.headers['ai-evaluation-model-specification-version'], '4');
  assert.equal(captured.init.headers['ai-model-id'], 'typesafe-ai/jev'); assert.equal(JSON.parse(captured.init.body).questions.yes.type, 'boolean');
});
test('HTTP failure never prints a provider response that may echo the secret', async () => {
  const fake: typeof fetch = async () => new Response('SECRET in provider error', { status: 401 });
  await assert.rejects(() => new JevProvider(defaults().decision, 'test-key', fake).evaluate('x', { yes: questions.yes! }), e => e instanceof ProviderError && e.status === 401 && !e.message.includes('SECRET'));
});
test('bounded retry does not retry schema errors or authorization failures', async () => {
  let count = 0;
  await assert.rejects(() => withRetries(async () => { count++; throw new ProviderError('unauthorized', 401); }, 3)); assert.equal(count, 1);
  count = 0;
  const result = await withRetries(async () => { if (count++ === 0) throw new ProviderError('busy', 429, 1); return 'ok'; }, 1); assert.equal(result, 'ok'); assert.equal(count, 2);
});
test('abort prevents a new provider request', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(() => withRetries(async () => { calls++; return 1; }, 3, controller.signal)); assert.equal(calls, 0);
});
