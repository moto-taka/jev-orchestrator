import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { createDemo, DemoProvider } from '../src/demo.ts';
import { canonical } from '../src/util.ts';
import type { Answer, Evaluation, Json, Question } from '../src/types.ts';

const bool = (probability = 0.99): Answer => ({ kind: 'boolean', probability });
const choice = (selected: string, confidence = 0.99): Answer => ({
  kind: 'choice', selected, confidence, probabilities: { [selected]: 1 }
});
const score = (value: number): Answer => ({
  kind: 'score', value, levels: ['0','1','2','3','4'],
  probabilities: { '0': value === 0 ? 1 : 0, '1': value === 1 ? 1 : 0, '2': value === 2 ? 1 : 0, '3': value === 3 ? 1 : 0, '4': value === 4 ? 1 : 0 },
  confidence: 1
});

function passingGate(): Record<string, Answer> {
  return {
    evidenceAdequate: bool(), requirementsMet: bool(), diffRequirementFit: bool(),
    testsProtectBehavior: bool(), scopePreserved: bool(), correctnessQuality: score(3),
    securityGate: choice('safe'), compatibilityGate: choice('safe'),
    maintainabilityAdvisory: score(0),
  };
}

test('Jev Review Gate hard-blocks security/scope failures but low maintainability remains advisory', async () => {
  const f = await createDemo();
  try {
    const internal = f.engine as any, task = f.engine.tasks[0]!;
    assert.equal(internal.reviewGatePass(task, passingGate()), true, 'advisory maintainability must not reject otherwise valid work');
    const security = passingGate(); security.securityGate = choice('unsafe');
    assert.equal(internal.reviewGatePass(task, security), false);
    const scope = passingGate(); scope.scopePreserved = bool(0.01);
    assert.equal(internal.reviewGatePass(task, scope), false);
  } finally { f.store.close(); }
});

test('small handoffs skip Jev while large handoffs use recipient-specific exact/reference/drop selection', async () => {
  const f = await createDemo();
  try {
    const internal = f.engine as any, run = f.engine.run, profile = run.config.profiles[0]!;
    let task = f.store.updateTask(f.engine.tasks[0]!.id, { snapshot: run.base });
    const addObservation = (name: string) => {
      const text = `SOURCE: ${name}\nimportant evidence ${name}`;
      const h = f.store.artifact(run.id, text), current = f.store.task(task.id);
      task = f.store.updateTask(task.id, { evidence: [...current.evidence, {
        id: name, kind: 'observation', sourceHash: h, snapshot: run.base,
        excerpt: text, producer: 'fixture', trust: 'runtime-observed', truncated: false
      }] });
    };
    for (let i = 0; i < 3; i++) addObservation(`small-${i}`);
    const before = f.engine.run.decisionCalls;
    const small = JSON.parse(await internal.buildHandoff(f.store.task(task.id), 'implementer', profile, 'default', new AbortController().signal));
    assert.equal(small.selection, 'all-small'); assert.equal(f.engine.run.decisionCalls, before);
    assert(small.items.some((i: any) => i.mode === 'exact'));

    for (let i = 0; i < 4; i++) addObservation(`large-${i}`);
    const large = JSON.parse(await internal.buildHandoff(f.store.task(task.id), 'implementer', profile, 'default', new AbortController().signal));
    assert.equal(large.selection, 'jev'); assert.equal(f.engine.run.decisionCalls, before + 1);
    assert(large.decisionId); assert(large.items.every((i: any) => i.mode === 'exact' || i.mode === 'reference'));
    assert(f.store.events(run.id, 1000).some(e => e.kind === 'handoff.created'));
  } finally { f.store.close(); }
});

test('reviewer handoff does not include prior review artifacts', async () => {
  const f = await createDemo();
  try {
    const internal = f.engine as any, run = f.engine.run, profile = run.config.profiles[0]!;
    let task = f.store.updateTask(f.engine.tasks[0]!.id, { snapshot: run.base });
    const text = 'previous reviewer opinion that must not anchor the next reviewer', h = f.store.artifact(run.id, text);
    task = f.store.updateTask(task.id, { evidence: [...task.evidence, {
      id: 'prior-review', kind: 'review', sourceHash: h, snapshot: run.base,
      excerpt: text, producer: 'reviewer-1', trust: 'worker-claimed', truncated: false
    }] });
    const bundle = JSON.parse(await internal.buildHandoff(task, 'reviewer', profile, 'default', new AbortController().signal));
    assert(!bundle.items.some((i: any) => i.kind === 'review'));
    assert(!canonical(bundle).includes('previous reviewer opinion'));
  } finally { f.store.close(); }
});

test('Jev chooses model effort in the same routing evaluation and the effort is preserved by the implementation session', { timeout: 30_000 }, async () => {
  const f = await createDemo(), base = new DemoProvider();
  const config = f.engine.run.config;
  config.profiles = config.profiles.map(p => ({ ...p, reasoning: true, efforts: ['low','high'] }));
  f.store.updateRun(f.engine.runId, { config });
  let sawActionAndAssignment = false;
  const provider = {
    identity: 'effort-routing-fixture',
    async evaluate(state: Json, questions: Record<string, Question>): Promise<Evaluation> {
      const result = await base.evaluate(state, questions), s = state as Record<string, any>;
      if (questions.action?.type === 'choice') {
        const assignments = Object.entries(questions).filter(([key,q]) => key.startsWith('assignment_') && q.type === 'choice');
        if (assignments.length) sawActionAndAssignment = true;
        const candidates = (s.candidates ?? []) as Array<{ id: string; kind: string; effort?: string }>;
        for (const [key,q] of assignments) {
          const kind = key.slice('assignment_'.length);
          const selected = candidates.find(c => c.kind === kind && c.effort === 'high')?.id ?? Object.keys((q as any).criteria)[0];
          const ids = Object.keys((q as any).criteria);
          result.answers[key] = { kind: 'choice', selected, confidence: 1, probabilities: Object.fromEntries(ids.map(id => [id, id === selected ? 1 : 0])) };
        }
      }
      return result;
    }
  };
  const engine = new Engine(f.store, f.engine.runId, provider, { adapter: f.adapter });
  try {
    await engine.drive();
    assert.equal(engine.run.status, 'ready_for_user_apply', engine.run.blockReason);
    assert(sawActionAndAssignment, 'model and effort should be selected in the existing route evaluation');
    const task = engine.tasks.find(t => t.kind === 'work')!;
    assert.equal(task.effort, 'high');
    const implementations = f.store.all<any>('attempts', engine.runId).filter(a => a.invocation.role === 'implementer');
    assert(implementations.length >= 2);
    assert(implementations.every(a => a.invocation.effort === 'high'));
    assert.equal(engine.run.decisionCalls, 3, 'effort selection must not add a separate Jev routing call');
    assert(f.adapter.invocations[1]!.prompt.startsWith('Continue task'), 'repair should reuse the same session rather than build a new handoff');
  } finally { f.store.close(); }
});
