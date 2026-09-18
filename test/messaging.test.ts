import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, copyFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createDemo, DemoProvider } from '../src/demo.ts';
import { Engine, makeTask } from '../src/engine.ts';
import { NativeAdapter } from '../src/adapters/native.ts';
import { detectOne, profileFrom } from '../src/adapters/registry.ts';
import { Mailbox, parsePeerQuestions } from '../src/messaging/mailbox.ts';
import { SecretGuard } from '../src/security.ts';
import { git } from '../src/workspaces.ts';
import { renderScreen } from '../src/tui/screen.ts';
import type { Candidate, Json, Question, Decision, Operation } from '../src/types.ts';
class PeerProvider extends DemoProvider {
 override async evaluate(state:Json, questions:Record<string,Question>) {
  const r=await super.evaluate(state,questions),s=state as Record<string,any>,cs=(s.candidates??[]) as Candidate[];
  if(questions.action?.type==='choice') {
   const action = s.task.id==='T1'&&s.phase==='assess'?'REQUEST_PLAN': ['DELIVER_MESSAGE','ANSWER_PEER','CONTINUE_AFTER_PEER'].find(k=>cs.some(c=>c.kind===k));
   let chosen=cs.find(c=>c.kind===action);
   if(!chosen) { const a=r.answers.action; if(a?.kind==='choice') chosen=cs.find(c=>c.id===a.selected); }
   if(chosen?.profileId) {
    const key='assignment_'+chosen.kind, q=questions[key];
    if(q?.type==='choice') {
      const profile=s.task.id.endsWith('-B')?'claude-pool':'codex-pool';
      const selected=cs.find(c=>c.kind===chosen!.kind&&c.profileId===profile)?.id ?? Object.keys(q.criteria)[0]!;
      r.answers[key]={kind:'choice',selected,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(id=>[id,id===selected?1:0]))};
    }
   }
   if(chosen) r.answers.action={kind:'choice',selected:chosen.id,probabilities:Object.fromEntries(cs.map(c=>[c.id,c.id===chosen!.id?1:0])),confidence:1};
  }
  return r;
 }
}
async function fixture(parallel:number) {
 const f=await createDemo(),run=f.engine.run,dir=mkdtempSync(join(tmpdir(),'jvo-peer-cli-'));
 const config=run.config;config.runtime.maxParallel=parallel;config.runtime.maxDecisions=300;
 const profiles=[];
 for(const name of ['codex','claude'] as const) { const path=join(dir,name);copyFileSync(fileURLToPath(new URL('./fixtures/peer-cli.mjs',import.meta.url)),path);chmodSync(path,0o700);const cap=await detectOne(name,path);assert(cap);const p=profileFrom(cap);p.id=name+'-pool';p.model=name==='codex'?'allowed-one':'allowed-two';profiles.push(p); }
 config.profiles=profiles;
 for(const letter of ['a','b']) writeFileSync(join(run.integration,letter+'.cjs'),'module.exports = 0;\n');
 writeFileSync(join(run.integration,'check.cjs'),"const a=require('./a.cjs'),b=require('./b.cjs'); if(typeof a!=='number'||typeof b!=='number') process.exit(1);\n");
 await git(run.integration,['add','.']);await git(run.integration,['commit','-m','Peer test baseline']);const base=await git(run.integration,['rev-parse','HEAD']);
 f.store.updateRun(run.id,{base,integrationHead:base,config}); const engine=new Engine(f.store,run.id,new PeerProvider(),{adapter:new NativeAdapter()});return {...f,engine};
}
for(const parallel of [1,3]) test(`native codex/claude protocol peers ask each other and resume original sessions (slots=${parallel})`,{timeout:30000},async()=>{
 const f=await fixture(parallel);
 try { await f.engine.drive();assert.equal(f.engine.run.status,'ready_for_user_apply',f.engine.run.blockReason);
  const ms=f.engine.mailbox.all();assert.equal(ms.length,4);assert(ms.every(m=>m.status==='closed'));
  for(const t of f.engine.tasks.filter(t=>t.spec.id==='T1-A'||t.spec.id==='T1-B')) {
   assert.equal(t.attempts,1,'A peer continuation is not a repair retry');assert.equal(t.peerTurns,1);assert(t.reviewCount>=1 && t.testsPassed);
   const attempts=f.store.all<any>('attempts',f.engine.runId).filter(a=>a.invocation.taskId===t.id&&a.invocation.role==='implementer');assert.equal(attempts.length,2);
   assert.equal(attempts[1].invocation.resume,attempts[0].result.sessionId);assert.equal(attempts[1].invocation.cwd,attempts[0].invocation.cwd);assert.equal(attempts[1].invocation.profileId,attempts[0].invocation.profileId);
  }
  const ds=f.store.all<Decision>('decisions',f.engine.runId).filter(d=>d.selected?.kind==='DELIVER_MESSAGE');assert.equal(ds.length,0,'Routine questions and replies must not call Jev');
  assert.equal(f.store.all<Operation>('outbox',f.engine.runId).filter(o=>o.policy?.rule==='peer.deliver').length,4);
  assert.equal(readFileSync(join(f.engine.run.integration,'a.cjs'),'utf8'),'module.exports = 1;\n');assert.equal(readFileSync(join(f.engine.run.integration,'b.cjs'),'utf8'),'module.exports = 2;\n');
  assert(f.store.verifyJournal(f.engine.runId));
  const screen=renderScreen(f.engine.view(),{input:'',cursor:0,panel:'/messages',scroll:0},120,40).lines.join('\n');assert(screen.includes('質問')&&screen.includes('返答'));
 }finally{f.store.close();}
});
test('mailbox rejects sender spoofing, other-run recipient, duplicates with changed content, secrets and expired or stale scope',async()=>{
 const f=await createDemo();try{
  const run=f.engine.run,t=f.engine.tasks[0]!;f.store.updateTask(t.id,{snapshot:run.base});
  const peer=makeTask(run,{...t.spec,id:'PEER'});f.store.put('tasks',peer.id,run.id,peer);
  const box=new Mailbox(f.store,run.id,new SecretGuard(['secret-value-for-test']));const sender=f.store.task(t.id);
  assert.throws(()=>parsePeerQuestions([{id:'q',to:'PEER',body:'test',from:'fake'}]),/sender/);
  const q={summary:'query',claims:[],questions:[],peerQuestions:[{id:'q',to:'PEER',body:'actual question'}]};
  const first=box.propose(sender,'invocation',run.base,q)[0]!;assert.equal(box.propose(sender,'invocation',run.base,q)[0]!.id,first.id);assert.equal(box.all().length,1);
  assert.throws(()=>box.propose(sender,'invocation',run.base,{...q,peerQuestions:[{id:'q',to:'PEER',body:'different'}]}),/different/);
  assert.throws(()=>box.propose(sender,'other',run.base,{...q,peerQuestions:[{id:'q',to:'other-run',body:'question'}]}),/roster/);
  assert.throws(()=>box.propose(sender,'secret',run.base,{...q,peerQuestions:[{id:'q',to:'PEER',body:'secret-value-for-test'}]}),/secret|credential/i);
  assert.throws(()=>box.assertFresh({...first,expiresAt:'2000-01-01'}),/expired/);
  f.store.updateRun(run.id,{pendingMessage:'changed requirements'});assert.throws(()=>box.assertFresh(first),/scope/);
 }finally{f.store.close();}
});
test('partial replies do not resume an implementation or occupy a runnable slot',async()=>{
 const f=await createDemo();try{const run=f.engine.run,sender=f.store.updateTask(f.engine.tasks[0]!.id,{snapshot:run.base});
  for(const id of ['B','C']) {const p=makeTask(run,{...sender.spec,id});f.store.put('tasks',p.id,run.id,p);}
  const box=f.engine.mailbox,report={summary:'q',claims:[],questions:[],peerQuestions:[{id:'b',to:'B',body:'B?'},{id:'c',to:'C',body:'C?'}]};
  const qs=box.propose(sender,'two-questions',run.base,report);for(const q of qs)box.update(q.id,{status:'queued'});
  const b=f.engine.tasks.find(t=>t.spec.id==='B')!,a=box.reply(qs[0]!,b,'reply1','model',{replyTo:qs[0]!.id,body:'B answer'});box.update(a.id,{status:'queued'});
  assert.equal(box.readyAnswers(sender).length,0);assert.equal(box.actionable(sender),false);
 }finally{f.store.close();}
});
test('pausing without changing scope retains pending messages; changing requirements retires them',async()=>{
 const f=await createDemo();try{const run=f.engine.run,s=f.store.updateTask(f.engine.tasks[0]!.id,{snapshot:run.base});const p=makeTask(run,{...s.spec,id:'P'});f.store.put('tasks',p.id,run.id,p);
  const m=f.engine.mailbox.propose(s,'pause',run.base,{summary:'q',claims:[],questions:[],peerQuestions:[{id:'q',to:'P',body:'Question?'}]})[0]!;
  await f.engine.pause();await f.engine.resume();assert.doesNotThrow(()=>f.engine.mailbox.assertFresh(m));
  await f.engine.pause();await f.engine.resume('new requirement');assert.equal(f.engine.mailbox.get(m.id).status,'rejected');
 }finally{f.store.close();}
});
test('read-only answering cannot modify its peer worktree or create an admissible reply', {timeout:20000},async()=>{
 const f=await fixture(1);try{
  const base=new NativeAdapter();const engine=new Engine(f.store,f.engine.runId,new PeerProvider(),{adapter:{run:async i=>base.run({...i,prompt:i.role==='explainer'?i.prompt+'\nBROKEN_REPLY_FIXTURE':i.prompt})}});
  await engine.drive();assert.equal(engine.run.status,'blocked');assert.match(engine.run.blockReason??'',/read-only/);assert(engine.mailbox.all().some(m=>m.status==='unknown'));
  assert(!engine.mailbox.all().some(m=>m.kind==='answer'));assert(f.store.all<Operation>('outbox',engine.runId).some(o=>o.state==='unknown'));
  await engine.recover(true);assert(!engine.mailbox.all().some(m=>m.status==='unknown'),'Explicit recovery must retire uncertain deliveries, not resend them');
 }finally{f.store.close();}
});
test('legacy strict run retains its originally approved delivery policy', {timeout:20000},async()=>{
 const f=await fixture(1);try{
  f.store.updateRun(f.engine.runId,{controlVersion:undefined});
  const delegate=new PeerProvider();const provider={identity:'reject-peer-fixture',evaluate:async(s:Json,qs:Record<string,Question>)=>{const result=await delegate.evaluate(s,qs);const cs=(s as any).candidates as Candidate[]|undefined;const reject=cs?.find(c=>c.kind==='REJECT_MESSAGE');if(reject)result.answers.action={kind:'choice',selected:reject.id,confidence:1,probabilities:Object.fromEntries(cs!.map(c=>[c.id,c.id===reject.id?1:0]))};return result;}};
  const engine=new Engine(f.store,f.engine.runId,provider,{adapter:new NativeAdapter()});await engine.drive();assert.equal(engine.run.status,'blocked');assert.match(engine.run.blockReason??'',/rejected/);assert(engine.mailbox.all().every(m=>m.status==='rejected'));assert(!engine.tasks.filter(t=>t.spec.id!=='T1').some(t=>t.staged));
 }finally{f.store.close();}
});
