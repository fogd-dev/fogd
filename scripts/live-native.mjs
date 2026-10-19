// Minimal native Void WebSocket transport probe; not durable-session qualification.
import assert from 'node:assert/strict';
import {cp,mkdir,symlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {configEnv,stackRoot,run} from '../packages/cli/src/local.mjs';
import {execute} from '../packages/cli/src/recovery/execute.mjs';
import {chromium,expect} from './guestbook-browser.mjs';
const output=resolve(process.argv[2] || '');assert.ok(process.argv[2], 'Supply a new output directory');
await mkdir(output,{mode:0o700});
const project=join(output,'project');await mkdir(join(project,'routes/rooms'),{recursive:true});
for(const name of ['package.json','vite.config.ts'])await cp(join(stackRoot,'examples/guestbook',name),join(project,name));
for(const name of ['void.config.ts','tsconfig.json'])await cp(join(stackRoot,'examples/imports',name),join(project,name));
await symlink(join(stackRoot,'examples/guestbook/node_modules'),join(project,'node_modules'));
await cp(join(stackRoot,'scripts/live-probe/room.ts'),join(project,'routes/rooms/[room].ws.ts'));
const env=await configEnv();assert.match(env.COMPOSE_PROJECT_NAME || '',/^fogd-m11[a-z0-9-]*$/);
const cli=args=>execute(process.execPath,[join(stackRoot,'packages/cli/bin/fogd.js'),...args],{env});
await cli(['up']);
const auth={Authorization:`Basic ${Buffer.from(`${env.FOGD_ADMIN_USER}:${env.FOGD_ADMIN_PASSWORD}`).toString('base64')}`};
async function admin(){const r=await fetch(`http://127.0.0.1:${env.FOGD_ADMIN_PORT}/v1/admin`,{headers:auth});assert.equal(r.status,200);return r.json()}
await expect.poll(async()=>{try{return Object.keys((await admin()).apps).length===0}catch{return false}},{timeout:120000}).toBe(true);
const credential=JSON.parse(await cli(['admin','issue-token','live-probe','live-probe']));
await run(process.execPath,[join(stackRoot,'packages/cli/bin/fogd.js'),'deploy','--name','live-probe'],{cwd:project,env:{...env,FOGD_DEPLOY_TOKEN:credential.token}});
const release=Object.values((await admin()).deployments).find(r=>r.app==='live-probe');assert.equal(release.status,'pending');
await cli(['admin','approve',release.id,release.digest]);
const browser=await chromium.launch({args:['--host-resolver-rules=MAP live-probe.localhost 127.0.0.1']});
try {
const page=await browser.newPage();const origin=`http://live-probe.localhost:${env.FOGD_HTTP_PORT}`;
assert.equal((await page.goto(origin+'/rooms/test')).status(),200);
const result=await page.evaluate(async origin=>new Promise((resolve,reject)=>{
 const socket=new WebSocket(origin.replace('http:','ws:')+'/rooms/test');const events=[];
 const timer=setTimeout(()=>{socket.close();reject(Error('WebSocket timeout'))},15000);
 socket.onerror=()=>{clearTimeout(timer);reject(Error('WebSocket error'))};
 socket.onmessage=e=>{events.push(JSON.parse(e.data));if(events.length===1)socket.send(JSON.stringify({type:'ping'}));else {clearTimeout(timer);socket.close(1000,'probe complete');resolve(events)}};
}),origin);
assert.deepEqual(result,[{type:'ready',room:'test'},{type:'ready',room:'test'}]);
await writeFile(join(output,'evidence.json'),JSON.stringify({scope:'Minimal native Void WebSocket roundtrip through ordinary CLI approval and workerd; no durable-state/failure qualification',project:env.COMPOSE_PROJECT_NAME,release:{id:release.id,digest:release.digest},events:result},null,2)+'\n');
console.log('PASS: native Void room upgrades through workerd and exchanges typed messages');
}finally{await browser.close()}
