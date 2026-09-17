#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || major === 22 && minor < 16 || major === 23) {
  console.error('jvo requires Node.js 22.16+ (22.x) or 24+.'); process.exit(1);
}
const entry = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
if (!existsSync(entry)) { console.error('jvo: JavaScript build is missing. In the cloned repository, run npm run build, then retry.'); process.exit(1); }
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { try { child.kill(signal); } catch { /* child may already have exited */ } });
child.on('error', error => { console.error(`jvo: ${error.message}`); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 130 : 1); });
