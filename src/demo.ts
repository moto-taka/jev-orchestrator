import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, startRun } from './engine.ts';
import { defaults, repoId } from './config.ts';
import { Store } from './storage.ts';
import { execute, executable } from './process.ts';
import { EventParser } from './adapters/native.ts';
import { parseReport } from './contracts.ts';
import { terminalApp } from './tui/app.ts';
import { git } from './workspaces.ts';
import { id, invariant, now } from './util.ts';
import type { AgentAdapter, AgentResult, Candidate, DecisionProvider, Evaluation, Invocation, Json, Question, View } from './types.ts';
export class DemoProvider implements DecisionProvider {
  identity = 'DEMO-scripted-decisions-NOT-A-MODEL';
  async evaluate(state: Json, questions: Record<string, Question>): Promise<Evaluation> {
    const context = state as Record<string, any>, answers: Evaluation['answers'] = {};
    for (const [key, q] of Object.entries(questions)) {
      if (q.type === 'boolean') {
        answers[key] = { kind: 'boolean', probability: context.testsPassed === false ? 0.01 : 0.99 };
      } else if (q.type === 'score') {
        const high = key === 'correctnessQuality' || key === 'maintainabilityAdvisory';
        const index = high ? q.criteria.length - 1 : 0;
        answers[key] = { kind: 'score', value: index, levels: q.criteria,
          probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === index ? 1 : 0])), confidence: 1 };
      } else {
        const cs = (context.candidates ?? []) as Candidate[];
        const order = ['ACCEPT_TASK', 'STAGE_INTEGRATION', 'REWORK_SAME_SESSION', 'START_TASK', 'REQUEST_REVIEW', 'ACCEPT_PLAN', 'ASK_USER'];
        let selected: string;
        if (key.startsWith('assignment_') || key.startsWith('handoff_')) selected = Object.keys(q.criteria)[0]!;
        else if (key.startsWith('finding_')) selected = context.testsPassed === true || context.reviewGate ? 'fixed' : 'open';
        else if (key === 'securityGate' || key === 'compatibilityGate') selected = 'safe';
        else selected = order.map(kind => cs.find(c => c.kind === kind)).find(Boolean)?.id ?? Object.keys(q.criteria)[0]!;
        answers[key] = { kind: 'choice', selected, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === selected ? 1 : 0])), confidence: 1 };
      }
    }
    return { provider: 'typesafe', requestedModel: 'DEMO', resolvedModel: 'DEMO', answers, usage: { basis: 'unavailable' } };
  }
}
export class DemoAdapter implements AgentAdapter {
  attempts = new Map<string, number>();
  invocations: { role: string; cwd: string; session?: string; prompt: string }[] = [];
  async run(i: Invocation): Promise<AgentResult> {
    const attempt = (this.attempts.get(i.taskId) ?? 0) + 1;
    if (i.role === 'implementer') this.attempts.set(i.taskId, attempt);
    this.invocations.push({ role: i.role, cwd: i.cwd, session: i.sessionId, prompt: i.prompt });
    const session = i.sessionId ?? id('demo-session'), parser = new EventParser('codex');
    const result = await execute([process.execPath, fileURLToPath(new URL('./demo-worker.mjs', import.meta.url)), i.role, String(attempt), session],
      { cwd: i.cwd, signal: i.signal, timeoutMs: 10_000, onSpawn: i.onSpawn, onStdout: line => { for (const e of parser.accept(JSON.parse(line))) i.onEvent(e); } });
    if (result.code !== 0) return { status: result.interrupted ? 'interrupted' : 'failed', sessionId: session, text: parser.text, error: 'Demo process interrupted', usage: [] };
    return { status: 'reported', sessionId: session, text: parser.text, report: parseReport(parser.text), usage: [] };
  }
}
export async function createDemo(): Promise<{ engine: Engine; store: Store; root: string; adapter: DemoAdapter }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jvo-demo-'))), repo = join(root, 'project');
  const { mkdirSync } = await import('node:fs'); mkdirSync(repo);
  const init = await execute([executable('git', root)!, 'init', '--initial-branch=main', repo], { cwd: root }); invariant(init.code === 0, 'Git init failed');
  writeFileSync(join(repo, 'calc.cjs'), 'exports.add = (a, b) => a - b;\n');
  writeFileSync(join(repo, 'check.cjs'), "const assert = require('node:assert/strict');\nassert.equal(require('./calc.cjs').add(2,3),5);\nconsole.log('addition: pass');\n");
  await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'Demo baseline']);
  const config = defaults(); config.profiles = [{ id: 'demo-cli', adapter: 'codex', binary: process.execPath, version: 'DEMO', roles: ['scout', 'planner', 'implementer', 'reviewer', 'explainer'], enabled: true, level: 'trusted-local', capabilityHash: 'demo', maxTurns: 10, timeoutMs: 30_000 }];
  config.trusts[repoId(repo)] = { repo, shareCode: true, allowLocalExecution: true, allowNoTests: false,
    tests: [{ argv: [process.execPath, 'check.cjs'], timeoutMs: 10_000 }], setup: [], exclude: [], skills: [], maxEvidenceBytes: 64_000, approvedAt: now() };
  const store = new Store(join(root, 'state'));
  const run = await startRun(store, repo, '加算関数の不具合を修正し、回帰テストを通してください。', config);
  const adapter = new DemoAdapter(), engine = new Engine(store, run.id, new DemoProvider(), { adapter });
  engine.log('demo', 'DEMO: 判断とCLIはテスト専用fixtureです。Git・検証コマンド・SQLiteは実際に動作し、API利用はありません。');
  return { engine, store, root, adapter };
}
export async function demo(headless: boolean): Promise<void> {
  const { engine, store, root } = await createDemo();
  try {
    if (headless) {
      let last = '';
      engine.on('change', () => { const v = engine.view(), recent = v.events.at(-1); if (recent && recent.text !== last) { last = recent.text; process.stdout.write(JSON.stringify({ demo: true, event: recent }) + '\n'); } });
      await engine.drive(); process.stdout.write(JSON.stringify({ demo: true, status: engine.run.status, root, run: engine.run.id, attempts: engine.tasks.map(t => ({ id: t.spec.id, attempts: t.attempts })), journalValid: store.verifyJournal(engine.runId) }) + '\n');
      if (engine.run.status !== 'ready_for_user_apply') process.exitCode = 2;
    } else {
      const actions = {
        async submit(text: string): Promise<View> { await engine.pause(); await engine.resume(text); void engine.drive(); return engine.view(); },
        async command(name: string, arg: string) {
          if (name === '/pause') await engine.pause();
          else if (name === '/resume') { await engine.resume(arg); void engine.drive(); }
          else if (name === '/apply') await engine.apply();
          else if (name === '/cancel') await engine.pause('Demo cancelled', true);
          else if (name === '/diff') return { detail: await engine.ws.diff(engine.run.base, engine.run.finalSnapshot ?? engine.run.integrationHead) };
          else if (name === '/recover') { await engine.recover(arg === 'acknowledge'); }
          else if (name === '/exit') { if (engine.run.status === 'running') await engine.pause(); return { exit: true }; }
          else throw new Error('This command is unavailable in the isolated demo.');
          return { view: engine.view() };
        },
      };
      const driving = engine.drive();
      await terminalApp(actions, engine.view(), { demo: true, subscribe: listener => engine.on('change', () => listener(engine.view())) });
      await driving;
      process.stdout.write(`Demo files preserved at ${root}\n`);
    }
  } finally { store.close(); }
}
