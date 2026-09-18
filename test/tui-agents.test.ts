import test from 'node:test';
import assert from 'node:assert/strict';
import { agentCards, renderScreen, type ScreenState } from '../src/tui/screen.ts';
import type { View } from '../src/types.ts';

function fixture(): View {
  return {
    agents: [{
      id: 'pi_231b6b4926dfb0478b8f', adapter: 'pi', binary: '/usr/bin/pi', version: '0.85.1',
      model: 'qwen3-coder', provider: 'openrouter', modelName: 'Qwen 3 Coder', roles: ['scout','planner','implementer','reviewer','explainer'],
      enabled: true, level: 'trusted-local', capabilityHash: 'x', maxTurns: 20, timeoutMs: 1000,
    }],
    tasks: [{
      id: 'run_T1', runId: 'run', spec: { id: 'T1', title: 'バグ探索', instruction: 'バグを探索', acceptance: ['TODO追加'], dependsOn: [], readPaths: ['**'], writePaths: ['**'], resources: [] },
      version: 1, phase: 'assess', status: 'running', kind: 'work', attempts: 0, diagnoses: 0, reviewCount: 0, requiredReviews: 1,
      evidence: [], findings: [], sameFailure: 0, staged: false, contextIds: [], activeProfileId: 'pi_231b6b4926dfb0478b8f', activeRole: 'scout',
    }],
    agentEvents: [
      { invocationId: 'op1', time: '2026-09-19T00:50:00.000Z', taskId: 'run_T1', taskSpecId: 'T1', profileId: 'pi_231b6b4926dfb0478b8f', adapter: 'pi', role: 'scout', provider: 'openrouter', configuredModel: 'qwen3-coder', effort: 'high', type: 'started', text: 'バグ探索' },
      { invocationId: 'op1', time: '2026-09-19T00:50:01.000Z', taskId: 'run_T1', taskSpecId: 'T1', profileId: 'pi_231b6b4926dfb0478b8f', adapter: 'pi', role: 'scout', provider: 'openrouter', configuredModel: 'qwen3-coder', observedModel: 'qwen3-coder', effort: 'high', type: 'model', text: 'qwen3-coder' },
      { invocationId: 'op1', time: '2026-09-19T00:50:02.000Z', taskId: 'run_T1', taskSpecId: 'T1', profileId: 'pi_231b6b4926dfb0478b8f', adapter: 'pi', role: 'scout', provider: 'openrouter', configuredModel: 'qwen3-coder', observedModel: 'qwen3-coder', effort: 'high', type: 'tool', text: 'read src/auth.ts' },
    ],
    events: [], usage: [], decisions: [],
  };
}

test('parent TUI shows human CLI/model/role instead of opaque profile id', () => {
  const view = fixture(), cards = agentCards(view);
  assert.equal(cards[0]?.label, 'Pi · openrouter/qwen3-coder');
  const state: ScreenState = { input: '', cursor: 0, panel: '', scroll: 0, agentIndex: 0 };
  const screen = renderScreen(view, state, 120, 34).lines.join('\n');
  assert.match(screen, /Pi · openrouter\/qwen3-coder · scout · T1/);
  assert.match(screen, /prefix pi · alias Qwen 3 Coder · model openrouter\/qwen3-coder · effort high/);
  assert.doesNotMatch(screen, /pi_231b6b4926dfb0478b8f/);
});

test('focused agent stream exposes profile/session detail and live operation history', () => {
  const view = fixture();
  view.agentEvents![1]!.sessionId = 'session-abc';
  const state: ScreenState = { input: '', cursor: 0, panel: '', scroll: 0, agentIndex: 0, agentFocus: true };
  const screen = renderScreen(view, state, 120, 34).lines.join('\n');
  assert.match(screen, /← Agent/);
  assert.match(screen, /profile: pi_231b6b4926dfb0478b8f/);
  assert.match(screen, /model: observed qwen3-coder · effort: high/);
  assert.match(screen, /tool\s+read src\/auth\.ts/);
});

test('observed model wins over configured model in the agent card', () => {
  const view = fixture();
  view.agentEvents!.push({ ...view.agentEvents![2]!, time: '2026-09-19T00:50:03.000Z', type: 'model', observedModel: 'qwen3-coder-v2', text: 'qwen3-coder-v2' });
  assert.equal(agentCards(view)[0]?.label, 'Pi · openrouter/qwen3-coder-v2');
});


test('multiline prompt is rendered on real wrapped rows instead of a single ↵ placeholder row', () => {
  const view = fixture();
  const input = 'first line\nsecond line with more text';
  const state: ScreenState = { input, cursor: [...input].length, panel: '', scroll: 0, agentIndex: 0 };
  const lines = renderScreen(view, state, 60, 24).lines;
  assert(lines.some(line => line.includes('❯ first line')));
  assert(lines.some(line => line.includes('second line with more text')));
  assert(!lines.some(line => line.includes(' ↵ ')));
});

test('scroll offset exposes older long content for PgUp/PgDn state changes', () => {
  const view = fixture();
  const detail = Array.from({ length: 40 }, (_, i) => `line-${String(i).padStart(2, '0')}`).join('\n');
  const newest = renderScreen(view, { input: '', cursor: 0, panel: '/diff', detail, scroll: 0 }, 80, 20).lines.join('\n');
  const older = renderScreen(view, { input: '', cursor: 0, panel: '/diff', detail, scroll: 12 }, 80, 20).lines.join('\n');
  assert.match(newest, /line-39/);
  assert.doesNotMatch(older, /line-39/);
  assert.match(older, /line-2[0-9]/);
});

test('footer selection metadata follows OpenClaude-style model and route status placement', () => {
  const view = fixture();
  const screen = renderScreen(view, { input: '', cursor: 0, panel: '', scroll: 0, agentIndex: 0, agentSelected: true }, 120, 26).lines.join('\n');
  assert.match(screen, /› ↓ agents 1\/1/);
  assert.match(screen, /Pi · openrouter\/qwen3-coder · scout · T1/);
  assert.match(screen, /prefix pi · alias Qwen 3 Coder · model openrouter\/qwen3-coder/);
  assert.match(screen, /↑↓ 選択 · Esc 戻る/);
});
