import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execute, executable, assertManagedDirectory } from './process.ts';
import { excluded, globMatch, validateRelativePath, workerEnvironment } from './security.ts';
import { hash, invariant, isInside, privateDir, safeChild } from './util.ts';
import type { Run, Task, Trust } from './types.ts';
const GIT_OPTIONS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'commit.gpgsign=false', '-c', 'merge.gpgsign=false', '-c', 'user.name=Jev Orchestrator', '-c', 'user.email=jvo@localhost', '-c', 'advice.detachedHead=false'];
export async function git(cwd: string, args: string[], extra: { input?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean; maxBytes?: number } = {}): Promise<string> {
  const binary = executable('git', cwd);
  invariant(binary, 'Git is required and must be on a trusted PATH');
  const r = await execute([binary, ...GIT_OPTIONS, ...args], {
    cwd, input: extra.input, timeoutMs: 60_000, maxBytes: extra.maxBytes ?? 16_000_000,
    env: { ...workerEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_MERGE_AUTOEDIT: 'no', ...extra.env },
  });
  if (!extra.allowFailure) invariant(r.code === 0 && !r.overflow && !r.timedOut, `git ${args[0]} failed: ${r.stderr.slice(0, 2000)}`);
  return r.stdout.trimEnd();
}
const NOT_GIT_GUIDANCE = `このディレクトリはGitリポジトリではありません。jvoは既存のGit baselineが必要です。
先に次を実行してください:
  git init
  git status
  git add <jvoで扱うファイル>
  git commit -m "Initial commit"
ファイルがまだない場合:
  git commit --allow-empty -m "Initial commit"
その後 jvo を再実行してください。`;
const NO_HEAD_GUIDANCE = `Gitリポジトリにまだcommitがありません。jvoはHEADをbaselineとして使うため、最初のcommitを作成してください。
先に次を実行してください:
  git status
  git add <jvoで扱うファイル>
  git commit -m "Initial commit"
ファイルがまだない場合:
  git commit --allow-empty -m "Initial commit"
その後 jvo を再実行してください。`;
export async function repository(cwd: string): Promise<string> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  invariant(top, NOT_GIT_GUIDANCE);
  const repo = realpathSync(top);
  invariant(await git(repo, ['rev-parse', '--is-bare-repository']) === 'false', 'A working Git repository is required');
  const head = await git(repo, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  invariant(head, NO_HEAD_GUIDANCE);
  const filters = await git(repo, ['config', '--local', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'], { allowFailure: true });
  invariant(!filters, 'Repository-local executable Git filters are unsupported. Disable them before automated worktree operations.');
  return repo;
}
export async function fingerprint(repo: string): Promise<string> {
  const head = await git(repo, ['rev-parse', 'HEAD']);
  const staged = await git(repo, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv']);
  const unstaged = await git(repo, ['diff', '--binary', '--no-ext-diff', '--no-textconv']);
  const files = (await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).sort();
  const untracked = files.map(p => {
    const path = join(repo, p), stat = lstatSync(path);
    return { path: p, mode: stat.mode, bytes: stat.size, content: stat.isSymbolicLink() ? hash(readlinkSync(path)) : stat.isFile() && stat.size < 10_000_000 ? hash(readFileSync(path).toString('base64')) : `${stat.mtimeMs}:${stat.size}` };
  });
  return hash({ head, staged, unstaged, untracked });
}
export async function dirty(repo: string): Promise<boolean> { return (await git(repo, ['status', '--porcelain=v1', '-z'])).length > 0; }
export async function changedPaths(repo: string, base = 'HEAD'): Promise<string[]> {
  const tracked = (await git(repo, ['diff', '--name-only', '-z', base, '--'])).split('\0');
  const untracked = (await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0');
  return [...new Set([...tracked, ...untracked].filter(Boolean))].sort();
}
export async function assertChanges(repo: string, base: string, allow: string[], exclude: string[] = []): Promise<string[]> {
  const paths = await changedPaths(repo, base);
  invariant(paths.length <= 10_000, 'Too many changed paths');
  for (const p of paths) {
    validateRelativePath(p);
    invariant(!excluded(p, exclude), `Protected or excluded file was modified: ${p}`);
    invariant(allow.some(pattern => globMatch(p, pattern)), `Write outside approved task scope: ${p}`);
    const absolute = join(repo, p);
    if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) invariant(isInside(repo, resolve(repo, p, '..', readlinkSync(absolute))), `Symlink escapes workspace: ${p}`);
  }
  return paths;
}
export class Workspaces {
  root: string;
  repo: string;
  constructor(root: string, repo: string) { this.root = privateDir(join(root, 'workspaces')); this.repo = repo; }
  path(name: string): string { invariant(/^[A-Za-z0-9_-]+$/.test(name), 'Invalid workspace name'); return safeChild(this.root, name); }
  async create(name: string, base: string, branch?: string): Promise<string> {
    const path = this.path(name);
    if (existsSync(path)) {
      await this.validate(path);
      const actual = await git(path, ['rev-parse', 'HEAD']);
      invariant(actual === base, 'Existing workspace baseline differs; explicit reconciliation is required');
      return path;
    }
    await git(this.repo, ['worktree', 'add', ...(branch ? ['-b', branch] : ['--detach']), path, base]);
    await this.validate(path); return path;
  }
  async validate(path: string): Promise<void> {
    assertManagedDirectory(this.root, path);
    const common = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const expected = await git(this.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    invariant(realpathSync(common) === realpathSync(expected), 'Workspace belongs to another repository');
    invariant(realpathSync(await git(path, ['rev-parse', '--show-toplevel'])) === realpathSync(path), 'Not a worktree root');
  }
  async remove(path: string): Promise<void> {
    await this.validate(path);
    // Deliberately no --force: unknown local changes must never be discarded silently.
    await git(this.repo, ['worktree', 'remove', path]);
  }
  async snapshot(task: Task, trust: Trust): Promise<string> {
    invariant(task.workspace && task.base, 'Task has no workspace baseline');
    if (task.workspace !== this.repo) await this.validate(task.workspace);
    await assertChanges(task.workspace, task.base, task.spec.writePaths, trust.exclude);
    const diffCheck = await execute([executable('git', task.workspace)!, ...GIT_OPTIONS, 'diff', '--check'], { cwd: task.workspace });
    invariant(diffCheck.code === 0, 'Conflict markers or whitespace errors remain in the diff');
    // Use a private index for an in-place task; the user's index and branch remain untouched.
    if (task.workspace === this.repo) return this.captureSelected(task.base, await changedPaths(this.repo, task.base), task.runId);
    const paths = await changedPaths(task.workspace, 'HEAD');
    if (!paths.length && !(await git(task.workspace, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFailure: true }))) return git(task.workspace, ['rev-parse', 'HEAD']);
    await git(task.workspace, ['add', '-A', '--', '.']);
    await git(task.workspace, ['commit', '--no-verify', '-m', `jvo: ${task.spec.title.slice(0, 160)}`]);
    return git(task.workspace, ['rev-parse', 'HEAD']);
  }
  async captureSelected(base: string, paths: string[], runId: string): Promise<string> {
    invariant(paths.length <= 10_000, 'Too many selected paths');
    for (const p of paths) { validateRelativePath(p); invariant(!excluded(p), `Cannot include sensitive path: ${p}`); }
    if (!paths.length) return base;
    const index = safeChild(this.root, `index-${hash({ runId, paths, time: Date.now() })}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await git(this.repo, ['read-tree', base], { env });
      await git(this.repo, ['add', '-A', '--', ...paths], { env });
      const tree = await git(this.repo, ['write-tree'], { env });
      const commit = await git(this.repo, ['commit-tree', tree, '-p', base], { input: `jvo approved baseline ${runId}\n`, env });
      await git(this.repo, ['update-ref', `refs/jvo/baselines/${runId}`, commit]);
      return commit;
    } finally { if (existsSync(index)) unlinkSync(index); }
  }
  async diff(base: string, snapshot: string, exclude: string[] = []): Promise<string> {
    const paths = (await git(this.repo, ['diff', '--name-only', '-z', base, snapshot, '--'])).split('\0').filter(Boolean).filter(p => !excluded(p, exclude));
    if (!paths.length) return '';
    return git(this.repo, ['diff', '--no-ext-diff', '--no-textconv', '--stat', '--patch', base, snapshot, '--', ...paths]);
  }
  async merge(run: Run, task: Task): Promise<{ ok: boolean; head?: string; conflicts: string[] }> {
    invariant(task.snapshot, 'Cannot integrate a task without a snapshot');
    await this.validate(run.integration);
    invariant(!(await dirty(run.integration)), 'Integration workspace is dirty; reconciliation is required');
    const r = await execute([executable('git', this.repo)!, ...GIT_OPTIONS, 'merge', '--no-ff', '--no-commit', '--no-edit', task.snapshot], { cwd: run.integration, env: { ...workerEnvironment(), GIT_MERGE_AUTOEDIT: 'no' } });
    if (r.code !== 0) {
      const conflicts = (await git(run.integration, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
      invariant(conflicts.length > 0, `Integration failed without resolvable conflicts: ${r.stderr.slice(0, 1000)}`);
      return { ok: false, conflicts };
    }
    if (await dirty(run.integration) || await git(run.integration, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFailure: true })) await git(run.integration, ['commit', '--no-verify', '-m', `jvo: integrate ${task.spec.id}`]);
    return { ok: true, head: await git(run.integration, ['rev-parse', 'HEAD']), conflicts: [] };
  }
  async apply(run: Run): Promise<'in-place' | 'patch' | 'fast-forward'> {
    invariant(run.status === 'ready_for_user_apply' && run.finalSnapshot, 'Run is not ready to apply');
    const current = await fingerprint(this.repo);
    if (run.mode === 'in-place') {
      invariant(current === run.inPlaceFingerprint, 'In-place files changed since verification; refusing to acknowledge stale results');
      return 'in-place'; // Deliberately leaves edits uncommitted and does not touch the user's index.
    }
    invariant(current === run.checkoutFingerprint && await git(this.repo, ['rev-parse', 'HEAD']) === run.checkoutHead, 'Original checkout changed; refusing automatic apply');
    if (await dirty(this.repo)) {
      const paths = (await changedPaths(this.repo, run.checkoutHead)).filter(p => !excluded(p, run.trust.exclude));
      const currentTree = await this.captureSelected(run.checkoutHead, paths, `${run.id}-apply-current`);
      invariant(await git(this.repo, ['rev-parse', `${currentTree}^{tree}`]) === await git(this.repo, ['rev-parse', `${run.base}^{tree}`]), 'Uncommitted changes were excluded from the verified baseline; refusing an unverified combined apply. The integration branch is retained.');
      const patch = await git(this.repo, ['diff', '--binary', '--no-ext-diff', '--no-textconv', run.base, run.finalSnapshot]);
      if (patch.trim()) { await git(this.repo, ['apply', '--check', '--whitespace=nowarn', '-'], { input: patch + '\n' }); await git(this.repo, ['apply', '--whitespace=nowarn', '-'], { input: patch + '\n' }); }
      const result = await this.captureSelected(run.checkoutHead, (await changedPaths(this.repo, run.checkoutHead)).filter(p => !excluded(p, run.trust.exclude)), `${run.id}-applied`);
      invariant(await git(this.repo, ['rev-parse', `${result}^{tree}`]) === await git(this.repo, ['rev-parse', `${run.finalSnapshot}^{tree}`]), 'Working tree changed during apply; inspect the preserved edits and re-verify.');
      return 'patch';
    }
    await git(this.repo, ['merge', '--ff-only', '--no-edit', run.finalSnapshot]); return 'fast-forward';
  }
}
