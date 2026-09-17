import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage.ts';
import { defaults } from '../src/config.ts';
import { makeTask } from '../src/engine.ts';
import type { Run, Task, Decision, Operation } from '../src/types.ts';
const fixture = () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'jvo-db-'))), c = defaults();
  const run = { id: 'r', scopeVersion: 1, config: c, repo: tmpdir() } as Run;
  s.put('runs', 'r', 'r', run);
  const spec = { id: 'A', title: 'A', instruction: 'A', acceptance: ['OK'], dependsOn: [], readPaths: ['**'], writePaths: ['**'], resources: [] };
  const t = makeTask(run, spec); s.put('tasks', t.id, 'r', t); return { s, t };
};
function decision(t: Task, s: Store): { d: Decision; op: Operation } {
  const candidate = { id: 'c', kind: 'START_TASK' as const, taskId: t.id, evidenceIds: [], reason: 'test' };
  return { d: { id: 'd', runId: 'r', taskId: t.id, refs: s.refs(t), semanticHash: 'h', candidateHash: 'c', questionVersion: 'v1', policyHash: 'p', provider: 'fixture', requestedModel: 'fixture', answers: {}, selected: candidate, outcome: 'execute', evidenceIds: [], createdAt: new Date().toISOString() },
    op: { id: 'o', runId: 'r', taskId: t.id, decisionId: 'd', candidate, state: 'pending' } };
}
test('transactions roll back state and journal atomically', () => {
  const { s } = fixture(); try { assert.throws(() => s.tx(() => { s.put('artifacts', 'temp', 'r', { value: 1 }); s.event('r', 'temp', {}); throw new Error('rollback'); })); assert.equal(s.get('artifacts', 'temp'), undefined); assert.equal(s.events('r').length, 0); } finally { s.close(); }
});
test('decision and outbox commit atomically and duplicate events do not start a second operation', () => {
  const { s, t } = fixture(); try { const { d, op } = decision(t, s); assert(s.commitDecision(d, op)); assert(!s.commitDecision(d, op)); assert.equal(s.all('outbox').length, 1); assert.equal(s.get<Decision>('decisions', 'd')?.outcome, 'execute'); } finally { s.close(); }
});
test('stale task decision records failure but never queues an operation', () => {
  const { s, t } = fixture(); try { const { d, op } = decision(t, s); s.updateTask(t.id, { phase: 'review' }); assert(!s.commitDecision(d, op)); assert.equal(s.get<Decision>('decisions', 'd')?.outcome, 'stale'); assert.equal(s.all('outbox').length, 0); } finally { s.close(); }
});
test('unrelated task progress does not invalidate a decision readset', () => {
  const { s, t } = fixture(); try { const refs = s.refs(t), b = { ...t, id: 'r_B' }; s.put('tasks', b.id, 'r', b); s.updateTask(b.id, { lastActivity: 'unrelated' }); assert(s.fresh('r', refs)); s.updateRun('r', { scopeVersion: 2 }); assert(!s.fresh('r', refs)); } finally { s.close(); }
});
test('leases are atomic and are never stolen based only on expiry', () => {
  const { s } = fixture(); try { assert(s.lease(['a', 'b'], 'first', 'r', -1)); assert(!s.lease(['b', 'c'], 'second', 'r', 100)); assert(!s.held().some(l => l.resource === 'c')); s.release('first'); assert(s.lease(['b', 'c'], 'second', 'r', 100)); } finally { s.close(); }
});
test('artifacts are content-addressed and integrity is checked when read', () => {
  const { s } = fixture(); try { const h = s.artifact('r', 'proof'); assert.equal(h, s.artifact('r', 'proof')); assert.equal(s.readArtifact(h), 'proof'); writeFileSync(join(s.root, 'artifacts', h), 'tampered'); assert.throws(() => s.readArtifact(h)); } finally { s.close(); }
});
test('event replay verifies the journal without any model or command execution', () => {
  const { s } = fixture(); try { s.event('r', 'one', { a: 1 }); s.event('r', 'two', { b: 2 }); assert(s.verifyJournal('r')); assert.equal(s.events('r').length, 2); s.db.prepare('UPDATE events SET data=? WHERE seq=1').run('{"tampered":true}'); assert(!s.verifyJournal('r')); } finally { s.close(); }
});
test('usage observations have idempotent keys', () => {
  const { s } = fixture(); try { s.usage('turn1', 'r', { inputTotal: 10, basis: 'provider-reported' }); s.usage('turn1', 'r', { inputTotal: 10, basis: 'provider-reported' }); assert.equal(s.all('usage').length, 1); } finally { s.close(); }
});
