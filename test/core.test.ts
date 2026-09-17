import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, hash, clip, safeChild } from '../src/util.ts';
import { SecretGuard, sanitize, globMatch, excluded, validateRelativePath, workerEnvironment } from '../src/security.ts';
import { defaults, validateConfig, validateTrust } from '../src/config.ts';
import { parseReport, validateGraph } from '../src/contracts.ts';
import { parseCommand } from '../src/setup.ts';
import { codexUsage, anthropicUsage, summarizeUsage, checked } from '../src/telemetry.ts';
import { cellWidth, fit, graphemes, renderScreen, wrap } from '../src/tui/screen.ts';
import { execute, processBirth, alive } from '../src/process.ts';

test('canonical hashing is deterministic, independent of object insertion order', () => {
  assert.equal(hash({ z: 1, a: { b: 2 } }), hash({ a: { b: 2 }, z: 1 }));
  assert.notEqual(hash({ x: 1 }), hash({ x: 2 })); assert.equal(canonical({ a: undefined, b: 1 }), '{"b":1}');
  assert.throws(() => canonical({ x: NaN })); assert.notEqual(hash([1, 2]), hash([2, 1]));
});
test('clips at UTF-8 boundaries and marks omitted content', () => {
  const c = clip('日本語の文章'.repeat(20), 24); assert.equal(c.truncated, true); assert(!c.text.includes('�'));
});
test('sanitizes terminal OSC, ANSI, bidirectional controls and NUL', () => {
  assert.equal(sanitize('\x1b[31mred\x1b[0m\x1b]52;c;bad\x07\u202eevil\0'), 'redevil');
  assert.equal(sanitize('a\nb\tc'), 'a\nb\tc');
});
test('control secrets are blocked from outbound state and redacted from logs', () => {
  const guard = new SecretGuard(['a-long-custom-secret']);
  assert.throws(() => guard.assertOutbound('a-long-custom-secret'));
  assert.throws(() => guard.assertOutbound('sk-proj-abcdefghijklmnopqrstuvwx'));
  assert.equal(guard.redact('before a-long-custom-secret after'), 'before [REDACTED] after');
  assert.doesNotThrow(() => guard.assertOutbound('ordinary repository source'));
});
test('worker/test environment never inherits control API keys or startup injection variables', () => {
  const env = { TYPESAFE_API_KEY: 'secret', AI_GATEWAY_API_KEY: 'secret', JVO_API_KEY: 'secret', VERCEL_OIDC_TOKEN: 'secret', NODE_OPTIONS: '--require bad', BASH_ENV: '/tmp/bad', GIT_CONFIG: 'bad', ANTHROPIC_API_KEY: 'worker-specific', PATH: '/usr/bin' };
  const worker = workerEnvironment(env); assert.equal(worker.TYPESAFE_API_KEY, undefined); assert.equal(worker.AI_GATEWAY_API_KEY, undefined); assert.equal(worker.ANTHROPIC_API_KEY, 'worker-specific'); assert.equal(worker.NODE_OPTIONS, undefined);
  const verification = workerEnvironment(env, true); assert.equal(verification.ANTHROPIC_API_KEY, undefined); assert.equal(verification.PATH, '/usr/bin');
});
test('safe path and exclusion rules cover dotfiles, symlinks, credentials and glob roots', () => {
  for (const p of ['../file', '/tmp/file', 'src/../../a', '.git/config', 'a\0b', 'C:\\secret']) assert.throws(() => validateRelativePath(p));
  assert(globMatch('src/a/b.ts', 'src/**')); assert(!globMatch('src/a/b.ts', 'src/*.ts')); assert(globMatch('a.ts', '**/*.ts'));
  for (const p of ['.env', 'src/.env.local', 'auth.json', 'id.pem', 'node_modules/x', '.git/config']) assert(excluded(p));
  assert(excluded('private/notes.txt', ['private/**'])); assert(!excluded('src/app.ts'));
  const root = mkdtempSync(join(tmpdir(), 'jvo-safe-')); symlinkSync(tmpdir(), join(root, 'link'));
  assert.throws(() => safeChild(root, 'link/escape')); assert.throws(() => safeChild(root, '../escape'));
});
test('config rejects unknown providers and unsafe endpoints', () => {
  assert.equal(validateConfig(defaults()).version, 1);
  const c = defaults(); c.decision.endpoint = 'http://public.example/api'; assert.throws(() => validateConfig(c));
  c.decision.endpoint = 'http://127.0.0.1:1234/eval'; assert.doesNotThrow(() => validateConfig(c));
  c.runtime.maxParallel = 0; assert.throws(() => validateConfig(c));
});
test('task plans must be bounded paths, nonempty acceptance and an acyclic graph', () => {
  const base = { title: 'Task', instruction: 'Change', acceptance: ['Works'], readPaths: ['**'], writePaths: ['src/**'], resources: [] };
  assert.doesNotThrow(() => validateGraph([{ ...base, id: 'A', dependsOn: [] }, { ...base, id: 'B', dependsOn: ['A'] }]));
  assert.throws(() => validateGraph([{ ...base, id: 'A', dependsOn: ['A'] }]));
  assert.throws(() => validateGraph([{ ...base, id: 'A', dependsOn: ['missing'] }]));
  assert.throws(() => parseReport(JSON.stringify({ summary: 'plan', plan: [{ ...base, id: 'A', dependsOn: [], writePaths: ['../outside'] }] })));
});
test('worker JSON report is strictly parsed, not accepted from prose success claims', () => {
  assert.equal(parseReport('{"summary":"done","claims":[],"questions":[]}').summary, 'done');
  assert.equal(parseReport('```json\n{"summary":"done"}\n```').summary, 'done');
  assert.throws(() => parseReport('Everything passed!'));
  assert.throws(() => parseReport('{"approved":true}'));
});
test('trusted command parser handles quoting without implicit shells', () => {
  assert.deepEqual(parseCommand('node "a file.cjs" --test'), ['node', 'a file.cjs', '--test']);
  assert.deepEqual(parseCommand("sh -c 'echo hello && node check.cjs'"), ['sh', '-c', 'echo hello && node check.cjs']);
  assert.throws(() => parseCommand('npm test; rm -rf .')); assert.throws(() => parseCommand('node "bad'));
});
test('Codex cache is already inside total; Anthropic cache is additive', () => {
  const c = codexUsage({ input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 });
  assert.equal(c.inputTotal, 100); assert.equal(c.inputUncached, 20);
  const a = anthropicUsage({ input_tokens: 20, cache_read_input_tokens: 70, cache_creation_input_tokens: 10, output_tokens: 4 });
  assert.equal(a.inputTotal, 100); assert.equal(a.inputCacheRead, 70);
  assert.throws(() => checked({ inputTotal: 10, inputCacheRead: 11, basis: 'provider-reported' }));
});
test('usage is token-weighted and never turns unknown into 0% or zero dollars', () => {
  const s = summarizeUsage([{ inputTotal: 100, inputCacheRead: 80, basis: 'provider-reported' }, { inputTotal: 900, inputCacheRead: 0, basis: 'provider-reported' }, { basis: 'unavailable' }]);
  assert.equal(s.cacheRate, 0.08); assert.equal(s.cacheObserved, 2); assert.equal(s.total, 3); assert.equal(s.cost, undefined);
  assert.equal(summarizeUsage([{ basis: 'unavailable' }]).cacheRate, undefined);
});
test('TUI handles Japanese, combining marks, emoji and narrow terminals', () => {
  assert.equal(cellWidth('日本abc'), 7); assert.equal(graphemes('👩‍💻').length, 1); assert.equal(cellWidth('e\u0301'), 1);
  assert.equal(fit('日本語abc', 5), '日本'); assert.deepEqual(wrap('日本語', 4), ['日本', '語']);
  const r = renderScreen(undefined, { input: '日本語', cursor: 2, panel: '', scroll: 0 }, 36, 18);
  assert(r.lines.every(l => cellWidth(l) <= 34)); assert(r.cursor.column >= 1 && r.cursor.column <= 36); assert(r.lines.join('\n').includes('jvo'));
});
test('process runner drains both pipes and enforces timeout', async () => {
  const r = await execute([process.execPath, '-e', 'console.log("ok");console.error("err")'], { cwd: tmpdir() });
  assert.equal(r.code, 0); assert.match(r.stdout, /ok/); assert.match(r.stderr, /err/);
  const timed = await execute([process.execPath, '-e', 'setInterval(()=>{},1000)'], { cwd: tmpdir(), timeoutMs: 60 });
  assert(timed.timedOut); assert.notEqual(timed.code, 0);
});
test('process ownership cannot be assumed from a PID without birth identity', () => {
  assert.equal(alive(process.pid), 'unknown'); assert.equal(alive(process.pid, processBirth(process.pid)), 'yes'); assert.equal(alive(process.pid, 'wrong-birth'), 'no');
});
