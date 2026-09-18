import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseReports, triageReports, attentionBatches } from '../src/report-triage.ts';
import { triageCommand } from '../src/triage-command.ts';
import { defaults } from '../src/config.ts';
import { SecretGuard } from '../src/security.ts';
import type { DecisionProvider, Evaluation, Json, Question } from '../src/types.ts';
function provider(value=0.999):DecisionProvider {return {identity:'fixture',async evaluate(_s:Json,q:Record<string,Question>):Promise<Evaluation>{return {provider:'typesafe',requestedModel:'fixture',answers:Object.fromEntries(Object.keys(q).map(k=>[k,{kind:'boolean',probability:value}])),usage:{inputTotal:20,outputTotal:0,basis:'provider-reported'}};}};}
const six=parseReports([
 {id:'p1',text:'ファイル3つを編集しました。次はテストです。'},
 {id:'p2',text:'入力文字列を受け付けました。'},
 {id:'q',kind:'question',text:'AとBのどちらにしますか'},
 {id:'b',kind:'blocked',text:'検証に失敗しました'},
 {id:'c',kind:'completed',text:'作業が完了しました'},
 {id:'s',kind:'scope-change',text:'依頼にない仕様変更が必要です'}]);
test('batch gate preserves all six originals, forwards four explicit events and batches two ambiguous reports into one Jev request',async()=>{
 const result=await triageReports(six,{provider:provider()});assert.equal(result.jevCalls,1);assert.equal(result.archive.length,6);assert.equal(result.attention.length,4);
 assert.deepEqual(result.archive.map(r=>r.text),six.map(r=>r.text));assert.equal(attentionBatches(result).length,1);
 const prompt=JSON.stringify(attentionBatches(result));assert(!prompt.includes(six[0]!.text));assert(prompt.includes(six[2]!.text));
});
test('uncertain, unreadable, missing or errored classification always keeps the report visible',async()=>{
 for(const p of [provider(0.7),provider(NaN),{identity:'missing',evaluate:async()=>({...await provider().evaluate({},{}),answers:{}})}, {identity:'offline',evaluate:async()=>{throw new Error('provider unavailable');}}]) {
  const r=await triageReports(six,{provider:p});assert.equal(r.attention.length,6);assert.equal(r.archive.length,6);
 }
});
test('routine labels cannot hide completion, failures, permissions or questions; no Jev needed for those',async()=>{
 const reports=parseReports(['完了','テスト失敗','May I deploy?','権限変更を承認してください'].map((text,i)=>({id:String(i),kind:'progress',text})));
 const r=await triageReports(reports,{provider:provider()});assert.equal(r.jevCalls,0);assert.equal(r.attention.length,4);
});
test('rules-only is conservative and only empty heartbeats are automatically archived',async()=>{
 const r=await triageReports([...six,{id:'h',kind:'heartbeat',text:''}]);assert.equal(r.jevCalls,0);assert.equal(r.attention.length,6);assert.equal(r.archive.length,7);
});
test('secret-bearing reports are local-only and excluded from Jev and operator payloads',async()=>{
 let sent='';const base=provider(),p={...base,evaluate:async(s:Json,q:Record<string,Question>)=>{sent+=JSON.stringify(s);return base.evaluate(s,q);}};
 const r=await triageReports(parseReports([{id:'s',text:'sensitive-value-123'},{id:'p',text:'editing local files'}]),{provider:p,guard:new SecretGuard(['sensitive-value-123'])});
 assert.equal(r.localOnly.length,1);assert(!sent.includes('sensitive-value-123'));assert(!JSON.stringify(attentionBatches(r)).includes('sensitive-value-123'));assert(r.archive[0]!.text.includes('[REDACTED]'));
});
test('budgets, cancellation and input boundaries cannot silently discard reports',async()=>{
 const r=await triageReports(six,{provider:provider(),maxCalls:0});assert.equal(r.jevCalls,0);assert.equal(r.attention.length,6);
 const abort=new AbortController();abort.abort();await assert.rejects(()=>triageReports(six,{provider:provider(),signal:abort.signal}));
 assert.throws(()=>parseReports([{id:'x',text:'a'},{id:'x',text:'b'}]),/unique/);
 await assert.rejects(()=>triageReports(six,{routineThreshold:0.5}),/threshold/);
});
test('optional operator reads only bounded attention batches and never receives execution authority',async()=>{
 const root=mkdtempSync(join(tmpdir(),'jvo-triage-')),input=join(root,'reports.json'),saved=process.env.JVO_HOME;process.env.JVO_HOME=join(root,'state');
 const config=defaults();config.profiles=[{id:'allowed-operator',adapter:'codex',binary:process.execPath,version:'fixture',roles:['explainer'],enabled:true,level:'trusted-local',capabilityHash:'test',maxTurns:2,timeoutMs:10000}];
 writeFileSync(input,JSON.stringify([{id:'h',kind:'heartbeat',text:''},{id:'important',kind:'question',text:'Choose A or B?'}]));let calls=0,prompt='';
 try{
  const result=await triageCommand(input,config,{allowApi:false,allowWorker:true,operator:'allowed-operator',adapter:{run:async i=>{calls++;prompt=i.prompt;assert.equal(i.role,'explainer');return {status:'reported',sessionId:'operator-session',text:'advice',report:{summary:'Please confirm the intended behavior.',claims:[],questions:[]},usage:[]};}}}) as any;
  assert.equal(calls,1);assert.equal(result.jevCalls,0);assert.equal(result.archive.length,2);assert(prompt.includes('not an executor or approver'));assert(!prompt.includes('empty-heartbeat'));
  assert(JSON.parse(readFileSync(join(result.archiveDirectory,'result.json'),'utf8')).replies.length===1);
  assert.equal(JSON.parse(readFileSync(join(result.archiveDirectory,'intake.json'),'utf8')).length,2);
  await assert.rejects(()=>triageCommand(input,config,{allowApi:false,allowWorker:false,operator:'allowed-operator'}),/explicitly/);
 }finally{if(saved===undefined)delete process.env.JVO_HOME;else process.env.JVO_HOME=saved;}
});
