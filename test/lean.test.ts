import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from '../src/engine.ts';
import { createDemo, DemoProvider } from '../src/demo.ts';
import { hash, json, canonical } from '../src/util.ts';
import { git } from '../src/workspaces.ts';
import type { Candidate, Decision, Operation, Question, Json, Evaluation } from '../src/types.ts';

test('identical-success comparison: 9 legacy requests versus 3 lean requests, without dropping tests or independent review', {timeout:60000}, async () => {
  const counts: number[] = [];
  for (const lean of [false, true]) {
    const f = await createDemo();
    try {
      if (!lean) f.store.updateRun(f.engine.runId, { controlVersion: undefined });
      f.adapter.attempts.set(f.engine.tasks[0]!.id, 1);
      await f.engine.drive(); assert.equal(f.engine.run.status, 'ready_for_user_apply', f.engine.run.blockReason);
      counts.push(f.engine.run.decisionCalls);
      if (lean) {
        assert.equal(f.engine.tasks.length, 1);
        assert.equal(f.adapter.invocations.filter(i => i.role === 'reviewer').length, 1);
        const task = f.engine.tasks[0]!; assert.equal(f.engine.run.finalSnapshot, task.snapshot);
        assert.equal(f.store.events(f.engine.runId,10000).filter(e=>e.kind==='proof.reused').length,1);
        const ops = f.store.all<Operation>('outbox',f.engine.runId);
        assert(ops.some(o=>o.policy?.rule==='task.final-verify'),'Do not assume external test conditions stayed constant');
        assert(ops.filter(o=>o.candidate.kind==='ACCEPT_TASK').every(o=>o.policy?.rule==='task.accept-verdict'));
        assert(!f.store.all<Decision>('decisions',f.engine.runId).some(d=>d.provider==='runtime'), 'Runtime must not forge a model evaluation');
      }
    } finally { f.store.close(); }
  }
  assert.deepEqual(counts,[9,3]);
});

test('ambiguous model preference does not block a clear action; Jev still selects an allowed model', {timeout:30000}, async () => {
  const f = await createDemo(), base = new DemoProvider();
  const config = f.engine.run.config; config.profiles = Array.from({length:8}, (_,n)=>({...config.profiles[0]!,id:`model-${n}`,model:`allowed-${n}`}));
  f.store.updateRun(f.engine.runId,{config});
  const provider = { identity:'tied-model-fixture', async evaluate(s:Json,qs:Record<string,Question>):Promise<Evaluation> {
    const result = await base.evaluate(s,qs);
    for (const [key,q] of Object.entries(qs)) if (key.startsWith('model_') && q.type==='choice') {
      const ids=Object.keys(q.criteria); result.answers[key]={kind:'choice',selected:ids.at(-1)!,confidence:0,probabilities:Object.fromEntries(ids.map(id=>[id,1/ids.length]))};
    }
    if(qs.action?.type==='choice') assert(Object.keys(qs.action.criteria).length<=10,'Actions must not multiply with models');
    return result;
  }};
  const e=new Engine(f.store,f.engine.runId,provider,{adapter:f.adapter});
  try {await e.drive();assert.equal(e.run.status,'ready_for_user_apply',e.run.blockReason);assert.equal(e.tasks[0]!.profileId,'model-7');} finally {f.store.close();}
});

test('verdict input and exact memo survive unrelated usage counters but not new evidence', async () => {
  const f=await createDemo();try {
    const t=f.engine.tasks[0]!, internal=f.engine as any;
    const before=internal.state(t,'verdict'); f.store.updateRun(f.engine.runId,{decisionCalls:17,workerStarts:12});
    assert.equal(canonical(before),canonical(internal.state(t,'verdict')));
    assert.equal((before as any).profiles,undefined);
    const qs={evidence:{type:'boolean' as const,instructions:'Is the evidence adequate?'}};
    await internal.evaluate(t,before,qs,new AbortController().signal); const calls=f.engine.run.decisionCalls;
    await internal.evaluate(t,internal.state(t,'verdict'),qs,new AbortController().signal);assert.equal(f.engine.run.decisionCalls,calls);
    await internal.evaluate(t,json({...before,evidence:'changed'}),qs,new AbortController().signal);assert.equal(f.engine.run.decisionCalls,calls+1);
  }finally{f.store.close();}
});

test('runtime policy rechecks scope before execution; pending consequence is not silently re-authorized', {timeout:30000}, async () => {
  const f=await createDemo();try {
    f.adapter.attempts.set(f.engine.tasks[0]!.id,1);
    const internal=f.engine as any, execute=internal.executeOperation.bind(internal);let altered=false;
    internal.executeOperation=async(op:Operation,signal:AbortSignal)=>{
      if(op.policy?.rule==='task.stage'&&!altered){altered=true;f.store.updateRun(f.engine.runId,{scopeVersion:f.engine.run.scopeVersion+1,status:'paused'});return;}
      return execute(op,signal);
    };
    await f.engine.drive();assert(altered);
    const pending=f.store.all<Operation>('outbox',f.engine.runId).find(o=>o.policy?.rule==='task.stage')!;
    f.store.updateRun(f.engine.runId,{status:'running'});
    await execute(pending,new AbortController().signal);
    assert.equal(f.store.get<Operation>('outbox',pending.id)!.state,'failed');assert.notEqual(f.engine.run.status,'ready_for_user_apply');
  }finally{f.store.close();}
});

test('exact duplicate findings are grouped locally without losing original evidence or asking Jev', async()=>{
 const f=await createDemo();try{
  const t=f.engine.tasks[0]!,finding={id:'a',requirement:'same',snapshot:f.engine.run.base,severity:'warning' as const,evidence:'same evidence',reproduce:'same',status:'open' as const,sources:['a']};
  f.store.updateTask(t.id,{findings:[finding,{...finding,id:'b',sources:['b']},{...finding,id:'c',evidence:'different concern'}]});
  const before=f.engine.run.decisionCalls;await (f.engine as any).deduplicateFindings(t.id,new AbortController().signal);
  const fs=f.store.task(t.id).findings;assert.equal(fs.length,3);assert.equal(fs[1]!.duplicateOf,'a');assert.equal(fs[2]!.duplicateOf,undefined);assert.equal(f.engine.run.decisionCalls,before);
 }finally{f.store.close();}
});

test('changed test environment prevents final approval even for exactly the same code commit', {timeout:30000},async()=>{
 const f=await createDemo();try{
  f.adapter.attempts.set(f.engine.tasks[0]!.id,1);
  const flag=join(f.root,'external-check-marker');const run=f.engine.run,config=run.config;config.runtime.maxRepairs=1;
  const trust={...run.trust,tests:[{argv:[process.execPath,'-e',`const fs=require('fs');if(fs.existsSync(${JSON.stringify(flag)}))process.exit(1);fs.writeFileSync(${JSON.stringify(flag)},'changed external state')`],timeoutMs:10000}]};
  f.store.updateRun(run.id,{config,trust});
  await f.engine.drive();assert.notEqual(f.engine.run.status,'ready_for_user_apply');
  assert(f.store.all<Operation>('outbox',run.id).some(o=>o.policy?.rule==='task.final-verify'));
 }finally{f.store.close();}
});
