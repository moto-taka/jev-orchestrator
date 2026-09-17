import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const prefix = mkdtempSync(join(tmpdir(), 'jvo-package-'));
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 90_000, maxBuffer: 8_000_000, env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' } });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
let archive;
try {
  // Build before packing, then disable lifecycle scripts during installation to
  // prove the archive already contains runnable JS and needs no npm dependency.
  run(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/build.mjs']);
  run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', prefix]);
  const packed = readdirSync(prefix).filter(name => name.endsWith('.tgz')); if (packed.length !== 1) throw new Error('Expected exactly one package archive');
  archive = join(prefix, packed[0]);
  run('npm', ['install', '--global', '--prefix', prefix, archive, '--offline', '--ignore-scripts', '--no-audit', '--no-fund']);
  const cli = join(prefix, 'bin', 'jvo');
  const version = run(cli, ['--version']).trim(); if (version !== '0.1.0') throw new Error('Installed launcher returned the wrong version');
  const lines = run(cli, ['demo', '--json']).trim().split('\n'), final = JSON.parse(lines.at(-1));
  if (final.status !== 'ready_for_user_apply' || !final.journalValid) throw new Error('Installed package did not complete the isolated demo');
  console.log(JSON.stringify({ installedVersion: version, runtimeDependencies: 0, status: final.status, journalValid: final.journalValid }));
} finally { rmSync(prefix, { recursive: true, force: true }); if (archive) rmSync(archive, { force: true }); }
