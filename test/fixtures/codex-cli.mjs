#!/usr/bin/env node
// Protocol fixture only. Not a real model, never used by production discovery automatically.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex fixture 1.0.0'); process.exit(0); }
if (args.includes('--help')) { console.log('exec resume --json --sandbox --model'); process.exit(0); }
let prompt = ''; for await (const data of process.stdin) prompt += data;
const writer = args.includes('sandbox_mode="workspace-write"');
const resume = args.includes('resume');
const session = resume ? args.at(-2) : `fixture-${randomUUID()}`;
const emit = value => console.log(JSON.stringify(value));
emit({ type: 'thread.started', thread_id: session }); emit({ type: 'turn.started' });
if (writer) {
  const correct = resume || readFileSync('calc.cjs', 'utf8').includes('fixture first');
  writeFileSync('calc.cjs', correct ? 'exports.add = (a, b) => a + b;\n' : 'exports.add = (a, b) => a - b; // fixture first\n');
}
const good = readFileSync('calc.cjs', 'utf8').includes('a + b');
const report = { summary: good ? 'Fixture observed correct addition.' : 'Fixture observed subtraction.', claims: [], questions: [], findings: !writer && !good ? [{ id: 'F1', requirement: 'Addition', severity: 'blocker', evidence: 'a-b', reproduce: 'node check.cjs', status: 'open' }] : [] };
emit({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(report) } });
emit({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: resume ? 80 : 0, output_tokens: 10 } });
