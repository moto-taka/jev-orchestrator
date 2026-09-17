import { connect, createServer, type Socket, type Server } from 'node:net';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Engine } from './engine.ts';
import { Store } from './storage.ts';
import { JevProvider } from './decision/provider.ts';
import { repoHome, getKey, home, loadConfig } from './config.ts';
import { SecretGuard } from './security.ts';
import { alive, processBirth } from './process.ts';
import { delay, errorText, hash, id, invariant, privateDir } from './util.ts';
import type { Run, View } from './types.ts';

export function ipcPaths(repo: string): { dir: string; socket: string; token: string; lock: string } {
  const dir = privateDir(join(tmpdir(), `jvo-${process.getuid?.() ?? 'user'}-${hash(realpathSync(repo)).slice(0, 16)}`));
  return { dir, socket: process.platform === 'win32' ? `\\\\.\\pipe\\jvo-${hash(repo).slice(0, 24)}` : join(dir, 'control.sock'), token: join(dir, 'token'), lock: join(dir, 'owner.json') };
}
interface Owner { pid: number; birth?: string; runId: string; }
export function owner(repo: string): Owner | undefined {
  const p = ipcPaths(repo); if (!existsSync(p.lock)) return undefined;
  return JSON.parse(readFileSync(p.lock, 'utf8')) as Owner;
}
function acquire(repo: string, runId: string): () => void {
  const p = ipcPaths(repo), value = { pid: process.pid, birth: processBirth(process.pid), runId };
  if (existsSync(p.lock)) {
    const current = owner(repo)!;
    invariant(alive(current.pid, current.birth) === 'no', `Supervisor ${current.pid} is alive or uncertain. Reconnect instead of starting a second process.`);
    unlinkSync(p.lock); // stale OS owner only; work operations still require explicit recovery
  }
  writeFileSync(p.lock, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  return () => {
    try { const current = owner(repo); if (current?.pid !== process.pid || current.birth !== value.birth) return;
      for (const f of [p.lock, p.token, p.socket]) if (existsSync(f)) unlinkSync(f);
    } catch { /* Never delete another owner's files. */ }
  };
}
export async function supervise(repo: string, runId: string): Promise<void> {
  const release = acquire(repo, runId), p = ipcPaths(repo), store = new Store(repoHome(repo)), resourceStore = new Store(join(home(), 'resources'));
  let server: Server | undefined, engine: Engine | undefined;
  try {
    const run = store.run(runId), key = await getKey(run.config), guard = new SecretGuard([key]);
    engine = new Engine(store, runId, new JevProvider(run.config.decision, key), { guard, resourceStore });
    const token = randomBytes(32).toString('hex'); writeFileSync(p.token, token, { mode: 0o600 }); chmodSync(p.token, 0o600);
    if (existsSync(p.socket)) unlinkSync(p.socket);
    const subscribers = new Set<Socket>(), connections = new Set<Socket>(); let closing = false, hadClient = false;
    let refresh: NodeJS.Timeout | undefined;
    const send = (socket: Socket, value: unknown) => { if (!socket.destroyed) { if (socket.writableLength > 2_000_000) { socket.destroy(); return; } socket.write(JSON.stringify(value) + '\n'); } };
    const broadcast = () => {
      if (refresh) return;
      refresh = setTimeout(() => { refresh = undefined; if (closing) return; const view = engine!.view(); for (const s of subscribers) send(s, { event: 'view', view }); }, 100);
    };
    const shutdown = async (reason: string) => {
      if (closing) return; closing = true;
      if (refresh) clearTimeout(refresh);
      if (engine!.run.status === 'running') await engine!.pause(reason);
      for (const s of connections) { send(s, { event: 'closing', reason }); s.end(); }
      server?.close();
    };
    engine.on('change', broadcast);
    server = createServer(socket => {
      connections.add(socket); let pending = '', authenticated = false;
      socket.on('error', () => socket.destroy());
      socket.on('data', (chunk: Buffer) => {
        pending += chunk.toString('utf8');
        if (Buffer.byteLength(pending) > 100_000) { socket.destroy(); return; }
        for (;;) {
          const n = pending.indexOf('\n'); if (n < 0) break;
          const line = pending.slice(0, n); pending = pending.slice(n + 1);
          void (async () => {
            let requestId = '';
            try {
              const req = JSON.parse(line) as { id: string; token: string; command: string; message?: string; acknowledge?: boolean };
              invariant(typeof req.token === 'string' && req.token.length === token.length && timingSafeEqual(Buffer.from(req.token), Buffer.from(token)), 'Unauthorized local client');
              authenticated = true; hadClient = true; requestId = req.id;
              invariant(typeof requestId === 'string' && requestId.length <= 80, 'Invalid request id');
              let value: unknown;
              switch (req.command) {
                case 'subscribe': subscribers.add(socket); value = engine!.view(); break;
                case 'view': value = engine!.view(); break;
                case 'pause': await engine!.pause(); value = engine!.view(); break;
                case 'cancel': await engine!.pause('User cancelled the run', true); value = engine!.view(); break;
                case 'resume': await engine!.resume(req.message); void engine!.drive(); value = engine!.view(); break;
                case 'apply': await engine!.apply(); value = engine!.view(); break;
                case 'refresh': { const next = loadConfig(), nextKey = await getKey(next); guard.add(nextKey); await engine!.refreshPolicy(next, new JevProvider(next.decision, nextKey), guard); value = engine!.view(); break; }
                case 'recover': await engine!.recover(req.acknowledge === true); value = engine!.view(); break;
                case 'diff': value = await engine!.ws.diff(engine!.run.base, engine!.run.finalSnapshot ?? engine!.run.integrationHead, engine!.run.trust.exclude); break;
                case 'detach': store.updateRun(runId, { detached: true }); value = { detached: true }; break;
                case 'attach': store.updateRun(runId, { detached: false }); value = engine!.view(); break;
                case 'close': send(socket, { id: requestId, ok: true }); await shutdown('User closed the session'); return;
                default: throw new Error('Unknown control command');
              }
              send(socket, { id: requestId, ok: true, value });
            } catch (e) { send(socket, { id: requestId, ok: false, error: guard.redact(errorText(e)) }); if (!authenticated) socket.destroy(); }
          })();
        }
      });
      socket.on('close', () => {
        connections.delete(socket); subscribers.delete(socket);
        if (authenticated && hadClient && ![...connections].length && !engine!.run.detached) void shutdown('Client disconnected; run paused, work preserved');
      });
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(p.socket, () => { if (process.platform !== 'win32') chmodSync(p.socket, 0o600); resolve(); }); });
    const stop = () => { void shutdown('Supervisor interrupted'); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop); process.once('SIGHUP', stop);
    // An unattached startup never runs indefinitely or performs unrequested detached work.
    const startupTimeout = setTimeout(() => { if (!hadClient && !run.detached) void shutdown('No client attached'); }, 15_000); startupTimeout.unref();
    void engine.drive().catch(e => engine!.log('error', errorText(e)));
    await new Promise<void>(resolve => server!.once('close', resolve));
    clearTimeout(startupTimeout); if (refresh) clearTimeout(refresh);
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); process.removeListener('SIGHUP', stop);
  } finally { store.close(); resourceStore.close(); release(); }
}
export class Client extends EventEmitter {
  private socket: Socket; private token: string; private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  constructor(socket: Socket, token: string) {
    super(); this.socket = socket; this.token = token; let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8'); if (buffer.length > 5_000_000) { socket.destroy(new Error('Control response too large')); return; }
      for (;;) { const n = buffer.indexOf('\n'); if (n < 0) break; const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
        try { const r = JSON.parse(line); if (r.event) { this.emit(r.event, r.view ?? r.reason); continue; }
          const request = this.pending.get(r.id); if (request) { clearTimeout(request.timer); this.pending.delete(r.id); r.ok ? request.resolve(r.value) : request.reject(new Error(r.error)); }
        } catch (e) { this.emit('protocol-error', errorText(e)); }
      }
    });
    socket.on('error', e => this.emit('connection-error', errorText(e)));
    socket.on('close', () => { for (const r of this.pending.values()) { clearTimeout(r.timer); r.reject(new Error('Supervisor disconnected')); } this.pending.clear(); this.emit('closed'); });
  }
  request<T = View>(command: string, extra: Record<string, unknown> = {}): Promise<T> {
    const requestId = id('req');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Control request timed out')); }, 120_000);
      this.pending.set(requestId, { resolve, reject, timer }); this.socket.write(JSON.stringify({ ...extra, token: this.token, id: requestId, command }) + '\n');
    });
  }
  close(): void { this.socket.end(); }
}
export async function connectClient(repo: string): Promise<Client> {
  const p = ipcPaths(repo), token = readFileSync(p.token, 'utf8');
  const socket = connect(p.socket);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return new Client(socket, token);
}
export async function launchSupervisor(repo: string, runId: string): Promise<Client> {
  const current = owner(repo);
  if (current && alive(current.pid, current.birth) !== 'no') {
    invariant(current.runId === runId, `Another run is supervised: ${current.runId}`); return connectClient(repo);
  }
  const log = join(privateDir(repoHome(repo)), 'supervisor.log');
  const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './cli.ts' : './cli.js', import.meta.url)), '__supervise', repo, runId], { detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
  let error = ''; child.stderr?.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-8000); });
  child.unref();
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`Supervisor startup failed: ${error || child.exitCode}`);
    const owned = owner(repo);
    if (owned?.pid === child.pid && existsSync(ipcPaths(repo).token)) { try { const client = await connectClient(repo); child.stderr?.destroy(); return client; } catch { /* Socket may not be listening yet. */ } }
    await delay(100);
  }
  child.kill('SIGTERM'); throw new Error(`Supervisor did not become ready. ${error}`);
}
