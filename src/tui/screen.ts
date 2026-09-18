import { basename } from 'node:path';
import type { AgentTrace, Profile, View } from '../types.ts';
import { sanitize } from '../security.ts';
import { summarizeUsage } from '../telemetry.ts';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const graphemes = (s: string): string[] => [...segmenter.segment(s)].map(x => x.segment);
export function cellWidth(s: string): number {
  let width = 0;
  for (const g of graphemes(sanitize(s))) {
    if (/^[\p{Mark}\u200d\ufe0f]+$/u.test(g)) continue;
    const cp = g.codePointAt(0)!;
    width += /\p{Extended_Pictographic}/u.test(g) || cp >= 0x1100 && (cp <= 0x115f || cp >= 0x2329 && cp <= 0x232a || cp >= 0x2e80 && cp <= 0xa4cf || cp >= 0xac00 && cp <= 0xd7a3 || cp >= 0xf900 && cp <= 0xfaff || cp >= 0xfe10 && cp <= 0xfe6f || cp >= 0xff01 && cp <= 0xff60 || cp >= 0xffe0 && cp <= 0xffe6 || cp >= 0x20000) ? 2 : 1;
  }
  return width;
}
export function fit(s: string, width: number): string {
  let out = '', n = 0;
  for (const g of graphemes(sanitize(s).replace(/[\r\n\t]/g, ' '))) { const w = cellWidth(g); if (n + w > width) break; out += g; n += w; }
  return out;
}
export function wrap(s: string, width: number): string[] {
  width = Math.max(4, width); const out: string[] = [];
  for (const raw of sanitize(s).split('\n')) {
    let line = '', n = 0;
    for (const g of graphemes(raw.replace(/\t/g, '  '))) { const w = cellWidth(g); if (n + w > width && line) { out.push(line); line = ''; n = 0; } line += g; n += w; }
    out.push(line);
  }
  return out;
}
export interface ScreenState { input: string; cursor: number; panel: string; scroll: number; notice?: string; detail?: string; demo?: boolean; agentIndex?: number; agentSelected?: boolean; agentFocus?: boolean; }
export const COMMANDS = ['/agents', '/tasks', '/diff', '/why', '/messages', '/usage', '/pause', '/resume', '/apply', '/recover', '/refresh', '/cancel', '/detach', '/help', '/exit'];
const labels: Record<string, string> = { running: '実行中', paused: '一時停止', blocked: '確認待ち', ready_for_user_apply: '反映待ち', applied: '反映済み', cancelled: '取消済み', queued: '待機', waiting_for_peer: '担当の返答待ち', reported: '報告済み', reviewing: 'レビュー中', verifying: '検証中', accepted: '承認済み', done: '完了', rework: '修正中', staging: '統合中' };
const number = (v?: number) => v === undefined ? '不明' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
export interface AgentCard {
  invocationId: string; taskId: string; taskSpecId: string; profileId: string;
  label: string; prefix: string; alias: string; model: string; role: string; status: 'running' | 'done' | 'error';
  lastText?: string; lastType?: AgentTrace['type']; time: string; observedModel?: string; configuredModel?: string; sessionId?: string;
  events: AgentTrace[];
}
const adapterNames: Record<string, string> = { codex: 'Codex', claude: 'Claude', pi: 'Pi', opencode: 'OpenCode' };
function modelLabel(profile: Profile | undefined, observed?: string, configured?: string): string {
  let model = observed ?? configured ?? profile?.model;
  if (!model) return 'default / 未観測';
  const provider = profile?.provider;
  if (provider && !model.startsWith(provider + '/')) model = provider + '/' + model;
  return model;
}
function profileLabel(view: View | undefined, profileId: string, observed?: string, configured?: string): string {
  const p = view?.agents.find(x => x.id === profileId);
  return `${adapterNames[p?.adapter ?? ''] ?? p?.adapter ?? 'Agent'} · ${modelLabel(p, observed, configured)}`;
}
export function agentCards(view: View | undefined): AgentCard[] {
  const grouped = new Map<string, AgentTrace[]>();
  for (const e of view?.agentEvents ?? []) {
    const list = grouped.get(e.invocationId) ?? []; list.push(e); grouped.set(e.invocationId, list);
  }
  const cards: AgentCard[] = [];
  for (const [invocationId, events] of grouped) {
    events.sort((a, b) => a.time.localeCompare(b.time));
    const first = events[0]!, last = events.at(-1)!;
    const observed = [...events].reverse().find(e => e.observedModel)?.observedModel;
    const configured = [...events].reverse().find(e => e.configuredModel)?.configuredModel;
    const sessionId = [...events].reverse().find(e => e.sessionId)?.sessionId;
    const status: AgentCard['status'] = last.type === 'error' ? 'error' : last.type === 'completed' ? 'done' : 'running';
    const lastVisible = [...events].reverse().find(e => e.text && !['session','model'].includes(e.type));
    const profile = view?.agents.find(x => x.id === first.profileId);
    cards.push({ invocationId, taskId: first.taskId, taskSpecId: first.taskSpecId, profileId: first.profileId,
      label: profileLabel(view, first.profileId, observed, configured), prefix: profile?.adapter ?? first.adapter,
      alias: profile?.modelName ?? configured ?? observed ?? 'default', model: modelLabel(profile, observed, configured), role: first.role, status,
      lastText: lastVisible?.text, lastType: lastVisible?.type, time: last.time, observedModel: observed, configuredModel: configured, sessionId, events });
  }
  if (!cards.length && view?.tasks.length) {
    for (const t of view.tasks.filter(t => t.activeProfileId && ['running','reviewing','verifying','waiting_for_peer'].includes(t.status))) {
      const p = view.agents.find(x => x.id === t.activeProfileId);
      cards.push({ invocationId: 'task:' + t.id, taskId: t.id, taskSpecId: t.spec.id, profileId: t.activeProfileId!,
        label: profileLabel(view, t.activeProfileId!, t.observedModel), prefix: p?.adapter ?? 'agent',
        alias: p?.modelName ?? p?.model ?? t.observedModel ?? 'default', model: modelLabel(p, t.observedModel), role: t.activeRole ?? t.phase, status: 'running',
        lastText: t.lastActivity, time: '', observedModel: t.observedModel, configuredModel: p?.model, sessionId: t.sessionId, events: [] });
    }
  }
  return cards.sort((a, b) => (a.status === 'running' ? 0 : a.status === 'error' ? 1 : 2) - (b.status === 'running' ? 0 : b.status === 'error' ? 1 : 2) || b.time.localeCompare(a.time));
}


function inputLayout(input: string, cursor: number, width: number, maxRows: number): { lines: string[]; cursorRow: number; cursorColumn: number; hiddenAbove: boolean; hiddenBelow: boolean } {
  const inner = Math.max(4, width - 4), chars = graphemes(input), out: string[] = [];
  let line = '', cells = 0, cursorLine = 0, cursorColumn = 0, captured = false;
  const capture = (index: number) => {
    if (captured || index !== cursor) return;
    cursorLine = out.length; cursorColumn = cells; captured = true;
  };
  for (let i = 0; i <= chars.length; i++) {
    capture(i);
    if (i === chars.length) break;
    const g = chars[i]!;
    if (g === '\n') { out.push(line); line = ''; cells = 0; continue; }
    const w = cellWidth(g);
    if (cells + w > inner && line) { out.push(line); line = ''; cells = 0; capture(i); }
    line += g; cells += w;
  }
  out.push(line);
  if (!captured) { cursorLine = out.length - 1; cursorColumn = cells; }
  const rows = Math.max(1, Math.min(maxRows, out.length));
  let start = Math.max(0, cursorLine - rows + 1);
  if (start + rows > out.length) start = Math.max(0, out.length - rows);
  return { lines: out.slice(start, start + rows), cursorRow: cursorLine - start, cursorColumn, hiddenAbove: start > 0, hiddenBelow: start + rows < out.length };
}
export function renderScreen(view: View | undefined, state: ScreenState, columns: number, rows: number): { lines: string[]; cursor: { row: number; column: number } } {
  const width = Math.max(20, columns - 2), height = Math.max(8, rows), run = view?.run;
  const lines: string[] = [];
  lines.push(`  ▐▛██▜▌  jvo  0.3.2${state.demo ? '  [DEMO · API呼び出しなし]' : ''}`);
  lines.push(`  ▝▜██▛▘  ${run ? basename(run.repo) : 'Jev Orchestrator'}  ·  ${run ? state.demo ? 'DEMO fixture / 本番API未使用' : `${run.config.decision.provider} / ${run.config.decision.model}` : '判断はJev、作業はお使いのCLIへ。'}`);
  lines.push(`    ▘▘    ${run ? `${labels[run.status] ?? run.status}  ·  ${run.id.slice(0, 16)}` : 'タスクを入力してください。 /help で操作を確認できます。'}`);
  lines.push('');
  const content: string[] = [];
  const cards = agentCards(view), selectedAgent = cards.length ? cards[Math.min(state.agentIndex ?? 0, cards.length - 1)] : undefined;
  if (state.agentFocus && selectedAgent) {
    const icon = selectedAgent.status === 'running' ? '●' : selectedAgent.status === 'error' ? '!' : '✓';
    content.push(`  ← Agent  ${icon} ${selectedAgent.label} · ${selectedAgent.role} · ${selectedAgent.taskSpecId}`,
      `     profile: ${selectedAgent.profileId}`,
      `     model: ${selectedAgent.observedModel ? 'observed ' + selectedAgent.observedModel : 'configured ' + (selectedAgent.configuredModel ?? 'default') + ' / actual未観測'}`,
      `     session: ${selectedAgent.sessionId ?? '未観測'}`,
      '', '  実行ストリーム  [Esc: 親へ / ↑↓: agent切替 / PgUp・PgDn: スクロール]', '');
    for (const e of selectedAgent.events) {
      const time = e.time.slice(11, 19);
      if (e.type === 'started') content.push(`  ${time}  ● start   ${e.text ?? ''}`);
      else if (e.type === 'tool') content.push(`  ${time}  ├ tool    ${e.text ?? ''}`);
      else if (e.type === 'model') content.push(`  ${time}  ├ model   ${e.observedModel ?? e.text ?? ''}`);
      else if (e.type === 'session') content.push(`  ${time}  ├ session ${e.sessionId ?? ''}`);
      else if (e.type === 'text' && e.text) content.push(`  ${time}  │ ${e.text}`);
      else if (e.type === 'error') content.push(`  ${time}  ! error   ${e.text ?? ''}`);
      else if (e.type === 'done') content.push(`  ${time}  ├ turn done`);
      else if (e.type === 'completed') content.push(`  ${time}  └ done    ${e.text ?? ''}`);
    }
    if (!selectedAgent.events.length) content.push('  詳細イベントはこのrunでは記録されていません。現在の状態だけ表示しています。');
  } else if (state.panel) {
    content.push(`  ┌ ${state.panel}  [Escで閉じる / PgUp・PgDnで移動]`, '');
    if (state.panel === '/agents') {
      for (const [i, p] of (view?.agents ?? []).entries()) {
        const active = view?.tasks.filter(t => t.activeProfileId === p.id && ['running', 'reviewing'].includes(t.status)) ?? [];
        content.push(`  ${i === (view?.agents.length ?? 0) - 1 ? '└─' : '├─'} ${p.id} · ${p.adapter} · ${p.provider ? p.provider + '/' : ''}${p.model ?? 'CLI既定モデル（未観測）'}`);
        content.push(`     ${p.enabled ? '有効' : '無効'} / ${p.tier ?? '役割はJevが選択'} / ${p.level} / ${p.version}`);
        content.push(`     ${active.length ? active.map(t => t.spec.title).join(' · ') : '待機'} · ${p.roles.join(', ')}`);
      }
    } else if (state.panel === '/tasks') {
      for (const t of view?.tasks ?? []) { content.push(`  ${t.staged ? '✓' : t.status === 'running' ? '●' : '○'} ${t.spec.id} ${labels[t.status] ?? t.status} · ${t.spec.title}`); content.push(`     ${t.phase} · 修正 ${t.attempts}/${run?.config.runtime.maxRepairs} · レビュー ${t.reviewCount}/${t.requiredReviews}`); if (t.workspace) content.push(`     ${t.workspace}`); if (t.lastFailure) content.push(`     ${t.lastFailure.slice(0, 300)}`); }
    } else if (state.panel === '/why') {
      for (const d of view?.decisions.slice(-20) ?? []) {
        content.push(`  ${d.createdAt.slice(11, 19)}  ${d.selected?.kind ?? '評価'} · ${d.outcome}${d.sourceDecisionId ? ' · 厳密キャッシュ再利用' : ''}`);
        for (const [k, a] of Object.entries(d.answers)) content.push(`     ${k}: ${a.kind === 'boolean' ? `true確率=${a.probability.toFixed(3)}` : a.kind === 'score' ? `${a.value.toFixed(2)} / ${a.levels.length - 1}` : `${a.selected} · confidence=${a.confidence?.toFixed(3) ?? '不明'}`}`);
        content.push(`     根拠 ${d.evidenceIds.length}件 · ${d.semanticHash.slice(0, 12)} · ${d.provider}`);
      }
      for (const t of view?.runtimeTransitions?.slice(-12) ?? []) content.push(`  runtime · ${t.rule} · ${t.state} · 元判断 ${t.sourceDecisionId}`);
      content.push('', '  confidenceは正解率ではありません。記録された選択と根拠を表示しています。');
    } else if (state.panel === '/messages') {
      const states: Record<string, string> = { proposed: run?.controlVersion === 'lean-v1' ? '宛先・権限確認待ち' : 'Jev判断待ち', queued: '配送待ち', submitted: '入力済み・完了未確認', answered: '返答を保存', closed: '応答・継続済み', rejected: '配送拒否', unknown: '配送状態不明' };
      for (const m of view?.messages ?? []) {
        const name = (id: string) => view?.tasks.find(t => t.id === id)?.spec.id ?? id;
        content.push(`  ${name(m.fromTaskId)} → ${name(m.toTaskId)} · ${m.kind === 'question' ? '質問' : '返答'} · ${states[m.status]}`);
        content.push(...m.body.split('\n').slice(0, 8).map(line => `     ${line}`));
        content.push(`     ${m.id} · snapshot ${m.snapshot.slice(0, 10)}`);
      }
      if (!view?.messages?.length) content.push('  エージェント間のメッセージはまだありません。');
      content.push('', '  jvo内蔵通信です。会話の一致はタスクの完了承認ではありません。');
    } else if (state.panel === '/usage') {
      const usage = summarizeUsage(view?.usage ?? []);
      content.push(`  入力token（観測分）       ${number(usage.input)}`, `  出力token（観測分）       ${number(usage.output)}`,
        `  cache-read率             ${usage.cacheRate === undefined ? '不明' : (usage.cacheRate * 100).toFixed(1) + '%'}`,
        `  入力観測                 ${usage.observed}/${usage.total}`, `  cache観測                ${usage.cacheObserved}/${usage.total}`,
        `  費用（報告された分のみ） ${usage.cost === undefined ? '不明' : '$' + usage.cost.toFixed(4)}`,
        `  費用（推計された分のみ） ${usage.estimatedCost === undefined ? '不明' : '$' + usage.estimatedCost.toFixed(4)}`,
        `  Jev呼び出し              ${run?.decisionCalls ?? 0}/${run?.config.runtime.maxDecisions ?? '—'}`,
        `  worker起動               ${run?.workerStarts ?? 0}/${run?.config.runtime.maxWorkerStarts ?? '—'}`,
        '', '  観測不能な使用量・サブスク残量・費用を0とは扱いません。');
    } else if (state.panel === '/help') content.push(...[
      '  通常入力: 新規タスク / 停止中なら要件を補足して再開',
      '  /agents  担当CLI    /tasks  タスクと作業場',
      '  /diff    統合差分   /why    Jevの判断記録',
      '  /messages  担当間の質問・返答と配送状態',
      '  /usage   使用量     /pause  停止・作業は保持',
      '  /resume  再開       /apply  検証済み成果物を反映',
      '  /recover 不明な副作用の照合（確認が必要）',
      '  /refresh 承認済み設定を明示的に再読込（停止中のみ）',
      '  /cancel  取消       /detach 明示的に切り離して継続',
      '  /exit    終了（既定で停止）', '',
      '  Tab: コマンド補完 / ↑↓: 入力履歴 / Esc: パネルを閉じる',
      '  Ctrl+C: 入力取消・実行停止 / Ctrl+D: 終了',
    ]);
    else content.push(...(state.detail ?? '読み込み中…').split('\n'));
  } else {
    if (run) content.push(`  ❯ ${run.goal}`, '');
    for (const e of view?.events.slice(-10) ?? []) { if (!e.text) continue; content.push(`  ${e.kind === 'decision' ? '◆ Jev ' : e.kind.startsWith('worker') ? '└' : e.kind === 'blocked' ? '!' : '●'} ${e.text}`); }
    if (!run) content.push('  いつものターミナルで、複数のCLIをひとつの流れに。', '', '  Jevは担当・難易度・差し戻し・承認だけを判断します。', '  実装とレビューは既存CLIが行い、セッションを維持します。');
    if (cards.length) {
      const active = cards.filter(a => a.status === 'running').length;
      content.push('', `  ${active ? '●' : '✓'} agents ${active} running / ${cards.length} total  ·  ↓で選択、Enterで実行を表示`);
    } else if (view?.tasks.length) {
      content.push('');
      const visible = view.tasks.filter(t => t.phase !== 'done').slice(0, 5);
      for (const [i, t] of visible.entries()) {
        content.push(`    ${i === visible.length - 1 ? '└─' : '├─'} ${t.activeRole ?? t.phase} · ${t.spec.id} · ${labels[t.status] ?? t.status} · ${t.spec.title}`);
        if (t.lastActivity) content.push(`       └ ${t.lastActivity.replace(/\n/g, ' ').slice(0, Math.max(10, width - 12))}`);
      }
    }
    if (view?.tasks.length) content.push(`    完了 ${view.tasks.filter(t => t.staged).length}/${view.tasks.length} · 同時実行 ${view.tasks.filter(t => ['running', 'verifying', 'reviewing'].includes(t.status)).length}/${run?.config.runtime.maxParallel}`);
  }
  const wrapped = content.flatMap(line => wrap(line, width));
  const inputMaxRows = Math.max(2, Math.min(8, Math.floor(height / 3)));
  const inputView = inputLayout(state.input, state.cursor, width, inputMaxRows);
  const footerRows = 1 + 1 + inputView.lines.length + 1 + 2;
  const available = Math.max(1, height - lines.length - footerRows);
  const maxScroll = Math.max(0, wrapped.length - available);
  const scroll = Math.min(Math.max(0, state.scroll), maxScroll);
  const end = Math.max(0, wrapped.length - scroll), start = Math.max(0, end - available);
  const visibleContent = wrapped.slice(start, end);
  lines.push(...visibleContent);
  while (lines.length < height - footerRows) lines.push('');
  const scrollHint = maxScroll > 0 ? `  PgUp/PgDn ${Math.round((maxScroll - scroll) / Math.max(1, maxScroll) * 100)}%` : '';
  lines.push(fit(state.notice ? `  ${state.notice}` : run?.blockReason ? `  ! ${run.blockReason}` : scrollHint, width));
  lines.push('─'.repeat(width));
  const inputRowStart = lines.length + 1;
  for (const [i, line] of inputView.lines.entries()) {
    const prefix = i === 0 ? '❯ ' : '  ';
    const marker = i === 0 && inputView.hiddenAbove ? '…' : i === inputView.lines.length - 1 && inputView.hiddenBelow ? '…' : '';
    lines.push(fit(prefix + line + marker, width));
  }
  lines.push('─'.repeat(width));
  const selectedIndex = cards.length ? Math.min(state.agentIndex ?? 0, cards.length - 1) : 0;
  const selected = cards[selectedIndex];
  if (selected) {
    const icon = selected.status === 'running' ? '●' : selected.status === 'error' ? '!' : '✓';
    const selection = state.agentSelected || state.agentFocus ? '›' : ' ';
    lines.push(fit(`  ${selection} ↓ agents ${selectedIndex + 1}/${cards.length}  ${icon} ${selected.label} · ${selected.role} · ${selected.taskSpecId} · Enterで実行を見る`, width));
    lines.push(fit(`    prefix ${selected.prefix} · alias ${selected.alias} · model ${selected.model} · ↑↓ 選択 · Esc 戻る`, width));
  } else {
    const commandHint = state.input.startsWith('/') ? COMMANDS.filter(c => c.startsWith(state.input.split(' ')[0]!)).join('  ') : '/agents  /tasks  /messages  /diff  /why  /usage';
    lines.push(fit(`  ${commandHint}`, width));
    lines.push(fit('  Shift+Enter / Ctrl+J: 改行 · Enter: 送信 · PgUp/PgDn: 履歴スクロール', width));
  }
  const cursorRow = inputRowStart + inputView.cursorRow;
  const cursorColumn = Math.min(width, 3 + inputView.cursorColumn);
  return { lines: lines.slice(0, height).map(line => fit(line, width)), cursor: { row: Math.min(height, cursorRow), column: cursorColumn } };

}
