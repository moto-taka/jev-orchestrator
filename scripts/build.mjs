import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';

// Build only this package. No project code, network, compiler download or lifecycle
// command is executed. Runtime packages contain ordinary JavaScript under dist/.
const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'src'), target = join(root, 'dist'), staging = join(root, `.dist-${randomUUID()}`);
if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('Refusing a symlinked dist directory');
const digest = value => createHash('sha256').update(value).digest('hex');
const manifest = { format: 1, sources: {}, outputs: {} };
mkdirSync(staging);
function visit(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Build input may not contain symlinks');
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { visit(path); continue; }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.mjs')) continue;
    const name = relative(source, path).replaceAll('\\', '/'), data = readFileSync(path, 'utf8');
    let output = data, outputName = name;
    if (name.endsWith('.ts')) {
      output = stripTypeScriptTypes(data, { mode: 'strip' });
      // Imports in this package are literal relative paths. This intentionally
      // does not implement tsconfig path aliases, JSX, enums or arbitrary TS.
      output = output.replace(/(\bfrom\s*['"]|\bimport\s*\(\s*['"])(\.{1,2}\/[^'"\n]+)\.ts(['"])/g, '$1$2.js$3');
      outputName = name.slice(0, -3) + '.js';
    }
    const out = join(staging, outputName); mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, output);
    manifest.sources[name] = digest(data); manifest.outputs[outputName] = digest(output);
  }
}
try {
  visit(source); writeFileSync(join(staging, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  if (existsSync(target)) rmSync(target, { recursive: true }); renameSync(staging, target);
  console.log(`Built ${Object.keys(manifest.outputs).length} JavaScript modules (no runtime npm dependencies).`);
} catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
