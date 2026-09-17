import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync } from 'node:fs';
import { loadConfig, saveConfig, configPath, repoId, keyEnv, getKey, storeKey } from './config.ts';
import { detectAll, profileFrom } from './adapters/registry.ts';
import { JevProvider } from './decision/provider.ts';
import { repository } from './workspaces.ts';
import { invariant, now } from './util.ts';
import { sanitize } from './security.ts';
import type { CommandSpec, Config, Trust, Profile } from './types.ts';
export class Prompter {
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
  const detected = await detectAll();
  stdout.write('\nインストール済みCLI（認証は未確認・無課金の検出）\n');
  for (const [i, c] of detected.entries()) stdout.write(`  ${i + 1}. ${c.adapter} · ${c.version} · ${c.level}\n`);
  invariant(detected.length > 0, '対応CLIが見つかりません。codex / claude / pi / opencode のいずれかをインストールしてから jvo setup を実行してください。');
  const selected = await prompts.ask('自動実行を許可する番号（例: 1,2）', detected.map((_, i) => String(i + 1)).join(','));
  const numbers = [...new Set(selected.split(',').map(n => Number(n.trim()) - 1))];
  invariant(numbers.length > 0 && numbers.every(n => Number.isInteger(n) && n >= 0 && n < detected.length), 'Invalid CLI selection');
  const profiles = [];
  for (const n of numbers) {
    const cap = detected[n]!, prior = config.profiles.find(p => p.id === cap.adapter), profile = profileFrom(cap);
    const model = await prompts.ask(`${cap.adapter}のモデルID（空欄でCLI既定）`, prior?.model ?? 'default');
    if (model !== 'default') profile.model = model;
    const tier = await prompts.ask(`${cap.adapter}の用途: fast / standard / deep / review`, prior?.tier ?? 'standard');
    invariant(['fast', 'standard', 'deep', 'review'].includes(tier), 'Invalid profile tier'); profile.tier = tier as Profile['tier'];
    profiles.push(profile);
  }
  if (await prompts.yes('同じCLIに別モデルのprofileを追加しますか')) {
    for (;;) {
      const name = await prompts.ask('profile名（例: fast / deep / review、終了は空欄）'); if (!name) break;
      invariant(/^[a-zA-Z0-9_-]{1,64}$/.test(name) && !profiles.some(p => p.id === name), 'Invalid or duplicate profile name');
      const n = Number(await prompts.ask('使用するCLI番号', '1')) - 1; invariant(Number.isInteger(n) && n >= 0 && n < detected.length, 'Invalid CLI number');
      const profile = profileFrom(detected[n]!); profile.id = name;
      const model = await prompts.ask('モデルID', 'default'); if (model !== 'default') profile.model = model;
      const tier = await prompts.ask('用途: fast / standard / deep / review', ['fast', 'standard', 'deep', 'review'].includes(name) ? name : 'standard');
      invariant(['fast', 'standard', 'deep', 'review'].includes(tier), 'Invalid tier'); profile.tier = tier as Profile['tier'];
      if (tier === 'review') profile.roles = ['reviewer']; profiles.push(profile);
    }
  }
  config.profiles = profiles; saveConfig(config);
  stdout.write(`\n設定しました: ${configPath()}\nキーは設定JSONに保存していません。CLI更新時には実行前に再承認を求めます。\n`); return config;
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
