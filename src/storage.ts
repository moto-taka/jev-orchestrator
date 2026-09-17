import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync, chmodSync, lstatSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, hash, invariant, now, privateDir, safeChild } from './util.ts';
import type { Decision, Operation, Run, Task, Usage } from './types.ts';
const TABLES = new Set(['runs', 'tasks', 'attempts', 'profiles', 'sessions', 'workspaces', 'decisions', 'artifacts', 'usage', 'outbox', 'approvals']);
export class Store {
  root: string;
  db: DatabaseSync;
  private depth = 0;
  constructor(root: string, options: { readOnly?: boolean } = {}) {
    this.root = options.readOnly ? root : privateDir(root);
    const path = join(this.root, 'state.sqlite');
    invariant(!existsSync(path) || !lstatSync(path).isSymbolicLink(), 'Unsafe state database');
    if (options.readOnly) invariant(!existsSync(path + '-wal') || statSync(path + '-wal').size === 0, 'A live SQLite journal is present. Close the supervisor with /exit before offline replay; jvo will not checkpoint it implicitly.');
    // SQLite's ordinary read-only mode can create WAL sidecars. Immutable mode
    // avoids those writes and is used only for a fully checkpointed offline DB.
    this.db = new DatabaseSync(options.readOnly ? pathToFileURL(path).href + '?immutable=1&mode=ro' : path, { readOnly: options.readOnly ?? false });
    if (options.readOnly) {
      this.db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;');
      const schema = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined;
      invariant(schema?.value === '1', 'Unsupported or missing state schema');
      return;
    }
    chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | undefined;
    invariant(!version || version.value === '1', 'Unsupported state schema; do not downgrade jvo');
    for (const table of TABLES) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ${table}_run ON ${table}(run_id)`);
    this.db.exec('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, time TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, previous TEXT NOT NULL, hash TEXT NOT NULL); CREATE INDEX IF NOT EXISTS events_run ON events(run_id,seq); CREATE TABLE IF NOT EXISTS leases (resource TEXT PRIMARY KEY, owner TEXT NOT NULL, run_id TEXT NOT NULL, expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS memo (key TEXT PRIMARY KEY, decision_id TEXT NOT NULL, data TEXT NOT NULL);');
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('schema','1')").run();
    privateDir(join(this.root, 'artifacts'));
  }
  close(): void { this.db.close(); }
  tx<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    finally { this.depth--; }
  }
  get<T>(table: string, id: string): T | undefined {
    invariant(TABLES.has(table), 'Unknown table');
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as T : undefined;
  }
  put(table: string, id: string, runId: string, value: unknown): void {
    invariant(TABLES.has(table), 'Unknown table');
    this.db.prepare(`INSERT INTO ${table}(id,run_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,run_id=excluded.run_id`).run(id, runId, canonical(value));
  }
  all<T>(table: string, runId?: string): T[] {
    invariant(TABLES.has(table), 'Unknown table');
    const rows = (runId === undefined ? this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all()
      : this.db.prepare(`SELECT data FROM ${table} WHERE run_id=? ORDER BY rowid`).all(runId)) as { data: string }[];
    return rows.map(r => JSON.parse(r.data) as T);
  }
  run(runId: string): Run { const r = this.get<Run>('runs', runId); invariant(r, `Run not found: ${runId}`); return r; }
  task(taskId: string): Task { const t = this.get<Task>('tasks', taskId); invariant(t, `Task not found: ${taskId}`); return t; }
  updateTask(taskId: string, update: Partial<Task>, expected?: number): Task {
    const task = this.task(taskId);
    invariant(expected === undefined || task.version === expected, 'Stale task version');
    const next = { ...task, ...update, id: task.id, runId: task.runId, version: task.version + 1 };
    this.put('tasks', task.id, task.runId, next); return next;
  }
  updateRun(runId: string, update: Partial<Run>): Run {
    const previous = this.run(runId);
    const clock: Partial<Run> = {};
    if (previous.status === 'running' && update.status && update.status !== 'running') { clock.activeMs = (previous.activeMs ?? 0) + Math.max(0, Date.now() - Date.parse(previous.activeSince ?? previous.createdAt)); clock.activeSince = undefined; }
    if (previous.status !== 'running' && update.status === 'running') clock.activeSince = now();
    const run = { ...previous, ...update, ...clock, id: runId, updatedAt: now() };
    this.put('runs', runId, runId, run); return run;
  }
  event(runId: string, kind: string, data: unknown): void {
    this.tx(() => {
      const row = this.db.prepare('SELECT hash FROM events WHERE run_id=? ORDER BY seq DESC LIMIT 1').get(runId) as { hash: string } | undefined;
      const time = now(), body = canonical(data), previous = row?.hash ?? 'genesis';
      this.db.prepare('INSERT INTO events(run_id,time,kind,data,previous,hash) VALUES(?,?,?,?,?,?)').run(runId, time, kind, body, previous, hash({ runId, time, kind, body, previous }));
    });
  }
  events(runId: string, limit = 200): { seq: number; time: string; kind: string; data: Record<string, unknown> }[] {
    const rows = this.db.prepare('SELECT seq,time,kind,data FROM events WHERE run_id=? ORDER BY seq DESC LIMIT ?').all(runId, limit) as { seq: number; time: string; kind: string; data: string }[];
    return rows.reverse().map(r => ({ ...r, data: JSON.parse(r.data) as Record<string, unknown> }));
  }
  verifyJournal(runId: string): boolean {
    let previous = 'genesis';
    const rows = this.db.prepare('SELECT * FROM events WHERE run_id=? ORDER BY seq').all(runId) as { time: string; kind: string; data: string; previous: string; hash: string }[];
    for (const r of rows) {
      if (r.previous !== previous || r.hash !== hash({ runId, time: r.time, kind: r.kind, body: r.data, previous })) return false;
      previous = r.hash;
    }
    return true;
  }
  artifact(runId: string, content: string): string {
    const h = hash(content), p = safeChild(join(this.root, 'artifacts'), h);
    if (!existsSync(p)) writeFileSync(p, content, { mode: 0o600, flag: 'wx' });
    this.put('artifacts', h, runId, { hash: h, bytes: Buffer.byteLength(content) }); return h;
  }
  readArtifact(h: string): string {
    invariant(/^[a-f0-9]{64}$/.test(h), 'Invalid artifact ID');
    const s = readFileSync(safeChild(join(this.root, 'artifacts'), h), 'utf8');
    invariant(hash(s) === h, 'Artifact integrity failure'); return s;
  }
  lease(resources: string[], owner: string, runId: string, ttl: number): boolean {
    return this.tx(() => {
      for (const resource of [...new Set(resources)].sort()) {
        const row = this.db.prepare('SELECT owner FROM leases WHERE resource=?').get(resource) as { owner: string } | undefined;
        // An expired lease is NOT proof that the previous process stopped. Explicit reconciliation is required.
        if (row && row.owner !== owner) return false;
      }
      for (const resource of new Set(resources)) this.db.prepare('INSERT INTO leases VALUES(?,?,?,?) ON CONFLICT(resource) DO UPDATE SET expires=excluded.expires').run(resource, owner, runId, Date.now() + ttl);
      return true;
    });
  }
  release(owner: string): void { this.db.prepare('DELETE FROM leases WHERE owner=?').run(owner); }
  held(runId?: string): { resource: string; owner: string }[] {
    return (runId ? this.db.prepare('SELECT resource,owner FROM leases WHERE run_id=?').all(runId) : this.db.prepare('SELECT resource,owner FROM leases').all()) as { resource: string; owner: string }[];
  }
  refs(task: Task): Record<string, number> {
    const refs: Record<string, number> = { [task.id]: task.version, '@scope': this.run(task.runId).scopeVersion };
    for (const dep of task.spec.dependsOn) refs[dep] = this.task(dep).version;
    return refs;
  }
  fresh(runId: string, refs: Record<string, number>): boolean {
    return Object.entries(refs).every(([k, v]) => k === '@scope' ? this.run(runId).scopeVersion === v : this.get<Task>('tasks', k)?.version === v);
  }
  commitDecision(decision: Decision, operation?: Operation): boolean {
    return this.tx(() => {
      const existing = this.get<Decision>('decisions', decision.id);
      if (existing) { invariant(existing.semanticHash === decision.semanticHash && existing.candidateHash === decision.candidateHash, 'Decision ID collision'); return false; }
      if (!this.fresh(decision.runId, decision.refs)) { decision.outcome = 'stale'; operation = undefined; }
      this.put('decisions', decision.id, decision.runId, decision);
      this.event(decision.runId, 'decision', { id: decision.id, taskId: decision.taskId, action: decision.selected?.kind, outcome: decision.outcome });
      if (!operation) return false;
      invariant(decision.outcome === 'execute', 'Only an executed decision can create an operation');
      invariant(!this.task(operation.taskId).activeOperation, 'Task already has an operation');
      this.put('outbox', operation.id, operation.runId, operation);
      this.updateTask(operation.taskId, { activeOperation: operation.id }); return true;
    });
  }
  memo(key: string): { decisionId: string; evaluation: unknown } | undefined {
    const row = this.db.prepare('SELECT decision_id,data FROM memo WHERE key=?').get(key) as { decision_id: string; data: string } | undefined;
    return row ? { decisionId: row.decision_id, evaluation: JSON.parse(row.data) } : undefined;
  }
  saveMemo(key: string, decisionId: string, evaluation: unknown): void {
    this.db.prepare('INSERT INTO memo VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET decision_id=excluded.decision_id,data=excluded.data').run(key, decisionId, canonical(evaluation));
  }
  usage(key: string, runId: string, value: Usage): void {
    this.db.prepare('INSERT OR IGNORE INTO usage VALUES(?,?,?)').run(key, runId, canonical(value));
  }
}
