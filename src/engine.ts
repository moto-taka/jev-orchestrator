import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { AgentAdapter, Candidate, Config, Decision, DecisionProvider, Evaluation, Evidence, Invocation, Json, Operation, Profile, Question, Role, Run, Task, TaskSpec, Trust, View, WorkerReport } from './types.ts';
import { Store } from './storage.ts';
import { Workspaces, assertChanges, changedPaths, dirty, fingerprint, git, repository } from './workspaces.ts';
import { canonical, clip, errorText, hash, id, invariant, json, now, privateDir, safeChild } from './util.ts';
import { SecretGuard, terminalText, workerEnvironment } from './security.ts';
import { alive, processGroupAlive, execute, executable } from './process.ts';
import { repoId, validateConfig } from './config.ts';
import { validateGraph, REPORT_CONTRACT } from './contracts.ts';
import { QUESTION_VERSION, assessmentQuestions, choiceQuestion, evidenceQuestions } from './decision/questions.ts';
import { withRetries } from './decision/provider.ts';
import { evidencePack, relevanceQuestions, repositoryContext, skillContext } from './context.ts';
import { NativeAdapter } from './adapters/native.ts';

export interface StartOptions { baseline?: 'head' | string[]; mode?: 'worktree' | 'in-place'; }
export function makeTask(run: Run, spec: TaskSpec, kind: Task['kind'] = 'work'): Task {
  return { id: `${run.id}_${spec.id}`, runId: run.id, spec, version: 1, phase: 'assess', status: 'queued', kind,
    attempts: 0, diagnoses: 0, reviewCount: 0, requiredReviews: 1, evidence: [], findings: [], sameFailure: 0, staged: false, contextIds: [] };
}
export async function startRun(store: Store, cwd: string, goal: string, config: Config, options: StartOptions = {}): Promise<Run> {
  invariant(goal.trim().length > 0 && goal.length <= 50_000, 'Supply a nonempty task (at most 50,000 characters)');
  const repo = await repository(cwd), rid = repoId(repo), trust = config.trusts[rid];
  invariant(trust?.repo === repo && trust.shareCode && trust.allowLocalExecution, 'Repository is not approved. Run jvo trust first.');
  invariant(config.profiles.some(p => p.enabled && p.roles.includes('implementer') && ['managed', 'trusted-local'].includes(p.level)), 'Approve an implementation CLI profile with jvo setup.');
  invariant(config.profiles.some(p => p.enabled && p.roles.includes('reviewer') && ['managed', 'trusted-local'].includes(p.level)), 'Approve a review profile (a separate session of the same CLI is permitted).');
  invariant(trust.tests.length > 0 || trust.allowNoTests, 'No verification command is approved. Configure tests in jvo trust or explicitly allow manual review only.');
  const busy = store.all<Run>('runs').find(r => !['cancelled', 'applied'].includes(r.status));
  invariant(!busy, `Run ${busy?.id} already owns this repository. Resume it or explicitly cancel it before starting another run.`);
  const runId = id('run'), ws = new Workspaces(store.root, repo), head = await git(repo, ['rev-parse', 'HEAD']);
  const isDirty = await dirty(repo), checkoutFingerprint = await fingerprint(repo);
  invariant(!isDirty || options.baseline !== undefined || options.mode === 'in-place', 'Working tree has uncommitted changes. Use --baseline=head to exclude them, or --include with an explicit list of approved paths. Nothing was stashed.');
  let base = head;
  if (Array.isArray(options.baseline)) base = await ws.captureSelected(head, options.baseline, runId);
  if (options.mode === 'in-place' && isDirty) invariant(Array.isArray(options.baseline), 'In-place mode with pre-existing edits requires --include for the approved baseline.');
  const branch = `jvo/${runId}/integration`, integration = await ws.create(`${runId}_integration`, base, branch);
  const run: Run = { id: runId, repo, repoId: rid, goal: goal.trim(), scopeVersion: 1, createdAt: now(), updatedAt: now(), status: 'running',
    base, checkoutHead: head, checkoutFingerprint, integration, integrationBranch: branch, integrationHead: base, mode: options.mode ?? 'worktree',
    config: JSON.parse(JSON.stringify(config)), trust, workerStarts: 0, decisionCalls: 0, instructionVersion: hash(REPORT_CONTRACT), detached: false, activeMs: 0, activeSince: now() };
  const task = makeTask(run, { id: 'T1', title: goal.slice(0, 120), instruction: goal, acceptance: ['The requested behavior is implemented and verified without regressions.'], dependsOn: [], readPaths: ['**'], writePaths: ['**'], resources: [] });
  task.evidence.push({ id: 'request', kind: 'user-request', sourceHash: store.artifact(runId, goal), snapshot: base, excerpt: goal, producer: 'user', trust: 'user-specified', truncated: false });
  store.tx(() => { store.put('runs', runId, runId, run); store.put('tasks', task.id, runId, task); store.put('approvals', `${runId}-scope`, runId, { trust, baseline: base, mode: run.mode, fingerprint: checkoutFingerprint }); store.event(runId, 'started', { text: 'Jev orchestration started', baseline: base, mode: run.mode }); });
  return run;
}

export class Engine extends EventEmitter {
  store: Store; runId: string; provider: DecisionProvider; guard: SecretGuard; ws: Workspaces;
  private adapter: AgentAdapter; private resourceStore: Store; private active = new Map<string, Promise<void>>(); private aborters = new Map<string, AbortController>();
  private pumping?: Promise<void>; private changeCounter = 0;
  constructor(store: Store, runId: string, provider: DecisionProvider, options: { adapter?: AgentAdapter; guard?: SecretGuard; resourceStore?: Store } = {}) {
    super(); this.store = store; this.runId = runId; this.provider = provider; this.guard = options.guard ?? new SecretGuard();
    this.resourceStore = options.resourceStore ?? store; this.adapter = options.adapter ?? new NativeAdapter(this.guard); this.ws = new Workspaces(store.root, store.run(runId).repo);
  }
  get run(): Run { return this.store.run(this.runId); }
  get tasks(): Task[] { return this.store.all<Task>('tasks', this.runId); }
  notify(): void { this.changeCounter++; this.emit('change'); }
  view(): View {
    const source = this.run;
    const trust = { ...source.trust, tests: source.trust.tests.map(c => ({ ...c, env: undefined })), setup: source.trust.setup.map(c => ({ ...c, env: undefined })) };
    const visibleRun = { ...source, trust, config: { ...source.config, trusts: {} } };
    const visibleTasks = this.tasks.map(t => ({ ...t, evidence: t.evidence.map(e => ({ ...e, excerpt: '' })), lastReport: t.lastReport ? { summary: t.lastReport.summary.slice(0, 1000), claims: [], questions: t.lastReport.questions.slice(0, 5) } : undefined,
      proposedPlan: undefined, findings: t.findings.slice(-10).map(f => ({ ...f, evidence: f.evidence.slice(0, 1000) })) }));
    return { run: visibleRun, tasks: visibleTasks, agents: source.config.profiles, usage: this.store.all('usage', this.runId),
      decisions: this.store.all<Decision>('decisions', this.runId).slice(-100), events: this.store.events(this.runId, 200).filter(e => typeof e.data.text === 'string' && e.data.text.length > 0).map(e => ({ time: e.time, kind: e.kind, taskId: typeof e.data.taskId === 'string' ? e.data.taskId : undefined, text: terminalText(String(e.data.text)) })) };
  }
  log(kind: string, text: string, taskId?: string): void { this.store.event(this.runId, kind, { text: this.guard.redact(terminalText(text)).slice(0, 5000), taskId }); this.notify(); }
  async drive(): Promise<void> { if (this.pumping) return this.pumping; this.pumping = this.loop().finally(() => { this.pumping = undefined; }); return this.pumping; }
  private async loop(): Promise<void> {
    for (;;) {
      const run = this.run;
      if (run.status !== 'running') { if (this.active.size) await Promise.allSettled(this.active.values()); return; }
      if ((run.activeMs ?? 0) + (run.activeSince ? Date.now() - Date.parse(run.activeSince) : 0) > run.config.runtime.maxRunMs) { await this.pause('Run time budget reached'); continue; }
      const max = run.mode === 'in-place' ? 1 : run.config.runtime.maxParallel;
      let launched = false;
      for (const task of this.tasks) {
        if (this.active.size >= max) break;
        if (task.phase === 'done' || task.phase === 'blocked' || this.active.has(task.id)) continue;
        if (!task.spec.dependsOn.every(dep => this.store.task(dep).staged)) continue;
        if (task.kind !== 'conflict' && (task.phase === 'stage' || task.kind === 'integration') && this.tasks.some(t => t.kind === 'conflict' && !t.staged)) continue;
        const resources = this.resources(task);
        if (!this.resourceStore.lease(resources, task.id, this.runId, 60_000)) continue;
        const controller = new AbortController(); this.aborters.set(task.id, controller);
        const p = this.step(task.id, controller.signal).catch(e => {
          const message = this.guard.redact(errorText(e));
          if (this.run.status === 'running') this.store.updateRun(this.runId, { status: 'blocked', blockReason: message });
          this.log('blocked', message, task.id);
        }).finally(() => { this.active.delete(task.id); this.aborters.delete(task.id); const pending = this.store.task(task.id).activeOperation; const state = pending ? this.store.get<Operation>('outbox', pending)?.state : undefined; if (!state || !['running', 'unknown'].includes(state)) this.resourceStore.release(task.id); this.notify(); });
        this.active.set(task.id, p); launched = true;
      }
      if (this.active.size) { await Promise.race(this.active.values()); continue; }
      if (!launched && this.run.status === 'running') {
        const work = this.tasks.filter(t => t.kind !== 'integration');
        if (work.length && work.every(t => t.staged) && !this.tasks.some(t => t.kind === 'integration')) { await this.prepareFinal(); continue; }
        this.store.updateRun(this.runId, { status: 'blocked', blockReason: 'No runnable task; inspect dependencies, locks and unknown operations.' }); this.notify(); return;
      }
    }
  }
  private resources(task: Task): string[] {
    const resources = [`task:${task.id}`, ...task.spec.resources.map(r => `resource:${r}`)];
    if (task.phase === 'verify') resources.push('verification-environment');
    if (task.workspace) resources.push(`workspace:${task.workspace}`);
    if (task.kind === 'integration' || task.kind === 'conflict' || task.phase === 'stage') resources.push('integration');
    if (this.run.mode === 'in-place') resources.push('user-checkout');
    return resources;
  }
  private async step(taskId: string, signal: AbortSignal): Promise<void> {
    let task = this.store.task(taskId);
    if (task.activeOperation) {
      const op = this.store.get<Operation>('outbox', task.activeOperation);
      invariant(op?.state === 'pending', 'An interrupted operation has unknown side effects. Use jvo recover after checking the process and worktree.');
      await this.executeOperation(op, signal); return;
    }
    if (task.phase === 'verify') {
      if (task.kind === 'integration') {
        const current = await git(this.run.integration, ['rev-parse', 'HEAD']);
        if (current !== task.snapshot) {
          task = this.store.updateTask(task.id, { snapshot: current, testsPassed: undefined, reviewedSnapshot: undefined, reviewCount: 0 });
          this.addEvidence(task.id, 'code-diff', current, await this.ws.diff(this.run.base, current, this.run.trust.exclude), 'runtime', 'runtime-observed');
          task = this.store.task(task.id);
        }
      }
      // Verification is a mechanical consequence of the already authorized worker action.
      // Journal it in the same outbox so a crash never silently repeats an arbitrary test command.
      const origin = this.store.all<Decision>('decisions', this.runId).filter(d => d.outcome === 'execute' && d.selected && (d.taskId === task.id || task.kind === 'integration' && d.selected.kind === 'STAGE_INTEGRATION')).at(-1);
      invariant(origin, 'Verification requires a prior authorized decision');
      const candidate: Candidate = { id: `verify-${task.id}-${task.version}`, kind: 'REQUEST_EVIDENCE', taskId: task.id, reason: 'runtime.verify', evidenceIds: task.evidence.map(e => e.id) };
      const op: Operation = { id: id('verify'), runId: this.runId, taskId: task.id, decisionId: origin.id, candidate, state: 'pending' };
      this.store.tx(() => { this.store.put('outbox', op.id, this.runId, op); this.store.updateTask(task.id, { activeOperation: op.id }); });
      await this.executeOperation(op, signal); return;
    }
    if (task.phase === 'assess' && !task.assessments) {
      const items = [...await repositoryContext(this.run.repo, task.snapshot ?? this.run.integrationHead, task, this.run.trust), ...skillContext(this.run.trust)];
      if (items.length) {
        const { evaluation, fresh } = await this.evaluate(task, json({ task: task.spec, sources: items.map(i => ({ id: i.id, description: i.description, content: i.content })) }), relevanceQuestions(items), signal);
        if (!fresh) return;
        const selected = items.filter(i => { const a = evaluation.answers[i.id]; return a?.kind === 'boolean' && a.probability >= 0.65; });
        const contextIds = selected.map(i => this.store.artifact(this.runId, `SOURCE: ${i.path}\n${i.content}`));
        task = this.store.updateTask(taskId, { contextIds });
      }
      const { evaluation, fresh } = await this.evaluate(task, this.state(task), assessmentQuestions(), signal);
      if (!fresh) return;
      const risk = evaluation.answers.risk;
      const requiredReviews = (risk?.kind === 'score' && risk.value >= 1.3) || /auth|payment|billing|migration|認証|課金|権限|個人情報/i.test(task.spec.instruction) ? 2 : 1;
      task = this.store.updateTask(taskId, { assessments: evaluation.answers, requiredReviews });
    }
    let assessments: Record<string, unknown> = {};
    if (task.phase === 'judge') {
      const questions = evidenceQuestions(task);
      for (const finding of task.findings.slice(-50)) questions[`finding_${hash(finding.id).slice(0, 12)}`] = { type: 'choice', instructions: `Using the actual current-snapshot proof, classify finding ${finding.id}: ${finding.requirement}. Do not trust a worker's self-asserted fix.`, criteria: { fixed: 'The defect is demonstrably fixed and verified.', 'not-applicable': 'The finding is demonstrably not applicable to the approved requirement.', open: 'The concern remains or proof is insufficient.', disputed: 'The evidence is contradictory and needs independent investigation.' } };
      const { evaluation, fresh } = await this.evaluate(task, this.state(task), questions, signal);
      if (!fresh) return;
      assessments = evaluation.answers;
    }
    task = this.store.task(taskId);
    const candidates = this.candidates(task, assessments);
    const refs = this.store.refs(task);
    const { evaluation, source, decisionId, fresh, stateHash, questionHash } = await this.evaluate(task, json({ ...this.state(task) as Record<string, Json>, checks: assessments, candidates }), choiceQuestion(task, candidates), signal, false);
    if (!fresh) return;
    const answer = evaluation.answers.action; invariant(answer?.kind === 'choice', 'Jev did not choose an action');
    const chosen = candidates.find(c => c.id === answer.selected); invariant(chosen, 'Jev selected an unknown action');
    const approval = chosen.kind === 'ACCEPT_TASK' || chosen.kind === 'ACCEPT_PLAN';
    const threshold = approval ? task.requiredReviews > 1 ? this.run.config.thresholds.highRiskAccept : this.run.config.thresholds.accept : this.run.config.thresholds.route;
    const isStop = ['ASK_USER', 'PAUSE', 'CANCEL'].includes(chosen.kind);
    const certainty = answer.confidence ?? answer.probabilities[answer.selected]!; // selection support, explicitly not fabricated confidence
    const outcome = isStop || certainty >= threshold ? 'execute' : 'abstain';
    const record: Decision = { id: decisionId, runId: this.runId, taskId, refs, semanticHash: stateHash, questionArtifact: questionHash, candidateHash: hash(candidates),
      questionVersion: QUESTION_VERSION, policyHash: hash(this.run.config), provider: evaluation.provider, requestedModel: evaluation.requestedModel,
      resolvedModel: evaluation.resolvedModel, answers: evaluation.answers, selected: chosen, outcome, evidenceIds: task.evidence.map(e => e.id), sourceDecisionId: source, createdAt: now() };
    const op: Operation = { id: id('op'), runId: this.runId, taskId, decisionId, candidate: chosen, state: 'pending' };
    const committed = this.store.commitDecision(record, outcome === 'execute' ? op : undefined);
    if (outcome === 'abstain') { this.store.updateRun(this.runId, { status: 'blocked', blockReason: 'Jev selection support is below the policy threshold; supply additional evidence. No automatic reroll.' }); this.log('abstain', '判断の確実性が不足しています。証拠を追加するか、設定を確認してください。', taskId); return; }
    if (committed) {
      const labels: Record<string, string> = { START_TASK: '実装を依頼', REQUEST_SCOUT: '調査を依頼', REQUEST_PLAN: '計画案を依頼', ACCEPT_PLAN: '計画案を採用', REQUEST_EVIDENCE: '不足する根拠の確認を依頼', REQUEST_REVIEW: '独立レビューを依頼', REWORK_SAME_SESSION: '同じセッションへ修正を依頼', REASSIGN_TASK: '担当変更を選択', ACCEPT_TASK: '現在の検証結果を承認', STAGE_INTEGRATION: '統合作業場への反映を承認', ASK_USER: '利用者へ確認', PAUSE: '一時停止', CANCEL: '取消し' };
      this.log('decision', `${labels[chosen.kind] ?? chosen.kind} · ${chosen.profileId ?? task.spec.id}`, taskId); await this.executeOperation(op, signal);
    }
  }
  private state(task: Task): Json {
    const run = this.run;
    const pack = evidencePack(task.evidence, run.trust.maxEvidenceBytes, this.guard);
    const value = json({ goal: run.goal, requirementUpdate: run.pendingMessage, task: task.spec, phase: task.phase, kind: task.kind,
      snapshot: task.snapshot ?? task.base ?? run.integrationHead, assessments: task.assessments, attempts: task.attempts, diagnoses: task.diagnoses,
      profile: task.profileId, sessionAvailable: !!task.sessionId, reviews: task.reviewCount, requiredReviews: task.requiredReviews,
      testsPassed: task.testsPassed, testedSnapshot: task.testedSnapshot, reviewedSnapshot: task.reviewedSnapshot,
      evidence: pack, findings: task.findings, proposedPlan: task.proposedPlan, lastFailure: task.lastFailure, sameFailure: task.sameFailure,
      profiles: run.config.profiles.filter(p => p.enabled).map(({ binary: _binary, ...profile }) => profile), context: task.contextIds.map(h => this.store.readArtifact(h)),
      remainingStarts: run.config.runtime.maxWorkerStarts - run.workerStarts,
      remainingDecisions: run.config.runtime.maxDecisions - run.decisionCalls });
    this.guard.assertOutbound(canonical(value));
    invariant(Buffer.byteLength(canonical(value)) < run.trust.maxEvidenceBytes + 200_000, 'Decision state exceeds transmission limit'); return value;
  }
  private async evaluate(task: Task, state: Json, questions: Record<string, Question>, signal: AbortSignal, record = true): Promise<{ evaluation: Evaluation; fresh: boolean; source?: string; decisionId: string; stateHash: string; questionHash: string }> {
    const refs = this.store.refs(task), run = this.run, decisionId = id('decision');
    this.guard.assertOutbound(canonical(state));
    invariant(Buffer.byteLength(canonical(state)) <= run.trust.maxEvidenceBytes + 200_000, 'Decision state too large');
    const key = hash({ state, questions, policy: run.config, model: this.provider.identity, version: QUESTION_VERSION,
      epoch: run.config.decision.immutableModel ? 'immutable' : run.id });
    const stateHash = this.store.artifact(this.runId, canonical(state));
    const questionHash = this.store.artifact(this.runId, canonical(questions));
    const cached = this.store.memo(key); let evaluation: Evaluation;
    if (cached) evaluation = cached.evaluation as Evaluation;
    else {
      try {
        evaluation = await withRetries(async () => {
          signal.throwIfAborted(); invariant(this.run.status === 'running', 'Run is paused');
          invariant(this.run.decisionCalls < run.config.runtime.maxDecisions, 'Jev request budget reached');
          const attempt = this.run.decisionCalls + 1;
          this.store.updateRun(this.runId, { decisionCalls: attempt });
          try { return await this.provider.evaluate(state, questions, signal); }
          catch (e) { this.store.usage(`${decisionId}-failed-${attempt}`, this.runId, { basis: 'unavailable' }); throw e; }
        }, run.config.decision.retries, signal);
      } catch (e) {
        this.store.commitDecision({ id: decisionId, runId: this.runId, taskId: task.id, refs, semanticHash: stateHash, questionArtifact: questionHash, candidateHash: hash(questions), questionVersion: QUESTION_VERSION, policyHash: hash(run.config), provider: run.config.decision.provider, requestedModel: run.config.decision.model, answers: {}, outcome: 'invalid', evidenceIds: task.evidence.map(e => e.id), createdAt: now() });
        this.log('evaluation.unavailable', this.guard.redact(errorText(e)), task.id); throw e;
      }
      this.store.usage(`${decisionId}-api`, this.runId, evaluation.usage);
      this.store.saveMemo(key, decisionId, evaluation);
    }
    const fresh = this.store.fresh(this.runId, refs) && this.run.status === 'running' && !signal.aborted;
    if (record || !fresh) {
      const d: Decision = { id: decisionId, runId: this.runId, taskId: task.id, refs, semanticHash: stateHash, questionArtifact: questionHash, candidateHash: hash(questions),
        questionVersion: QUESTION_VERSION, policyHash: hash(run.config), provider: evaluation.provider, requestedModel: evaluation.requestedModel,
        resolvedModel: evaluation.resolvedModel, answers: evaluation.answers, outcome: fresh ? 'execute' : 'stale', evidenceIds: task.evidence.map(e => e.id), sourceDecisionId: cached?.decisionId, createdAt: now() };
      this.store.commitDecision(d);
    }
    return { evaluation, fresh, source: cached?.decisionId, decisionId, stateHash, questionHash };
  }
  private profiles(role: Role): Profile[] { return this.run.config.profiles.filter(p => p.enabled && p.roles.includes(role) && ['managed', 'trusted-local'].includes(p.level)); }
  private candidates(task: Task, checks: Record<string, unknown>): Candidate[] {
    const list: Candidate[] = [];
    const resolutions: Record<string, 'fixed' | 'not-applicable' | 'open' | 'disputed'> = {};
    for (const f of task.findings) {
      const a = checks[`finding_${hash(f.id).slice(0, 12)}`] as import('./types.ts').Answer | undefined;
      if (a?.kind === 'choice' && ['fixed', 'not-applicable'].includes(a.selected) && (a.confidence ?? a.probabilities[a.selected] ?? 0) >= this.run.config.thresholds.accept) resolutions[f.id] = a.selected as 'fixed' | 'not-applicable';
    }
    const criticalResolved = task.findings.every(f => f.severity !== 'blocker' || f.status === 'fixed' || f.status === 'not-applicable' || !!resolutions[f.id]);
    const add = (kind: Candidate['kind'], reason: string, profileId?: string, specialization?: string) => {
      const c = { kind, reason, taskId: task.id, profileId, specialization, workspace: task.workspace,
        sessionId: kind === 'REWORK_SAME_SESSION' ? task.sessionId : undefined, evidenceIds: task.evidence.map(e => e.id) };
      list.push({ ...c, ...(kind === 'ACCEPT_TASK' ? { findingResolutions: resolutions } : {}), id: `C_${hash({ ...c, resolutions: kind === 'ACCEPT_TASK' ? resolutions : undefined }).slice(0, 14)}` });
    };
    const propose = (kind: Candidate['kind'], role: Role, reason: string) => { for (const p of this.profiles(role)) add(kind, reason, p.id); };
    if (task.phase === 'assess') {
      propose('START_TASK', 'implementer', 'Implement this task directly; use the task worktree and submit proof.');
      if (task.diagnoses < 2) {
        propose('REQUEST_SCOUT', 'scout', 'Inspect the code to resolve missing information; do not edit.');
        if (this.run.mode !== 'in-place') propose('REQUEST_PLAN', 'planner', 'Propose a scoped task graph; do not start any task.');
      }
    } else if (task.phase === 'plan-review') {
      if (task.proposedPlan?.length) add('ACCEPT_PLAN', 'Adopt the proposed bounded, acyclic task graph only if it fully preserves the requested scope.');
      if (task.diagnoses < 3) propose('REQUEST_PLAN', 'planner', 'Revise the proposal without expanding scope.');
    } else if (task.phase === 'implement' || task.phase === 'judge') {
      const adequate = (checks.evidenceAdequate as { probability?: number } | undefined)?.probability ?? 0;
      const met = (checks.requirementsMet as { probability?: number } | undefined)?.probability ?? 0;
      if (task.phase === 'judge' && this.acceptable(task) && criticalResolved && adequate >= this.run.config.thresholds.evidence && met >= (task.requiredReviews > 1 ? this.run.config.thresholds.highRiskAccept : this.run.config.thresholds.accept)) add('ACCEPT_TASK', 'The current snapshot has runtime verification and independent reviews; close findings only if all requirements are actually met.');
      if (task.attempts < this.run.config.runtime.maxRepairs && task.sameFailure < this.run.config.runtime.maxSameFailure) {
        if (task.sessionId && task.profileId) add('REWORK_SAME_SESSION', 'Repair the unresolved findings in the same implementation session and workspace.', task.profileId);
        else propose('START_TASK', 'implementer', 'Continue the retained task workspace with a new explicitly selected session.');
        for (const p of this.profiles('implementer').filter(p => p.id !== task.profileId)) add('REASSIGN_TASK', 'Choose only for a demonstrated capability or availability mismatch; preserve the task workspace.', p.id);
      }
      if (task.diagnoses < 3) propose('REQUEST_EVIDENCE', 'scout', 'Resolve missing proof or diagnose repeated failure without editing or treating capacity problems as task difficulty.');
      if (task.snapshot && task.reviewCount < task.requiredReviews + 2) propose('REQUEST_REVIEW', 'reviewer', 'Re-examine disputed findings or missing evidence in an independent session.');
    } else if (task.phase === 'review') {
      propose('REQUEST_REVIEW', 'reviewer', task.reviewCount > 0 ? 'Perform an additional independent risk-focused review. Inspect security, authorization, data loss, regressions and disputed findings.' : 'Independently review this frozen snapshot against every acceptance criterion.');
    } else if (task.phase === 'stage') add('STAGE_INTEGRATION', 'Integrate this accepted snapshot into the isolated run branch; never push or modify the user checkout.');
    add('ASK_USER', 'Stop at a checkpoint and ask the user to clarify missing requirements, evidence, capabilities, or budget.');
    add('PAUSE', 'Pause without accepting or discarding any work.');
    return list;
  }
  private acceptable(task: Task): boolean {
    return !!task.snapshot && task.testsPassed === true && task.testedSnapshot === task.snapshot && task.reviewedSnapshot === task.snapshot && task.reviewCount >= task.requiredReviews;
  }
  private async executeOperation(op: Operation, signal: AbortSignal): Promise<void> {
    invariant(this.run.status === 'running' && !signal.aborted, 'Run is not running');
    const task = this.store.task(op.taskId), c = op.candidate;
    invariant(task.activeOperation === op.id && op.state === 'pending', 'Operation is not pending for this task');
    if (c.reason !== 'runtime.verify') {
      const decision = this.store.get<Decision>('decisions', op.decisionId);
      invariant(decision?.outcome === 'execute', 'Operation has no executed decision');
      const expected = { ...decision.refs, [task.id]: decision.refs[task.id]! + 1 };
      if (!this.store.fresh(this.runId, expected)) {
        this.store.tx(() => { this.store.put('outbox', op.id, this.runId, { ...op, state: 'failed', error: 'Decision preconditions changed before execution' }); this.store.updateTask(task.id, { activeOperation: undefined }); this.store.event(this.runId, 'operation.stale', { taskId: task.id, operation: op.id }); });
        return;
      }
    }
    op = { ...op, state: 'running', startedAt: now() }; this.store.put('outbox', op.id, this.runId, op);
    const complete = (update: Partial<Task> = {}) => this.store.tx(() => {
      this.store.updateTask(task.id, { ...update, activeOperation: undefined, activeProfileId: undefined, activeRole: undefined });
      this.store.put('outbox', op.id, this.runId, { ...this.store.get<Operation>('outbox', op.id), state: 'done', receipt: hash(update) });
      this.store.event(this.runId, 'operation.completed', { taskId: task.id, action: c.kind, operation: op.id });
    });
    try {
      if (c.reason === 'runtime.verify') { await this.verify(task, signal, op); complete(); return; }
      if (c.kind === 'ASK_USER' || c.kind === 'PAUSE' || c.kind === 'CANCEL') {
        complete(); this.store.updateRun(this.runId, { status: c.kind === 'CANCEL' ? 'cancelled' : c.kind === 'ASK_USER' ? 'blocked' : 'paused', blockReason: c.reason });
        this.log('attention', c.kind === 'ASK_USER' ? `確認が必要です: ${task.lastReport?.questions.join(' / ') || task.lastFailure || task.spec.title}` : '実行を一時停止しました。', task.id); return;
      }
      if (c.kind === 'ACCEPT_PLAN') { this.adoptPlan(task); complete({ phase: 'done', status: 'done', staged: true }); return; }
      if (c.kind === 'ACCEPT_TASK') {
        invariant(this.acceptable(task), 'Policy denies approval: tests/reviews are absent or stale');
        await this.ensureSnapshot(task);
        if (task.kind === 'integration') {
          invariant((await git(this.run.integration, ['rev-parse', 'HEAD'])) === task.snapshot, 'Integration changed after review');
          complete({ phase: 'done', status: 'done', staged: true, findings: task.findings.map(f => ({ ...f, status: c.findingResolutions?.[f.id] ?? f.status })) });
          this.store.updateRun(this.runId, { status: 'ready_for_user_apply', finalSnapshot: task.snapshot,
            inPlaceFingerprint: this.run.mode === 'in-place' ? await fingerprint(this.run.repo) : undefined });
          this.log('ready', '全体検証とJevの承認が完了しました。/diff で確認し、/apply で反映できます。');
        } else complete({ phase: 'stage', status: 'accepted', findings: task.findings.map(f => ({ ...f, status: c.findingResolutions?.[f.id] ?? f.status })) });
        return;
      }
      if (c.kind === 'STAGE_INTEGRATION') { await this.stage(task); complete({ phase: 'done', status: 'done', staged: true }); return; }
      const role: Role = c.kind === 'REQUEST_SCOUT' || c.kind === 'REQUEST_EVIDENCE' ? 'scout' : c.kind === 'REQUEST_PLAN' ? 'planner' : c.kind === 'REQUEST_REVIEW' ? 'reviewer' : 'implementer';
      await this.worker(task, op, role, signal, complete);
    } catch (e) {
      const current = this.store.get<Operation>('outbox', op.id);
      if (current?.state !== 'done') {
        this.store.put('outbox', op.id, this.runId, { ...current, state: 'unknown', error: this.guard.redact(errorText(e)) });
        // The worktree is kept exactly as-is. Side effects cannot be guessed from an exception.
        this.log('operation.unknown', `作業状態を確認してください: ${errorText(e)}`, task.id);
      }
      throw e;
    } finally { this.notify(); }
  }
  private adoptPlan(task: Task): void {
    const specs = task.proposedPlan; invariant(specs?.length, 'No plan to adopt'); validateGraph(specs);
    invariant(this.run.mode === 'worktree', 'Task graph splitting is unavailable in explicitly single-task in-place mode');
    invariant(this.tasks.length + specs.length <= this.run.config.runtime.maxTasks, 'Plan exceeds task budget');
    // A child may narrow a parent's authority, never broaden it implicitly.
    const within = (child: string, parents: string[]) => parents.some(parent => parent === '**' || parent === child || (parent.endsWith('/**') && child.startsWith(parent.slice(0, -2)) && !child.slice(parent.length - 2).includes('..')));
    for (const spec of specs) invariant(spec.writePaths.every(path => within(path, task.spec.writePaths)), `Child task ${spec.id} expands the approved write scope`);
    const mapping = new Map(specs.map(s => [s.id, `${task.spec.id}-${s.id}`]));
    this.store.tx(() => {
      for (const spec of specs) {
        const localId = mapping.get(spec.id)!;
        const next = makeTask(this.run, { ...spec, id: localId, instruction: `Original requirement: ${this.run.goal}\n\n${spec.instruction}`, dependsOn: spec.dependsOn.length ? spec.dependsOn.map(dep => `${this.runId}_${mapping.get(dep)!}`) : task.spec.dependsOn });
        invariant(!this.store.get('tasks', next.id), 'Plan task already exists');
        this.store.put('tasks', next.id, this.runId, next);
      }
      const depended = new Set(specs.flatMap(s => s.dependsOn));
      const leaves = specs.filter(s => !depended.has(s.id)).map(s => `${this.runId}_${mapping.get(s.id)!}`);
      for (const other of this.tasks.filter(t => t.id !== task.id && t.spec.dependsOn.includes(task.id))) this.store.updateTask(other.id, { spec: { ...other.spec, dependsOn: [...new Set(other.spec.dependsOn.flatMap(dep => dep === task.id ? leaves : [dep]))] } });
      this.store.event(this.runId, 'plan.accepted', { taskId: task.id, count: specs.length });
    });
  }
  private async ensureWorkspace(task: Task): Promise<Task> {
    if (task.workspace) { if (task.workspace !== this.run.repo) await this.ws.validate(task.workspace); return task; }
    const run = this.run, base = run.integrationHead;
    const branch = `jvo/${run.id}/${task.spec.id}`;
    const workspace = run.mode === 'in-place' ? run.repo : await this.ws.create(task.id, base, branch);
    this.store.put('workspaces', task.id, this.runId, { taskId: task.id, workspace, base, branch });
    return this.store.updateTask(task.id, { workspace, branch, base });
  }
  private async ensureSnapshot(task: Task): Promise<void> {
    invariant(task.snapshot && task.workspace, 'Missing snapshot or workspace');
    if (task.workspace === this.run.repo) {
      const current = await this.ws.captureSelected(task.base!, await changedPaths(task.workspace, task.base), `${this.runId}-check`);
      const a = await git(this.run.repo, ['rev-parse', `${current}^{tree}`]), b = await git(this.run.repo, ['rev-parse', `${task.snapshot}^{tree}`]);
      invariant(a === b, 'User files changed since verification');
    } else {
      await this.ws.validate(task.workspace);
      invariant(!(await dirty(task.workspace)) && await git(task.workspace, ['rev-parse', 'HEAD']) === task.snapshot, 'Workspace changed since its snapshot was verified');
    }
  }
  private async worker(initial: Task, op: Operation, role: Role, signal: AbortSignal, complete: (update?: Partial<Task>) => unknown): Promise<void> {
    const run = this.run, c = op.candidate;
    const profile = run.config.profiles.find(p => p.id === c.profileId);
    invariant(profile?.enabled && profile.roles.includes(role), 'Selected profile does not allow this role');
    invariant(run.workerStarts < run.config.runtime.maxWorkerStarts, 'Worker start budget reached');
    let task = initial;
    const writer = role === 'implementer';
    if (writer) task = await this.ensureWorkspace(task);
    const baseline = task.snapshot ?? task.base ?? run.integrationHead;
    let cwd: string;
    if (writer) cwd = task.workspace!;
    else cwd = await this.ws.create(`${task.id}_${role}_${op.id}`, baseline);
    const beforeRead = !writer ? await fingerprint(cwd) : undefined;
    const resume = writer && c.kind === 'REWORK_SAME_SESSION' ? task.sessionId : undefined;
    const affinity = hash({ profile, role, cwd, instructionVersion: run.instructionVersion });
    if (resume) invariant(task.sessionFingerprint === affinity && task.profileId === profile.id, 'Session affinity changed; select an explicit reassignment instead of corrupting cached context');
    const sessionDir = privateDir(join(this.store.root, 'sessions', task.id, writer ? profile.id : op.id));
    const context = task.contextIds.map(h => this.store.readArtifact(h)).join('\n\n');
    const pack = evidencePack(task.evidence, run.trust.maxEvidenceBytes, this.guard);
    const prompt = resume ? `Continue task ${task.spec.id} in this same session and workspace.\nDo not repeat completed work.\nCurrent snapshot: ${baseline}\nUnresolved findings: ${canonical(task.findings.filter(f => f.status !== 'fixed'))}\nLatest runtime proof: ${canonical(pack.items.slice(-4))}\nLatest failure: ${task.lastFailure ?? 'none'}\n${run.pendingMessage ? `User clarification: ${run.pendingMessage}\n` : ''}${REPORT_CONTRACT}`
      : `You are the ${role} worker, not the orchestrator. Do not spawn agents, push, deploy, alter task ownership, or approve your own work.\n${role === 'reviewer' ? 'Review independently; do not edit any files. Investigate acceptance criteria, security, regressions and unresolved findings. Review round ' + (task.reviewCount + 1) + '.\n' : !writer ? 'Read-only investigation. Do not edit.\n' : 'Edit only the permitted writePaths. Do not modify credentials, excluded files, or other workspaces.\n'}Task: ${canonical(task.spec)}\n${run.pendingMessage ? `User clarification: ${run.pendingMessage}\n` : ''}Snapshot: ${baseline}\nContext:\n${context}\nEvidence:\n${canonical(pack)}\nFindings: ${canonical(task.findings)}\n${REPORT_CONTRACT}`;
    const logPath = safeChild(privateDir(join(this.store.root, 'logs', this.runId)), `${op.id}.jsonl`);
    writeFileSync(logPath, '', { mode: 0o600, flag: 'wx' }); let logged = 0, lastEvent = 0;
    this.store.updateRun(this.runId, { workerStarts: this.run.workerStarts + 1 });
    this.store.updateTask(task.id, { status: role === 'reviewer' ? 'reviewing' : 'running', activeProfileId: profile.id, activeRole: role, lastActivity: `${profile.id}: ${role}`,
      ...(writer ? { profileId: profile.id, sessionId: resume, sessionFingerprint: affinity, attempts: task.attempts + 1, reviewCount: 0, testsPassed: undefined, reviewedSnapshot: undefined, testedSnapshot: undefined } : {}) });
    this.log('worker.started', `${profile.id} · ${role} · ${task.spec.title}`, task.id);
    const invocation: Invocation = { id: op.id, runId: this.runId, taskId: task.id, role, profile, cwd, prompt, sessionId: resume, sessionDir, signal,
      onSpawn: (pid, birth) => this.store.put('outbox', op.id, this.runId, { ...this.store.get<Operation>('outbox', op.id), pid, birth }),
      onEvent: e => {
        const clean = { ...e, text: e.text === undefined ? undefined : this.guard.redact(terminalText(e.text)).slice(0, 20_000) };
        const line = JSON.stringify(clean) + '\n';
        if (logged + Buffer.byteLength(line) <= run.config.runtime.maxLogBytes) { appendFileSync(logPath, line); logged += Buffer.byteLength(line); }
        if (e.type === 'session' && writer && e.sessionId) {
          const current = this.store.task(task.id); this.store.put('tasks', task.id, this.runId, { ...current, sessionId: e.sessionId });
          this.store.put('sessions', hash({ taskId: task.id, profile: profile.id }), this.runId, { taskId: task.id, sessionId: e.sessionId, affinity, cwd, profile });
        }
        // Transport progress must not invalidate a semantic decision or generate API calls.
        if (e.type === 'tool' || Date.now() - lastEvent > 150) {
          const current = this.store.task(task.id); this.store.put('tasks', task.id, this.runId, { ...current, lastActivity: clean.text?.slice(-300) ?? current.lastActivity });
          lastEvent = Date.now(); this.notify();
        }
      } };
    const result = await this.adapter.run(invocation);
    this.store.put('attempts', op.id, this.runId, { invocation: { id: op.id, taskId: task.id, profileId: profile.id, role, cwd, resume, promptHash: hash(prompt), snapshot: baseline }, result: JSON.parse(this.guard.redact(canonical(result))) });
    for (const [i, u] of result.usage.entries()) this.store.usage(`${op.id}:${i}`, this.runId, u);
    if (!result.usage.length) this.store.usage(`${op.id}:unknown`, this.runId, { basis: 'unavailable' });
    if (!writer) invariant(await fingerprint(cwd) === beforeRead, 'Read-only worker changed its review snapshot; its report is not admissible');
    if (result.status === 'unknown') {
      this.store.updateTask(task.id, { status: 'reported', lastActivity: '終了状態不明・再開前に確認', lastFailure: result.error ?? 'Unknown worker outcome', sessionId: writer ? result.sessionId ?? this.store.task(task.id).sessionId : task.sessionId });
      throw new Error(result.error ?? 'Unknown worker outcome; inspect the retained files and acknowledge recovery');
    }
    if (writer && resume && task.observedModel && result.model && result.model !== task.observedModel) throw new Error('Observed model changed during the same session; explicit reassignment is required');
    if (result.status !== 'reported' || !result.report) {
      const failure = this.guard.redact(result.error ?? `Worker ${result.status}`);
      const previous = this.store.task(task.id);
      const signature = hash(failure.replace(/\b\d+(?:\.\d+)?\b/g, '#'));
      const same = previous.lastFailure && hash(previous.lastFailure.replace(/\b\d+(?:\.\d+)?\b/g, '#')) === signature ? previous.sameFailure + 1 : 1;
      complete({ phase: writer ? 'implement' : role === 'reviewer' ? 'review' : role === 'planner' && task.proposedPlan?.length ? 'plan-review' : 'assess', status: 'reported', lastFailure: failure, sameFailure: same,
        ...(writer ? { sessionId: result.sessionId ?? this.store.task(task.id).sessionId } : {}) });
      this.addEvidence(task.id, 'observation', baseline, failure, 'runtime', 'runtime-observed');
      this.log('worker.failed', failure, task.id);
      if (result.status === 'interrupted' && this.run.status === 'running') this.store.updateRun(this.runId, { status: 'paused', blockReason: failure });
      return;
    }
    const report = result.report;
    this.guard.assertOutbound(canonical(report));
    this.addEvidence(task.id, role === 'reviewer' ? 'review' : 'observation', baseline, canonical(report), `${profile.id}:${op.id}`, 'worker-claimed');
    if (writer) {
      task = this.store.task(task.id); const snapshot = await this.ws.snapshot(task, run.trust);
      const diff = await this.ws.diff(task.base!, snapshot, run.trust.exclude);
      const changed = await changedPaths(task.workspace!, task.base!);
      const risk = changed.some(p => /(?:auth|payment|billing|migration|permission|credential|session)/i.test(p));
      if (risk && task.requiredReviews < 2) this.store.updateTask(task.id, { requiredReviews: 2 });
      this.addEvidence(task.id, 'code-diff', snapshot, diff || '(no changes)', 'runtime', 'runtime-observed');
      const repeat = snapshot === task.snapshot ? task.sameFailure + 1 : task.sameFailure;
      complete({ snapshot, observedModel: result.model ?? task.observedModel, sessionId: result.sessionId ?? this.store.task(task.id).sessionId, lastReport: report, phase: 'verify', status: 'reported', sameFailure: repeat });
    } else if (role === 'planner') {
      invariant(report.plan?.length, 'Planner did not submit a task graph'); validateGraph(report.plan);
      complete({ proposedPlan: report.plan, lastReport: report, phase: 'plan-review', status: 'reported', diagnoses: task.diagnoses + 1 });
    } else if (role === 'reviewer') {
      await this.ensureSnapshot(task);
      const findings = [...task.findings, ...(report.findings ?? []).map(f => ({ ...f, id: `${op.id}-${f.id}`, snapshot: baseline, status: 'open' as const, sources: [op.id] }))];
      const rounds = task.reviewCount + 1;
      complete({ findings, reviewCount: rounds, reviewedSnapshot: baseline, lastReport: report, phase: rounds >= task.requiredReviews ? 'judge' : 'review', status: 'reported' });
      await this.deduplicateFindings(task.id, signal);
    } else {
      complete({ lastReport: report, diagnoses: task.diagnoses + 1, phase: task.snapshot ? 'judge' : task.workspace ? 'implement' : 'assess', status: 'reported',
        sameFailure: task.sameFailure >= run.config.runtime.maxSameFailure ? 0 : task.sameFailure });
    }
    this.log('worker.completed', `${profile.id} · ${role} · ${report.summary}`, task.id);
  }
  private addEvidence(taskId: string, kind: Evidence['kind'], snapshot: string, content: string, producer: string, trust: Evidence['trust']): void {
    const clean = this.guard.redact(terminalText(content));
    const h = this.store.artifact(this.runId, clean), excerpt = clip(clean, 24_000), task = this.store.task(taskId);
    const evidence: Evidence = { id: id('evidence'), kind, sourceHash: h, snapshot, excerpt: excerpt.text, truncated: excerpt.truncated, producer, trust };
    this.store.updateTask(taskId, { evidence: [...task.evidence, evidence] });
  }
  private async verify(task: Task, signal: AbortSignal, operation: Operation): Promise<void> {
    invariant(task.snapshot, 'No snapshot to verify'); await this.ensureSnapshot(task);
    this.store.updateTask(task.id, { status: 'verifying' }); this.log('verify', '固定した成果物で検証コマンドを実行しています。', task.id);
    const scratch = await this.ws.create(`${task.id}_verify_${id('v')}`, task.snapshot);
    let passed = true; const results: unknown[] = [];
    for (const [kind, commands] of [['setup', this.run.trust.setup], ['test', this.run.trust.tests]] as const) {
      for (const cmd of commands) {
        signal.throwIfAborted();
        const bin = cmd.argv[0]!.includes('/') ? cmd.argv[0]! : executable(cmd.argv[0]!, scratch);
        invariant(bin, `Approved verification command is unavailable: ${cmd.argv[0]}`);
        const result = await execute([bin, ...cmd.argv.slice(1)], { cwd: scratch, env: { ...workerEnvironment(process.env, true), ...cmd.env }, timeoutMs: cmd.timeoutMs, signal, maxBytes: 4_000_000, onSpawn: (pid, birth) => this.store.put('outbox', operation.id, this.runId, { ...this.store.get<Operation>('outbox', operation.id), pid, birth }) });
        invariant(!result.groupRunning, 'Verification command left background processes; reconcile before retrying');
        const entry = { kind, argv: cmd.argv, code: result.code, timedOut: result.timedOut, interrupted: result.interrupted, snapshot: task.snapshot,
          stdout: this.guard.redact(clip(result.stdout, 20_000).text), stderr: this.guard.redact(clip(result.stderr, 20_000).text) };
        results.push(entry);
        if (result.code !== 0 || result.timedOut || result.interrupted || result.overflow) { passed = false; break; }
      }
      if (!passed) break;
    }
    // A test may produce ignored output, but changing tracked source invalidates the proof.
    invariant(!(await git(scratch, ['diff', '--name-only', 'HEAD', '--'])), 'Verification command changed tracked source; tests must verify the approved snapshot');
    if (!this.run.trust.tests.length) { invariant(this.run.trust.allowNoTests, 'No tests are approved'); results.push({ kind: 'no-tests', userExplicitlyApproved: true, warning: 'No automated tests ran. Independent review is still required.' }); }
    const encoded = canonical(results);
    this.addEvidence(task.id, 'test', task.snapshot, encoded, 'runtime', 'runtime-observed');
    const signature = hash(encoded.replace(/\b\d{4}-[^" ]+/g, 'TIME'));
    this.store.updateTask(task.id, { testsPassed: passed, testedSnapshot: task.snapshot, phase: 'review', status: 'reported',
      lastFailure: passed ? undefined : `Verification failed: ${signature}\n${clip(encoded, 2500).text}`, sameFailure: !passed && task.lastFailure?.includes(signature) ? task.sameFailure + 1 : task.sameFailure });
    this.notify();
  }
  private async deduplicateFindings(taskId: string, signal: AbortSignal): Promise<void> {
    const task = this.store.task(taskId), pairs: [number, number][] = [];
    for (let i = 0; i < task.findings.length; i++) for (let j = i + 1; j < task.findings.length && pairs.length < 24; j++) {
      const a = task.findings[i]!, b = task.findings[j]!;
      if (a.snapshot === b.snapshot && !b.duplicateOf && a.requirement === b.requirement) pairs.push([i, j]);
    }
    if (!pairs.length || this.run.status !== 'running') return;
    const questions: Record<string, Question> = Object.fromEntries(pairs.map(([a, b], n) => [`pair${n}`, { type: 'boolean', instructions: `Do findings ${task.findings[a]!.id} and ${task.findings[b]!.id} describe exactly the same defect in the same snapshot? Distinct evidence or concerns must be retained.` }]));
    const { evaluation, fresh } = await this.evaluate(task, json({ findings: task.findings }), questions, signal);
    if (!fresh) return;
    const findings = task.findings.map(f => ({ ...f }));
    for (const [n, [a, b]] of pairs.entries()) { const answer = evaluation.answers[`pair${n}`]; if (answer?.kind === 'boolean' && answer.probability >= 0.95) findings[b]!.duplicateOf = findings[a]!.id; }
    this.store.updateTask(taskId, { findings }); // originals and sources never discarded
  }
  private async stage(task: Task): Promise<void> {
    await this.ensureSnapshot(task);
    if (task.kind === 'conflict') {
      this.store.updateRun(this.runId, { integrationHead: task.snapshot! }); return;
    }
    const result = await this.ws.merge(this.run, task);
    if (result.ok) { this.store.updateRun(this.runId, { integrationHead: result.head! }); this.log('integrated', `統合済み: ${task.spec.title}`, task.id); return; }
    const conflictId = `merge-${task.spec.id}`;
    const conflict = makeTask(this.run, { id: conflictId, title: `Resolve integration conflicts for ${task.spec.title}`, instruction: `Resolve the merge conflicts without losing either accepted task's requirements. Conflicted paths: ${result.conflicts.join(', ')}. Original request: ${this.run.goal}`, acceptance: task.spec.acceptance, dependsOn: [], readPaths: ['**'], writePaths: ['**'], resources: ['integration'] }, 'conflict');
    conflict.workspace = this.run.integration; conflict.base = this.run.base;
    conflict.evidence = task.evidence; this.store.put('tasks', conflict.id, this.runId, conflict);
    this.log('conflict', '統合競合を独立した修正タスクとして作成しました。再検証・再レビューを行います。', conflict.id);
  }
  private async prepareFinal(): Promise<void> {
    const run = this.run;
    invariant(!(await dirty(run.integration)), 'Integration still has uncommitted changes');
    const snapshot = await git(run.integration, ['rev-parse', 'HEAD']);
    const task = makeTask(run, { id: 'FINAL', title: 'Integrated acceptance review', instruction: run.goal,
      acceptance: [...new Set(this.tasks.flatMap(t => t.spec.acceptance))], dependsOn: this.tasks.map(t => t.id), readPaths: ['**'], writePaths: ['**'], resources: ['integration'] }, 'integration');
    Object.assign(task, { workspace: run.integration, base: run.base, snapshot, phase: 'verify', status: 'accepted', requiredReviews: Math.max(...this.tasks.map(t => t.requiredReviews)) });
    const diff = await this.ws.diff(run.base, snapshot, run.trust.exclude);
    this.store.put('tasks', task.id, run.id, task); this.addEvidence(task.id, 'code-diff', snapshot, diff || '(no changes)', 'runtime', 'runtime-observed');
    this.store.updateRun(this.runId, { integrationHead: snapshot }); this.log('integration.verify', '統合後の成果物を全体検証しています。');
  }
  async pause(reason = 'User paused the run', cancel = false): Promise<void> {
    this.store.updateRun(this.runId, { status: cancel ? 'cancelled' : 'paused', scopeVersion: this.run.scopeVersion + 1, blockReason: reason });
    for (const controller of this.aborters.values()) controller.abort(new Error(reason));
    this.log(cancel ? 'cancelled' : 'paused', reason); await Promise.allSettled(this.active.values());
  }
  async resume(message?: string): Promise<void> {
    invariant(!['applied', 'cancelled'].includes(this.run.status), 'Terminal run cannot resume');
    invariant(!this.active.size, 'Workers have not stopped yet');
    invariant(!this.store.all<Operation>('outbox', this.runId).some(op => ['running', 'unknown'].includes(op.state)), 'Uncertain operations require jvo recover before resuming');
    for (const task of this.tasks.filter(t => t.workspace && t.workspace !== this.run.repo)) await this.ws.validate(task.workspace!);
    const patch: Partial<Run> = { status: 'running', blockReason: undefined, scopeVersion: this.run.scopeVersion + 1 };
    if (message?.trim()) {
      invariant(message.length <= 30_000, 'Clarification is too long');
      patch.pendingMessage = [this.run.pendingMessage, message].filter(Boolean).join('\n');
      // A user change invalidates all accepted results; preserve work and re-review it.
      for (const task of this.tasks) if (task.kind !== 'integration' && task.snapshot) {
        const partial = task.phase === 'implement' || task.workspace && await dirty(task.workspace);
        this.store.updateTask(task.id, { phase: partial ? 'implement' : 'verify', status: 'reported', staged: false, testsPassed: undefined, testedSnapshot: undefined, reviewedSnapshot: undefined, reviewCount: 0 });
      }
      const final = this.tasks.find(t => t.kind === 'integration');
      if (final) this.store.updateTask(final.id, { phase: 'verify', status: 'reported', reviewedSnapshot: undefined, reviewCount: 0, staged: false });
    }
    this.store.updateRun(this.runId, patch); this.log('resumed', message ? `追加指示: ${message}` : '実行を再開しました。');
  }
  async refreshPolicy(next: Config, provider: DecisionProvider, guard: SecretGuard): Promise<void> {
    invariant(['paused', 'blocked', 'ready_for_user_apply'].includes(this.run.status) && !this.active.size, 'Pause the run before refreshing its approved configuration');
    invariant(!this.store.all<Operation>('outbox', this.runId).some(op => ['running', 'unknown'].includes(op.state)), 'Reconcile uncertain operations before changing configuration');
    validateConfig(next);
    const run = this.run, trust = next.trusts[run.repoId];
    invariant(trust?.repo === run.repo && trust.shareCode && trust.allowLocalExecution, 'Current repository permissions are not approved');
    invariant(trust.tests.length > 0 || trust.allowNoTests, 'Approve verification commands before refreshing');
    invariant(next.profiles.some(p => p.enabled && p.roles.includes('implementer')) && next.profiles.some(p => p.enabled && p.roles.includes('reviewer')), 'Implementation and review profiles are required');
    const contextChanged = hash(trust.skills) !== hash(run.trust.skills);
    this.store.tx(() => {
      this.store.updateRun(run.id, { config: JSON.parse(canonical(next)), trust, status: 'paused', scopeVersion: run.scopeVersion + 1, finalSnapshot: undefined, blockReason: 'Approved configuration refreshed; /resume to revalidate retained work' });
      for (const task of this.tasks) {
        const before = run.config.profiles.find(p => p.id === task.profileId), after = next.profiles.find(p => p.id === task.profileId);
        const changed = contextChanged || !after?.enabled || hash(before ?? null) !== hash(after);
        this.store.updateTask(task.id, { assessments: undefined, contextIds: contextChanged ? [] : task.contextIds,
          ...(changed ? { profileId: undefined, sessionId: undefined, sessionFingerprint: undefined, observedModel: undefined } : {}),
          ...(task.phase === 'done' && !task.snapshot ? {} : { phase: task.snapshot ? 'verify' : 'assess', status: 'reported', testsPassed: undefined, testedSnapshot: undefined, reviewedSnapshot: undefined, reviewCount: 0, staged: false }) });
      }
      this.store.put('approvals', id('policy'), run.id, { oldPolicyHash: hash(run.config), newPolicyHash: hash(next), trust, by: 'user', time: now() });
    });
    this.provider = provider; this.guard = guard; this.adapter = new NativeAdapter(guard);
    this.log('policy.refreshed', '承認済み設定を更新しました。保持した成果物は新しい条件で再検証します。');
  }
  async recover(acknowledge: boolean): Promise<void> {
    invariant(acknowledge, 'Recovery requires explicit --acknowledge after inspecting the retained worktrees and logs');
    invariant(!this.active.size, 'Cannot recover an active supervisor');
    for (const op of this.store.all<Operation>('outbox', this.runId).filter(o => ['running', 'unknown'].includes(o.state))) {
      invariant(!op.pid || (alive(op.pid, op.birth) === 'no' && !processGroupAlive(op.pid)), `Operation ${op.id} may still be running. Stop/reconcile it first.`);
      const task = this.store.task(op.taskId);
      if (task.workspace && task.workspace !== this.run.repo) await this.ws.validate(task.workspace);
      this.store.put('outbox', op.id, this.runId, { ...op, state: 'failed', error: 'Explicitly acknowledged uncertain side effects; next action still requires Jev' });
      this.store.updateTask(task.id, { activeOperation: undefined, phase: op.candidate.reason === 'runtime.verify' ? 'verify' : task.snapshot ? 'judge' : task.workspace ? 'implement' : 'assess', status: 'reported', reviewedSnapshot: undefined, testsPassed: undefined, blockReason: undefined });
      this.resourceStore.release(task.id);
    }
    this.log('recovered', '保持された作業場を再利用します。未確認の成果物は自動承認しません。');
  }
  async apply(): Promise<void> {
    invariant(!this.active.size, 'A worker is still active'); this.store.event(this.runId, 'apply.requested', { snapshot: this.run.finalSnapshot, by: 'user' }); const mode = await this.ws.apply(this.run);
    this.store.updateRun(this.runId, { status: 'applied' }); this.store.put('approvals', `${this.runId}-apply`, this.runId, { snapshot: this.run.finalSnapshot, time: now(), by: 'user' });
    this.log('applied', mode !== 'fast-forward' ? '検証済みです。手元の変更とindexは未コミットのまま保持しています。' : '検証済みの変更を作業ブランチへ反映しました。リモートへのpushは行っていません。');
  }
}
