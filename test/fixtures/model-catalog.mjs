#!/usr/bin/env node
// Metadata-only CLI doubles. Receiving a generation prompt is a test failure.
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
const cli = basename(process.argv[1]), args = process.argv.slice(2);
if (cli === 'opencode') { if (args.join(' ') !== 'models') process.exit(7); console.log('openai/model-a\ncustom/model-b'); process.exit(0); }
if (cli === 'pi') { if (!args.includes('rpc') || !args.includes('--no-tools')) process.exit(8); }
else if (cli === 'codex') { if (args.join(' ') !== 'app-server') process.exit(9); }
else if (cli === 'claude') { if (!args.includes('stream-json')) process.exit(10); }
const write = value => process.stdout.write(JSON.stringify(value)+'\n');
for await (const line of createInterface({input:process.stdin})) {
 const r = JSON.parse(line);
 if (cli === 'pi' && r.type === 'get_available_models') write({id:r.id,type:'response',success:true,data:{models:[{id:'same-model',provider:'oauth-one',name:'Model One'},{id:'same-model',provider:'oauth-two',name:'Model Two'},{id:'model-b',provider:'custom-provider',contextWindow:123456,reasoning:true}]}});
 else if (cli === 'codex' && r.method === 'initialize') write({id:r.id,result:{userAgent:'fixture'}});
 else if (cli === 'codex' && r.method === 'initialized') continue;
 else if (cli === 'codex' && r.method === 'config/read') write({id:r.id,result:{config:{model_provider:'configured-route'}}});
 else if (cli === 'codex' && r.method === 'model/list') write({id:r.id,result:{data:r.params.cursor?[{id:'two',model:'model-two',displayName:'Two'}]:[{id:'one',model:'model-one',displayName:'One',isDefault:true},{model:'hidden',hidden:true}],nextCursor:r.params.cursor?null:'page2'}});
 else if (cli === 'claude' && r.type === 'control_request' && r.request?.subtype === 'initialize') write({type:'control_response',response:{request_id:r.request_id,subtype:'success',response:{models:[{value:'sonnet',displayName:'Sonnet'},{value:'opus',displayName:'Opus'},{value:'opusplan',displayName:'Automatic two-model plan'}]}}});
 else { console.error('Unexpected request: a discovery probe must not start inference'); process.exit(11); }
}
