import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDemo, DemoProvider } from '../src/demo.ts';
import { Engine } from '../src/engine.ts';
import { git } from '../src/workspaces.ts';
import { delay } from '../src/util.ts';
import type { AgentAdapter, AgentResult, Candidate, Invocation, Json, Question, TaskSpec } from '../src/types.ts';
class PlanProvider extends DemoProvider {
  override async evaluate(state: Json, questions: Record<string, Question>) {
    const result = await super.evaluate(state, questions), s = state as Record<string, any>;
    const cs = (s.candidates ?? []) as Candidate[];
    const plan = s.task?.id === 'T1' && s.phase === 'assess' ? cs.find(c => c.kind === 'REQUEST_PLAN') : undefined;
    if (plan && questions.action?.type === 'choice') result.answers.action = { kind: 'choice', selected: plan.id, probabilities: Object.fromEntries(cs.map(c => [c.id, c.id === plan.id ? 1 : 0])), confidence: 1 };
    return result;
  }
}
class GraphAdapter implements AgentAdapter {
  conflict: boolean; active = 0; maximum = 0; entered = 0; private open!: () => void; private barrier: Promise<void>;
  constructor(conflict: boolean) { this.conflict = conflict; this.barrier = new Promise<void>(r => { this.open = r; }); }
  async run(i: Invocation): Promise<AgentResult> {
    const report: NonNullable<AgentResult['report']> = { summary: 'Test fixture graph action', claims: [], questions: [], findings: [] };
    if (i.role === 'planner') report.plan = ['A', 'B'].map((id, index) => ({ id, title: `Change ${id}`, instruction: `Set component ${id} to ${index + 1}`, acceptance: [`${id} has the requested value`], dependsOn: [], readPaths: ['**'], writePaths: this.conflict ? ['pair.cjs'] : [`${id.toLowerCase()}.cjs`], resources: [] }));
    if (i.role === 'implementer') {
      this.active++; this.maximum = Math.max(this.maximum, this.active);
      if (!i.taskId.includes('merge-')) { this.entered++; if (this.entered >= 2) this.open(); await this.barrier; }
      await delay(25);
      if (this.conflict) writeFileSync(join(i.cwd, 'pair.cjs'), i.taskId.includes('merge-') ? 'module.exports = {a:1,b:2};\n' : i.taskId.endsWith('-A') ? 'module.exports = {a:1,b:0};\n' : 'module.exports = {a:0,b:2};\n');
      else writeFileSync(join(i.cwd, i.taskId.endsWith('-A') ? 'a.cjs' : 'b.cjs'), i.taskId.endsWith('-A') ? 'module.exports = 1;\n' : 'module.exports = 2;\n');
      this.active--;
    }
    return { status: 'reported', sessionId: i.sessionId ?? `fixture-${i.id}`, text: JSON.stringify(report), report, usage: [] };
  }
}
async function scenario(conflict: boolean) {
  const f = await createDemo(), run = f.engine.run;
  // Replace only the retained integration baseline before any task has run.
  const p = run.integration;
  writeFileSync(join(p, 'a.cjs'), 'module.exports = 0;\n'); writeFileSync(join(p, 'b.cjs'), 'module.exports = 0;\n');
  writeFileSync(join(p, 'pair.cjs'), 'module.exports = {a:0,b:0};\n');
  writeFileSync(join(p, 'check.cjs'), "const assert = require('node:assert/strict'); assert.equal(typeof require('./a.cjs'),'number'); assert.equal(typeof require('./b.cjs'),'number'); assert.equal(typeof require('./pair.cjs').a,'number'); console.log('structural checks pass');\n");
  await git(p, ['add', '.']); await git(p, ['commit', '-m', 'Graph fixture baseline']);
  const base = await git(p, ['rev-parse', 'HEAD']); f.store.updateRun(run.id, { base, integrationHead: base });
  const adapter = new GraphAdapter(conflict), engine = new Engine(f.store, run.id, new PlanProvider(), { adapter });
  return { ...f, engine, adapter };
}
test('Jev accepts a plan, independent tasks actually overlap, and only integrated results pass the final gate', { timeout: 20_000 }, async () => {
  const f = await scenario(false);
  try {
    await f.engine.drive(); assert.equal(f.engine.run.status, 'ready_for_user_apply', f.engine.run.blockReason);
    assert(f.adapter.maximum >= 2, 'Independent workers did not overlap'); assert.equal(f.engine.tasks.length, 4);
    const parent = f.engine.tasks.find(t => t.spec.id === 'T1')!;
    const plannerEvidence = parent.evidence.find(e => e.kind === 'observation');
    assert(plannerEvidence, 'Planner report should be retained as handoff evidence');
    for (const id of ['T1-A','T1-B']) {
      const child = f.engine.tasks.find(t => t.spec.id === id)!;
      assert(child.evidence.some(e => e.sourceHash === plannerEvidence.sourceHash), 'Child task must inherit planner evidence for recipient-specific handoff');
    }
    assert.equal(readFileSync(join(f.engine.run.integration, 'a.cjs'), 'utf8'), 'module.exports = 1;\n');
    assert.equal(readFileSync(join(f.engine.run.integration, 'b.cjs'), 'utf8'), 'module.exports = 2;\n');
  }
  finally { f.store.close(); }
});
test('parallel edits that conflict become a dedicated repair task with fresh tests and reviews', { timeout: 25_000 }, async () => {
  const f = await scenario(true);
  try { await f.engine.drive(); assert.equal(f.engine.run.status, 'ready_for_user_apply', f.engine.run.blockReason); const conflict = f.engine.tasks.find(t => t.kind === 'conflict'); assert(conflict, 'Expected merge conflict was not surfaced'); assert(conflict.testsPassed); assert(conflict.reviewCount >= 1); assert(conflict.staged); assert.match(readFileSync(join(f.engine.run.integration, 'pair.cjs'), 'utf8'), /a:1,b:2/); }
  finally { f.store.close(); }
});
