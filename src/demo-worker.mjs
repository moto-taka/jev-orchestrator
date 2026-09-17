// Deliberately scripted demo/test worker. Never selected by production profiles.
import { readFileSync, writeFileSync } from 'node:fs';
const [role, attempt, session] = process.argv.slice(2);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
emit({ type: 'thread.started', thread_id: session });
if (role === 'implementer') {
  emit({ type: 'item.started', item: { type: 'command_execution', command: 'Inspect calc.cjs (demo)' } });
  // First attempt remains wrong on purpose, demonstrating measured failure and same-session rework.
  writeFileSync('calc.cjs', Number(attempt) > 1 ? 'exports.add = (a, b) => a + b;\n' : 'exports.add = (a, b) => a - b; // first demo attempt\n');
}
const good = readFileSync('calc.cjs', 'utf8').includes('a + b');
const report = { summary: role === 'implementer' ? '加算関数を修正しました。実測テストと独立レビューで確認してください。' : good ? '固定snapshotで加算の実装と検証結果を確認しました。' : '加算関数が減算を行っています。修正が必要です。',
  claims: [good ? '加算実装を確認' : '減算実装を確認'], questions: [], findings: role === 'reviewer' && !good ? [{ id: 'F1', requirement: 'add(2,3) must return 5', severity: 'blocker', evidence: 'calc.cjs uses a - b; measured assertion fails', reproduce: 'node check.cjs', status: 'open' }] : [] };
emit({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(report) } });
emit({ type: 'turn.completed' });
