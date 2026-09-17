import { stripVTControlCharacters } from 'node:util';
import { isAbsolute } from 'node:path';
import { invariant } from './util.ts';
const KEY_NAMES = /(?:JVO_.*(?:KEY|TOKEN)|TYPESAFE.*(?:KEY|TOKEN)|AI_GATEWAY_API_KEY|VERCEL_(?:OIDC_TOKEN|API_KEY|TOKEN))/i;
const SECRET = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g;
export function sanitize(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}
export class SecretGuard {
  private secrets: string[];
  constructor(values: string[] = []) { this.secrets = values.filter(v => v.length >= 8); }
  add(value: string): void { if (value.length >= 8 && !this.secrets.includes(value)) this.secrets.push(value); }
  redact(value: string): string {
    let out = sanitize(value).replace(SECRET, '[REDACTED]');
    for (const s of this.secrets) out = out.split(s).join('[REDACTED]');
    return out.replace(/((?:api[_-]?key|authorization|access[_-]?token|secret)\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',}]{12,}/gi, '$1[REDACTED]');
  }
  assertOutbound(value: string): void {
    SECRET.lastIndex = 0;
    invariant(!SECRET.test(value) && !this.secrets.some(s => value.includes(s)), 'Possible secret in outbound evidence; transmission blocked. Exclude the source or remove the secret.');
  }
}
export function workerEnvironment(env: NodeJS.ProcessEnv = process.env, tests = false): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (KEY_NAMES.test(k) || /^JVO_|^GIT_|^NODE_OPTIONS$|^BASH_ENV$|^ENV$|^CDPATH$|^LD_PRELOAD$|^DYLD_/i.test(k)) continue;
    if (tests && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k)) continue;
    result[k] = v;
  }
  return { ...result, NO_COLOR: '1', TERM: 'dumb', GIT_TERMINAL_PROMPT: '0', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
}
export function validateRelativePath(path: string, glob = false): void {
  invariant(path.length > 0 && path.length <= 1024 && !isAbsolute(path) && !/^[A-Za-z]:/.test(path), 'Path must be relative');
  invariant(!/[\u0000-\u001f\\]/.test(path) && !path.split('/').includes('..'), 'Unsafe path');
  invariant(!path.split('/').some(p => p === '.git') && (!glob || !/[\[\]{}]/.test(path)), 'Unsupported or protected path');
}
export function globMatch(path: string, pattern: string): boolean {
  const re = pattern.split('**').map(part => part.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
  return new RegExp(`^${re}$`).test(path) || (pattern.startsWith('**/') && globMatch(path, pattern.slice(3)));
}
export function excluded(path: string, extra: string[] = []): boolean {
  return path.split('/').some(p => p === '.git' || p === 'node_modules' || p === '.ssh' || p === '.aws' || p === '.jvo' || p === '.pi')
    || /(?:^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|credentials(?:\.json)?|auth\.json)$/.test(path)
    || extra.some(pattern => globMatch(path, pattern));
}
export function assertCommand(argv: string[]): void {
  invariant(argv.length > 0 && argv.length <= 100 && argv.every(a => typeof a === 'string' && !a.includes('\0') && a.length < 100_000), 'Invalid command arguments');
  invariant(argv[0]!.length > 0, 'Missing executable');
}

export const terminalText = sanitize;
