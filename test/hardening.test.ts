import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage.ts';
import { createDemo, DemoProvider } from '../src/demo.ts';
import { hash, canonical } from '../src/util.ts';
import { EventParser } from '../src/adapters/native.ts';
import { SecretGuard } from '../src/security.ts';
import { assertManagedDirectory } from '../src/process.ts';
import { readDataset } from '../src/eval.ts';
import { skillContext } from '../src/context.ts';
import type { Decision, Question, Json } from '../src/types.ts';

test('offline replay does not create WAL sidecars or mutate the checkpointed database', () => {
  const root = mkdtempSync(join(tmpdir(), 'jvo-replay-ro-')); const s = new Store(root); s.event('fixture', 'proof', { immutable: true }); s.close();
  const before = hash(readFileSync(join(root, 'state.sqlite')).toString('base64')), files = readdirSync(root);
  const ro = new Store(root, { readOnly: true }); assert(ro.verifyJournal('fixture')); assert.throws(() => ro.event('fixture', 'bad', {}), /readonly|read-only/i); ro.close();
  assert.deepEqual(readdirSync(root), files); assert.equal(hash(readFileSync(join(root, 'state.sqlite')).toString('base64')), before);
});
test('offline replay refuses an active WAL instead of mutating or reading an incomplete checkpoint', () => {
  const root = mkdtempSync(join(tmpdir(), 'jvo-replay-active-')); const s = new Store(root);
  try { s.event('fixture', 'proof', {}); assert.throws(() => new Store(root, { readOnly: true }), /journal/); } finally { s.close(); }
});
test('all persisted decision hashes reference the exact frozen request and questions, including the action candidates', async () => {
  const f = await createDemo(); try { await f.engine.drive();
    for (const d of f.store.all<Decision>('decisions', f.engine.runId)) {
      const state = f.store.readArtifact(d.semanticHash); assert.equal(hash(state), d.semanticHash);
      assert(d.questionArtifact); const questions = JSON.parse(f.store.readArtifact(d.questionArtifact)); assert(Object.keys(questions).length);
      if (d.selected) { const parsed = JSON.parse(state); assert(parsed.candidates.some((c: any) => c.id === d.selected!.id)); assert.equal(hash(parsed.candidates), d.candidateHash); }
    }
  } finally { f.store.close(); }
});
test('strict decision memo repeats only an exact request and records its provenance', async () => {
  const f = await createDemo(); try {
    const task = f.engine.tasks[0]!, state: Json = { task: 'same', snapshot: 'A' }, q: Record<string, Question> = { relevant: { type: 'boolean', instructions: 'Is this state relevant?' } };
    const first = await (f.engine as any).evaluate(task, state, q, new AbortController().signal), calls = f.engine.run.decisionCalls;
    const second = await (f.engine as any).evaluate(task, state, q, new AbortController().signal);
    assert.equal(f.engine.run.decisionCalls, calls); assert.equal(second.source, first.decisionId);
    await (f.engine as any).evaluate(task, { ...state as object, snapshot: 'B' }, q, new AbortController().signal); assert.equal(f.engine.run.decisionCalls, calls + 1);
  } finally { f.store.close(); }
});
test('duplicate Codex completion usage replaces the same turn, rather than doubling tokens', () => {
  const p = new EventParser('codex'); p.accept({ type: 'turn.started' }); const e = { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } }; p.accept(e); p.accept(e);
  assert.equal(p.usage.size, 1); assert.equal([...p.usage.values()][0]!.inputTotal, 100);
  p.accept({ type: 'turn.started' }); p.accept(e); assert.equal(p.usage.size, 2);
});
test('approved policy refresh retains files but invalidates tests, reviews and changed session affinity', async () => {
  const f = await createDemo(); try {
    await f.engine.drive(); const t = f.engine.tasks.find(t => t.kind === 'work')!, before = readFileSync(join(t.workspace!, 'calc.cjs'), 'utf8');
    const config = JSON.parse(canonical(f.engine.run.config)); config.profiles[0].model = 'another-explicitly-approved-model';
    await f.engine.refreshPolicy(config, new DemoProvider(), new SecretGuard()); const after = f.store.task(t.id);
    assert.equal(f.engine.run.status, 'paused'); assert.equal(after.sessionId, undefined); assert.equal(after.testedSnapshot, undefined); assert.equal(after.reviewCount, 0); assert.equal(after.phase, 'verify'); assert.equal(readFileSync(join(t.workspace!, 'calc.cjs'), 'utf8'), before);
  } finally { f.store.close(); }
});
test('nested plan cannot broaden the parent write scope', async () => {
  const f = await createDemo(); try {
    const t = f.engine.tasks[0]!, spec = { ...t.spec, id: 'child', writePaths: ['**'], dependsOn: [] };
    f.store.updateTask(t.id, { spec: { ...t.spec, writePaths: ['src/**'] }, proposedPlan: [spec] });
    assert.throws(() => (f.engine as any).adoptPlan(f.store.task(t.id)), /expands/);
  } finally { f.store.close(); }
});
test('symlink ancestors cannot redirect workspaces or opted-in skills outside their root', async () => {
  const f = await createDemo(); try {
    const root = join(f.root, 'safe'), outside = join(f.root, 'outside'); mkdirSync(root); mkdirSync(outside); mkdirSync(join(outside, 'leaf')); writeFileSync(join(outside, 'leaf', 'SKILL.md'), 'description: hidden'); symlinkSync(outside, join(root, 'alias'));
    assert.throws(() => assertManagedDirectory(root, join(root, 'alias', 'leaf')), /escaped|symlink/);
    symlinkSync(join(outside, 'leaf'), join(root, 'skill')); assert.equal(skillContext({ ...f.engine.run.trust, skills: [root] }).length, 0);
  } finally { f.store.close(); }
});
test('shadow evaluation requires actual independent labels before making calls', () => {
  const root = mkdtempSync(join(tmpdir(), 'jvo-eval-')), p = join(root, 'data.json');
  writeFileSync(p, JSON.stringify({ cases: [{ id: 'x', state: {}, questions: { check: { type: 'boolean', instructions: 'Check evidence' } }, labels: {} }] })); assert.throws(() => readDataset(p), /labels/);
});
