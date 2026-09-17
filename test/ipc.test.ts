import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, copyFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createDemo, DemoProvider } from '../src/demo.ts';
import { detectOne, profileFrom } from '../src/adapters/registry.ts';
import { repoId } from '../src/config.ts';
import { execute } from '../src/process.ts';
import { defaults } from '../src/config.ts';
import { git } from '../src/workspaces.ts';
import type { Json, Question, Evaluation } from '../src/types.ts';
function wire(e: Evaluation) { return { model: 'fixture-jev', answers: Object.fromEntries(Object.entries(e.answers).map(([k, a]) => [k, a.kind === 'boolean' ? { type: 'noul', noul: a.probability } : a.kind === 'choice' ? { type: 'choice', choice: a.selected, probabilities: a.probabilities, confidence: a.confidence } : { type: 'score', score: a.value, legend: Object.fromEntries(a.levels.map((v, i) => [String(i), v])), probabilities: a.probabilities, confidence: a.confidence }])), usage: { input_tokens: 50, output_tokens: 5 } }; }
test('CLI -> private supervisor IPC -> loopback Jev contract -> native fixture -> ready; replay makes no API call', { timeout: 30_000 }, async () => {
  const f = await createDemo(), envHome = mkdtempSync(join(tmpdir(), 'jvo-ipc-home-')), binDir = mkdtempSync(join(tmpdir(), 'jvo-ipc-bin-'));
  let calls = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const data of req) body += data;
    try { calls++; const input = JSON.parse(body), questions = Object.fromEntries(Object.entries(input.questions).map(([k, v]) => [k, { ...v as object, type: (v as any).type === 'noul' ? 'boolean' : (v as any).type }])) as Record<string, Question>;
      const result = await new DemoProvider().evaluate(input.state, questions); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(wire(result)));
    } catch { res.statusCode = 400; res.end('{}'); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const port = (server.address() as { port: number }).port;
  try {
    const binary = join(binDir, 'codex'); copyFileSync(fileURLToPath(new URL('./fixtures/codex-cli.mjs', import.meta.url)), binary); chmodSync(binary, 0o700);
    const cap = await detectOne('codex', binary); assert(cap);
    const config = defaults(), repo = f.engine.run.repo; config.profiles = [profileFrom(cap)]; config.trusts[repoId(repo)] = f.engine.run.trust; config.decision.endpoint = `http://127.0.0.1:${port}/evaluation`; config.decision.retries = 0;
    writeFileSync(join(envHome, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    const env = { ...process.env, JVO_HOME: envHome, TYPESAFE_API_KEY: 'fixture-key-not-a-real-secret' };
    const cli = fileURLToPath(new URL('../bin/jvo.mjs', import.meta.url));
    const result = await execute([process.execPath, cli, 'run', 'Fix addition', '--json'], { cwd: repo, env, timeoutMs: 20_000, maxBytes: 6_000_000 });
    assert.equal(result.code, 0, result.stderr + '\n' + result.stdout.slice(-4000)); assert.match(result.stdout, /ready_for_user_apply/); assert(calls > 0);
    const before = calls;
    const replay = await execute([process.execPath, cli, 'replay'], { cwd: repo, env, timeoutMs: 5000, maxBytes: 6_000_000 });
    assert.equal(replay.code, 0, replay.stderr); assert.equal(calls, before); assert.match(replay.stdout, /"journalValid": true/);
    const files = (await import('node:fs')).readdirSync(join(envHome, 'repos', repoId(repo), 'logs'));
    assert(files.length); assert(!result.stdout.includes(env.TYPESAFE_API_KEY));
  } finally { await new Promise<void>(r => server.close(() => r())); f.store.close(); }
});
