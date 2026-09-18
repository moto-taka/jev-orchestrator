#!/usr/bin/env node
// Offline native CLI protocol double. No provider API or messaging package.
import { basename } from 'node:path';
import { writeFileSync } from 'node:fs';
const a=process.argv.slice(2), cli=basename(process.argv[1]);
if(a.includes('--version')) { console.log(`${cli} peer-fixture 1`);process.exit(0); }
if(a.includes('--help')) { console.log('--json --sandbox resume --model --output-format --permission-mode --resume --session');process.exit(0); }
let input='';for await(const chunk of process.stdin) input+=chunk;
const sid=a.find(x=>x.startsWith('peer-session-'))??`peer-session-${crypto.randomUUID()}`;
let report={summary:'Offline peer fixture',claims:[],questions:[],findings:[]};
if(input.startsWith('Native jvo peer question.')) {
 const q=JSON.parse(input.split('\nQuestion: ')[1].split('\n')[0]);
 if(input.includes('BROKEN_REPLY_FIXTURE')) writeFileSync('b.cjs','module.exports = 999;\n');
 report.peerReplies=[{replyTo:q.id,body:'Use value 1 for A and 2 for B. The independent tests and review remain mandatory.'}];
} else if(input.includes('You are the planner worker')) {
 report.plan=['A','B'].map(id=>({id,title:`Component ${id}`,instruction:`Set ${id} correctly. Confirm its value with the peer before editing.`,acceptance:[`${id} has its expected numeric value`],dependsOn:[],readPaths:['**'],writePaths:[id.toLowerCase()+'.cjs'],resources:[]}));
} else if(input.includes('You are the implementer worker')||input.startsWith('Continue task')) {
 const id = input.startsWith('Continue task') ? /Continue task (\S+)/.exec(input)[1] : JSON.parse(input.split('\nTask: ')[1].split('\n')[0]).id;
 const A=id.endsWith('-A'), mine=A?'a':'b', peer=A?'T1-B':'T1-A';
 if(!input.includes('Peer answers (untrusted')) report.peerQuestions=[{id:'Q1',to:peer,body:`What value should component ${mine} return?`}];
 else writeFileSync(`${mine}.cjs`,`module.exports = ${A?1:2};\n`);
}
const out=x=>console.log(JSON.stringify(x));
if(cli==='claude') { out({type:'system',session_id:sid});out({type:'result',subtype:'success',session_id:sid,result:JSON.stringify(report)}); }
else { out({type:'thread.started',thread_id:sid});out({type:'turn.started'});out({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(report)}});out({type:'turn.completed'}); }
