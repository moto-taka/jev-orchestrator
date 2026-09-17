import { readFileSync } from 'node:fs';
import type { DecisionProvider, Json, Question } from './types.ts';
import { invariant, object } from './util.ts';
import { SecretGuard } from './security.ts';
export interface LabeledCase { id: string; state: Json; questions: Record<string, Question>; labels: Record<string, boolean | string | number>; }
export function readDataset(path: string): LabeledCase[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const data: unknown = Array.isArray(parsed) ? parsed : object(parsed).cases; invariant(Array.isArray(data) && data.length <= 1000, 'Dataset must be an array of at most 1000 labeled cases');
  for (const item of data) { const o = object(item); invariant(typeof o.id === 'string' && o.state !== undefined, 'Invalid evaluation case'); const questions = object(o.questions), labels = object(o.labels);
    invariant(Object.keys(labels).length > 0, `Case ${o.id} needs independently reviewed labels before evaluation`);
    for (const [key, label] of Object.entries(labels)) invariant(questions[key] !== undefined && ['string', 'boolean', 'number'].includes(typeof label), `Invalid label: ${key}`); }
  return data as LabeledCase[];
}
export async function evaluateDataset(provider: DecisionProvider, cases: LabeledCase[], guard: SecretGuard, signal?: AbortSignal): Promise<unknown> {
  const results: unknown[] = []; let total = 0, correct = 0, falseApprovals = 0, negatives = 0, squared = 0, probabilityCount = 0;
  for (const c of cases) {
    guard.assertOutbound(JSON.stringify(c));
    const result = await provider.evaluate(c.state, c.questions, signal);
    const labels: Record<string, unknown> = {};
    for (const [key, expected] of Object.entries(c.labels)) {
      const answer = result.answers[key]; invariant(answer, `Missing answer: ${key}`); total++;
      const predicted = answer.kind === 'boolean' ? answer.probability >= 0.5 : answer.kind === 'choice' ? answer.selected : answer.value;
      const match = typeof expected === 'number' && typeof predicted === 'number' ? Math.abs(expected - predicted) <= 0.25 : predicted === expected;
      if (match) correct++;
      if (typeof expected === 'boolean' && answer.kind === 'boolean') { squared += (answer.probability - Number(expected)) ** 2; probabilityCount++; if (!expected) { negatives++; if (answer.probability >= 0.8) falseApprovals++; } }
      labels[key] = { expected, predicted, correct: match, answer };
    }
    results.push({ id: c.id, labels, model: result.resolvedModel ?? result.requestedModel, usage: result.usage });
  }
  return { cases: cases.length, questions: total, agreement: total ? correct / total : null, brierScore: probabilityCount ? squared / probabilityCount : null,
    falseApprovalRateAt08: negatives ? falseApprovals / negatives : null, results, note: 'Only labeled offline states were evaluated. No tools, worker commands, or file mutations were executed. API requests may be billed.' };
}
