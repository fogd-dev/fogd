import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { installedPreviewFixture } from './fixtures/installed-preview.mjs';
import { previewRuntimeFamily } from '../src/preview/runtime-catalog.mjs';
import { startPreviewAllocation } from '../src/preview/startup.mjs';
import { runPreviewAllocation } from '../src/preview/lifecycle.mjs';
import { id } from './fixtures/artifact-review.mjs';

const name='celld-preview-http-v1-linux-arm64';
const fixture=t=>installedPreviewFixture(t,undefined,{runtime:previewRuntimeFamily(name,{candidateEnrollment:true})});
const role=(x,id)=>x.f.observed.containers.find(c=>c.Id===id)?.Config.Labels['fogd.preview.role'];

test('candidate runtime is closed ordinarily and exact explicit selection binds its image and signed target',async t=>{
 assert.throws(()=>previewRuntimeFamily(name),{code:'PREVIEW_HOST_REFUSED',reason:'preview-runtime'});
 const x=await fixture(t);x.args.candidateEnrollment=false;await assert.rejects(startPreviewAllocation(x.args),{code:'PREVIEW_HOST_REFUSED',reason:'preview-runtime'});assert.deepEqual(x.calls,[]);
 x.args.candidateEnrollment=true;x.args.runtime='unknown-family';await assert.rejects(startPreviewAllocation(x.args));assert.deepEqual(x.calls,[]);
});
test('startup verifies runtime bytes and phase readiness before exposing the protected URL',async t=>{
 const x=await fixture(t),ready=await startPreviewAllocation(x.args);
 assert.equal(ready.started,true);assert.equal(ready.ordinaryEnrollment,false);assert.equal(ready.runtime.admission,'candidate');assert.equal(ready.runtime.programFiles,151);
 assert.deepEqual(x.calls.filter(c=>c[0]==='start').map(c=>c.slice(1).map(id=>role(x,id))),[['minio'],['bucket-init'],['slot-1-a','slot-1-b','slot-2-a','slot-2-b'],['controller'],['gateway'],['ingress']]);
 assert.equal(Date.parse(ready.expiresAt)-Date.parse(ready.shutdownAt),30000);assert.ok((await readdir(x.directory)).includes('startup.complete.json'));
 assert.ok(!(await readdir(x.host)).includes('launch.pending.json'));assert.equal(x.source.calls.length,4);
});
for(const failed of ['minio','slot-1-a','controller','ingress'])test(`ambiguous ${failed} start retains fence, blocks later phases and cannot replay`,async t=>{
 const x=await fixture(t),run=x.args.run;x.args.run=async args=>{if(args[0]==='start'&&args.slice(1).some(id=>role(x,id)===failed)){await run(args);throw Error('Unknown start result')}return run(args)};
 await assert.rejects(startPreviewAllocation(x.args),{code:'PREVIEW_HOST_REFUSED',reason:'uncertain'});const count=x.calls.filter(c=>c[0]==='start').length;assert.ok(!(await readdir(x.directory)).includes('startup.complete.json'));assert.equal(JSON.parse(await readFile(join(x.host,'launch.pending.json'))).phase,'writing');
 await assert.rejects(startPreviewAllocation(x.args),{code:'PREVIEW_HOST_REFUSED',reason:'pending'});assert.equal(x.calls.filter(c=>c[0]==='start').length,count);assert.ok(!x.calls.some(c=>['rm','kill','restart','stop'].includes(c[0])));
});
test('changed runtime program bytes refuse before application effects and release only the checking fence',async t=>{
 const x=await fixture(t),run=x.args.run;x.args.run=async args=>{const v=await run(args);if(args[0]==='cp'&&args[1].endsWith(':/app/packages/cli/src/.'))await writeFile(join(args[2],'preview/backend.mjs'),'changed');return v};
 await assert.rejects(startPreviewAllocation(x.args),{code:'PREVIEW_HOST_REFUSED',reason:'preview-runtime-bytes'});assert.ok(!x.calls.some(c=>c[0]==='start'));assert.ok(!(await readdir(x.host)).includes('launch.pending.json'));
});
test('source recheck after runtime inspection refuses a changed proposal before any service starts',async t=>{
 const x=await fixture(t),run=x.args.run;x.args.run=async args=>{const v=await run(args);if(args[0]==='cp'&&args[1].endsWith(':/app/packages/cli/src/.'))x.source.state.deployments[id].status='rejected';return v};
 await assert.rejects(startPreviewAllocation(x.args));assert.ok(!x.calls.some(c=>c[0]==='start'));assert.ok(!(await readdir(x.host)).includes('launch.pending.json'));
});
test('successful start output without actual running state cannot advance readiness',async t=>{
 const x=await fixture(t),run=x.args.run;x.args.run=async args=>args[0]==='start'?'':run(args);
 await assert.rejects(startPreviewAllocation(x.args),{code:'PREVIEW_HOST_REFUSED',reason:'startup-exited'});assert.ok(!x.calls.some(c=>c[0]==='exec'));assert.ok((await readdir(x.host)).includes('launch.pending.json'));
});
test('a previously ready writer exiting during controller readiness prevents gateway and ingress starts',async t=>{
 const x=await fixture(t),run=x.args.run;x.args.run=async args=>{const v=await run(args);if(args[0]==='exec'&&args.at(-1).includes('/internal/preview')){const c=x.f.observed.containers.find(c=>c.Config.Labels['fogd.preview.role']==='slot-1-a');Object.assign(c.State,{Running:false,Pid:0,Status:'exited'})}return v};
 await assert.rejects(startPreviewAllocation(x.args),{code:'PREVIEW_HOST_REFUSED',reason:'startup-exited'});assert.ok(!x.calls.some(c=>c[0]==='start'&&c.slice(1).some(id=>['gateway','ingress'].includes(role(x,id)))));
});
test('manager cancellation stops in verified order and retains resources and memory hold',async t=>{
 const x=await fixture(t),controller=new AbortController();x.args.signal=controller.signal;const active=await runPreviewAllocation(x.args);controller.abort();const stopped=await active.completion;
 assert.equal(stopped.ordered,true);assert.equal(stopped.storageRequired,true);assert.equal(stopped.memoryBudgetHeld,true);assert.equal(x.f.observed.containers.length,10);
 assert.deepEqual(x.calls.filter(c=>c[0]==='stop').map(c=>c.slice(3).map(id=>role(x,id))),[['ingress'],['gateway','controller'],['slot-1-a','slot-1-b','slot-2-a','slot-2-b'],['minio']]);assert.ok(!(await readdir(x.directory)).includes('memory.released.json'));
});
test('watcher is scheduled before returning readiness and stops before the original service fallback deadline',async t=>{
 const x=await fixture(t);let now=Date.now();t.mock.method(Date,'now',()=>now);const active=await runPreviewAllocation(x.args);now=Date.parse(active.ready.shutdownAt)+1;const stopped=await active.completion;
 assert.equal(stopped.ordered,true);assert.ok(Date.parse(stopped.observedAt)<Date.parse(active.ready.expiresAt));assert.equal(stopped.memoryBudgetHeld,true);
});
test('too little time for readiness and ordered shutdown refuses without starting any service',async t=>{
 const x=await fixture(t);t.mock.method(Date,'now',()=>Date.parse(x.f.envelope.grant.expiresAt)-40000);await assert.rejects(startPreviewAllocation(x.args),{code:'PREVIEW_HOST_REFUSED',reason:'startup-window'});assert.ok(!x.calls.some(c=>c[0]==='start'));assert.ok(!(await readdir(x.host)).includes('launch.pending.json'));
});
test('readiness failure never advances to bucket initialization or silently retries a Docker error',async t=>{
 const x=await fixture(t),run=x.args.run;let now=Date.now();t.mock.method(Date,'now',()=>now);x.args.run=async args=>{if(args[0]==='exec'){now+=10001;return JSON.stringify({ready:false})}return run(args)};
 await assert.rejects(startPreviewAllocation(x.args),{code:'PREVIEW_HOST_REFUSED',reason:'startup-readiness'});assert.deepEqual(x.calls.filter(c=>c[0]==='start').map(c=>c.slice(1).map(id=>role(x,id))),[['minio']]);assert.ok((await readdir(x.host)).includes('launch.pending.json'));
});
test('a Docker readiness command error retains the pending operation with no probe replay',async t=>{
 const x=await fixture(t),run=x.args.run;let attempts=0;x.args.run=async args=>{if(args[0]==='exec'){attempts++;throw Error('Docker observation unavailable')}return run(args)};
 await assert.rejects(startPreviewAllocation(x.args),{code:'PREVIEW_HOST_REFUSED',reason:'uncertain'});assert.equal(attempts,1);assert.equal(x.calls.filter(c=>c[0]==='start').length,1);assert.ok(!(await readdir(x.directory)).includes('startup.complete.json'));
});
test('cancelled launch and a wrong expected image refuse before any Docker or source observation',async t=>{
 const x=await fixture(t),controller=new AbortController();controller.abort();await assert.rejects(startPreviewAllocation({...x.args,signal:controller.signal}));assert.deepEqual(x.calls,[]);assert.deepEqual(x.source.calls,[]);
 await assert.rejects(startPreviewAllocation({...x.args,expectedImage:'sha256:'+'0'.repeat(64)}));assert.deepEqual(x.calls,[]);assert.deepEqual(x.source.calls,[]);
});
