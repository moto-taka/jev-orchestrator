import { existsSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { loadConfig, configPath, repoHome, getKey, repoId, statePath } from './config.ts';
import { setup, setupModels, trustRepository } from './setup.ts';
import { detectAll } from './adapters/registry.ts';
import { Store } from './storage.ts';
import { Engine, startRun } from './engine.ts';
import { repository } from './workspaces.ts';
import { terminalApp } from './tui/app.ts';
import { launchSupervisor, supervise, owner, type Client } from './ipc.ts';
import { demo } from './demo.ts';
import { invariant, errorText } from './util.ts';
import { SecretGuard, sanitize } from './security.ts';
import { JevProvider } from './decision/provider.ts';
import { alive } from './process.ts';
import { summarizeUsage } from './telemetry.ts';
import { readDataset, evaluateDataset } from './eval.ts';
import type { Config, Run, View, Decision, Question, Json, Task, Usage } from './types.ts';
export const HELP = `jvo · Jev Orchestrator

  jvo                           対話開始（初回は設定）
  jvo "タスク"                  タスクを開始
  jvo run "タスク" --json        非対話実行・JSONイベント
  jvo setup                     Jevキー / CLI別モデル複数選択・版の再承認
  jvo models                    CLI別の許可モデルを複数選択（キー再入力なし）
  jvo trust                     リポジトリ・検証コマンドの承認
  jvo doctor                    安全なCLI検出（課金・ログインなし）
  jvo agents                    登録したprofile
  jvo config                    設定ファイルの場所
  jvo resume [run-id]            再接続・再開
  jvo recover [run-id] --acknowledge   不明な副作用の明示照合
  jvo replay [run-id]            記録のみ表示（API・CLI実行なし）
  jvo messages [run-id]          担当間の質問・返答を記録から表示（読取専用）
  jvo metrics [run-id]           保存済みrunの使用量・再開率を出力（読取専用）
  jvo export-eval [run-id]       保存済みの判断入力を評価用に出力（読取専用）
  jvo eval dataset.json --allow-api   操作なしのJev比較評価（API課金あり）
  jvo demo [--json]              課金なし・分離したGit上でデモ

  --refresh-policy              resume時に明示承認済みの設定を読み直す
  --baseline=head               手元の未コミット変更を含めない
  --include=path1,path2          指定した変更だけ基準snapshotへ取り込む
  --in-place                    明示的な単一タスク・直接編集モード
  --apply                       非対話実行で検証後のローカル反映を許可

通常はタスク別worktreeで実行します。push・deployは行いません。
Node.js >=22.16.0 / Git / macOS・Linux・WSL。Windows nativeは未対応です。
`;
function flags(args: string[]): { positional: string[]; flags: Set<string>; values: Record<string, string> } {
  const positional: string[] = [], fs = new Set<string>(), values: Record<string, string> = {};
  for (const arg of args) { if (!arg.startsWith('--')) positional.push(arg); else if (arg.includes('=')) { const [key, ...value] = arg.slice(2).split('='); values[key!] = value.join('='); } else fs.add(arg.slice(2)); }
  return { positional, flags: fs, values };
}
function selectRun(store: Store, name?: string): Run {
  if (name) { const all = store.all<Run>('runs').filter(r => r.id === name || r.id.startsWith(name)); invariant(all.length === 1, 'Run not found or prefix is ambiguous'); return all[0]!; }
  const run = store.all<Run>('runs').at(-1); invariant(run, 'No saved run in this repository'); return run;
}
async function ready(config: Config, repo: string): Promise<Config> {
  if (!config.profiles.length || !existsSync(configPath())) config = await setup(config);
  await getKey(config);
  if (!config.trusts[repoId(repo)]) config = await trustRepository(repo, config);
  return config;
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args[0] === '__supervise') { invariant(args[1] && args[2], 'Missing supervisor arguments'); await supervise(args[1], args[2]); return; }
  const f = flags(args), command = f.positional[0];
  if (f.flags.has('help') || command === 'help' || command === '-h') { console.log(HELP); return; }
  if (f.flags.has('version') || command === '-v') { console.log('0.2.0'); return; }
  if (command === 'demo') { await demo(f.flags.has('json') || !process.stdin.isTTY); return; }
  // Replay opens only an existing database in read-only mode. It never runs Git,
  // loads a provider key, creates directories, starts a supervisor, or executes a worker.
  if (command === 'replay' || command === 'export-eval' || command === 'metrics' || command === 'messages') {
    let repo = realpathSync(process.cwd());
    for (;;) {
      if (existsSync(join(repo, '.git')) && !lstatSync(join(repo, '.git')).isSymbolicLink()) break;
      const parent = dirname(repo); invariant(parent !== repo, 'No recorded Git repository found'); repo = parent;
    }
    const store = new Store(join(statePath(), 'repos', repoId(repo)), { readOnly: true });
    try {
      const run = selectRun(store, f.positional[1]); invariant(run.repo === repo, 'Recorded repository identity does not match');
      const decisions = store.all<Decision>('decisions', run.id);
      if (command === 'messages') { console.log(JSON.stringify(store.hasTable('messages') ? store.all('messages', run.id) : [], null, 2)); }
      else if (command === 'metrics') {
        const attempts = store.all<{ invocation: { role: string; resume?: string; cwd: string } }>('attempts', run.id), workers = attempts.filter(a => a.invocation.role === 'implementer');
        console.log(JSON.stringify({ runId: run.id, status: run.status, activeMilliseconds: run.activeMs ?? 0, usage: summarizeUsage(store.all<Usage>('usage', run.id)), acceptedTasks: store.all<Task>('tasks', run.id).filter(t => t.kind === 'work' && t.staged && t.snapshot).length, implementationStarts: workers.length, resumedStarts: workers.filter(a => a.invocation.resume).length, decisionCalls: run.decisionCalls, workerStarts: run.workerStarts, independentlyValidatedQuality: null, note: 'Only observed usage is totaled. A ready run is not independent proof of correctness. Include failed runs when comparing aggregate cost.' }, null, 2));
      } else if (command === 'export-eval') {
        console.log(JSON.stringify({ sourceRun: run.id, note: 'Add independently reviewed expected labels; exporting does not send any data or call an API.', cases: decisions.filter(d => d.questionArtifact).map(d => ({ id: d.id, state: JSON.parse(store.readArtifact(d.semanticHash)) as Json, questions: JSON.parse(store.readArtifact(d.questionArtifact!)) as Record<string, Question>, labels: {} })) }, null, 2));
      } else console.log(JSON.stringify({ run: run.id, status: run.status, journalValid: store.verifyJournal(run.id), decisions, events: store.events(run.id, 100_000) }, null, 2));
    } finally { store.close(); }
    return;
  }
  let config = loadConfig();
  if (command === 'setup') { if (f.flags.has('models')) await setupModels(config); else await setup(config); return; }
  if (command === 'models') { if (f.flags.has('json')) console.log(JSON.stringify(config.profiles, null, 2)); else await setupModels(config); return; }
  if (command === 'config') { console.log(configPath()); return; }
  if (command === 'doctor') { console.log(JSON.stringify({ node: process.version, platform: process.platform, config: configPath(), agents: await detectAll(), note: 'Detection only. Authentication and live protocol compatibility are not assumed.' }, null, 2)); return; }
  if (command === 'agents') { console.log(JSON.stringify(config.profiles, null, 2)); return; }
  if (command === 'trust') { await trustRepository(process.cwd(), config); return; }
  if (command === 'eval') {
    invariant(f.flags.has('allow-api'), 'Evaluation sends the labeled dataset to Jev and may incur charges. Add --allow-api to authorize.');
    invariant(f.positional[1], 'Supply a JSON dataset path'); const key = await getKey(config);
    console.log(JSON.stringify(await evaluateDataset(new JevProvider(config.decision, key), readDataset(resolve(f.positional[1])), new SecretGuard([key])), null, 2)); return;
  }
  invariant(process.platform !== 'win32', 'Native Windows supervision is not enabled; run jvo inside WSL.');
  const repo = await repository(process.cwd());
  let client: Client | undefined, initial: View | undefined;
  const handlers = new Set<(view: View) => void>();
  const attach = async (runId: string) => {
    client = await launchSupervisor(repo, runId);
    client.on('view', view => { initial = view as View; for (const h of handlers) h(initial); });
    client.on('connection-error', e => { if (!process.stdout.isTTY) process.stderr.write(sanitize(String(e)) + '\n'); });
    initial = await client.request('subscribe'); await client.request('attach'); return initial;
  };
  if (command === 'resume' || command === 'recover') {
    const store = new Store(repoHome(repo)); let run: Run;
    try {
      run = selectRun(store, f.positional[1]);
      if (f.flags.has('refresh-policy')) {
        const current = owner(repo);
        invariant(!current || alive(current.pid, current.birth) === 'no', 'Close the existing supervisor with /exit before --refresh-policy. In an attached TUI, /pause then /refresh can update keychain-backed settings.');
        const key = await getKey(config), guard = new SecretGuard([key]);
        const engine = new Engine(store, run.id, new JevProvider(config.decision, key), { guard });
        await engine.refreshPolicy(config, engine.provider, guard); run = store.run(run.id);
      }
    } finally { store.close(); }
    await getKey(run.config); await attach(run.id);
    if (command === 'recover') { await client!.request('recover', { acknowledge: f.flags.has('acknowledge') }); client!.close(); return; }
    if (['paused', 'blocked'].includes(initial!.run!.status)) initial = await client!.request('resume');
  } else config = await ready(config, repo);
  const start = async (text: string): Promise<View | undefined> => {
    if (client && initial?.run && !['cancelled', 'applied'].includes(initial.run.status)) {
      if (initial.run.status === 'running') await client.request('pause');
      return client.request('resume', { message: text });
    }
    if (client) { await client.request('close'); client.close(); client = undefined; }
    const store = new Store(repoHome(repo)); let run: Run;
    try { run = await startRun(store, repo, text, config, { baseline: f.values.include !== undefined ? f.values.include.split(',').filter(Boolean) : f.values.baseline === 'head' ? 'head' : undefined, mode: f.flags.has('in-place') ? 'in-place' : 'worktree' }); }
    finally { store.close(); }
    return attach(run.id);
  };
  const initialTask = command === 'run' ? f.positional.slice(1).join(' ') : command && !['resume', 'recover'].includes(command) ? f.positional.join(' ') : '';
  if (initialTask) initial = await start(initialTask);
  if (f.flags.has('json') || !process.stdin.isTTY || !process.stdout.isTTY) {
    invariant(client && initial?.run, 'Non-interactive mode requires a task or a saved run. See jvo --help.');
    const c = client;
    try {
      await new Promise<void>((resolve, reject) => {
        const listener = (view: View) => {
          process.stdout.write(JSON.stringify({ event: 'view', ...view }) + '\n');
          if (view.run?.status !== 'running') { handlers.delete(listener); if (['paused', 'blocked', 'cancelled'].includes(view.run!.status)) process.exitCode = 2; resolve(); }
        };
        handlers.add(listener); c.once('closed', () => reject(new Error('Supervisor disconnected'))); listener(initial!);
      });
      if (f.flags.has('apply') && initial?.run?.status === 'ready_for_user_apply') console.log(JSON.stringify({ event: 'applied', view: await c.request('apply') }));
    } finally { c.close(); } return;
  }
  try {
    await terminalApp({ submit: start, command: async (name, arg) => {
      if (name === '/exit') { if (client) await client.request('close'); return { exit: true }; }
      invariant(client, '先にタスクを入力してください。');
      if (name === '/detach') { await client.request('detach'); client.close(); return { exit: true }; }
      if (name === '/diff') return { detail: await client.request<string>('diff') };
      if (name === '/recover') return { view: await client.request('recover', { acknowledge: arg === 'acknowledge' }), notice: '照合しました。/resume で再開できます。' };
      const commands: Record<string, string> = { '/pause': 'pause', '/resume': 'resume', '/apply': 'apply', '/cancel': 'cancel', '/refresh': 'refresh' };
      invariant(commands[name], 'Unknown command. /help で操作を確認してください。');
      return { view: await client.request(commands[name]!, name === '/resume' && arg ? { message: arg } : {}) };
    } }, initial ?? { tasks: [], events: [], agents: config.profiles, usage: [], decisions: [] }, { subscribe: h => { handlers.add(h); } });
  } finally { client?.close(); }
}
main().catch(e => { console.error(`jvo: ${sanitize(errorText(e))}`); process.exitCode = 1; });
