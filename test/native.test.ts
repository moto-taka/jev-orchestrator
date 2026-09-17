import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemo, DemoProvider } from '../src/demo.ts';
import { detectOne, profileFrom, validateInstalled } from '../src/adapters/registry.ts';
import { Engine } from '../src/engine.ts';
import { NativeAdapter } from '../src/adapters/native.ts';
export async function nativeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'jvo-native-cli-')), binary = join(dir, 'codex');
  copyFileSync(fileURLToPath(new URL('./fixtures/codex-cli.mjs', import.meta.url)), binary); chmodSync(binary, 0o700);
  const cap = await detectOne('codex', binary); assert(cap); return profileFrom(cap);
}
test('native adapter goes through version pinning, real subprocess JSONL, same-session repair and final integration', async () => {
  const f = await createDemo();
  try { const profile = await nativeFixture(); assert.equal(profile.version, 'codex fixture 1.0.0'); const config = f.engine.run.config; config.profiles = [profile]; f.store.updateRun(f.engine.runId, { config });
    const engine = new Engine(f.store, f.engine.runId, new DemoProvider(), { adapter: new NativeAdapter() }); await engine.drive();
    assert.equal(engine.run.status, 'ready_for_user_apply', engine.run.blockReason); const task = engine.tasks.find(t => t.kind === 'work')!; assert.equal(task.attempts, 2); assert(task.sessionId?.startsWith('fixture-'));
    assert(f.store.all<any>('usage', engine.runId).some(u => u.inputCacheRead === 80));
  } finally { f.store.close(); }
});
test('changed profile version is rejected before execution', async () => { const profile = await nativeFixture(); profile.version = 'unapproved'; await assert.rejects(() => validateInstalled(profile), /changed|unavailable/); });
