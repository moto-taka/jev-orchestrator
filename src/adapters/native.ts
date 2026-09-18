import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { AdapterId, AgentAdapter, AgentEvent, AgentResult, Invocation, Usage } from '../types.ts';
import { parseReport, REPORT_CONTRACT } from '../contracts.ts';
import { execute } from '../process.ts';
import { workerEnvironment, SecretGuard, terminalText } from '../security.ts';
import { anthropicUsage, codexUsage, piUsage, opencodeUsage } from '../telemetry.ts';
import { errorText, hash, invariant, privateDir } from '../util.ts';
import { validateInstalled } from './registry.ts';

type Obj = Record<string, any>; // External JSON is validated at the contract boundary, never executed as instructions.
export class EventParser {
  adapter: AdapterId; text = ''; sessionId?: string; model?: string; done = false; failed?: string;
  usage = new Map<string, Usage>(); private partial = ''; private seen = new Set<string>(); private lastAssistant = ''; private count = 0;
  constructor(adapter: AdapterId) { this.adapter = adapter; }
  accept(raw: unknown): AgentEvent[] {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const e = raw as Obj, result: AgentEvent[] = [];
    if (typeof e.type !== 'string') return [];
    const emitText = (v: unknown, final = false) => {
      if (typeof v !== 'string') return;
      if (final) { this.text = v; this.lastAssistant = v; } else this.partial = (this.partial + v).slice(-2_000_000);
      result.push({ type: 'text', text: v });
    };
    const session = (v: unknown) => { if (typeof v === 'string' && v.length < 1024 && !/[\x00-\x1f]/.test(v)) { this.sessionId = v; result.push({ type: 'session', sessionId: v }); } };
    const model = (v: unknown) => { if (typeof v === 'string' && v.length < 300 && !/[\\x00-\\x1f]/.test(v) && v !== this.model) { this.model = v; result.push({ type: 'model', model: v, text: v }); } };
    const usage = (key: string, u: Usage) => { this.usage.set(key, u); result.push({ type: 'usage', key, usage: u }); };
    if (typeof e.model === 'string') model(e.model);
    if (typeof e.model_id === 'string') model(e.model_id);
    if (typeof e.modelID === 'string') model(e.modelID);
    if (this.adapter === 'codex') {
      if (e.type === 'thread.started') { session(e.thread_id); model(e.model ?? e.model_id); }
      if (e.type === 'turn.started') { this.count++; this.done = false; }
      if (e.type === 'item.completed' || e.type === 'item.updated' || e.type === 'item.started') {
        const item = e.item ?? {};
        if (item.type === 'agent_message' && e.type === 'item.completed') emitText(item.text, true);
        if (item.type === 'command_execution' || item.type === 'file_change' || item.type === 'mcp_tool_call') result.push({ type: 'tool', text: String(item.command ?? item.tool ?? item.type) });
      }
      if (e.type === 'turn.completed') { this.done = true; if (e.usage) usage(`turn:${this.count}`, codexUsage(e.usage)); }
      if (e.type === 'turn.failed' || e.type === 'error') this.failed = String(e.error?.message ?? e.message ?? 'Codex failed');
    } else if (this.adapter === 'claude') {
      if (e.session_id) session(e.session_id);
      if (e.type === 'system' && e.model) model(e.model);
      if (e.type === 'assistant' && e.message) {
        const msg = e.message;
        if (typeof msg.model === 'string') model(msg.model);
        const content = Array.isArray(msg.content) ? msg.content : [];
        const texts = content.filter((c: Obj) => c.type === 'text').map((c: Obj) => c.text).join('');
        if (texts) emitText(texts, true);
        for (const c of content) if (c.type === 'tool_use') result.push({ type: 'tool', text: String(c.name) });
        if (msg.usage) usage(`message:${msg.id ?? hash(msg)}`, anthropicUsage(msg.usage));
      }
      if (e.type === 'stream_event') {
        const delta = e.event?.delta;
        if (delta?.type === 'text_delta') emitText(delta.text);
      }
      if (e.type === 'result') {
        this.done = true;
        if (e.is_error || (e.subtype && e.subtype !== 'success')) this.failed = String(e.result ?? e.subtype);
        if (e.structured_output && typeof e.structured_output === 'object') emitText(JSON.stringify(e.structured_output), true); else if (typeof e.result === 'string') emitText(e.result, true);
        if (e.usage) { this.usage.clear(); usage('result-total', { ...anthropicUsage(e.usage), observedCost: typeof e.total_cost_usd === 'number' ? e.total_cost_usd : undefined, currency: 'USD' }); }
      }
    } else if (this.adapter === 'pi') {
      if (e.type === 'session' && e.id) session(e.id);
      if (e.type === 'message_update') {
        const delta = e.assistantMessageEvent;
        if (delta?.type === 'text_delta') emitText(delta.delta);
      }
      if (e.type === 'message_end' && e.message?.role === 'assistant') {
        const msg = e.message, key = `message:${msg.timestamp ?? hash(msg)}`;
        if (typeof msg.model === 'string') model(msg.model);
        const t = Array.isArray(msg.content) ? msg.content.filter((c: Obj) => c.type === 'text').map((c: Obj) => c.text).join('') : '';
        if (t) emitText(t, true);
        if (msg.usage) usage(key, piUsage(msg.usage));
        if (msg.stopReason === 'error') this.failed = String(msg.errorMessage ?? 'Pi model error');
      }
      if (e.type === 'tool_execution_start') result.push({ type: 'tool', text: String(e.toolName) });
      if (e.type === 'agent_end') this.done = true;
    } else {
      if (e.sessionID) session(e.sessionID);
      if (e.type === 'text') emitText(e.part?.text, true);
      if (e.type === 'tool_use') result.push({ type: 'tool', text: String(e.part?.tool ?? 'tool') });
      if (e.type === 'step_finish') {
        const p = e.part ?? {}; if (p.tokens) usage(`step:${p.id ?? hash(p)}`, opencodeUsage(p.tokens, p.cost));
        if (p.reason === 'stop' || p.reason === 'end_turn') this.done = true;
      }
      if (e.type === 'error') this.failed = String(e.error?.data?.message ?? e.error?.name ?? 'OpenCode failed');
    }
    if (this.failed) result.push({ type: 'error', text: this.failed });
    if (this.done) result.push({ type: 'done' });
    // Deduplicate upstream repeated events; repeated usage totals replace, not add.
    return result.filter(r => { if (r.type !== 'usage') return true; const k = hash(r); if (this.seen.has(k)) return false; this.seen.add(k); return true; });
  }
}
export function invocationCommand(i: Invocation): { argv: string[]; env: NodeJS.ProcessEnv; input: string; sessionPath?: string } {
  const p = i.profile, env = workerEnvironment(), writer = i.role === 'implementer';
  const args: string[] = []; let sessionPath: string | undefined;
  if (p.adapter === 'codex') {
    args.push('exec'); if (i.sessionId) args.push('resume');
    args.push('--json', '-c', 'features.multi_agent=false', '-c', 'approval_policy="never"', '-c', `sandbox_mode="${writer ? 'workspace-write' : 'read-only'}"`);
    if (p.model) args.push('--model', p.model);
    if (p.provider) args.push('-c', `model_provider=${JSON.stringify(p.provider)}`);
    if (p.thinking) args.push('-c', `model_reasoning_effort=${JSON.stringify(p.thinking)}`);
    if (i.sessionId) args.push(i.sessionId);
    args.push('-');
  } else if (p.adapter === 'claude') {
    args.push('-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--max-turns', String(p.maxTurns),
      '--permission-mode', writer ? 'acceptEdits' : 'plan', '--disallowedTools', 'Agent,Task,WebFetch,WebSearch',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'user');
    if (!writer) args.push('--tools', 'Read,Grep,Glob');
    if (p.model) args.push('--model', p.model);
    if (i.sessionId) args.push('--resume', i.sessionId);
  } else if (p.adapter === 'pi') {
    privateDir(i.sessionDir);
    sessionPath = join(i.sessionDir, 'session.jsonl');
    if (i.sessionId) invariant(existsSync(sessionPath), 'Pi session file is missing; refusing to silently create a replacement');
    args.push('--print', '--mode', 'json', '--session', sessionPath, ...(p.globalPiProviders ? ['--no-approve', '--no-context-files'] : ['--no-extensions']), '--no-skills', '--no-prompt-templates', '--no-themes',
      '--tools', writer ? 'read,grep,find,ls,edit,write,bash' : 'read,grep,find,ls');
    if (p.model) args.push('--model', p.model);
    if (p.provider) args.push('--provider', p.provider);
    if (p.thinking) args.push('--thinking', p.thinking);
  } else {
    args.push('run', '--format', 'json');
    if (p.model) args.push('--model', p.model);
    if (i.sessionId) args.push('--session', i.sessionId);
    // No credential extraction. Native authentication stays with OpenCode.
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: { task: 'deny', external_directory: 'deny', doom_loop: 'deny',
      ...(writer ? {} : { edit: 'deny', bash: 'deny' }) }, mcp: {} });
  }
  // Pass the prompt on stdin, not as a shell argument or temporary project file.
  return { argv: [p.binary, ...args], env, input: i.prompt + '\n', sessionPath };
}
export class NativeAdapter implements AgentAdapter {
  private guard: SecretGuard;
  constructor(guard = new SecretGuard()) { this.guard = guard; }
  async run(i: Invocation): Promise<AgentResult> {
    await validateInstalled(i.profile);
    invariant(i.profile.enabled && ['managed', 'trusted-local'].includes(i.profile.level), 'Profile is not enabled for automatic execution');
    const c = invocationCommand(i), parser = new EventParser(i.profile.adapter);
    let protocolErrors = 0;
    const result = await execute(c.argv, { cwd: i.cwd, input: c.input, env: c.env, timeoutMs: i.profile.timeoutMs, signal: i.signal,
      maxBytes: 8_000_000, onSpawn: i.onSpawn, onStderr: line => { if (line.trim()) i.onEvent({ type: 'text', text: this.guard.redact(terminalText(line)) }); }, onStdout: line => {
        if (!line.trim()) return;
        try { for (const e of parser.accept(JSON.parse(line))) i.onEvent({ ...e, text: e.text === undefined ? undefined : this.guard.redact(terminalText(e.text)) }); }
        catch { protocolErrors++; }
      } });
    const base = { sessionId: c.sessionPath ?? parser.sessionId, text: this.guard.redact(parser.text), model: parser.model, usage: [...parser.usage.values()] };
    if (result.groupRunning) return { ...base, status: 'unknown', error: 'Worker left a running process group; explicit reconciliation is required.' };
    if (i.sessionId && base.sessionId !== i.sessionId) return { ...base, status: 'unknown', error: 'Upstream returned a different or unobservable session ID during resume.' };
    if (result.interrupted) return { ...base, status: 'interrupted', error: 'Interrupted' };
    if (result.timedOut || result.overflow || result.code !== 0 || parser.failed) return { ...base, status: 'failed', error: this.guard.redact(parser.failed ?? (result.timedOut ? 'Worker timeout' : result.overflow ? 'Worker output limit exceeded' : `CLI exited with ${result.code}: ${result.stderr.slice(-1500)}`)) };
    if (!parser.done || protocolErrors > 0) return { ...base, status: 'unknown', error: `Incomplete structured protocol (${protocolErrors} invalid JSON lines). Changes are retained, not approved.` };
    try { return { ...base, status: 'reported', report: parseReport(base.text) }; }
    catch (e) { return { ...base, status: 'failed', error: `Final report contract: ${errorText(e)}. ${REPORT_CONTRACT.slice(0, 200)}` }; }
  }
}
