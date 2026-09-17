import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { atomicWrite, hash, integer, invariant, object, privateDir, text } from './util.ts';
import { execute, executable } from './process.ts';
import { assertCommand, workerEnvironment } from './security.ts';
import type { Config, Profile, Trust } from './types.ts';
export function statePath(): string { return resolve(process.env.JVO_HOME ?? join(homedir(), '.local', 'state', 'jvo')); }
export function home(): string { return privateDir(statePath()); }
export function configPath(): string { return join(home(), 'config.json'); }
export function defaults(): Config {
  return {
    version: 1,
    decision: { provider: 'typesafe', model: 'jev-latest', transport: 'http', timeoutMs: 30_000, retries: 2, immutableModel: false, keyStore: 'environment', gatewayOptions: {} },
    runtime: { maxParallel: 3, maxRepairs: 3, maxSameFailure: 2, maxWorkerStarts: 40, maxDecisions: 200, maxRunMs: 7_200_000, maxTasks: 24, maxLogBytes: 8_000_000 },
    thresholds: { route: 0.5, accept: 0.8, highRiskAccept: 0.9, evidence: 0.8 },
    profiles: [], trusts: {},
  };
}
export function validateConfig(value: unknown): Config {
  const c = object(value);
  invariant(c.version === 1, 'Unsupported configuration version');
  const d = object(c.decision), rt = object(c.runtime), th = object(c.thresholds);
  invariant(d.provider === 'typesafe' || d.provider === 'vercel', 'Invalid decision provider');
  invariant(d.transport === 'http' || d.transport === 'sdk', 'Invalid transport');
  invariant(d.keyStore === 'environment' || d.keyStore === 'keychain', 'Invalid key store');
  invariant(typeof d.immutableModel === 'boolean', 'immutableModel must be boolean');
  text(d.model, 'model', 160);
  integer(d.timeoutMs, 'timeoutMs', 100, 300_000); integer(d.retries, 'retries', 0, 5);
  object(d.gatewayOptions);
  if (d.endpoint !== undefined) {
    const url = new URL(text(d.endpoint));
    invariant(!url.username && !url.password && !url.search && !url.hash, 'Invalid provider endpoint');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    invariant(url.protocol === 'https:' || (url.protocol === 'http:' && local), 'Provider endpoint must use HTTPS (loopback HTTP is allowed for tests)');
  }
  for (const [key, max] of Object.entries({ maxParallel: 16, maxRepairs: 20, maxSameFailure: 20, maxWorkerStarts: 1000, maxDecisions: 10_000, maxRunMs: 86_400_000, maxTasks: 100, maxLogBytes: 100_000_000 })) integer(rt[key], key, 1, max);
  for (const key of ['route', 'accept', 'highRiskAccept', 'evidence']) invariant(typeof th[key] === 'number' && th[key] >= 0 && th[key] <= 1, `Invalid ${key} threshold`);
  invariant(Array.isArray(c.profiles) && c.profiles.length <= 64, 'Invalid profiles');
  const ids = new Set<string>();
  for (const p of c.profiles) {
    validateProfile(p);
    invariant(!ids.has((p as Profile).id), 'Duplicate profile ID'); ids.add((p as Profile).id);
  }
  const trusts = object(c.trusts);
  for (const [key, tr] of Object.entries(trusts)) { validateTrust(tr); invariant(key === repoId((tr as Trust).repo), 'Trust must match the canonical repository path'); }
  return c as unknown as Config;
}
function validateProfile(value: unknown): void {
  const p = object(value);
  invariant(/^[a-zA-Z0-9_-]{1,64}$/.test(text(p.id)), 'Invalid profile ID');
  invariant(['codex', 'claude', 'pi', 'opencode'].includes(text(p.adapter)), 'Invalid adapter');
  invariant(isAbsolute(text(p.binary)) && !text(p.binary).includes('\0'), 'Profile executable must be absolute');
  text(p.version); text(p.capabilityHash);
  if (p.tier !== undefined) invariant(['fast', 'standard', 'deep', 'review'].includes(String(p.tier)), 'Invalid profile tier');
  invariant(Array.isArray(p.roles) && p.roles.length > 0 && p.roles.every(r => ['scout', 'planner', 'implementer', 'reviewer', 'explainer'].includes(r)), 'Invalid profile roles');
  invariant(['managed', 'trusted-local', 'assisted', 'unavailable'].includes(text(p.level)) && typeof p.enabled === 'boolean', 'Invalid management level');
  integer(p.maxTurns, 'profile maxTurns', 1, 200); integer(p.timeoutMs, 'profile timeout', 1000, 7_200_000);
  for (const key of ['model', 'provider', 'thinking']) if (p[key] !== undefined) invariant(text(p[key], key, 160).length > 0, `${key} cannot be empty`);
}
export function validateTrust(value: unknown): Trust {
  const t = object(value);
  invariant(isAbsolute(text(t.repo)), 'Trust repository must be absolute');
  for (const key of ['shareCode', 'allowLocalExecution', 'allowNoTests']) invariant(typeof t[key] === 'boolean', `Invalid trust ${key}`);
  for (const key of ['tests', 'setup']) {
    invariant(Array.isArray(t[key]) && t[key].length <= 20, 'Invalid command list');
    for (const cmd of t[key]) {
      const o = object(cmd); invariant(Array.isArray(o.argv), 'Command must be an argv array');
      assertCommand(o.argv as string[]); integer(o.timeoutMs, 'command timeout', 100, 7_200_000);
      if (o.env) for (const [k, v] of Object.entries(object(o.env))) {
        invariant(/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !/JVO_|TYPESAFE|AI_GATEWAY|VERCEL|NODE_OPTIONS|BASH_ENV|LD_PRELOAD|DYLD_/i.test(k), 'Control environment cannot be overridden'); text(v);
      }
    }
  }
  invariant(Array.isArray(t.exclude) && t.exclude.every(x => typeof x === 'string'), 'Invalid exclusions');
  invariant(Array.isArray(t.skills) && t.skills.every(x => typeof x === 'string' && isAbsolute(x)), 'Skill roots must be absolute and explicitly trusted');
  integer(t.maxEvidenceBytes, 'maxEvidenceBytes', 2000, 1_000_000); text(t.approvedAt);
  return t as unknown as Trust;
}
export function loadConfig(): Config {
  return existsSync(configPath()) ? validateConfig(JSON.parse(readFileSync(configPath(), 'utf8'))) : defaults();
}
export function saveConfig(config: Config): void { atomicWrite(configPath(), JSON.stringify(validateConfig(config), null, 2) + '\n'); }
export function repoId(repo: string): string { return hash(resolve(repo)).slice(0, 24); }
export function repoHome(repo: string): string { return privateDir(join(home(), 'repos', repoId(repo))); }
export function keyEnv(config: Config): string { return config.decision.provider === 'typesafe' ? 'TYPESAFE_API_KEY' : 'AI_GATEWAY_API_KEY'; }
export async function getKey(config: Config): Promise<string> {
  const env = process.env[keyEnv(config)] ?? process.env.JVO_API_KEY;
  if (env?.trim()) return env.trim();
  invariant(config.decision.keyStore === 'keychain', `Set ${keyEnv(config)} or run jvo setup`);
  let argv: string[];
  if (process.platform === 'darwin') argv = ['/usr/bin/security', 'find-generic-password', '-s', 'jev-orchestrator', '-a', config.decision.provider, '-w'];
  else {
    const bin = executable('secret-tool', homedir());
    invariant(bin, 'System secret store unavailable. Set the provider API key environment variable.');
    argv = [bin, 'lookup', 'service', 'jev-orchestrator', 'account', config.decision.provider];
  }
  const r = await execute(argv, { cwd: homedir(), timeoutMs: 10_000, env: workerEnvironment(), maxBytes: 20_000 });
  invariant(r.code === 0 && r.stdout.trim(), 'Could not read key from system secret store');
  return r.stdout.trim();
}
export async function storeKey(config: Config, key: string): Promise<boolean> {
  invariant(key.length >= 8 && !/[\n\r\0]/.test(key), 'Invalid API key');
  if (process.platform === 'darwin') {
    const quote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    // Interactive command input keeps the key out of the process argument list.
    const command = `add-generic-password -U -s jev-orchestrator -a ${quote(config.decision.provider)} -w ${quote(key)}\n`;
    const r = await execute(['/usr/bin/security', '-i'], { cwd: homedir(), input: command, timeoutMs: 15_000, maxBytes: 20_000 });
    return r.code === 0 && !/SecKeychain|error:/i.test(r.stderr);
  }
  const bin = executable('secret-tool', homedir());
  if (!bin) return false;
  const r = await execute([bin, 'store', '--label=Jev Orchestrator', 'service', 'jev-orchestrator', 'account', config.decision.provider], { cwd: homedir(), input: key, timeoutMs: 15_000, maxBytes: 20_000 });
  return r.code === 0;
}
