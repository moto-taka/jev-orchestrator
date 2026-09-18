import test from 'node:test';
import assert from 'node:assert/strict';
import { agentCards, renderScreen, type ScreenState } from '../src/tui/screen.ts';
import type { View } from '../src/types.ts';

function fixture(): View {
  return {
    agents: [{
      id: 'pi_231b6b4926dfb0478b8f', adapter: 'pi', binary: '/usr/bin/pi', version: '0.85.1',
      model: 'qwen3-coder', provider: 'openrouter', roles: ['scout','planner','implementer','reviewer','explainer'],
      enabled: true, level: 'trusted-local', capabilityHash: 'x', maxTurns: 20, timeoutMs: 1000,
    }],
    tasks: [{
      id: 'run_T1', runId: 'run', spec: { id: 'T1', title: 'バグ探索', instruction: 'バグを探索', acceptance: ['TODO追加'], dependsOn: [], readPaths: ['**'], writePaths: ['**'], resources: [] },
      version: 1, phase: 'assess', status: 'running', kind: 'work', attempts: 0, diagnoses: 0, reviewCount: 0, requiredReviews: 1,
      evidence: [], findings: [], sameFailure: 0, staged: false, contextIds: [], activeProfileId: 'pi_231b6b4926dfb0478b8f', activeRole: 'scout',
    }],
    agentEvents: [
      { invocationId: 'op1', time: '2026-09-19T00:50:00.000Z', taskId: 'run_T1', taskSpecId: 'T1', profileId: 'pi_231b6b4926dfb0478b8f', adapter: 'pi', role: 'scout', provider: 'openrouter', configuredModel: 'qwen3-coder', type: 'started', text: 'バグ探索' },
      { invocationId: 'op1', time: '2026-09-19T00:50:01.000Z', taskId: 'run_T1', taskSpecId: 'T1', profileId: 'pi_231b6b4926dfb0478b8f', adapter: 'pi', role: 'scout', provider: 'openrouter', configuredModel: 'qwen3-coder', observedModel: 'qwen3-coder', type: 'model', text: 'qwen3-coder' },
      { invocationId: 'op1', time: '2026-09-19T00:50:02.000Z', taskId: 'run_T1', taskSpecId: 'T1', profileId: 'pi_231b6b4926dfb0478b8f', adapter: 'pi', role: 'scout', provider: 'openrouter', configuredModel: 'qwen3-coder', observedModel: 'qwen3-coder', type: 'tool', text: 'read src/auth.ts' },
    ],
    events: [], usage: [], decisions: [],
  };
}

test('parent TUI shows human CLI/model/role instead of opaque profile id', () => {
  const view = fixture(), cards = agentCards(view);
  assert.equal(cards[0]?.label, 'Pi · openrouter/qwen3-coder');
  const state: ScreenState = { input: '', cursor: 0, panel: '', scroll: 0, agentIndex: 0 };
  const screen = renderScreen(view, state, 120, 34).lines.join('\n');
  assert.match(screen, /Pi · openrouter\/qwen3-coder · scout · T1 · 実行中/);
  assert.match(screen, /tool · read src\/auth\.ts/);
  assert.doesNotMatch(screen, /pi_231b6b4926dfb0478b8f/);
});

test('focused agent stream exposes profile/session detail and live operation history', () => {
  const view = fixture();
  view.agentEvents![1]!.sessionId = 'session-abc';
  const state: ScreenState = { input: '', cursor: 0, panel: '', scroll: 0, agentIndex: 0, agentFocus: true };
  const screen = renderScreen(view, state, 120, 34).lines.join('\n');
  assert.match(screen, /← Agent/);
  assert.match(screen, /profile: pi_231b6b4926dfb0478b8f/);
  assert.match(screen, /model: observed qwen3-coder/);
  assert.match(screen, /tool\s+read src\/auth\.ts/);
});

test('observed model wins over configured model in the agent card', () => {
  const view = fixture();
  view.agentEvents!.push({ ...view.agentEvents![2]!, time: '2026-09-19T00:50:03.000Z', type: 'model', observedModel: 'qwen3-coder-v2', text: 'qwen3-coder-v2' });
  assert.equal(agentCards(view)[0]?.label, 'Pi · openrouter/qwen3-coder-v2');
});
