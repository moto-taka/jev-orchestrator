import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync } from 'node:fs';
import { loadConfig, saveConfig, configPath, repoId, keyEnv, getKey, storeKey } from './config.ts';
import { detectAll } from './adapters/registry.ts';
import { JevProvider } from './decision/provider.ts';
import { repository } from './workspaces.ts';
import { invariant, now } from './util.ts';
import { sanitize } from './security.ts';
import type { CommandSpec, Config, Trust, Profile, Capabilities } from './types.ts';
import { discoverModels, scopedProfiles, modelKey, matchesScope, piScopePatterns, type ModelOption, type ModelCatalog } from './models/catalog.ts';
import { pickModels } from './models/picker.ts';
export class Prompter {
  async models(title: string, models: ModelOption[], selected: string[]): Promise<ModelOption[]> { return pickModels(title, models, selected); }
  async ask(question: string, fallback = ''): Promise<string> {
    invariant(stdin.isTTY && stdout.isTTY, 'Interactive setup requires a terminal. Use environment keys and the documented configuration JSON for automation.');
    const rl = createInterface({ input: stdin, output: stdout });
    try { const response = await rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `); return response.trim() || fallback; }
    finally { rl.close(); }
  }
  async yes(question: string, defaultYes = false): Promise<boolean> { return /^(y|yes|はい)$/i.test(await this.ask(`${question} (y/n)`, defaultYes ? 'y' : 'n')); }
  async secret(question: string): Promise<string> {
    invariant(stdin.isTTY, 'Set the API key environment variable when stdin is not a terminal');
    stdout.write(`${question}: `); stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    return new Promise((resolve, reject) => {
      let value = '';
      const finish = (error?: Error) => { stdin.removeListener('data', data); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); error ? reject(error) : resolve(value.trim()); };
      const data = (chunk: string) => { for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { finish(); return; }
        if (ch === '\x03' || ch === '\x04') { finish(new Error('Setup cancelled')); return; }
        if (ch === '\x7f') { if (value.length) { value = value.slice(0, -1); stdout.write('\b \b'); } }
        else if (ch.codePointAt(0)! >= 32 && value.length < 4096) { value += ch; stdout.write('•'); }
      } };
      stdin.on('data', data);
    });
  }
}
export function parseCommand(input: string): string[] {
  const result: string[] = []; let token = '', quote = '', escape = false, started = false;
  for (const c of input) {
    if (escape) { token += c; escape = false; started = true; }
    else if (c === '\\' && quote !== "'") escape = true;
    else if (quote) { if (c === quote) quote = ''; else token += c; started = true; }
    else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (/\s/.test(c)) { if (started) { result.push(token); token = ''; started = false; } }
    else { invariant(!/[|;&<>`]/.test(c), 'Shell operators are not implicit. Use an explicit trusted shell command only when necessary.'); token += c; started = true; }
  }
  invariant(!quote && !escape, 'Unclosed quote or trailing escape'); if (started) result.push(token);
  invariant(result.length > 0, 'Empty command'); return result;
}
export async function setup(config = loadConfig(), prompts = new Prompter()): Promise<Config> {
  config = structuredClone(config);
  stdout.write('\njvo · Jev Orchestrator\nJevの判断用APIと、作業用CLIを別々に設定します。OAuthトークンは取り出しません。\n\n');
  const provider = await prompts.ask('Jev接続先: 1 TypeSafe公式 / 2 Vercel AI Gateway', config.decision.provider === 'vercel' ? '2' : '1');
  invariant(provider === '1' || provider === '2', '1 または 2 を指定してください。');
  const changed = config.decision.provider !== (provider === '1' ? 'typesafe' : 'vercel');
  config.decision.provider = provider === '1' ? 'typesafe' : 'vercel';
  config.decision.model = await prompts.ask('Jevモデル', changed ? provider === '1' ? 'jev-latest' : 'typesafe-ai/jev' : config.decision.model);
  config.decision.transport = 'http';
  let key: string | undefined;
  try { key = await getKey(config); } catch { /* First setup has no key. */ }
  if (!key) {
    key = await prompts.secret(`${keyEnv(config)}（非表示入力）`); invariant(key.length >= 8, 'API keyが短すぎます。');
    process.env[keyEnv(config)] = key;
    if (await prompts.yes('OSの秘密情報ストアへ保存しますか', true)) {
      if (await storeKey(config, key)) config.decision.keyStore = 'keychain';
      else stdout.write(`秘密情報ストアが利用できません。このプロセス内だけで使用します。次回は ${keyEnv(config)} を環境変数で設定してください。\n`);
    }
  }
  if (await prompts.yes('プロジェクト情報を含まない接続試験を実行しますか（API利用として課金対象になり得ます）')) {
    const result = await new JevProvider(config.decision, key).evaluate('Connection check only. The number is 2.', { check: { type: 'boolean', instructions: 'Is the supplied number equal to 2?' } });
    stdout.write(`接続できました: ${sanitize(result.resolvedModel ?? result.requestedModel)}\n`);
  }
  return setupModels(config, prompts);
}
export async function setupModels(config = loadConfig(), prompts = new Prompter(), services: {
  detect?: () => Promise<Capabilities[]>;
  discover?: typeof discoverModels;
  save?: (c: Config) => void;
} = {}): Promise<Config> {
  // Do not mutate the caller's/previous configuration on escape, error, or an empty selection.
  const next: Config = structuredClone(config), detected = await (services.detect ?? detectAll)();
  stdout.write('\nインストール済みCLI（認証・契約枠は未確認）\n');
  for (const [i, c] of detected.entries()) stdout.write(`  ${i + 1}. ${sanitize(c.adapter)} · ${sanitize(c.version)} · ${c.level}\n`);
  invariant(detected.length > 0, '対応CLIが見つかりません。codex / claude / pi / opencode を確認してください。');
  const priorCli = detected.flatMap((c, i) => config.profiles.some(p => p.enabled && p.adapter === c.adapter) ? [String(i + 1)] : []);
  const selected = await prompts.ask('自動実行を許可するCLI番号（例: 1,2,3）', priorCli.length ? priorCli.join(',') : detected.map((_, i) => String(i + 1)).join(','));
  invariant(/^\d+(?:\s*,\s*\d+)*$/.test(selected), 'CLI番号をカンマ区切りで指定してください。');
  const numbers = [...new Set(selected.split(',').map(n => Number(n.trim()) - 1))];
  invariant(numbers.length > 0 && numbers.every(n => Number.isInteger(n) && n >= 0 && n < detected.length), 'Invalid CLI selection');
  stdout.write('各CLIのモデル一覧を取得します。生成プロンプトは送信しません。CLIの認証更新・モデル一覧の通信や、利用者設定の読込は発生する場合があります。\n');
  const profiles: Profile[] = [];
  for (const n of numbers) {
    const cap = detected[n]!, previous = config.profiles.filter(p => p.adapter === cap.adapter);
    invariant(cap.structuredEvents, `${cap.adapter}には対応する構造化プロトコルがありません。`);
    let globalPiProviders = false;
    if (cap.adapter === 'pi' && cap.projectTrustControl) {
      globalPiProviders = await prompts.yes('Piの利用者領域に登録済みのprovider拡張を読み込みますか（拡張コードを実行します。プロジェクト拡張は無効）', previous.some(p => p.globalPiProviders) || !previous.length);
    }
    let catalog: ModelCatalog;
    for (;;) {
      stdout.write(`\n${cap.adapter}: モデル一覧を取得しています…\n`);
      catalog = await (services.discover ?? discoverModels)(cap, { previous, globalPiProviders });
      for (const warning of catalog.warnings) stdout.write(sanitize(warning) + '\n');
      if (catalog.models.length || !(await prompts.yes('一覧を再取得しますか'))) break;
    }
    if (!catalog.models.length) continue;
    const priorIds = previous.filter(p => p.enabled).map(p => modelKey(p.adapter, p.provider, p.model ?? 'default'));
    const scope = !previous.length && cap.adapter === 'pi' ? piScopePatterns() : [];
    const initial = priorIds.length ? priorIds : catalog.models.filter(m => matchesScope(m, scope)).map(m => m.id);
    const chosen = await prompts.models(`${cap.adapter} · 使用を許可するモデル（複数選択）`, catalog.models, initial);
    invariant(chosen.every(m => catalog.models.some(x => x.id === m.id && x.model === m.model && x.provider === m.provider)), 'Selection is outside the discovered catalog');
    profiles.push(...scopedProfiles(cap, chosen, previous, globalPiProviders));
    stdout.write(`${cap.adapter}: ${chosen.length}モデルを許可。役割はJevが実行時に選択します。\n`);
  }
  invariant(profiles.length > 0, 'モデルが選択されていません。既存設定は変更していません。');
  invariant(profiles.length <= 256, '許可モデルは合計256件以内に絞ってください。');
  next.profiles = profiles;
  next.messaging ??= { enabled: true, maxMessages: 64, maxTurnsPerTask: 4, ttlMs: 1_800_000 };
  (services.save ?? saveConfig)(next);
  stdout.write(`\n設定しました: ${configPath()}\n${profiles.length}モデルを許可しました。CLIごとの用途固定はありません。未選択のモデルはJevの候補に入りません。\n`);
  return next;
}
export async function trustRepository(cwd: string, config = loadConfig(), prompts = new Prompter()): Promise<Config> {
  const repo = await repository(cwd), key = repoId(repo), previous = config.trusts[key];
  stdout.write(`\n信頼するリポジトリ: ${sanitize(repo)}\n既存CLIは同じOSユーザーで動作します。worktreeはセキュリティsandboxではありません。\nJevへは依頼・必要なコード断片・テスト・レビューが送られます。\n`);
  invariant(await prompts.yes('このリポジトリでのローカル実行と、必要最小限のJevへの送信を許可しますか', !!previous), 'Repository was not approved');
  const tests: CommandSpec[] = [], setupCommands: CommandSpec[] = [];
  const testDefault = previous?.tests[0]?.argv.map(x => /\s/.test(x) ? JSON.stringify(x) : x).join(' ') ?? '';
  const test = await prompts.ask('検証コマンド（例: npm test / 空欄で自動テストなし）', testDefault);
  if (test) tests.push({ argv: parseCommand(test), timeoutMs: 300_000 });
  const allowNoTests = tests.length === 0 ? await prompts.yes('自動テストなしで実行し、独立レビューだけで判断することを明示的に許可しますか') : false;
  invariant(tests.length > 0 || allowNoTests, 'Tests must be configured before starting');
  const install = await prompts.ask('各検証用worktreeのセットアップコマンド（例: npm ci / 不要なら空欄）');
  if (install) setupCommands.push({ argv: parseCommand(install), timeoutMs: 600_000 });
  const excludes = await prompts.ask('追加の送信・編集除外glob（カンマ区切り / 任意）', previous?.exclude.join(',') ?? '');
  const trust: Trust = { repo, shareCode: true, allowLocalExecution: true, allowNoTests, tests, setup: setupCommands,
    exclude: excludes.split(',').map(s => s.trim()).filter(Boolean), maxEvidenceBytes: 64_000, approvedAt: now(), skills: previous?.skills ?? [] };
  config.trusts[key] = trust; saveConfig(config);
  stdout.write('承認を保存しました。.env・秘密鍵などは既定で除外されます。リポジトリ内の設定で権限は緩められません。\n'); return config;
}
