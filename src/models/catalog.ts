/** Model discovery uses the installed CLI's metadata interfaces, never a prompt. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { execute } from '../process.ts';
import { workerEnvironment, terminalText } from '../security.ts';
import { hash, invariant, object, text } from '../util.ts';
import { profileFrom } from '../adapters/registry.ts';
import type { AdapterId, Capabilities, Profile } from '../types.ts';

export interface ModelOption {
  id: string; adapter: AdapterId; model: string; provider?: string;
  name: string; description?: string; source: 'cli' | 'saved' | 'alias';
  contextWindow?: number; reasoning?: boolean; efforts?: string[]; isDefault?: boolean;
}
export interface ModelCatalog { models: ModelOption[]; warnings: string[]; }
const EFFORTS = ['off','minimal','low','medium','high','xhigh','max'] as const;
function effortList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const raw = typeof item === 'string' ? item : item && typeof item === 'object'
      ? (item as Record<string, unknown>).reasoningEffort ?? (item as Record<string, unknown>).effort ?? (item as Record<string, unknown>).value
      : undefined;
    if (typeof raw === 'string' && (EFFORTS as readonly string[]).includes(raw) && !result.includes(raw)) result.push(raw);
  }
  return result;
}
function piEfforts(m: Record<string, any>): string[] {
  if (m.reasoning !== true) return ['off'];
  const map = m.thinkingLevelMap;
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    const values = map as Record<string, unknown>;
    const standard = ['off','minimal','low','medium','high'].filter(level => !Object.hasOwn(values, level) || values[level] !== null);
    const extended = ['xhigh','max'].filter(level => Object.hasOwn(values, level) && values[level] !== null);
    return [...standard, ...extended];
  }
  return ['off','minimal','low','medium','high'];
}
export const modelKey = (adapter: AdapterId, provider: string | undefined, model: string) => `${adapter}_${hash({ provider: provider ?? '', model }).slice(0, 20)}`;
export function modelOption(adapter: AdapterId, model: string, provider?: string, fields: Partial<ModelOption> = {}): ModelOption {
  invariant(model.length > 0 && model.length <= 160 && !/[\x00-\x1f\x7f]/.test(model), 'Invalid model ID');
  if (provider) invariant(provider.length <= 160 && !/[\x00-\x1f\x7f]/.test(provider), 'Invalid provider ID');
  return { ...fields, adapter, model, provider, name: fields.name || model, source: fields.source ?? 'cli', id: modelKey(adapter, provider, model) };
}
export function uniqueModels(models: ModelOption[]): ModelOption[] {
  return [...new Map(models.map(m => [m.id, m])).values()].sort((a, b) => `${a.provider ?? ''}/${a.model}`.localeCompare(`${b.provider ?? ''}/${b.model}`));
}

/** Bounded metadata-only JSONL exchange. No user turn, auth extraction or prompt. */
export class MetadataChannel {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (v: Record<string, any>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false; private bytes = 0; private timeout: number;
  constructor(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 15_000) {
    this.timeout = timeout;
    this.child = spawn(binary, args, { cwd, env, stdio: 'pipe', detached: process.platform !== 'win32' });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.child.stdout.on('data', b => { this.bytes += b.length; if (this.bytes > 8_000_000) this.fail(new Error('Model catalog output exceeded limit')); });
    this.child.stderr.on('data', b => { this.bytes += b.length; if (this.bytes > 8_000_000) this.fail(new Error('Model catalog output exceeded limit')); });
    this.child.stdin.on('error', () => this.fail(new Error('Model catalog transport closed')));
    this.child.on('error', () => this.fail(new Error('Could not start model catalog command')));
    this.child.on('close', () => this.fail(new Error('CLI closed before returning model metadata')));
    lines.on('line', line => {
      try {
        const msg = JSON.parse(line);
        const id = String(msg.id ?? msg.response?.request_id ?? '');
        const p = this.pending.get(id); if (!p) return;
        this.pending.delete(id); clearTimeout(p.timer);
        if (msg.error || msg.success === false || msg.response?.subtype === 'error') p.reject(new Error('CLI rejected model metadata request'));
        else p.resolve(msg);
      } catch { /* A plugin's non-protocol stdout is not a catalog or a prompt. */ }
    });
  }
  send(value: unknown): void { invariant(!this.closed, 'Metadata channel is closed'); this.child.stdin.write(JSON.stringify(value) + '\n'); }
  request(id: string, value: unknown): Promise<Record<string, any>> {
    invariant(!this.closed && !this.pending.has(id), 'Invalid metadata request');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Model listing timed out (no generation was requested)')); this.close(); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer }); this.send(value);
    });
  }
  private fail(e: Error): void { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); } this.pending.clear(); this.close(); }
  close(): void {
    if (this.closed) return; this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Metadata channel closed')); } this.pending.clear();
    this.child.stdin.end();
    try { if (this.child.pid && process.platform !== 'win32') process.kill(-this.child.pid, 'SIGTERM'); else this.child.kill('SIGTERM'); } catch { /* already exited */ }
    const timer = setTimeout(() => { try { if (this.child.pid && process.platform !== 'win32') process.kill(-this.child.pid, 'SIGKILL'); else this.child.kill('SIGKILL'); } catch { /* already exited */ } }, 1000);
    timer.unref(); this.child.once('close', () => clearTimeout(timer));
  }
}

export function parsePiModels(value: unknown): ModelOption[] {
  invariant(Array.isArray(value), 'Pi did not return a model list');
  return uniqueModels(value.map(x => {
    const m = object(x), model = text(m.id, 'model', 160), provider = text(m.provider, 'provider', 160);
    return modelOption('pi', model, provider, { name: typeof m.name === 'string' ? m.name : model,
      contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : undefined, reasoning: typeof m.reasoning === 'boolean' ? m.reasoning : undefined, efforts: piEfforts(m) });
  }));
}
export function parsePiTable(output: string): ModelOption[] {
  const rows = terminalText(output).split('\n'), result: ModelOption[] = []; let inTable = false;
  for (const line of rows) {
    if (/^provider\s+model\s+context\s+max-out\s+thinking\s+images/.test(line.trim())) { inTable = true; continue; }
    if (!inTable) continue;
    const match = /^(\S+)\s+(\S+)\s+(\d+(?:\.\d+)?[KM]?)\s+\d+(?:\.\d+)?[KM]?\s+(yes|no)\s+(?:yes|no)\s*$/.exec(line.trim());
    if (!match) continue;
    const v = match[3]!, n = parseFloat(v) * (v.endsWith('M') ? 1e6 : v.endsWith('K') ? 1e3 : 1);
    result.push(modelOption('pi', match[2]!, match[1]!, { contextWindow: n, reasoning: match[4] === 'yes', efforts: match[4] === 'yes' ? ['off','minimal','low','medium','high'] : ['off'] }));
  }
  return uniqueModels(result);
}
export function parseCodexModels(value: unknown, provider?: string): ModelOption[] {
  invariant(Array.isArray(value), 'Codex did not return a model list');
  return value.filter(x => !object(x).hidden).map(x => {
    const m = object(x), model = text(m.model ?? m.id, 'model', 160);
    return modelOption('codex', model, provider, { name: typeof m.displayName === 'string' ? m.displayName : model,
      description: typeof m.description === 'string' ? m.description.slice(0, 500) : undefined, isDefault: m.isDefault === true,
      reasoning: Array.isArray(m.supportedReasoningEfforts) && m.supportedReasoningEfforts.length > 0,
      efforts: effortList(m.supportedReasoningEfforts) });
  });
}
export function parseClaudeModels(value: unknown): ModelOption[] {
  invariant(Array.isArray(value), 'Claude did not return its model picker entries');
  return uniqueModels(value.map(x => {
    const m = object(x), model = text(m.value ?? m.id ?? m.model, 'model', 160);
    return modelOption('claude', model, undefined, { name: typeof m.displayName === 'string' ? m.displayName : typeof m.name === 'string' ? m.name : model,
      description: typeof m.description === 'string' ? m.description.slice(0, 500) : undefined, isDefault: model === 'default' });
  }).filter(m => m.model !== 'opusplan')); // An implicit two-model planner defeats Jev-only assignment.
}
export function parseOpenCodeModels(output: string): ModelOption[] {
  return uniqueModels(terminalText(output).split('\n').map(s => s.trim()).filter(s => /^[^\s/]+\/[^\s]+$/.test(s)).map(s => modelOption('opencode', s)));
}

export async function discoverModels(cap: Capabilities, options: { globalPiProviders?: boolean; timeoutMs?: number; previous?: Profile[] } = {}): Promise<ModelCatalog> {
  const cwd = mkdtempSync(join(tmpdir(), 'jvo-models-')), env = { ...workerEnvironment(), NO_COLOR: '1', TERM: 'dumb', PI_SKIP_VERSION_CHECK: '1' };
  const warnings: string[] = []; let models: ModelOption[] = [], channel: MetadataChannel | undefined;
  try {
    if (cap.adapter === 'pi') {
      invariant(!options.globalPiProviders || cap.projectTrustControl, 'This Pi cannot isolate global providers from project extensions. Update Pi or disable global providers.');
      const flags = [...(cap.projectTrustControl ? ['--no-approve', '--no-context-files'] : []), ...(!options.globalPiProviders ? ['--no-extensions'] : []), '--no-skills', '--no-prompt-templates', '--no-themes'];
      try {
        channel = new MetadataChannel(cap.binary, ['--mode', 'rpc', '--no-session', '--no-tools', ...flags], cwd, env, options.timeoutMs);
        const response = await channel.request('catalog', { id: 'catalog', type: 'get_available_models' });
        models = parsePiModels(response.data?.models);
      } catch { // Older builds expose the non-inference table even when RPC startup is unavailable.
        channel?.close(); channel = undefined;
        const r = await execute([cap.binary, '--list-models', ...flags], { cwd, env, timeoutMs: options.timeoutMs ?? 15_000, maxBytes: 4_000_000 });
        invariant(r.code === 0 && !r.timedOut && !r.overflow, 'Pi model listing failed'); models = parsePiTable(r.stdout);
      }
    } else if (cap.adapter === 'codex') {
      channel = new MetadataChannel(cap.binary, ['app-server'], cwd, env, options.timeoutMs);
      await channel.request('init', { id: 'init', method: 'initialize', params: { clientInfo: { name: 'jvo_model_picker', title: 'Jev Orchestrator model picker', version: '0.4.1' } } });
      channel.send({ method: 'initialized', params: {} });
      let provider: string | undefined;
      try {
        const config = await channel.request('config', { id: 'config', method: 'config/read', params: { includeLayers: false } });
        const p = config.result?.config?.model_provider; if (typeof p === 'string') provider = p;
      } catch { warnings.push('Codexのprovider名は取得できませんでした。CLIの既存設定を使用します。'); }
      let cursor: string | undefined; const seen = new Set<string>();
      for (let page = 0; page < 50; page++) {
        const requestId = `models-${page}`;
        const r = await channel.request(requestId, { id: requestId, method: 'model/list', params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } });
        models.push(...parseCodexModels(r.result?.data, provider));
        const next = r.result?.nextCursor; if (next == null) break;
        invariant(typeof next === 'string' && !seen.has(next) && page < 49, 'Codex model catalog pagination did not complete'); seen.add(next); cursor = next;
      }
    } else if (cap.adapter === 'claude') {
      channel = new MetadataChannel(cap.binary, ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', ''], cwd, env, options.timeoutMs);
      const r = await channel.request('init', { type: 'control_request', request_id: 'init', request: { subtype: 'initialize', hooks: {}, agents: {}, skills: [] } });
      models = parseClaudeModels(r.response?.response?.models);
    } else {
      const r = await execute([cap.binary, 'models'], { cwd, env: { ...env, OPENCODE_CONFIG_CONTENT: '{"mcp":{}}' }, timeoutMs: options.timeoutMs ?? 15_000, maxBytes: 4_000_000 });
      invariant(r.code === 0 && !r.timedOut && !r.overflow, 'OpenCode model listing failed'); models = parseOpenCodeModels(r.stdout);
    }
  } catch { warnings.push(`${cap.adapter}のモデル一覧を取得できませんでした。CLIの認証・登録を確認してください（生成リクエストは送信していません）。`); }
  finally { channel?.close(); rmSync(cwd, { recursive: true, force: true }); }
  for (const p of options.previous ?? []) {
    if (p.adapter !== cap.adapter) continue;
    const model = p.model ?? 'default', saved = modelOption(cap.adapter, model, p.provider, { source: 'saved', description: '前回の許可設定。今回の一覧では利用可能性を確認できていません。' });
    if (!models.some(m => m.id === saved.id)) models.push(saved);
  }
  if (!models.length) warnings.push('モデルが0件です。このCLIはスキップするか、登録後に一覧を再取得してください。既定モデルを勝手に許可しません。');
  return { models: uniqueModels(models), warnings };
}
export function scopedProfiles(cap: Capabilities, models: ModelOption[], previous: Profile[] = [], globalPiProviders = false): Profile[] {
  return uniqueModels(models).map(m => {
    const prior = previous.find(p => p.adapter === cap.adapter && (p.model ?? 'default') === m.model && (p.provider ?? '') === (m.provider ?? ''));
    const p = profileFrom(cap); p.id = m.id;
    if (m.model !== 'default') p.model = m.model;
    if (m.provider) p.provider = m.provider;
    p.modelName = m.name; p.modelDescription = m.description; p.modelSource = m.source;
    p.contextWindow = m.contextWindow; p.reasoning = m.reasoning; p.efforts = m.efforts?.length ? m.efforts : prior?.efforts;
    if (!p.efforts?.length && prior?.thinking) p.efforts = [prior.thinking];
    if (cap.adapter === 'pi') p.globalPiProviders = globalPiProviders;
    // The user chooses the allowed pool, not permanent tiers or role assignments.
    // The engine's Jev candidates bind one pool entry to one runtime role.
    return p;
  });
}
export function piScopePatterns(): string[] {
  const path = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), 'settings.json');
  try { if (!existsSync(path)) return []; const value = JSON.parse(readFileSync(path, 'utf8')); return Array.isArray(value.enabledModels) ? value.enabledModels.filter((s: unknown) => typeof s === 'string') : []; } catch { return []; }
}
export function matchesScope(model: ModelOption, patterns: string[]): boolean {
  return patterns.some(p => {
    const withoutThinking = p.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, '');
    const escaped = withoutThinking.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i').test(`${model.provider ?? ''}/${model.model}`) || new RegExp(`^${escaped}$`, 'i').test(model.model);
  });
}
