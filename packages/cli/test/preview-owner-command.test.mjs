import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, chmod, symlink, link, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installedPreviewFixture } from './fixtures/installed-preview.mjs';
import { previewRuntimeFamily } from '../src/preview/runtime-catalog.mjs';
import { writePreviewOwnerControl } from '../src/preview/owner-control.mjs';
import { startPreviewAllocation } from '../src/preview/startup.mjs';
import { runPreviewAllocation } from '../src/preview/lifecycle.mjs';
import { acquirePreviewHost } from '../src/preview/host-registry.mjs';
import { jsonBytes } from '../src/build-cache/paths.mjs';

const exec = promisify(execFile), bin = new URL('../bin/fogd.js', import.meta.url).pathname;
const fixture=t=>installedPreviewFixture(t,undefined,{runtime:previewRuntimeFamily('celld-preview-http-v1-linux-arm64',{candidateEnrollment:true})});
async function cliFixture(t,{running=false}={}) {
 const x=await fixture(t);if(running)await startPreviewAllocation(x.args);x.source.calls.length=0;
 const owner=join(x.input.root,'owner'),control=await writePreviewOwnerControl(x.args,{directory:owner,dockerContext:'owner-test'});
 const tools=join(x.input.root,'tools'),state=join(x.input.root,'docker-state.json'),calls=join(x.input.root,'docker-calls.jsonl');await mkdir(tools,{mode:0o700});await writeFile(calls,'');await writeFile(state,jsonBytes({observed:x.f.observed,image:x.f.image}),{mode:0o600});
 const code=`#!${process.execPath}
import{readFile,writeFile,appendFile}from'node:fs/promises';const state=process.env.PREVIEW_OWNER_TEST_STATE,calls=process.env.PREVIEW_OWNER_TEST_CALLS;const input=process.argv.slice(2),context=input[1],args=input.slice(2);if(input[0]!=='--context')process.exit(2);await appendFile(calls,JSON.stringify({context,args,ambientDocker:Object.keys(process.env).some(k=>k.startsWith('DOCKER_')),ambientFogd:Object.keys(process.env).some(k=>k.startsWith('FOGD_'))})+'\\n');const data=JSON.parse(await readFile(state)),v=data.observed;
if(args[0]==='info')console.log(JSON.stringify(v.host));else if(args[0]==='image')console.log(JSON.stringify([data.image]));else if(args[0]==='stop'){for(const id of args.slice(3)){const c=v.containers.find(c=>c.Id===id);Object.assign(c.State,{Running:false,Pid:0,Status:'exited',ExitCode:0})}await writeFile(state,JSON.stringify(data));if(data.unknownStop){console.error('private-Docker-error '+v.containers[0].Config.Env.join(' '));process.exit(1)}console.log('stopped')}else{const kind={container:'containers',network:'networks',volume:'volumes'}[args[0]],items=v[kind];if(!items)process.exit(3);if(args[1]==='ls')console.log(items.map(i=>kind==='volumes'?i.Name:i.Id).join('\\n'));else if(args[1]==='inspect')console.log(JSON.stringify(items));else process.exit(4)}
`;
 await writeFile(join(tools,'docker'),code,{mode:0o700});
 const env={...process.env,...x.source.env,PATH:tools,DOCKER_CONTEXT:'wrong-ambient-context',DOCKER_HOST:'tcp://wrong-ambient-host',DOCKER_CONFIG:join(x.input.root,'wrong-config'),PREVIEW_OWNER_TEST_STATE:state,PREVIEW_OWNER_TEST_CALLS:calls};
 const run=(action,extra=[],overrides={})=>exec(process.execPath,[bin,'preview',action,x.args.allocationId,'--control',owner,...extra],{env:{...env,...overrides},timeout:40000});
 const records=async()=> (await readFile(calls,'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
 return{...x,owner,control,state,run,records,env};
}

test('owner control exports only stop/inspection expectations with private permissions and no source or TLS keys',async t=>{
 const x=await fixture(t),dir=join(x.input.root,'control');const control=await writePreviewOwnerControl(x.args,{directory:dir,dockerContext:'owner-test'}),text=await readFile(join(dir,'owner.json'),'utf8'),value=JSON.parse(text);
 assert.equal(control.capability,'inspect-stop-and-retire-only');assert.deepEqual(Object.keys(value.secretValues).sort(),['gatewayToken','storagePassword']);assert.ok(!text.includes(x.source.env.FOGD_ADMIN_PASSWORD));assert.ok(!text.includes('BEGIN PRIVATE KEY'));assert.ok(!text.includes(x.input.bundle.ingress.accessKey));assert.deepEqual(x.calls,[]);
 await assert.rejects(writePreviewOwnerControl(x.args,{directory:dir,dockerContext:'owner-test'}),{code:'PREVIEW_OWNER_CONTROL_REFUSED'});assert.equal(await readFile(join(dir,'owner.json'),'utf8'),text);
});
test('control output cannot modify the host ledger or immutable preparation directory',async t=>{
 const x=await fixture(t);for(const parent of [x.root,x.source.output]){const dir=join(parent,'owner');await assert.rejects(writePreviewOwnerControl(x.args,{directory:dir,dockerContext:'owner-test'}),{code:'PREVIEW_OWNER_CONTROL_REFUSED'});assert.ok(!(await readdir(parent)).includes('owner'))}assert.deepEqual(x.calls,[]);
});
test('real CLI reports verified process state without health, credentials, source calls or ambient Docker selection',async t=>{
 const x=await cliFixture(t,{running:true}),result=JSON.parse((await x.run('status')).stdout);assert.equal(result.state,'running');assert.equal(result.runtimeObserved,true);assert.equal(result.health,'not-assessed');assert.equal(result.memoryBudgetHeld,true);assert.equal(result.executionAuthorized,false);assert.equal(result.roles.controller,'running');const text=JSON.stringify(result);assert.ok(!text.includes(x.args.secretValues.storagePassword));assert.ok(!text.includes(x.args.secretValues.gatewayToken));assert.ok(!text.includes('Env'));assert.deepEqual(x.source.calls,[]);const calls=await x.records();assert.ok(calls.every(c=>c.context==='owner-test'&&!c.ambientDocker&&!c.ambientFogd));assert.ok(calls.every(c=>!['start','stop','exec','create','rm'].includes(c.args[0])));
});
test('real CLI stop is ordered and repeatable while retaining data, memory and first reason',async t=>{
 const x=await cliFixture(t,{running:true});const first=JSON.parse((await x.run('stop',['--reason','declined'])).stdout);assert.equal(first.state,'stopped');assert.equal(first.shutdownOrdered,true);assert.equal(first.stopReason,'declined');assert.equal(first.memoryBudgetHeld,true);const proof=await readFile(join(x.directory,'teardown.complete.json')),count=(await x.records()).filter(c=>c.args[0]==='stop').length;assert.equal(count,4);
 const again=JSON.parse((await x.run('stop',['--reason','revoked'])).stdout);assert.equal(again.stopReason,'declined');assert.equal((await x.records()).filter(c=>c.args[0]==='stop').length,count);assert.deepEqual(await readFile(join(x.directory,'teardown.complete.json')),proof);assert.deepEqual(x.source.calls,[]);assert.ok(!(await readdir(x.host)).includes('launch.pending.json'));
});
test('real CLI retirement refuses before original expiry and releases only memory afterward',async t=>{
 const x=await cliFixture(t,{running:true});await x.run('stop');await assert.rejects(x.run('retire'));assert.ok(!(await readdir(x.directory)).includes('memory.released.json'));assert.ok(!(await readdir(x.host)).includes('launch.pending.json'));
 const clock=join(x.input.root,'clock.mjs');await writeFile(clock,'Date.now=()=>'+(Date.parse(x.args.envelope.grant.expiresAt)+1)+';');const time={NODE_OPTIONS:'--import='+pathToFileURL(clock).href};const result=JSON.parse((await x.run('retire',[],time)).stdout);assert.equal(result.memoryBudgetHeld,false);assert.equal(result.resourcesRetained,true);assert.equal(result.namespaceReusable,false);const marker=await readFile(join(x.directory,'memory.released.json'));assert.equal(JSON.parse((await x.run('retire',[],time)).stdout).memoryBudgetHeld,false);assert.deepEqual(await readFile(join(x.directory,'memory.released.json')),marker);assert.equal((await x.records()).filter(c=>c.args[0]==='stop').length,4);
});
for(const fault of ['public','symlink','hardlink','invalid-json','extra-field','wrong-key','wrong-context'])test(`owner control ${fault} refuses without Docker calls or private contents in diagnostics`,async t=>{
 const x=await cliFixture(t),path=join(x.owner,'owner.json'),text=await readFile(path,'utf8');if(fault==='public')await chmod(path,0o644);if(fault==='symlink'){const real=join(x.input.root,'real-control.json');await writeFile(real,text,{mode:0o600});await rm(path);await symlink(real,path)}if(fault==='hardlink')await link(path,join(x.input.root,'linked-control.json'));if(fault==='invalid-json')await writeFile(path,'{private-source-secret:');if(['extra-field','wrong-key','wrong-context'].includes(fault)){const value=JSON.parse(text);if(fault==='extra-field')value.privateKey='PRIVATE_SIGNING_SECRET';if(fault==='wrong-key')value.publicKey='private-invalid-key';if(fault==='wrong-context')value.dockerContext='--host=foreign';await writeFile(path,jsonBytes(value))}
 await assert.rejects(x.run('status'),error=>{assert.match(error.stderr,/owner control refused/);assert.ok(!error.stderr.includes('PRIVATE_SIGNING_SECRET'));assert.ok(!error.stderr.includes('private-source-secret'));return true});assert.deepEqual(await x.records(),[]);assert.ok(!(await readdir(x.host)).includes('launch.pending.json'));
});
test('allocation mismatch and wrong engine refuse before touching the host fence',async t=>{
 const x=await cliFixture(t);const value=JSON.parse(await readFile(join(x.owner,'owner.json')));value.allocationId='00000000-0000-4000-8000-000000000099';await writeFile(join(x.owner,'owner.json'),jsonBytes(value));await assert.rejects(x.run('status'));assert.deepEqual(await x.records(),[]);value.allocationId=x.args.allocationId;await writeFile(join(x.owner,'owner.json'),jsonBytes(value));const state=JSON.parse(await readFile(x.state));state.observed.host.ID='another-engine';await writeFile(x.state,jsonBytes(state));await assert.rejects(x.run('stop'),error=>{assert.match(error.stderr,/owner engine refused/);return true});assert.equal((await x.records()).length,1);assert.ok(!(await readdir(x.host)).includes('launch.pending.json'));
});
test('pending status is explicit, unverified and nonzero without clearing another operation fence',async t=>{
 const x=await cliFixture(t),host=await acquirePreviewHost(x.root,x.f.plan.request.engineId);try{await assert.rejects(x.run('status'),error=>{const value=JSON.parse(error.stdout);assert.equal(value.state,'pending');assert.equal(value.runtimeObserved,false);assert.equal(value.memoryBudgetHeld,null);return true});assert.ok((await readdir(x.host)).includes('launch.pending.json'))}finally{await host.fence.release()}
});
test('unknown CLI stop result retains the fence and is never retried or logged with Docker secrets',async t=>{
 const x=await cliFixture(t,{running:true}),value=JSON.parse(await readFile(x.state));value.unknownStop=true;await writeFile(x.state,jsonBytes(value));await assert.rejects(x.run('stop'),error=>{assert.ok(!error.stderr.includes(x.args.secretValues.storagePassword));assert.ok(!error.stderr.includes(x.args.secretValues.gatewayToken));return true});assert.equal((await x.records()).filter(c=>c.args[0]==='stop').length,1);assert.equal(JSON.parse(await readFile(join(x.host,'launch.pending.json'))).phase,'writing');assert.ok(!(await readdir(x.directory)).includes('teardown.complete.json'));
});
test('managed coordinator writes its owner controls without enabling a public launch command',async t=>{
 const x=await fixture(t),directory=join(x.input.root,'manager-control'),cancel=new AbortController();const active=await runPreviewAllocation({...x.args,ownerControl:{directory,dockerContext:'owner-test'},signal:cancel.signal});assert.equal(active.ready.control.directory,await realpath(directory));assert.equal(active.ready.control.allocationId,x.args.allocationId);cancel.abort();assert.equal((await active.completion).ordered,true);
 const error=await exec(process.execPath,[bin,'preview','run'],{env:x.source.env}).then(()=>null,e=>e);assert.ok(error);assert.match(error.stderr,/Usage: fogd preview prepare/);
});
