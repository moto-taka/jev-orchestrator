import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDemo, DemoAdapter, DemoProvider } from '../src/demo.ts';
import { startRun, Engine } from '../src/engine.ts';
import { git, fingerprint, Workspaces, assertChanges, repository } from '../src/workspaces.ts';
import type { Operation, Task, Decision } from '../src/types.ts';

test('a dirty original checkout requires explicit baseline selection', async () => {
  const f = await createDemo(); try { await f.engine.pause('new test', true); writeFileSync(join(f.engine.run.repo, 'notes.txt'), 'user'); const before = await fingerprint(f.engine.run.repo);
    await assert.rejects(() => startRun(f.store, f.engine.run.repo, 'Fix', f.engine.run.config), /uncommitted/); assert.equal(await fingerprint(f.engine.run.repo), before);
  } finally { f.store.close(); }
});
test('selected dirty baseline applies as a patch without altering the user index or committing user changes', async () => {
  const f = await createDemo(); try {
    await f.engine.pause('replace fixture run', true); const repo = f.engine.run.repo;
    writeFileSync(join(repo, 'notes.txt'), 'user-owned note\n'); await git(repo, ['add', 'notes.txt']);
    const index = await git(repo, ['diff', '--cached', '--binary']), head = await git(repo, ['rev-parse', 'HEAD']);
    const run = await startRun(f.store, repo, 'Fix the addition', f.engine.run.config, { baseline: ['notes.txt'] });
    const e = new Engine(f.store, run.id, new DemoProvider(), { adapter: new DemoAdapter() }); await e.drive(); assert.equal(e.run.status, 'ready_for_user_apply', e.run.blockReason); await e.apply();
    assert.equal(await git(repo, ['rev-parse', 'HEAD']), head); assert.equal(await git(repo, ['diff', '--cached', '--binary']), index); assert.equal(readFileSync(join(repo, 'notes.txt'), 'utf8'), 'user-owned note\n'); assert.match(readFileSync(join(repo, 'calc.cjs'), 'utf8'), /a \+ b/);
  } finally { f.store.close(); }
});
test('in-place mode is explicit, single writer, and keeps edits uncommitted', async () => {
  const f = await createDemo(); try {
    await f.engine.pause('replace fixture run', true); const repo = f.engine.run.repo, head = await git(repo, ['rev-parse', 'HEAD']);
    const run = await startRun(f.store, repo, 'Fix the addition', f.engine.run.config, { mode: 'in-place' });
    const e = new Engine(f.store, run.id, new DemoProvider(), { adapter: new DemoAdapter() }); await e.drive(); assert.equal(e.run.status, 'ready_for_user_apply', e.run.blockReason); await e.apply();
    assert.equal(await git(repo, ['rev-parse', 'HEAD']), head); assert.match(readFileSync(join(repo, 'calc.cjs'), 'utf8'), /a \+ b/);
  } finally { f.store.close(); }
});
test('write scope violations block snapshot approval', async () => {
  const f = await createDemo(); try { const ws = await f.engine.ws.create('scope-test', f.engine.run.base); writeFileSync(join(ws, 'not-allowed.txt'), 'bad'); await assert.rejects(() => assertChanges(ws, f.engine.run.base, ['src/**']), /scope/); }
  finally { f.store.close(); }
});
test('unknown operations retain leases and require explicit recovery before another action', async () => {
  const f = await createDemo(); const adapter = { async run() { return { status: 'unknown' as const, text: 'lost stream', usage: [], error: 'fixture unknown' }; } };
  const e = new Engine(f.store, f.engine.runId, new DemoProvider(), { adapter });
  try { await e.drive(); assert.equal(e.run.status, 'blocked'); const unknown = f.store.all<Operation>('outbox', e.runId).filter(o => o.state === 'unknown'); assert.equal(unknown.length, 1); assert(f.store.held(e.runId).length > 0); await assert.rejects(() => e.resume(), /recover/); await assert.rejects(() => e.recover(false), /acknowledge/); await e.recover(true); assert.equal(f.store.held(e.runId).length, 0); }
  finally { f.store.close(); }
});
test('pending operation is discarded after a user scope change, not executed from an old choice', async () => {
  const f = await createDemo(); try {
    const task = f.engine.tasks[0]!, candidate = { id: 'old', kind: 'START_TASK' as const, taskId: task.id, profileId: 'demo-cli', evidenceIds: [], reason: 'old request' };
    const d: Decision = { id: 'stale-decision', runId: task.runId, taskId: task.id, refs: f.store.refs(task), semanticHash: 'x', candidateHash: 'y', questionVersion: '1', policyHash: 'p', provider: 'fixture', requestedModel: 'fixture', answers: {}, outcome: 'execute', selected: candidate, evidenceIds: [], createdAt: new Date().toISOString() };
    const op: Operation = { id: 'stale-op', runId: task.runId, taskId: task.id, decisionId: d.id, candidate, state: 'pending' }; f.store.commitDecision(d, op);
    f.store.updateRun(task.runId, { scopeVersion: 2 }); await f.engine.drive(); assert.equal(f.store.get<Operation>('outbox', op.id)?.state, 'failed'); assert.equal(f.store.get<Operation>('outbox', op.id)?.error, 'Decision preconditions changed before execution');
  } finally { f.store.close(); }
});


test('non-Git directories fail with setup commands instead of raw rev-parse output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jvo-not-git-'));
  await assert.rejects(() => repository(dir), error => {
    const message = String(error);
    assert.match(message, /Gitリポジトリではありません/);
    assert.match(message, /git init/);
    assert.match(message, /git add <jvoで扱うファイル>/);
    assert.match(message, /git commit -m "Initial commit"/);
    assert.doesNotMatch(message, /Needed a single revision/);
    return true;
  });
});

test('Git repositories without a first commit explain how to create the baseline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jvo-no-head-'));
  await git(dir, ['init']);
  writeFileSync(join(dir, 'todo.txt'), 'first file\n');
  await assert.rejects(() => repository(dir), error => {
    const message = String(error);
    assert.match(message, /まだcommitがありません/);
    assert.match(message, /git status/);
    assert.match(message, /git add <jvoで扱うファイル>/);
    assert.match(message, /git commit --allow-empty -m "Initial commit"/);
    assert.doesNotMatch(message, /Needed a single revision/);
    return true;
  });
});
