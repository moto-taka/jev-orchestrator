import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, chmodSync, openSync, writeFileSync, closeSync, fsyncSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Json } from './types.ts';
export function invariant(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export function object(value: unknown): Record<string, unknown> {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an object');
  return value as Record<string, unknown>;
}
export function text(value: unknown, name = 'value', max = 100_000): string {
  invariant(typeof value === 'string' && value.length <= max, `${name}: expected bounded text`);
  return value;
}
export function strings(value: unknown, name = 'value', max = 200): string[] {
  invariant(Array.isArray(value) && value.length <= max, `${name}: expected an array`);
  return value.map(x => text(x, name));
}
export function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  invariant(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max, `${name}: invalid integer`);
  return value;
}
export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    invariant(typeof value !== 'number' || Number.isFinite(value), 'Non-finite JSON number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined)
    .map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
export function hash(value: unknown): string { return createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex'); }
export const id = (prefix: string): string => `${prefix}-${randomUUID()}`;
export const now = (): string => new Date().toISOString();
export const json = (value: unknown): Json => JSON.parse(canonical(value)) as Json;
export function isInside(root: string, candidate: string): boolean {
  const r = relative(resolve(root), resolve(candidate));
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
}
export function privateDir(path: string): string {
  const full = resolve(path);
  const missing: string[] = [];
  let cursor = full;
  while (!existsSync(cursor)) { missing.unshift(cursor); cursor = dirname(cursor); }
  invariant(lstatSync(cursor).isDirectory(), `Not a directory: ${cursor}`);
  // Existing system ancestors may be symlinks (e.g. /var on macOS). The managed root itself may not.
  if (existsSync(full)) invariant(!lstatSync(full).isSymbolicLink(), `Refusing symlink: ${full}`);
  for (const p of missing) mkdirSync(p, { mode: 0o700 });
  chmodSync(full, 0o700);
  return realpathSync(full);
}
export function safeChild(root: string, name: string): string {
  invariant(!isAbsolute(name) && !name.split(/[\\/]/).includes('..'), 'Unsafe managed path');
  const p = resolve(root, name);
  invariant(isInside(root, p), 'Managed path escaped root');
  let q = p;
  while (q !== resolve(root)) {
    if (existsSync(q)) invariant(!lstatSync(q).isSymbolicLink(), `Symlink in managed path: ${q}`);
    q = dirname(q);
  }
  return p;
}
export function atomicWrite(path: string, content: string): void {
  privateDir(dirname(path));
  invariant(!existsSync(path) || !lstatSync(path).isSymbolicLink(), 'Refusing symlink file');
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? new Error('Aborted')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export function clip(value: string, bytes: number): { text: string; truncated: boolean } {
  const b = Buffer.from(value);
  if (b.length <= bytes) return { text: value, truncated: false };
  let s = b.subarray(0, Math.max(0, bytes - 30)).toString('utf8');
  if (s.endsWith('\uFFFD')) s = s.slice(0, -1);
  return { text: s + '\n[TRUNCATED: request more evidence]', truncated: true };
}
