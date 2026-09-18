import { stdin, stdout } from 'node:process';
import type { View } from '../types.ts';
import { COMMANDS, graphemes, renderScreen, type ScreenState } from './screen.ts';
import { errorText } from '../util.ts';
export interface Actions {
  submit(text: string): Promise<View | undefined>;
  command(name: string, arg: string): Promise<{ view?: View; detail?: string; exit?: boolean; notice?: string }>;
}
export async function terminalApp(actions: Actions, initial?: View, options: { demo?: boolean; subscribe?: (listener: (v: View) => void) => void } = {}): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Interactive mode needs a TTY. Use jvo run "task" --json, jvo replay, or jvo demo --json.');
  let view = initial, state: ScreenState = { input: '', cursor: 0, panel: '', scroll: 0, demo: options.demo };
  const history: string[] = []; let historyIndex = 0, busy = false, finished = false, redrawTimer: NodeJS.Timeout | undefined, previous: string[] = [];
  let escapeBuffer = '', paste = false, pasteText = '';
  let escapeTimer: NodeJS.Timeout | undefined;
  const write = (s: string) => { stdout.write(s); };
  const redraw = () => {
    redrawTimer = undefined; if (finished) return;
    const screen = renderScreen(view, state, stdout.columns || 100, stdout.rows || 30);
    let output = '\x1b[?2026h\x1b[?25l';
    for (let i = 0; i < Math.max(previous.length, screen.lines.length); i++) {
      const line = screen.lines[i] ?? '';
      if (line !== previous[i]) {
        const color = i === 0 || line.startsWith('  ◆ Jev') ? '\x1b[38;5;209m\x1b[1m' : line.startsWith('❯') ? '\x1b[1m' : line.startsWith('─') ? '\x1b[90m' : '';
        output += `\x1b[${i + 1};1H\x1b[2K${color}${line}\x1b[0m`;
      }
    }
    output += `\x1b[${screen.cursor.row};${screen.cursor.column}H\x1b[?25h\x1b[?2026l`;
    write(output); previous = screen.lines;
  };
  const requestRender = () => { if (!redrawTimer) redrawTimer = setTimeout(redraw, 65); };
  options.subscribe?.(next => { view = next; requestRender(); });
  let resolveDone: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  const quit = () => { finished = true; resolveDone!(); };
  const insert = (text: string) => {
    const chars = graphemes(state.input), added = graphemes(text); if (chars.length + added.length > 30_000) { state.notice = '入力は30,000文字以内にしてください。'; return; }
    chars.splice(state.cursor, 0, ...added); state.input = chars.join(''); state.cursor += added.length;
  };
  const act = async () => {
    const text = state.input.trim(); if (!text || busy) return;
    state.input = ''; state.cursor = 0; state.scroll = 0; state.notice = undefined;
    history.push(text); historyIndex = history.length; busy = true;
    try {
      if (text.startsWith('/')) {
        const space = text.indexOf(' '), command = space < 0 ? text : text.slice(0, space), arg = space < 0 ? '' : text.slice(space + 1);
        if (['/agents', '/tasks', '/why', '/messages', '/usage', '/help'].includes(command)) { state.panel = state.panel === command ? '' : command; }
        else {
          const result = await actions.command(command, arg);
          if (result.view) view = result.view; state.notice = result.notice;
          if (result.detail !== undefined) { state.panel = command; state.detail = result.detail; }
          if (result.exit) quit();
        }
      } else { view = await actions.submit(text) ?? view; state.panel = ''; }
    } catch (e) { state.notice = errorText(e); }
    finally { busy = false; requestRender(); }
  };
  const key = (s: string) => {
    if (s === '\x03') {
      if (state.input) { state.input = ''; state.cursor = 0; }
      else { void actions.command('/pause', '').then(r => { view = r.view ?? view; state.notice = '停止しました。Ctrl+Dで終了できます。'; requestRender(); }).catch(e => { state.notice = errorText(e); requestRender(); }); }
    } else if (s === '\x04') { void actions.command('/exit', '').then(quit, e => { state.notice = errorText(e); quit(); }); }
    else if (s === '\r' || s === '\n') void act();
    else if (s === '\x7f' || s === '\b') { const chars = graphemes(state.input); if (state.cursor > 0) { chars.splice(--state.cursor, 1); state.input = chars.join(''); } }
    else if (s === '\x1b[3~') { const chars = graphemes(state.input); chars.splice(state.cursor, 1); state.input = chars.join(''); }
    else if (s === '\x1b[D') state.cursor = Math.max(0, state.cursor - 1);
    else if (s === '\x1b[C') state.cursor = Math.min(graphemes(state.input).length, state.cursor + 1);
    else if (s === '\x01' || s === '\x1b[H' || s === '\x1b[1~') state.cursor = 0;
    else if (s === '\x05' || s === '\x1b[F' || s === '\x1b[4~') state.cursor = graphemes(state.input).length;
    else if (s === '\x15') { state.input = graphemes(state.input).slice(state.cursor).join(''); state.cursor = 0; }
    else if (s === '\x0b') state.input = graphemes(state.input).slice(0, state.cursor).join('');
    else if (s === '\x1b[A' || s === '\x1b[B') { historyIndex = Math.max(0, Math.min(history.length, historyIndex + (s.endsWith('A') ? -1 : 1))); state.input = history[historyIndex] ?? ''; state.cursor = graphemes(state.input).length; }
    else if (s === '\x1b[5~') state.scroll += Math.max(3, (stdout.rows || 30) - 12);
    else if (s === '\x1b[6~') state.scroll = Math.max(0, state.scroll - Math.max(3, (stdout.rows || 30) - 12));
    else if (s === '\t') { const matches = COMMANDS.filter(c => c.startsWith(state.input)); if (matches.length === 1) { state.input = matches[0]!; state.cursor = state.input.length; } }
    else if (s === '\x1b') { state.panel = ''; state.scroll = 0; }
    else if (!/[\x00-\x1f\x7f]/.test(s)) insert(s);
    requestRender();
  };
  const onData = (chunk: string) => {
    if (escapeTimer) { clearTimeout(escapeTimer); escapeTimer = undefined; }
    escapeBuffer += chunk;
    while (escapeBuffer) {
      if (paste) {
        const end = escapeBuffer.indexOf('\x1b[201~');
        if (end < 0) { if (escapeBuffer.length > 6) { pasteText += escapeBuffer.slice(0, -6); escapeBuffer = escapeBuffer.slice(-6); } if (pasteText.length > 40_000) pasteText = pasteText.slice(0, 40_000); break; }
        pasteText += escapeBuffer.slice(0, end); escapeBuffer = escapeBuffer.slice(end + 6); paste = false;
        insert(pasteText.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')); pasteText = ''; requestRender(); continue;
      }
      if (escapeBuffer.startsWith('\x1b[200~')) { escapeBuffer = escapeBuffer.slice(6); paste = true; continue; }
      if (escapeBuffer === '\x1b') {
        escapeTimer = setTimeout(() => { if (escapeBuffer === '\x1b') { escapeBuffer = ''; key('\x1b'); } }, 40); break;
      }
      if (escapeBuffer.startsWith('\x1b[')) {
        const sequence = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(escapeBuffer);
        if (!sequence) { if (escapeBuffer.length > 32) escapeBuffer = ''; break; }
        key(sequence[0]); escapeBuffer = escapeBuffer.slice(sequence[0].length); continue;
      }
      const first = [...escapeBuffer][0]!; escapeBuffer = escapeBuffer.slice(first.length); key(first);
    }
  };
  const resize = () => { previous = []; write('\x1b[2J'); requestRender(); };
  const signalExit = () => { void actions.command('/exit', '').then(quit, quit); };
  process.once('SIGTERM', signalExit); process.once('SIGHUP', signalExit);
  stdin.setEncoding('utf8'); stdin.setRawMode(true); stdin.resume(); stdin.on('data', onData); stdout.on('resize', resize);
  write('\x1b[?1049h\x1b[?2004h\x1b[2J'); redraw();
  try { await done; }
  finally {
    process.removeListener('SIGTERM', signalExit); process.removeListener('SIGHUP', signalExit);
    finished = true; if (escapeTimer) clearTimeout(escapeTimer); if (redrawTimer) clearTimeout(redrawTimer); stdin.removeListener('data', onData); stdout.removeListener('resize', resize); stdin.setRawMode(false); stdin.pause();
    write('\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1049l');
    if (view?.run) write(`jvo ${view.run.id} · ${view.run.status}\n再開: jvo resume ${view.run.id}\n`);
  }
}
