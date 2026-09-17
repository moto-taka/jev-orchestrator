import type { Usage } from './types.ts';
import { invariant } from './util.ts';
function count(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined; }
export function codexUsage(u: Record<string, unknown>): Usage {
  const inputTotal = count(u.input_tokens), inputCacheRead = count(u.cached_input_tokens);
  return checked({ inputTotal, inputCacheRead, inputUncached: inputTotal !== undefined && inputCacheRead !== undefined ? inputTotal - inputCacheRead : undefined, outputTotal: count(u.output_tokens), basis: 'provider-reported' });
}
export function anthropicUsage(u: Record<string, unknown>, cost?: unknown): Usage {
  const inputUncached = count(u.input_tokens), inputCacheRead = count(u.cache_read_input_tokens), inputCacheWrite = count(u.cache_creation_input_tokens);
  return checked({ inputUncached, inputCacheRead, inputCacheWrite,
    inputTotal: inputUncached === undefined ? undefined : inputUncached + (inputCacheRead ?? 0) + (inputCacheWrite ?? 0),
    outputTotal: count(u.output_tokens), observedCost: count(cost), currency: typeof cost === 'number' ? 'USD' : undefined, basis: 'provider-reported' });
}
export function piUsage(u: Record<string, unknown>): Usage {
  const inputUncached = count(u.input), inputCacheRead = count(u.cacheRead), inputCacheWrite = count(u.cacheWrite);
  const cost = u.cost && typeof u.cost === 'object' ? count((u.cost as Record<string, unknown>).total) : undefined;
  return checked({ inputUncached, inputCacheRead, inputCacheWrite, inputTotal: inputUncached === undefined ? undefined : inputUncached + (inputCacheRead ?? 0) + (inputCacheWrite ?? 0), outputTotal: count(u.output), estimatedCost: cost, currency: cost === undefined ? undefined : 'USD', basis: 'adapter-derived' });
}
export function opencodeUsage(u: Record<string, unknown>, cost?: unknown): Usage {
  const cache = (u.cache && typeof u.cache === 'object' ? u.cache : {}) as Record<string, unknown>;
  const inputUncached = count(u.input), inputCacheRead = count(cache.read), inputCacheWrite = count(cache.write);
  return checked({ inputUncached, inputCacheRead, inputCacheWrite, inputTotal: inputUncached === undefined ? undefined : inputUncached + (inputCacheRead ?? 0) + (inputCacheWrite ?? 0), outputTotal: count(u.output), estimatedCost: count(cost), currency: typeof cost === 'number' ? 'USD' : undefined, basis: 'adapter-derived' });
}
export function checked(u: Usage): Usage {
  for (const [k, v] of Object.entries(u)) if (typeof v === 'number') invariant(Number.isFinite(v) && v >= 0, `Invalid usage ${k}`);
  if (u.inputTotal !== undefined && u.inputCacheRead !== undefined) invariant(u.inputCacheRead <= u.inputTotal, 'Cached input exceeds total input');
  return u;
}
export function summarizeUsage(items: Usage[]): { input?: number; output?: number; cacheRate?: number; observed: number; cacheObserved: number; total: number; cost?: number; estimatedCost?: number } {
  const known = items.filter(i => i.inputTotal !== undefined);
  const cache = items.filter(i => i.inputTotal !== undefined && i.inputCacheRead !== undefined);
  const denominator = cache.reduce((n, i) => n + i.inputTotal!, 0);
  const output = items.filter(i => i.outputTotal !== undefined), costs = items.filter(i => i.observedCost !== undefined && i.currency === 'USD');
  const estimates = items.filter(i => i.estimatedCost !== undefined && i.currency === 'USD');
  return {
    input: known.length ? known.reduce((n, i) => n + i.inputTotal!, 0) : undefined,
    output: output.length ? output.reduce((n, i) => n + i.outputTotal!, 0) : undefined,
    cacheRate: denominator > 0 ? cache.reduce((n, i) => n + i.inputCacheRead!, 0) / denominator : undefined,
    observed: known.length, cacheObserved: cache.length, total: items.length,
    cost: costs.length ? costs.reduce((n, i) => n + i.observedCost!, 0) : undefined,
    estimatedCost: estimates.length ? estimates.reduce((n, i) => n + i.estimatedCost!, 0) : undefined,
  };
}
