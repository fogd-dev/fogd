import test from 'node:test';
import assert from 'node:assert/strict';
import { initializePreviewStorageAdmission, inspectPreviewStorageAdmission, quarantinePreviewStorage, repairPreviewStorageHold } from '../src/preview/storage-admission.mjs';
import { preparePreviewStorage, previewStorageBytes, previewStorageChargeBytes } from '../src/preview/storage.mjs';
import { createPreviewPlan, validatePreviewPlan } from '../src/preview/plan.mjs';
import { previewPlanFixture } from './fixtures/preview-plan.mjs';
import { hash, jsonBytes } from '../src/build-cache/paths.mjs';

const input={root:'/var/lib/docker/fogd-preview-storage',engineId:'engine-test'};
function report(){const policy={schema:1,kind:'fogd-preview-storage-admission',id:'00000000-0000-4000-8000-000000000001',...input,rootIdentity:{device:1,inode:2},maxProjects:2,chargeBytes:previewStorageChargeBytes,headroomBytes:previewStorageBytes,headroomInodes:8192};return{schema:2,kind:'fogd-preview-storage-admission-status',quarantines:[],quarantinedProjects:0,quarantinedChargeBytes:0,policy,heldProjects:0,heldChargeBytes:0,remainingProjects:2,pending:false,space:{availableBytes:4*previewStorageBytes,availableInodes:10000,device:1},admissionOpen:true,reservations:[],resourcesRetained:true,executionAuthorized:false}}
const refused={code:'PREVIEW_STORAGE_REFUSED'};
test('explicit initialization and status use closed transport requests without execution permission',async()=>{
 const calls=[],runHost=async(args,options)=>{calls.push(JSON.parse(options.inputText));return JSON.stringify({ok:true,admission:report()})};const result=await initializePreviewStorageAdmission({...input,runHost},{maxProjects:2});assert.equal(result.executionAuthorized,false);assert.deepEqual(await inspectPreviewStorageAdmission({...input,runHost}),result);assert.deepEqual(calls,[{action:'initialize',...input,maxProjects:2},{action:'admission',...input}]);
});
test('invalid root or capacity refuses before host execution',async()=>{
 let count=0;const runHost=async()=>{count++};for(const maxProjects of [0,-1,65,1.5,'2'])assert.throws(()=>initializePreviewStorageAdmission({...input,runHost},{maxProjects}),refused);assert.throws(()=>inspectPreviewStorageAdmission({...input,root:'/var/lib/../other',runHost}),refused);assert.equal(count,0);
});
for(const[name,change]of Object.entries({engine:x=>x.policy.engineId='other',device:x=>x.space.device=2,capacity:x=>x.remainingProjects=100,charge:x=>x.heldChargeBytes=1,headroom:x=>x.policy.headroomBytes=0,pending:x=>{x.pending=true;x.admissionOpen=true},space:x=>{x.space.availableBytes=0;x.admissionOpen=true},extra:x=>x.privateHostSecret='PRIVATE_HOST_SECRET'}))test(`storage admission rejects ${name} report without private diagnostics`,async()=>{
 const value=report();change(value);await assert.rejects(inspectPreviewStorageAdmission({...input,runHost:async()=>JSON.stringify({ok:true,admission:value})}),e=>e.code===refused.code&&!e.message.includes('PRIVATE_HOST_SECRET'));
});
for(const reason of ['pending','capacity'])test(`known ${reason} refusal is preserved without replaying provisioning`,async()=>{
 let calls=0;await assert.rejects(preparePreviewStorage({...input,project:'fogd-preview-'+'a'.repeat(32),runHost:async()=>{calls++;return JSON.stringify({ok:false,reason})}}),{...refused,reason});assert.equal(calls,1);
});
test('new plan construction refuses unadmitted storage while old plans remain verifiable',()=>{
 const f=previewPlanFixture(),historical=structuredClone(f.plan);historical.request.storage.storage.schema=1;delete historical.request.storage.storage.admission;historical.request.storage.sha256=hash(jsonBytes(historical.request.storage.storage));assert.deepEqual(validatePreviewPlan(historical),historical);assert.throws(()=>createPreviewPlan(historical.request),{code:'PREVIEW_PLAN_REFUSED'});
});

test('retained reservations close admission and duplicate identities cannot inflate free capacity',async()=>{
 const value=report();value.reservations=[1,2].map(n=>({schema:1,kind:'fogd-preview-storage-hold',profileId:value.policy.id,reservation:`00000000-0000-4000-8000-00000000000${n}`,project:'fogd-preview-'+String(n).repeat(32),engineId:input.engineId,backingBytes:previewStorageBytes,chargeBytes:previewStorageChargeBytes}));Object.assign(value,{heldProjects:2,heldChargeBytes:2*previewStorageChargeBytes,remainingProjects:0,admissionOpen:false});const runHost=async()=>JSON.stringify({ok:true,admission:value});assert.equal((await inspectPreviewStorageAdmission({...input,runHost})).heldProjects,2);value.reservations[1].reservation=value.reservations[0].reservation;await assert.rejects(inspectPreviewStorageAdmission({...input,runHost}),refused);
});


test('initialization cannot acknowledge a different configured limit',async()=>{
 await assert.rejects(initializePreviewStorageAdmission({...input,runHost:async()=>JSON.stringify({ok:true,admission:report()})},{maxProjects:3}),{code:'PREVIEW_STORAGE_REFUSED'});
});


function quarantinedReport() {
 const value=report();const row={schema:1,kind:'fogd-preview-storage-hold',profileId:value.policy.id,reservation:'00000000-0000-4000-8000-000000000002',project:'fogd-preview-'+'a'.repeat(32),engineId:input.engineId,backingBytes:previewStorageBytes,chargeBytes:previewStorageChargeBytes};
 Object.assign(value,{reservations:[row],heldProjects:1,heldChargeBytes:previewStorageChargeBytes,remainingProjects:1,quarantinedProjects:1,quarantinedChargeBytes:previewStorageChargeBytes,quarantines:[{operation:'00000000-0000-4000-8000-000000000003',project:row.project,profileId:row.profileId,reservation:row.reservation,chargeBytes:row.chargeBytes}]});return value;
}

test('explicit quarantine reports retained capacity and exact operation without execution authority',async()=>{
 const value=quarantinedReport(),calls=[],row=value.quarantines[0];const result=await quarantinePreviewStorage({...input,project:row.project,runHost:async(args,options)=>{calls.push(JSON.parse(options.inputText));return JSON.stringify({ok:true,admission:value})}},{operation:row.operation});
 assert.deepEqual(calls,[{action:'quarantine',...input,project:row.project,operation:row.operation}]);assert.equal(result.heldProjects,1);assert.equal(result.quarantinedProjects,1);assert.equal(result.executionAuthorized,false);
});

test('quarantine requires valid owner-selected identities before host execution',async()=>{
 let calls=0;for(const extra of [{project:'../other',operation:'00000000-0000-4000-8000-000000000003'},{project:'fogd-preview-'+'a'.repeat(32),operation:'bad'}])await assert.rejects(quarantinePreviewStorage({...input,project:extra.project,runHost:async()=>{calls++}},{operation:extra.operation}),refused);assert.equal(calls,0);
});

for(const[name,change]of Object.entries({charge:x=>x.quarantinedChargeBytes=0,foreignHold:x=>x.quarantines[0].reservation='00000000-0000-4000-8000-000000000009',wrongOperation:x=>x.quarantines[0].operation='00000000-0000-4000-8000-000000000009',space:x=>{x.space.availableBytes=previewStorageBytes+previewStorageChargeBytes;x.admissionOpen=true},inodes:x=>{x.space.availableInodes=8224;x.admissionOpen=true},duplicate:x=>x.quarantines.push({...x.quarantines[0]})}))test(`quarantine rejects ${name} acknowledgments`,async()=>{
 const value=quarantinedReport(),row={...value.quarantines[0]};change(value);await assert.rejects(quarantinePreviewStorage({...input,project:row.project,runHost:async()=>JSON.stringify({ok:true,admission:value})},{operation:row.operation}),refused);
});

test('unknown quarantine effect is not automatically replayed',async()=>{
 const value=quarantinedReport(),row=value.quarantines[0];let calls=0;await assert.rejects(quarantinePreviewStorage({...input,project:row.project,runHost:async()=>{calls++;throw Error('private host detail')}},{operation:row.operation}),refused);assert.equal(calls,1);
});


test('hold repair binds the exact original digest or explicit absence without execution permission',async()=>{
 for(const holdSha256 of ['a'.repeat(64),null]){
  const value=quarantinedReport(),row=value.quarantines[0],calls=[];const result=await repairPreviewStorageHold({...input,project:row.project,runHost:async(args,options)=>{calls.push(JSON.parse(options.inputText));return JSON.stringify({ok:true,admission:value})}},{operation:row.operation,holdSha256});
  assert.deepEqual(calls,[{action:'repair-hold',...input,project:row.project,operation:row.operation,holdSha256}]);assert.equal(result.heldChargeBytes,previewStorageChargeBytes);assert.equal(result.quarantinedProjects,1);assert.equal(result.executionAuthorized,false);
 }
});

test('hold repair requires an explicit valid fingerprint before contacting the host',async()=>{
 const row=quarantinedReport().quarantines[0];let calls=0;for(const holdSha256 of [undefined,'','bad','A'.repeat(64),0])await assert.rejects(repairPreviewStorageHold({...input,project:row.project,runHost:async()=>{calls++}},{operation:row.operation,holdSha256}),refused);assert.equal(calls,0);
});

test('hold repair cannot acknowledge another operation or silently retry unknown effects',async()=>{
 const value=quarantinedReport(),row=value.quarantines[0];let calls=0;await assert.rejects(repairPreviewStorageHold({...input,project:row.project,runHost:async()=>{calls++;throw Error('private diagnostic')}},{operation:row.operation,holdSha256:null}),refused);assert.equal(calls,1);
 await assert.rejects(repairPreviewStorageHold({...input,project:row.project,runHost:async()=>JSON.stringify({ok:true,admission:value})},{operation:'00000000-0000-4000-8000-000000000009',holdSha256:null}),refused);
});
