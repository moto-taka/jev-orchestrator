/** Native, checkpoint-based peer messaging. Only the supervisor writes this mailbox. */
import { Store } from '../storage.ts';
import { SecretGuard } from '../security.ts';
import { canonical, hash, invariant, now, object, text } from '../util.ts';
import type { Config, PeerMessage, PeerQuestion, PeerReply, Task, WorkerReport } from '../types.ts';
export const MESSAGE_LIMITS = { maxMessages: 64, maxTurnsPerTask: 4, ttlMs: 1_800_000 };
export function parsePeerQuestions(value: unknown): PeerQuestion[] {
  invariant(Array.isArray(value) && value.length <= 4, 'At most four peer questions per checkpoint');
  const seen = new Set<string>();
  return value.map(v => { const q = object(v), id = text(q.id, 'peer question ID', 64), to = text(q.to, 'peer recipient', 160), body = text(q.body, 'peer question body', 8000);
    invariant(/^[A-Za-z0-9_-]+$/.test(id) && !seen.has(id) && to.length > 0 && body.trim().length > 0, 'Invalid/duplicate peer question');
    invariant(!('from' in q) && !('fromTaskId' in q) && !('runId' in q), 'Peer senders are supplied by the runtime, not by a worker'); seen.add(id); return { id, to, body }; });
}
export function parsePeerReplies(value: unknown): PeerReply[] {
  invariant(Array.isArray(value) && value.length <= 4, 'At most four peer replies per checkpoint');
  return value.map(v => { const r = object(v), replyTo = text(r.replyTo, 'replyTo', 160), body = text(r.body, 'peer reply body', 8000);
    invariant(replyTo.length > 0 && body.trim().length > 0 && !('from' in r) && !('runId' in r), 'Invalid peer reply'); return { replyTo, body }; });
}
export class Mailbox {
  store: Store; runId: string; guard: SecretGuard;
  constructor(store: Store, runId: string, guard = new SecretGuard()) { this.store = store; this.runId = runId; this.guard = guard; }
  get enabled(): boolean { return this.store.run(this.runId).config.messaging?.enabled === true; }
  get scopeHash(): string { const r = this.store.run(this.runId); return hash({ config: r.config, trust: r.trust, goal: r.goal, clarification: r.pendingMessage }); }
  get limits() { return { ...MESSAGE_LIMITS, ...this.store.run(this.runId).config.messaging }; }
  all(): PeerMessage[] { return this.store.hasTable('messages') ? this.store.all<PeerMessage>('messages', this.runId) : []; }
  get(id: string): PeerMessage { const m = this.store.get<PeerMessage>('messages', id); invariant(m?.runId === this.runId, 'Message is not in this run'); return m; }
  update(id: string, patch: Partial<PeerMessage>): PeerMessage {
    const old = this.get(id), next = { ...old, ...patch, id: old.id, runId: old.runId };
    this.store.put('messages', id, this.runId, next); this.store.event(this.runId, 'peer.state', { messageId: id, status: next.status, taskId: next.fromTaskId }); return next;
  }
  /** Exact retry of one observed invocation is idempotent; no semantic near-match reuse. */
  propose(task: Task, invocationId: string, snapshot: string, report: WorkerReport): PeerMessage[] {
    const qs = parsePeerQuestions(report.peerQuestions ?? []); if (!qs.length) return [];
    invariant(this.enabled, 'Native peer messaging is disabled for this run');
    invariant((task.peerTurns ?? 0) < this.limits.maxTurnsPerTask, 'Peer conversation limit reached');
    const run = this.store.run(this.runId), tasks = this.store.all<Task>('tasks', this.runId);
    return this.store.tx(() => qs.map(q => {
      this.guard.assertOutbound(q.body);
      const to = tasks.find(t => t.id === q.to || t.spec.id === q.to);
      invariant(to && to.id !== task.id && to.kind === 'work' && !to.proposedPlan?.length, 'Choose a different concrete work task from the peer roster');
      const id = `msg-${hash({ run: this.runId, invocationId, localId: q.id }).slice(0, 32)}`;
      const old = this.store.get<PeerMessage>('messages', id);
      if (old) { invariant(old.body === q.body && old.toTaskId === to.id && old.snapshot === snapshot, 'Reused message ID with different content'); return old; }
      invariant(this.all().length < this.limits.maxMessages, 'Run message budget reached');
      const m: PeerMessage = { id, runId: this.runId, threadId: id, kind: 'question', fromTaskId: task.id, toTaskId: to.id,
        fromProfileId: task.profileId, invocationId, body: q.body, bodyHash: this.store.artifact(this.runId, q.body), snapshot, scopeVersion: run.scopeVersion, scopeHash: this.scopeHash,
        status: 'proposed', createdAt: now(), expiresAt: new Date(Date.now() + this.limits.ttlMs).toISOString() };
      this.store.put('messages', id, this.runId, m); this.store.event(this.runId, 'peer.proposed', { messageId: id, taskId: task.id, to: to.id }); return m;
    }));
  }
  reply(question: PeerMessage, task: Task, invocationId: string, profileId: string, reply: PeerReply): PeerMessage {
    invariant(question.kind === 'question' && question.toTaskId === task.id && reply.replyTo === question.id, 'Reply has the wrong conversation or participant');
    this.guard.assertOutbound(reply.body); this.assertFresh(question);
    const id = `msg-${hash({ question: question.id, invocationId, kind: 'answer' }).slice(0, 32)}`;
    const old = this.store.get<PeerMessage>('messages', id); if (old) { invariant(old.body === reply.body, 'Reply ID collision'); return old; }
    invariant(this.all().length < this.limits.maxMessages, 'Run message budget reached');
    const m: PeerMessage = { ...question, id, kind: 'answer', fromTaskId: task.id, toTaskId: question.fromTaskId,
      fromProfileId: profileId, invocationId, replyTo: question.id, body: reply.body, bodyHash: this.store.artifact(this.runId, reply.body), status: 'proposed', createdAt: now(), decisionId: undefined, deliveryOperation: undefined };
    this.store.put('messages', id, this.runId, m); this.update(question.id, { status: 'answered' }); return m;
  }
  assertFresh(m: PeerMessage): void {
    invariant(m.runId === this.runId && m.scopeHash === this.scopeHash, 'Message scope changed; re-propose against the current requirements');
    invariant(Date.parse(m.expiresAt) > Date.now(), 'Message expired; re-propose instead of delivering old information');
    const sender = this.store.task(m.kind === 'question' ? m.fromTaskId : m.toTaskId);
    invariant(sender.snapshot === m.snapshot, 'Question snapshot changed; the answer cannot be delivered to a different revision');
    invariant(hash(m.body) === m.bodyHash, 'Message body integrity check failed');
  }
  outgoing(task: Task): PeerMessage[] { return this.all().filter(m => m.fromTaskId === task.id && m.status === 'proposed'); }
  questions(task: Task): PeerMessage[] { return this.all().filter(m => m.kind === 'question' && m.toTaskId === task.id && m.status === 'queued'); }
  answers(task: Task): PeerMessage[] { return this.all().filter(m => m.kind === 'answer' && m.toTaskId === task.id && m.status === 'queued'); }
  waiting(task: Task): boolean { return this.all().some(m => m.kind === 'question' && m.fromTaskId === task.id && !['closed', 'rejected'].includes(m.status)); }
  readyAnswers(task: Task): PeerMessage[] {
    const answers = this.answers(task), qs = this.all().filter(m => m.kind === 'question' && m.fromTaskId === task.id && !['closed', 'rejected'].includes(m.status));
    return qs.length && qs.every(q => answers.some(a => a.replyTo === q.id)) ? answers : [];
  }
  actionable(task: Task): boolean { return this.enabled && !!(this.outgoing(task).length || this.questions(task).length || this.readyAnswers(task).length); }
  discard(reason: string, threads?: string[]): void {
    this.store.tx(() => { for (const m of this.all()) if (!['closed', 'rejected'].includes(m.status) && (!threads || threads.includes(m.threadId))) {
      this.update(m.id, { status: 'rejected' }); this.store.event(this.runId, 'peer.discarded-by-user', { messageId: m.id, reason });
      const sender = this.store.task(m.kind === 'question' ? m.fromTaskId : m.toTaskId);
      this.store.updateTask(sender.id, { phase: 'implement', status: 'reported', testsPassed: undefined, reviewedSnapshot: undefined, reviewCount: 0, lastFailure: reason });
    } });
  }
  roster(task: Task): string {
    if (!this.enabled) return '';
    const peers = this.store.all<Task>('tasks', this.runId).filter(t => t.kind === 'work' && t.id !== task.id && !t.proposedPlan?.length);
    if (!peers.length) return '';
    return `\nNative jvo peer messaging (no external tools): ${canonical(peers.map(t => ({ to: t.spec.id, task: t.spec.title, assignedProfile: t.profileId, phase: t.phase })))}\nWhen you need an answer from a peer, finish this checkpoint with peerQuestions:[{id:"Q1",to:"exact roster task ID",body:"specific question with relevant evidence"}]. jvo validates the addressed message, obtains a reply, then resumes THIS session with only the answers. Routine delivery is deterministic; Jev is used only when an unassigned peer needs a model or the work needs a new decision. Do not poll, spawn agents, change scope or invent a peer. Questions are not acceptance evidence. Maximum ${this.limits.maxTurnsPerTask} question checkpoints per task.\n`;
  }
}
