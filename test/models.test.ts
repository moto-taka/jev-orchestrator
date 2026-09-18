import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverModels, parsePiModels, parsePiTable, parseCodexModels, modelOption, scopedProfiles, matchesScope } from '../src/models/catalog.ts';
import { PickerState } from '../src/models/picker.ts';
import { Prompter, setupModels } from '../src/setup.ts';
import { defaults } from '../src/config.ts';
import { invocationCommand } from '../src/adapters/native.ts';
import type { AdapterId, Capabilities, Config, Invocation } from '../src/types.ts';
import type { ModelOption } from '../src/models/catalog.ts';
const capability = (adapter: AdapterId, binary = '/approved/cli'): Capabilities => ({ adapter, binary, version:'fixture1', auth:'unverified', structuredEvents:true, resumeById:true, modelSelection:true, modelIdentityObservable:true, structuredFinalReport:true, usageTelemetry:'tokens-and-cache', delegationControl:true, executionPolicyControl:true, isolation:'workspace-only', level:'trusted-local', helpHash:'approved', note:'fixture', projectTrustControl:adapter === 'pi' });
test('catalog metadata channels enumerate per-CLI models without sending any generation request', async () => {
  const dir = mkdtempSync(join(tmpdir(),'jvo-catalog-test-'));
  for (const adapter of ['codex','claude','pi','opencode'] as const) {
    const binary = join(dir, adapter); copyFileSync(fileURLToPath(new URL('./fixtures/model-catalog.mjs', import.meta.url)),binary); chmodSync(binary,0o700);
    const result = await discoverModels(capability(adapter,binary),{timeoutMs:2000,globalPiProviders:adapter === 'pi'});
    assert.equal(result.warnings.length,0, result.warnings.join()); assert.equal(result.models.length, adapter === 'pi' ? 3:2);
    if (adapter === 'codex') assert(result.models.every(m=>m.provider === 'configured-route'));
    if (adapter === 'pi') assert.equal(new Set(result.models.map(m=>m.id)).size,3);
    if (adapter === 'claude') assert(!result.models.some(m=>m.model==='opusplan'));
  }
});
test('Pi provider identity is preserved even when two registrations expose the same model ID', () => {
  const options = parsePiModels([{provider:'p1',id:'same'},{provider:'p2',id:'same'}]);
  const profiles = scopedProfiles(capability('pi'), options, [], true);
  assert.equal(profiles.length,2); assert.notEqual(profiles[0]!.id,profiles[1]!.id);
  for (const p of profiles) { assert.equal(p.tier,undefined); assert.deepEqual(p.roles,['scout','planner','implementer','reviewer','explainer']);
    const i = {profile:p,role:'implementer',sessionDir:mkdtempSync(join(tmpdir(),'jvo-catalog-session-')),prompt:'test'} as Invocation;
    const command = invocationCommand(i); assert(command.argv.includes(p.provider!)); assert(command.argv.includes('--no-approve')); assert(!command.argv.includes('--no-extensions'));
  }
});
test('picker preserves hidden checked models while filtering and toggles only visible models', () => {
  const ms = ['alpha','beta','gamma'].map(id=>modelOption('codex',id)), s = new PickerState(ms);
  s.toggle(); s.filter='beta'; s.toggle(); assert.equal(s.result().length,2); s.toggleVisible(); assert.deepEqual(s.result().map(m=>m.model),['alpha']);
  s.filter='not found'; s.toggle(); assert.equal(s.result().length,1); s.filter=''; s.move(999); assert.equal(s.cursor,2);
});
test('Pi text-list fallback and existing scoped models are parsed without dropping custom providers', () => {
  const models = parsePiTable('notice\nprovider  model  context  max-out  thinking  images\ncustom  m-one  128K  8K  yes  no\nother  m-two  1.5M  32K  no  yes\n');
  assert.equal(models.length,2); assert.equal(models[1]!.contextWindow,1_500_000);
  assert(matchesScope(models[0]!,['custom/*:high'])); assert(!matchesScope(models[1]!,['custom/*']));
});
class SelectPrompt extends Prompter {
  questions:string[]=[]; cancelled=false;
  override async ask(q:string, fallback='') { this.questions.push(q); return fallback; }
  override async yes() { return true; }
  override async secret():Promise<string> { throw Error('Model-only setup must never ask for API keys'); }
  override async models(_title:string, models:ModelOption[]) { if(this.cancelled)throw Error('cancel'); return models; }
}
test('model-only setup saves all selected models with all roles and never asks for a tier or secret', async () => {
  const config = defaults(); config.decision.model='keep-decision-model'; const prompts = new SelectPrompt(); let saved:Config|undefined;
  const result = await setupModels(config,prompts,{detect:async()=>[capability('codex'),capability('pi')],discover:async cap=>({models:[modelOption(cap.adapter,'one',cap.adapter==='pi'?'route-a':undefined),modelOption(cap.adapter,'two',cap.adapter==='pi'?'route-b':undefined)],warnings:[]}),save:c=>{saved=c;}});
  assert.equal(saved?.profiles.length,4); assert.equal(result.decision.model,'keep-decision-model'); assert(config.profiles.length===0,'input config mutated');
  assert(result.profiles.every(p=>p.tier===undefined&&p.roles.length===5)); assert(!prompts.questions.some(q=>q.includes('用途')||q.includes('モデルID'))); assert(result.messaging?.enabled);
});
test('cancelled model selection does not overwrite existing configuration', async () => {
  const config=defaults(), prompts=new SelectPrompt(); prompts.cancelled=true; let saved=false;
  await assert.rejects(()=>setupModels(config,prompts,{detect:async()=>[capability('pi')],discover:async()=>({models:[modelOption('pi','one','p')],warnings:[]}),save:()=>{saved=true;}}),/cancel/);
  assert.equal(saved,false); assert.deepEqual(config.profiles,[]);
});


test('model catalogs preserve only supported reasoning effort choices', () => {
  const pi = parsePiModels([{
    provider: 'p', id: 'reasoner', reasoning: true,
    thinkingLevelMap: { high: null, xhigh: 24576 }
  }])[0]!;
  assert.deepEqual(pi.efforts, ['off','minimal','low','medium','xhigh']);
  const plain = parsePiModels([{ provider: 'p', id: 'plain', reasoning: false }])[0]!;
  assert.deepEqual(plain.efforts, ['off']);

  const codex = parseCodexModels([{
    id: 'm', model: 'gpt-fixture',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'unsupported' }]
  }])[0]!;
  assert.deepEqual(codex.efforts, ['low','high']);
});
