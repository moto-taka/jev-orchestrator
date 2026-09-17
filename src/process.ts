import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, lstatSync, statSync, accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, resolve, dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { assertCommand, workerEnvironment } from './security.ts';
import { errorText, invariant, isInside } from './util.ts';
export function processBirth(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') {
      const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return s.slice(s.lastIndexOf(')') + 2).split(' ')[19];
    }
    const p = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1500 });
    return p.status === 0 && p.stdout.trim() ? p.stdout.trim() : undefined;
  } catch { return undefined; }
}
export function alive(pid: number, birth?: string): 'yes' | 'no' | 'unknown' {
  try { process.kill(pid, 0); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH' ? 'no' : 'unknown'; }
  if (!birth) return 'unknown';
  const actual = processBirth(pid);
  return actual ? (actual === birth ? 'yes' : 'no') : 'unknown';
}
export function processGroupAlive(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try { process.kill(-pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export function executable(name: string, cwd = process.cwd(), path = process.env.PATH ?? ''): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = resolve(dir, name);
    try {
      const resolved = realpathSync(p);
      if (isInside(cwd, resolved) || isInside(cwd, p)) continue;
      accessSync(resolved, constants.X_OK);
      if (statSync(resolved).isFile()) return resolved;
    } catch { /* An absent candidate is not an error. */ }
  }
  return undefined;
}
export interface ProcessOptions {
  cwd: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number;
  signal?: AbortSignal; maxBytes?: number;
  onStdout?: (line: string) => void; onStderr?: (line: string) => void;
  onSpawn?: (pid: number, birth?: string) => void;
}
export interface ProcessResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean; interrupted: boolean; overflow: boolean; groupRunning: boolean; }
export async function execute(argv: string[], options: ProcessOptions): Promise<ProcessResult> {
  assertCommand(argv);
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const max = options.maxBytes ?? 2_000_000;
    let stdout = '', stderr = '', outBytes = 0, errBytes = 0;
    let timedOut = false, interrupted = false, overflow = false, settled = false;
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd, env: options.env ?? workerEnvironment(), shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { process.platform === 'win32' ? child.kill('SIGTERM') : process.kill(-child.pid!, 'SIGTERM'); } catch { /* Already exited. */ }
      killTimer = setTimeout(() => {
        try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already exited. */ }
      }, 1500);
      killTimer.unref();
    };
    const abort = () => { interrupted = true; terminate(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs ?? 120_000);
    const wire = (stream: NodeJS.ReadableStream, cb: ((line: string) => void) | undefined, out: boolean) => {
      const decoder = new StringDecoder('utf8');
      let line = '';
      const emit = (s: string) => {
        try { cb?.(s); } catch (e) { stderr += `\nProtocol error: ${errorText(e)}`; overflow = true; terminate(); }
      };
      stream.on('data', (chunk: Buffer) => {
        const s = decoder.write(chunk);
        if (out) { outBytes += chunk.length; if (outBytes <= max) stdout += s; }
        else { errBytes += chunk.length; if (errBytes <= max) stderr += s; }
        // Keep draining both streams even when the UI isn't showing this worker.
        line += s;
        for (;;) {
          const i = line.indexOf('\n'); if (i < 0) break;
          emit(line.slice(0, i).replace(/\r$/, '')); line = line.slice(i + 1);
        }
        if (line.length > 1_000_000 || outBytes + errBytes > max * 4) { overflow = true; line = ''; terminate(); }
      });
      stream.on('end', () => { line += decoder.end(); if (line) emit(line); });
    };
    wire(child.stdout, options.onStdout, true); wire(child.stderr, options.onStderr, false);
    child.on('spawn', () => { try { if (child.pid) options.onSpawn?.(child.pid, processBirth(child.pid)); } catch (e) { stderr += `\nProcess receipt failed: ${errorText(e)}`; overflow = true; terminate(); } });
    const cleanup = () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); options.signal?.removeEventListener('abort', abort); };
    child.on('error', e => { if (!settled) { settled = true; cleanup(); reject(e); } });
    child.on('close', (code, signal) => {
      if (!settled) { settled = true; cleanup(); resolve({ code, signal, stdout, stderr, timedOut, interrupted, overflow, groupRunning: !!child.pid && processGroupAlive(child.pid) }); }
    });
    child.stdin.on('error', () => { /* EPIPE is reported through the process exit. */ });
    child.stdin.end(options.input ?? '');
  });
}
export function assertManagedDirectory(root: string, path: string): void {
  invariant(existsSync(path) && !lstatSync(path).isSymbolicLink() && lstatSync(path).isDirectory(), `Missing or unsafe workspace: ${path}`);
  invariant(isInside(realpathSync(root), realpathSync(path)), 'Workspace escaped managed root');
  let cursor = resolve(path); const boundary = resolve(root);
  while (cursor !== boundary) {
    invariant(!lstatSync(cursor).isSymbolicLink(), 'Workspace path contains a symlink');
    const parent = dirname(cursor); invariant(parent !== cursor, 'Workspace path escaped its lexical root'); cursor = parent;
  }
}
