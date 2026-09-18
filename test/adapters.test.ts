import test from 'node:test';
import assert from 'node:assert/strict';
import { EventParser, invocationCommand } from '../src/adapters/native.ts';
import type { Invocation, AdapterId } from '../src/types.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
function invocation(adapter: AdapterId, role: Invocation['role'] = 'implementer'): Invocation {
  return { id: 'op', taskId: 'task', runId: 'run', role, profile: { id: adapter, adapter, binary: `/bin/${adapter}`, version: 'fixture', enabled: true, level: 'trusted-local', capabilityHash: 'fixture', roles: [role], maxTurns: 10, timeoutMs: 1000, model: 'approved-model' }, cwd: tmpdir(), prompt: 'User prompt; $(not a shell)', sessionDir: mkdtempSync(join(tmpdir(), 'jvo-session-')), signal: new AbortController().signal, onEvent: () => {} };
}
test('Codex JSONL reports session, final text, tools and cache-inclusive usage', () => {
  const p = new EventParser('codex'); p.accept({ type: 'thread.started', thread_id: 'session-1' });
  const tools = p.accept({ type: 'item.started', item: { type: 'command_execution', command: 'npm test' } }); assert.equal(tools[0]?.type, 'tool');
  p.accept({ type: 'item.completed', item: { type: 'agent_message', text: '{"summary":"report"}' } });
  p.accept({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } });
  assert.equal(p.sessionId, 'session-1'); assert(p.done); assert.equal([...p.usage.values()][0]?.inputTotal, 100);
});
test('Claude uses result total instead of double-counting message totals', () => {
  const p = new EventParser('claude');
  p.accept({ type: 'assistant', session_id: 's', message: { id: 'm', model: 'model', content: [{ type: 'text', text: 'text' }], usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } } });
  p.accept({ type: 'result', subtype: 'success', result: '{"summary":"done"}', usage: { input_tokens: 20, cache_read_input_tokens: 180, output_tokens: 10 }, total_cost_usd: 0.03 });
  assert.equal(p.usage.size, 1); assert.equal([...p.usage.values()][0]?.inputTotal, 200); assert(p.done); assert.equal(p.text, '{"summary":"done"}');
});
test('Pi end-of-agent and cache counters are normalized', () => {
  const p = new EventParser('pi'); p.accept({ type: 'session', id: 's' });
  p.accept({ type: 'message_end', message: { role: 'assistant', timestamp: 1, content: [{ type: 'text', text: 'report' }], usage: { input: 10, cacheRead: 50, cacheWrite: 20, output: 8 } } });
  p.accept({ type: 'agent_end' }); assert(p.done); assert.equal([...p.usage.values()][0]?.inputTotal, 80);
});
test('OpenCode only finishes after a terminal step, not arbitrary tool output', () => {
  const p = new EventParser('opencode'); p.accept({ type: 'text', sessionID: 's', part: { text: 'report' } });
  p.accept({ type: 'step_finish', part: { id: 'one', reason: 'tool-calls', tokens: { input: 10, output: 3, cache: { read: 20, write: 0 } } } }); assert(!p.done);
  p.accept({ type: 'step_finish', part: { id: 'two', reason: 'stop', tokens: { input: 10, output: 3 } } }); assert(p.done); assert.equal(p.sessionId, 's');
});
test('a process success code alone never creates a terminal protocol event', () => { for (const id of ['codex', 'claude', 'pi', 'opencode'] as const) assert.equal(new EventParser(id).done, false); });
test('commands do not put user prompts or API keys in shell arguments', () => {
  for (const adapter of ['codex', 'claude', 'pi', 'opencode'] as const) {
    const i = invocation(adapter), c = invocationCommand(i); assert(!c.argv.includes(i.prompt)); assert(c.input.includes(i.prompt)); assert.equal(c.env.JVO_API_KEY, undefined);
  }
});
test('rework explicitly resumes the same Codex or Claude session', () => {
  for (const adapter of ['codex', 'claude'] as const) { const i = invocation(adapter); i.sessionId = 'session-fixed'; const c = invocationCommand(i); assert(c.argv.includes('session-fixed')); assert(c.argv.includes(adapter === 'codex' ? 'resume' : '--resume')); }
});
test('Pi resume refuses a vanished session file rather than inventing a new session', () => {
  const i = invocation('pi'); i.sessionId = join(i.sessionDir, 'session.jsonl'); assert.throws(() => invocationCommand(i)); writeFileSync(i.sessionId, '{}\n'); assert.doesNotThrow(() => invocationCommand(i));
});
test('review profiles have restrictive tool/policy arguments and no internal agents', () => {
  const claude = invocationCommand(invocation('claude', 'reviewer')); assert(claude.argv.includes('Read,Grep,Glob')); assert(claude.argv.includes('Agent,Task,WebFetch,WebSearch'));
  const pi = invocationCommand(invocation('pi', 'reviewer')); assert(pi.argv.includes('read,grep,find,ls')); assert(pi.argv.includes('--no-extensions'));
  const codex = invocationCommand(invocation('codex', 'reviewer')); assert(codex.argv.includes('sandbox_mode="read-only"')); assert(codex.argv.includes('features.multi_agent=false'));
});


test('selected effort is translated only through CLI-supported native flags', () => {
  const codex = invocation('codex'); codex.profile.thinking = 'high';
  const codexCommand = invocationCommand(codex);
  assert(codexCommand.argv.includes('model_reasoning_effort="high"'));

  const pi = invocation('pi'); pi.profile.thinking = 'medium';
  const piCommand = invocationCommand(pi);
  const at = piCommand.argv.indexOf('--thinking');
  assert(at >= 0); assert.equal(piCommand.argv[at + 1], 'medium');

  const claude = invocation('claude'); claude.profile.thinking = undefined;
  assert(!invocationCommand(claude).argv.includes('--thinking'));
});
