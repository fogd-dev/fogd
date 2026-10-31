import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, jsonBytes } from '../src/build-cache/paths.mjs';
import { createPreviewPlan, validatePreviewPlan } from '../src/preview/plan.mjs';
import { previewContainerCommands } from '../src/preview/container-plan.mjs';
import { previewExecutionSha256 } from '../src/preview/execution-authority.mjs';
import { assertCurrentPreviewStorage } from '../src/preview/storage-binding.mjs';
import { assertStoppedPreviewGraph } from '../src/preview/stopped-graph.mjs';
import { startPreviewAllocation } from '../src/preview/startup.mjs';
import { previewRuntimeFamily } from '../src/preview/runtime-catalog.mjs';
import { previewPlanFixture } from './fixtures/preview-plan.mjs';
import { stoppedPreviewFixture } from './fixtures/stopped-preview.mjs';
import { installedPreviewFixture } from './fixtures/installed-preview.mjs';
const refused={code:'PREVIEW_HOST_REFUSED',reason:'storage'};

test('schema-3 plan seals every persistent role source and refuses altered receipt or driver options',()=>{
 const f=previewPlanFixture();assert.equal(f.plan.schema,3);assert.equal(Object.keys(f.plan.volumes).length,12);
 for(const [role,volume]of Object.entries(f.plan.volumes))assert.deepEqual(volume.driverOptions,{type:'none',o:'bind',device:f.request.storage.storage.mount.target+'/'+role});
 const changed=structuredClone(f.plan);changed.volumes.minio.driverOptions.device='/var/lib/unbounded';assert.throws(()=>validatePreviewPlan(changed),{code:'PREVIEW_PLAN_REFUSED'});
 for(const change of [s=>s.sha256='0'.repeat(64),s=>s.storage.engineId='wrong-engine',s=>s.storage.project='wrong-project',s=>s.storage.disk.allocatedBytes=0]){const request=structuredClone(f.request);change(request.storage);assert.throws(()=>createPreviewPlan(request),{code:'PREVIEW_PLAN_REFUSED'})}
});
test('an alternative valid storage receipt cannot reuse an execution decision',()=>{
 const f=previewPlanFixture(),request=structuredClone(f.request);request.storage.storage.disk.inode++;request.storage.storage.loop['back-ino']++;request.storage.sha256=hash(jsonBytes(request.storage.storage));const plan=createPreviewPlan(request);
 assert.throws(()=>previewContainerCommands(plan,f.envelope,{role:'gateway',publicKey:f.authority.publicKey,expectedGrantSha256:previewExecutionSha256(f.envelope),secretValues:{}}),{code:'PREVIEW_PLAN_REFUSED'});
});
test('fresh storage checks select explicit phase and refuse missing transport, crossed state or worker version',async()=>{
 const f=previewPlanFixture(),seen=[],runHost=async(args,options)=>{seen.push(JSON.parse(options.inputText));return JSON.stringify({ok:true,storage:f.request.storage.storage})};
 for(const phase of ['empty','installed','any'])await assertCurrentPreviewStorage(f.plan,runHost,phase);
 assert.deepEqual(seen.map(x=>x.action),['inspect-empty','inspect-installed','inspect']);assert.ok(seen.every(x=>x.project===f.plan.project&&x.engineId===f.request.engineId));
 await assert.rejects(assertCurrentPreviewStorage(f.plan,undefined),refused);
 const changed=structuredClone(f.plan);changed.request.storage.workerSha256='f'.repeat(64);await assert.rejects(assertCurrentPreviewStorage(changed,runHost),refused);
 await assert.rejects(assertCurrentPreviewStorage(f.plan,async()=>{throw Error('PRIVATE_HOST_ERROR')}),e=>e.code===refused.code&&e.reason===refused.reason&&!e.message.includes('PRIVATE_HOST_ERROR'));
});
for(const [name,change]of Object.entries({missingOptions:f=>f.observed.volumes[0].Options=null,wrongSource:f=>f.observed.volumes[0].Options={...f.observed.volumes[0].Options,device:'/var/lib/other'},rawDeviceAlias:f=>f.observed.volumes.push({Name:'foreign',Options:{device:f.request.storage.storage.loop.name}}),directoryAlias:f=>f.observed.volumes.push({Name:'foreign',Options:{device:f.request.storage.storage.mount.target+'/minio'}}),parentBind:f=>f.observed.containers.push({Id:'f'.repeat(64),Name:'/foreign',Mounts:[{Type:'bind',Source:'/var/lib'}],HostConfig:{}}),deviceExposure:f=>f.observed.containers.push({Id:'f'.repeat(64),Name:'/foreign',Mounts:[],HostConfig:{Devices:[{PathOnHost:f.request.storage.storage.loop.name}]}})}))test(`bounded graph refuses ${name}`,()=>{
 const f=stoppedPreviewFixture();change(f);assert.throws(()=>assertStoppedPreviewGraph(f.plan,f.observed,f.image,f.commands,f.allocationId,f.created),{code:'PREVIEW_HOST_REFUSED',reason:'stopped-graph'});
});
test('startup storage failure releases its read-only fence before any app start or source request',async t=>{
 const runtime=previewRuntimeFamily('celld-preview-http-v1-linux-arm64',{candidateEnrollment:true}),f=await installedPreviewFixture(t,undefined,{runtime});f.args.runStorageHost=async()=>{throw Error('mount unavailable')};await assert.rejects(startPreviewAllocation(f.args),refused);assert.ok(!f.calls.some(c=>['start','exec'].includes(c[0])));assert.deepEqual(f.source.calls,[]);assert.ok(!(await readdir(f.host)).includes('launch.pending.json'));
});
test('a storage observation failure after storage starts retains the writing fence and blocks later services',async t=>{
 const runtime=previewRuntimeFamily('celld-preview-http-v1-linux-arm64',{candidateEnrollment:true}),f=await installedPreviewFixture(t,undefined,{runtime});f.args.runStorageHost=async()=>{if(f.f.observed.containers.find(c=>c.Name==='/'+f.f.plan.services.minio.name).State.Running)throw Error('mount changed');return JSON.stringify({ok:true,storage:f.f.request.storage.storage})};await assert.rejects(startPreviewAllocation(f.args),refused);assert.deepEqual(f.calls.filter(c=>c[0]==='start'),[['start',f.f.created.containers.minio]]);assert.equal(JSON.parse(await readFile(join(f.host,'launch.pending.json'))).phase,'writing');
});

test('expiry reached during a storage observation prevents the next Docker service start',async t=>{
 const runtime=previewRuntimeFamily('celld-preview-http-v1-linux-arm64',{candidateEnrollment:true}),f=await installedPreviewFixture(t,undefined,{runtime});let now=Date.now();t.mock.method(Date,'now',()=>now);f.args.runStorageHost=async(args,options)=>{if(JSON.parse(options.inputText).action==='inspect')now=Date.parse(f.f.envelope.grant.expiresAt);return JSON.stringify({ok:true,storage:f.f.request.storage.storage})};await assert.rejects(startPreviewAllocation(f.args));assert.deepEqual(f.calls.filter(c=>c[0]==='start'),[]);
});
