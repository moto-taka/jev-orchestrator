import { basename } from 'node:path';
import type { View } from '../types.ts';
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
export interface ScreenState { input: string; cursor: number; panel: string; scroll: number; notice?: string; detail?: string; demo?: boolean; }
export const COMMANDS = ['/agents', '/tasks', '/diff', '/why', '/messages', '/usage', '/pause', '/resume', '/apply', '/recover', '/refresh', '/cancel', '/detach', '/help', '/exit'];
const labels: Record<string, string> = { running: '実行中', paused: '一時停止', blocked: '確認待ち', ready_for_user_apply: '反映待ち', applied: '反映済み', cancelled: '取消済み', queued: '待機', waiting_for_peer: '担当の返答待ち', reported: '報告済み', reviewing: 'レビュー中', verifying: '検証中', accepted: '承認済み', done: '完了', rework: '修正中', staging: '統合中' };
const number = (v?: number) => v === undefined ? '不明' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
export function renderScreen(view: View | undefined, state: ScreenState, columns: number, rows: number): { lines: string[]; cursor: { row: number; column: number } } {
  const width = Math.max(20, columns - 2), height = Math.max(8, rows), run = view?.run;
  const lines: string[] = [];
  lines.push(`  ▐▛██▜▌  jvo  0.3.0${state.demo ? '  [DEMO · API呼び出しなし]' : ''}`);
  lines.push(`  ▝▜██▛▘  ${run ? basename(run.repo) : 'Jev Orchestrator'}  ·  ${run ? state.demo ? 'DEMO fixture / 本番API未使用' : `${run.config.decision.provider} / ${run.config.decision.model}` : '判断はJev、作業はお使いのCLIへ。'}`);
  lines.push(`    ▘▘    ${run ? `${labels[run.status] ?? run.status}  ·  ${run.id.slice(0, 16)}` : 'タスクを入力してください。 /help で操作を確認できます。'}`);
  lines.push('');
  const content: string[] = [];
  if (state.panel) {
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
    for (const e of view?.events.slice(-14) ?? []) { if (!e.text) continue; content.push(`  ${e.kind === 'decision' ? '◆ Jev ' : e.kind.startsWith('worker') ? '└' : e.kind === 'blocked' ? '!' : '●'} ${e.text}`); }
    if (!run) content.push('  いつものターミナルで、複数のCLIをひとつの流れに。', '', '  Jevは担当・難易度・差し戻し・承認だけを判断します。', '  実装とレビューは既存CLIが行い、セッションを維持します。');
    if (view?.tasks.length) {
      content.push('');
      const visible = view.tasks.filter(t => t.phase !== 'done').slice(0, 5);
      for (const [i, t] of visible.entries()) {
        content.push(`    ${i === visible.length - 1 ? '└─' : '├─'} ${t.activeProfileId ?? t.profileId ?? 'Jev'} · ${t.activeRole ?? t.phase} · ${t.spec.id} · ${labels[t.status] ?? t.status} · ${t.spec.title}`);
        if (t.lastActivity) content.push(`       └ ${t.lastActivity.replace(/\n/g, ' ').slice(0, Math.max(10, width - 12))}`);
      }
      content.push(`    完了 ${view.tasks.filter(t => t.staged).length}/${view.tasks.length} · 同時実行 ${view.tasks.filter(t => ['running', 'verifying', 'reviewing'].includes(t.status)).length}/${run?.config.runtime.maxParallel}`);
    }
  }
  const wrapped = content.flatMap(s => wrap(s, width));
  const available = Math.max(1, height - lines.length - 6);
  const end = Math.max(available, wrapped.length - state.scroll), start = Math.max(0, end - available);
  lines.push(...wrapped.slice(start, end));
  while (lines.length < height - 6) lines.push('');
  lines.push(fit(state.notice ? `  ${state.notice}` : run?.blockReason ? `  ! ${run.blockReason}` : '', width));
  lines.push('─'.repeat(width));
  const chars = graphemes(state.input), cursorText = chars.slice(0, state.cursor).join('');
  let offset = 0;
  while (cellWidth(chars.slice(offset, state.cursor).join('')) > width - 5 && offset < state.cursor) offset++;
  const input = fit(chars.slice(offset).join('').replace(/\n/g, ' ↵ '), width - 4);
  const cursorRow = lines.length + 1;
  lines.push(`❯ ${input}`);
  lines.push('─'.repeat(width));
  const matches = state.input.startsWith('/') ? COMMANDS.filter(c => c.startsWith(state.input.split(' ')[0]!)).join('  ') : '/agents  /tasks  /messages  /diff  /why  /usage   ·   Tabで補完';
  lines.push(fit(`  ${matches}`, width));
  lines.push(fit('  Jev decides. Your CLIs build.  ·  元の作業場への反映は /apply', width));
  return { lines: lines.slice(0, height).map(s => fit(s, width)), cursor: { row: Math.min(height, cursorRow), column: 3 + cellWidth(chars.slice(offset, state.cursor).join('').replace(/\n/g, ' ↵ ')) } };
}
