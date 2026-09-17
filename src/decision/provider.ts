import type { Answer, Config, DecisionProvider, Evaluation, Json, Question } from '../types.ts';
import { delay, errorText, invariant, object, text } from '../util.ts';
export function probability(value: unknown, label: string): number {
  invariant(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1, `Invalid probability: ${label}`); return value;
}
function distribution(value: unknown, keys: string[], tolerance = 0.015): Record<string, number> {
  const o = object(value);
  invariant(Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k)), 'Distribution keys do not match the question');
  const result = Object.fromEntries(keys.map(k => [k, probability(o[k], k)]));
  invariant(Math.abs(Object.values(result).reduce((n, v) => n + v, 0) - 1) <= tolerance, 'Probabilities do not sum to one');
  return result;
}
export function normalize(raw: unknown, questions: Record<string, Question>, provider: 'typesafe' | 'vercel', model: string): Evaluation {
  const body = object(raw), answers = object(body.answers);
  invariant(Object.keys(answers).length === Object.keys(questions).length, 'Missing or extra answers');
  const metadata = body.providerMetadata && typeof body.providerMetadata === 'object' ? body.providerMetadata as Record<string, unknown> : {};
  const ts = metadata.typesafe && typeof metadata.typesafe === 'object' ? metadata.typesafe as Record<string, unknown> : {};
  const confidences = ts.confidence && typeof ts.confidence === 'object' ? ts.confidence as Record<string, unknown> : {};
  const output: Record<string, Answer> = {};
  for (const [key, q] of Object.entries(questions)) {
    const a = object(answers[key]);
    invariant(a.type === (q.type === 'boolean' && provider === 'typesafe' ? 'noul' : q.type), `Answer type mismatch: ${key}`);
    if (q.type === 'boolean') { output[key] = { kind: 'boolean', probability: probability(provider === 'typesafe' ? a.noul : a.probability, key) }; continue; }
    const rawConfidence = provider === 'typesafe' ? a.confidence : confidences[key];
    const confidence = rawConfidence === undefined ? undefined : probability(rawConfidence, 'confidence');
    if (q.type === 'choice') {
      const probs = distribution(a.probabilities, Object.keys(q.criteria));
      const selected = text(a.choice);
      invariant(Object.hasOwn(q.criteria, selected), 'Unknown selected candidate');
      invariant(probs[selected]! + 0.015 >= Math.max(...Object.values(probs)), 'Selected candidate is inconsistent with the distribution');
      output[key] = { kind: 'choice', selected, probabilities: probs, confidence };
    } else {
      const keys = q.criteria.map((_, i) => String(i));
      const probs = distribution(a.probabilities, keys);
      if (provider === 'typesafe') {
        const legend = object(a.legend);
        invariant(keys.every((k, i) => legend[k] === q.criteria[i]) && Object.keys(legend).length === keys.length, 'Score legend mismatch');
      }
      invariant(typeof a.score === 'number' && Number.isFinite(a.score) && a.score >= 0 && a.score <= q.criteria.length - 1, 'Invalid score');
      const expected = keys.reduce((sum, k) => sum + Number(k) * probs[k]!, 0);
      invariant(Math.abs(expected - a.score) <= 0.025 * q.criteria.length, 'Score does not match the distribution');
      output[key] = { kind: 'score', value: a.score, levels: q.criteria, probabilities: probs, confidence };
    }
  }
  const usage = body.usage && typeof body.usage === 'object' ? body.usage as Record<string, unknown> : {};
  const count = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
  const response = body.response && typeof body.response === 'object' ? body.response as Record<string, unknown> : {};
  return { answers: output, provider, requestedModel: model,
    resolvedModel: typeof body.model === 'string' ? body.model : typeof response.modelId === 'string' ? response.modelId : undefined,
    usage: { inputTotal: count(usage.input_tokens ?? usage.inputTokens), outputTotal: count(usage.output_tokens ?? usage.outputTokens), basis: Object.keys(usage).length ? 'provider-reported' : 'unavailable' } };
}
export class ProviderError extends Error {
  status: number;
  retryAfter?: number;
  constructor(message: string, status = 0, retryAfter?: number) { super(message); this.name = 'ProviderError'; this.status = status; this.retryAfter = retryAfter; }
}
export class JevProvider implements DecisionProvider {
  identity: string;
  private config: Config['decision'];
  private key: string;
  private fetcher: typeof fetch;
  constructor(config: Config['decision'], key: string, fetcher: typeof fetch = fetch) {
    this.config = config; this.key = key; this.fetcher = fetcher;
    this.identity = `${config.provider}:${config.model}:${config.transport}:${config.endpoint ?? 'official'}`;
  }
  async evaluate(state: Json, questions: Record<string, Question>, signal?: AbortSignal): Promise<Evaluation> {
    invariant(Object.keys(questions).length > 0 && Object.keys(questions).length <= 64, 'Invalid number of questions');
    for (const q of Object.values(questions)) {
      invariant(q.instructions.length > 0, 'Question instructions are required');
      if (q.type === 'score') invariant(q.criteria.length >= 2 && q.criteria.length <= 20, 'Invalid score levels');
      if (q.type === 'choice') invariant(Object.keys(q.criteria).length >= 2 && Object.keys(q.criteria).length <= 200, 'Invalid choice count');
    }
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const abortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    if (this.config.provider === 'vercel' && this.config.transport === 'sdk') return this.sdk(state, questions, abortSignal);
    const direct = this.config.provider === 'typesafe';
    const endpoint = this.config.endpoint ?? (direct ? 'https://api.typesafe.ai/v1/systemone' : 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model');
    const wire = direct ? Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { ...q, type: q.type === 'boolean' ? 'noul' : q.type }])) : questions;
    let r: Response;
    try {
      r = await this.fetcher(endpoint, {
        method: 'POST', redirect: 'error', signal: abortSignal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}`,
          ...(!direct ? { 'ai-evaluation-model-specification-version': '4', 'ai-model-id': this.config.model, 'ai-gateway-auth-method': 'api-key', 'ai-gateway-protocol-version': '0.0.1' } : {}) },
        body: JSON.stringify(direct ? { model: this.config.model, state, questions: wire } : { state, questions: wire, providerOptions: { gateway: this.config.gatewayOptions } }),
      });
    } catch (e) { if (abortSignal.aborted) throw abortSignal.reason; throw new ProviderError(`Jev connection failed: ${errorText(e)}`); }
    if (!r.ok) {
      const retry = Number(r.headers.get('retry-after'));
      // Provider errors can echo request content. Do not persist or print the body.
      await r.body?.cancel();
      throw new ProviderError(`Jev HTTP ${r.status}`, r.status, Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 30_000) : undefined);
    }
    const bytes = await readBounded(r, 1_000_000);
    return normalize(JSON.parse(bytes), questions, this.config.provider, this.config.model);
  }
  private async sdk(state: Json, questions: Record<string, Question>, abortSignal: AbortSignal): Promise<Evaluation> {
    // Optional, explicit transport. No global API-key mutation and no silent fallback.
    const aiName = 'ai', gatewayName = '@ai-sdk/gateway';
    let sdk: Record<string, unknown>, gateway: Record<string, unknown>;
    try { sdk = await import(aiName) as Record<string, unknown>; gateway = await import(gatewayName) as Record<string, unknown>; }
    catch { throw new Error('SDK transport requires ai >= 7.0.105 and @ai-sdk/gateway with evaluationModel support. Install them in this package, or explicitly select the built-in http transport.'); }
    const evaluate = sdk.experimental_evaluate as ((options: unknown) => Promise<unknown>) | undefined;
    const createGateway = gateway.createGateway as ((options: unknown) => { evaluationModel(id: string): unknown }) | undefined;
    invariant(typeof evaluate === 'function' && typeof createGateway === 'function', 'Installed SDK has no evaluation API');
    const g = createGateway({ apiKey: this.key });
    invariant(typeof g.evaluationModel === 'function', 'Gateway SDK lacks evaluationModel');
    const result = await evaluate({ model: g.evaluationModel(this.config.model), state, questions, maxRetries: 0, abortSignal, providerOptions: { gateway: this.config.gatewayOptions } });
    return normalize(result, questions, 'vercel', this.config.model);
  }
}
async function readBounded(response: Response, max: number): Promise<string> {
  invariant(response.body, 'Empty provider response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const r = await reader.read(); if (r.done) break; bytes += r.value.length; invariant(bytes <= max, 'Provider response exceeded limit'); chunks.push(r.value); }
  } catch (e) { await reader.cancel(); throw e; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
export async function withRetries<T>(fn: () => Promise<T>, retries: number, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await fn(); }
    catch (e) {
      const transient = e instanceof ProviderError && [0, 408, 429, 500, 502, 503, 504, 529].includes(e.status);
      if (signal?.aborted || !transient || attempt >= retries) throw e;
      await delay(e.retryAfter ?? Math.min(30_000, 500 * 2 ** attempt + Math.floor(Math.random() * 200)), signal);
    }
  }
}
