import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { installedPreviewFixture } from './fixtures/installed-preview.mjs';
import { previewRuntimeFamily } from '../src/preview/runtime-catalog.mjs';
import { startPreviewAllocation } from '../src/preview/startup.mjs';
import { runPreviewAllocation } from '../src/preview/lifecycle.mjs';
import { requestPreviewStop, inspectPreviewTermination, stopPreviewAllocation, releasePreviewMemory } from '../src/preview/teardown.mjs';
import { previewTeardownPending } from '../src/preview/teardown-state.mjs';
import { jsonBytes } from '../src/build-cache/paths.mjs';
import { id } from './fixtures/artifact-review.mjs';

const fixture=(t,respond)=>installedPreviewFixture(t,respond,{runtime:previewRuntimeFamily('celld-preview-http-v1-linux-arm64',{candidateEnrollment:true})});
async function available(work) {
 for(let n=0;;n++)try{return await work()}catch(e){if(n>=200||e.code!=='PREVIEW_HOST_REFUSED'||e.reason!=='pending')throw e;await delay(20)}
}
const stopCount=x=>x.calls.filter(c=>c[0]==='stop').length;

test('idle termination polling has no Docker calls, source requests or allocation writes',async t=>{
 const x=await fixture(t),names=await readdir(x.directory),state=await inspectPreviewTermination(x.args);assert.equal(state.request,null);assert.equal(state.completed,null);assert.equal(state.memoryBudgetHeld,true);assert.deepEqual(x.calls,[]);assert.deepEqual(x.source.calls,[]);assert.deepEqual(await readdir(x.directory),names);
});
test('owner decline is durable and immutable, frees no memory, and prevents later startup',async t=>{
 const x=await fixture(t),first=await requestPreviewStop(x.args,{reason:'declined'}),bytes=await readFile(join(x.directory,'stop.requested.json'));assert.equal(first.request.reason,'declined');assert.equal(first.completed,null);assert.equal(first.memoryBudgetHeld,true);
 const second=await requestPreviewStop(x.args,{reason:'revoked'});assert.deepEqual(second.request,first.request);assert.deepEqual(await readFile(join(x.directory,'stop.requested.json')),bytes);assert.equal(stopCount(x),0);assert.deepEqual(x.source.calls,[]);
 await assert.rejects(startPreviewAllocation(x.args),{code:'PREVIEW_HOST_REFUSED',reason:'startup-state'});assert.ok(!x.calls.some(c=>c[0]==='start'));assert.ok(!(await readdir(x.host)).includes('launch.pending.json'));
});
test('invalid withdrawal reason refuses before acquiring a fence or querying Docker',async t=>{
 const x=await fixture(t);await assert.rejects(requestPreviewStop(x.args,{reason:'approve'}),{code:'PREVIEW_HOST_REFUSED',reason:'stop-reason'});assert.deepEqual(x.calls,[]);assert.ok(!(await readdir(x.host)).includes('launch.pending.json'));
});
test('completed stop is read-only and repeatable before and after explicit memory retirement',async t=>{
 const x=await fixture(t);await startPreviewAllocation(x.args);const first=await stopPreviewAllocation(x.args),bytes=await readFile(join(x.directory,'teardown.complete.json')),count=stopCount(x);
 assert.deepEqual(await stopPreviewAllocation(x.args),first);assert.equal(stopCount(x),count);assert.deepEqual(await readFile(join(x.directory,'teardown.complete.json')),bytes);assert.ok(!(await readdir(x.host)).includes('launch.pending.json'));
 t.mock.method(Date,'now',()=>Date.parse(x.args.envelope.grant.expiresAt)+1);await releasePreviewMemory(x.args);assert.deepEqual(await stopPreviewAllocation(x.args),first);assert.equal(stopCount(x),count);const state=await inspectPreviewTermination(x.args);assert.equal(state.memoryBudgetHeld,false);assert.deepEqual(state.completed,first);
 const requested=await requestPreviewStop(x.args);assert.equal(requested.request,null);assert.deepEqual(requested.completed,first);assert.ok(!(await readdir(x.directory)).includes('stop.requested.json'));
});
test('repeated observation cannot upgrade unordered shutdown or free its memory hold',async t=>{
 const x=await fixture(t);await startPreviewAllocation(x.args);const c=x.f.observed.containers.find(c=>c.Config.Labels['fogd.preview.role']==='minio');Object.assign(c.State,{Status:'exited',Running:false,Pid:0});const first=await stopPreviewAllocation(x.args),count=stopCount(x);assert.equal(first.ordered,false);assert.deepEqual(await stopPreviewAllocation(x.args),first);assert.equal(stopCount(x),count);
 t.mock.method(Date,'now',()=>Date.parse(x.args.envelope.grant.expiresAt)+1);await assert.rejects(releasePreviewMemory(x.args),{code:'PREVIEW_HOST_REFUSED',reason:'teardown-unconfirmed'});assert.ok(!(await readdir(x.directory)).includes('memory.released.json'));
});
for(const corrupt of ['null','partial','missing-phase','wrong-id','wrong-expiry'])test(`completed proof ${corrupt} cannot be replayed as a new stop`,async t=>{
 const x=await fixture(t);await startPreviewAllocation(x.args);await stopPreviewAllocation(x.args);const count=stopCount(x),path=join(x.directory,'teardown.complete.json'),value=JSON.parse(await readFile(path));
 if(corrupt==='null')await writeFile(path,'null\n');if(corrupt==='partial')await writeFile(path,'{');if(corrupt==='missing-phase')await rm(join(x.directory,'teardown.writers.json'));if(corrupt==='wrong-id'){value.stopped.controller='e'.repeat(64);await writeFile(path,jsonBytes(value))}if(corrupt==='wrong-expiry'){value.expiresAt='2099-01-01T00:00:00.000Z';await writeFile(path,jsonBytes(value))}
 await assert.rejects(stopPreviewAllocation(x.args),{code:'PREVIEW_HOST_REFUSED'});assert.equal(stopCount(x),count);assert.ok((await readdir(x.host)).includes('launch.pending.json'));
});
test('partial teardown intent without completion refuses without issuing Docker effects',async t=>{
 const x=await fixture(t),allocated=JSON.parse(await readFile(join(x.directory,'allocation.complete.json')));await writeFile(join(x.directory,'teardown.pending.json'),jsonBytes(previewTeardownPending(allocated)),{mode:0o600});await assert.rejects(stopPreviewAllocation(x.args),{code:'PREVIEW_HOST_REFUSED',reason:'teardown-unconfirmed'});assert.deepEqual(x.calls,[]);
});
for(const corrupt of ['null','partial','wrong-id','extra-field'])test(`malformed owner intent ${corrupt} is retained and cannot be treated as absence`,async t=>{
 const x=await fixture(t);await requestPreviewStop(x.args);x.calls.length=0;const path=join(x.directory,'stop.requested.json'),value=JSON.parse(await readFile(path));if(corrupt==='null')await writeFile(path,'null\n');if(corrupt==='partial')await writeFile(path,'{');if(corrupt==='wrong-id'){value.allocationId='00000000-0000-4000-8000-000000000099';await writeFile(path,jsonBytes(value))}if(corrupt==='extra-field'){value.reuse=true;await writeFile(path,jsonBytes(value))}
 await assert.rejects(inspectPreviewTermination(x.args),{code:'PREVIEW_HOST_REFUSED'});assert.deepEqual(x.calls,[]);assert.ok((await readdir(x.directory)).includes('stop.requested.json'));
});
test('owner stop and manager completion converge on one teardown with no duplicate effects or latched fence',async t=>{
 const x=await fixture(t),active=await runPreviewAllocation(x.args);await available(()=>requestPreviewStop(x.args,{reason:'owner-stop'}));const [owner,manager]=await Promise.all([available(()=>stopPreviewAllocation(x.args)),active.completion]);assert.deepEqual(owner,manager);assert.equal(owner.ordered,true);assert.equal(stopCount(x),4);assert.ok(!(await readdir(x.host)).includes('launch.pending.json'));
});
for(const change of ['declined','active-baseline','credentials','private-guard'])test(`source ${change} stops a ready preview and retains a durable withdrawal reason`,async t=>{
 let checking=false,n=0;const x=await fixture(t,({request,response,state})=>{if(checking&&request.url==='/v1/admin'){if(change==='credentials'){response.writeHead(403);response.end('{}');return true}if(change==='private-guard')state.deployments[id].private='guard-'+(++n)}return false});const active=await runPreviewAllocation(x.args);checking=true;if(change==='declined')x.source.state.deployments[id].status='rejected';if(change==='active-baseline')x.source.state.apps['review-app'].route='paused';const stopped=await active.completion;
 assert.equal(stopped.ordered,true);assert.equal(stopCount(x),4);assert.equal(JSON.parse(await readFile(join(x.directory,'stop.requested.json'))).reason,'source-unverifiable');assert.ok(x.source.calls.every(c=>c.method==='GET'));assert.ok(!(await readdir(x.directory)).includes('memory.released.json'));
});
test('unknown stop result is never retried by the manager and does not proceed to storage',async t=>{
 const x=await fixture(t),run=x.args.run;let stops=0;x.args.run=async args=>{if(args[0]==='stop'){stops++;await run(args);throw Error('Unknown Docker result')}return run(args)};const active=await runPreviewAllocation(x.args);await available(()=>requestPreviewStop(x.args,{reason:'revoked'}));await assert.rejects(active.completion,{code:'PREVIEW_HOST_REFUSED',reason:'uncertain'});assert.equal(stops,1);assert.equal(JSON.parse(await readFile(join(x.host,'launch.pending.json'))).phase,'writing');
});
test('unknown withdrawal write retains its partial bytes and fence without Docker mutations',async t=>{
 const x=await fixture(t),run=x.args.run;let infos=0;x.args.run=async args=>{const result=await run(args);if(args[0]==='info'&&++infos===2)await writeFile(join(x.directory,'stop.requested.json'),'{',{mode:0o600});return result};await assert.rejects(requestPreviewStop(x.args),{code:'PREVIEW_HOST_REFUSED',reason:'uncertain'});assert.equal(await readFile(join(x.directory,'stop.requested.json'),'utf8'),'{');assert.equal(JSON.parse(await readFile(join(x.host,'launch.pending.json'))).phase,'writing');assert.equal(stopCount(x),0);
});
test('a stalled source read cannot delay scheduled shutdown and is cancelled when monitoring ends',async t=>{
 let checking=false,response,notify,closed;const stalled=new Promise(resolve=>{notify=resolve});const x=await fixture(t,({request,response:res})=>{if(checking&&request.url==='/v1/admin'){response=res;closed=new Promise(resolve=>res.once('close',resolve));notify();return true}return false});
 t.after(()=>response?.destroy());let now=Date.now();t.mock.method(Date,'now',()=>now);const active=await runPreviewAllocation(x.args);checking=true;await stalled;now=Date.parse(active.ready.shutdownAt)+1;
 const stopped=await Promise.race([active.completion,delay(5000).then(()=>{throw Error('Source read blocked scheduled shutdown')})]);assert.equal(stopped.ordered,true);assert.equal(JSON.parse(await readFile(join(x.directory,'stop.requested.json'))).reason,'expiry');await closed;
});
