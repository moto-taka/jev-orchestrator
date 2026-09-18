import { emitKeypressEvents } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { sanitize } from '../security.ts';
import { fit } from '../tui/screen.ts';
import { invariant } from '../util.ts';
import type { ModelOption } from './catalog.ts';

export class PickerState {
  models: ModelOption[]; selected: Set<string>; filter = ''; cursor = 0;
  constructor(models: ModelOption[], selected: string[] = []) { this.models = models; this.selected = new Set(selected.filter(id => models.some(m => m.id === id))); }
  get visible(): ModelOption[] { const q = this.filter.toLowerCase(); return this.models.filter(m => `${m.provider ?? ''} ${m.model} ${m.name} ${m.description ?? ''}`.toLowerCase().includes(q)); }
  move(delta: number): void { this.cursor = Math.max(0, Math.min(Math.max(0, this.visible.length - 1), this.cursor + delta)); }
  toggle(): void { const id = this.visible[this.cursor]?.id; if (!id) return; this.selected.has(id) ? this.selected.delete(id) : this.selected.add(id); }
  toggleVisible(): void { const all = this.visible.every(m => this.selected.has(m.id)); for (const m of this.visible) all ? this.selected.delete(m.id) : this.selected.add(m.id); }
  result(): ModelOption[] { return this.models.filter(m => this.selected.has(m.id)); }
}
export async function pickModels(title: string, models: ModelOption[], selected: string[] = []): Promise<ModelOption[]> {
  invariant(stdin.isTTY && stdout.isTTY, 'Model selection requires a TTY');
  const state = new PickerState(models, selected), wasRaw = stdin.isRaw; let notice = '';
  emitKeypressEvents(stdin); stdin.setRawMode(true); stdin.resume(); stdout.write('\x1b[?1049h\x1b[?25l');
  const draw = () => {
    const width = Math.max(24, (stdout.columns || 100) - 2), rows = Math.max(3, (stdout.rows || 24) - 8), visible = state.visible;
    const start = Math.max(0, Math.min(state.cursor - Math.floor(rows / 2), visible.length - rows));
    const lines = [`  ${sanitize(title)}  ·  ${state.selected.size}件を許可`, '',
      `  検索: ${sanitize(state.filter) || '文字を入力して絞り込み'}`, ''];
    for (let i = start; i < Math.min(start + rows, visible.length); i++) {
      const m = visible[i]!;
      lines.push(`${i === state.cursor ? '❯' : ' '} [${state.selected.has(m.id) ? '✓' : ' '}] ${sanitize(m.provider ? `${m.provider}/${m.model}` : m.model)}${m.source === 'saved' ? ' [前回設定・未再確認]' : ''}${m.isDefault ? ' [CLI既定]' : ''}`);
    }
    if (!visible.length) lines.push('  一致するモデルがありません。Backspaceで検索を変更してください。');
    lines.push('', `  ${notice || '↑↓: 移動  Space: 選択  Ctrl+A: 表示中を全選択/解除'}`,
      '  Enter: 確定（0件ならこのCLIを除外）  Esc: 検索解除  Ctrl+C: 取消',
      '  許可したモデルの中から、モデル・役割をJevが選びます。');
    stdout.write('\x1b[H\x1b[2J' + lines.map(l => fit(l, width)).join('\n'));
  };
  try {
    return await new Promise<ModelOption[]>((resolve, reject) => {
      const finish = (error?: Error) => { stdin.removeListener('keypress', keypress); stdout.removeListener('resize', draw); error ? reject(error) : resolve(state.result()); };
      const keypress = (str: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
        if (key.ctrl && ['c', 'd'].includes(key.name ?? '')) { finish(new Error('Model selection cancelled; previous settings were not changed')); return; }
        if (key.name === 'return') { finish(); return; }
        if (key.name === 'up') state.move(-1);
        else if (key.name === 'down') state.move(1);
        else if (key.name === 'pageup') state.move(-10);
        else if (key.name === 'pagedown') state.move(10);
        else if (key.ctrl && key.name === 'a') state.toggleVisible();
        else if (key.name === 'space') state.toggle();
        else if (key.name === 'escape' || key.ctrl && key.name === 'u') { state.filter = ''; state.cursor = 0; }
        else if (key.name === 'backspace') { state.filter = Array.from(state.filter).slice(0, -1).join(''); state.cursor = 0; }
        else if (str && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(str)) { state.filter = (state.filter + str).slice(0, 200); state.cursor = 0; }
        notice = ''; draw();
      };
      stdin.on('keypress', keypress); stdout.on('resize', draw); draw();
    });
  } finally { stdin.setRawMode(!!wasRaw); stdin.pause(); stdout.write('\x1b[?25h\x1b[?1049l'); }
}
