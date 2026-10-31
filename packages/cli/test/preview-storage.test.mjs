import test from 'node:test';
import { previewStorageFixture } from './fixtures/preview-storage.mjs';
import assert from 'node:assert/strict';
import { preparePreviewStorage, inspectPreviewStorage, previewStorageBytes, previewStorageWorkerSha256 } from '../src/preview/storage.mjs';

const request=()=>({root:'/var/lib/fogd-preview-storage',project:'fogd-preview-'+'a'.repeat(32),engineId:'engine-fixture'});
const reply=input=>({ok:true,storage:previewStorageFixture(input.project,input.engineId,input.root).storage});
const refused={code:'PREVIEW_STORAGE_REFUSED'};

test('host storage transport binds the independently selected project and engine, without execution admission',async()=>{
 const input=request(),calls=[],runHost=async(args,options)=>{calls.push({args,body:JSON.parse(options.inputText)});return JSON.stringify(reply(input))};
 const prepared=await preparePreviewStorage({...input,runHost});assert.equal(prepared.executionAuthorized,false);assert.equal(prepared.ordinaryEnrollment,false);assert.equal(prepared.resourcesRetained,true);assert.equal(prepared.workerSha256,previewStorageWorkerSha256);assert.match(prepared.sha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(await inspectPreviewStorage({...input,runHost}),prepared);assert.deepEqual(calls.map(c=>c.body.action),['prepare','inspect']);assert.deepEqual(calls.map(c=>c.body.engineId),['engine-fixture','engine-fixture']);assert.ok(calls.every(c=>c.args[0]==='python3'&&c.args[1]==='-c'&&c.args.length===3));
});
test('unsafe or ambiguous storage requests refuse before invoking any host command',async()=>{
 for(const change of [x=>x.root='/var/lib/../danger',x=>x.root='/var/lib/storage/',x=>x.root='/var/lib/storage;echo',x=>x.project='../../data',x=>x.engineId='bad\nengine']){const input=request();change(input);let called=false;await assert.rejects(preparePreviewStorage({...input,runHost:async()=>{called=true}}),refused);assert.equal(called,false)}
});
for(const [name,change]of Object.entries({engine:x=>x.storage.engineId='another-engine',project:x=>x.storage.project='another-project',capacity:x=>x.storage.bytes=0,mount:x=>x.storage.mount.target='/var/lib/other',device:x=>x.storage.loop.name='/dev/sda',sparse:x=>x.storage.disk.allocatedBytes=0,offset:x=>x.storage.loop.offset=4096,weakMount:x=>x.storage.mount.options='rw,relatime',missingRole:x=>delete x.storage.roles.minio,roleReuse:x=>x.storage.roles.controller=x.storage.roles.minio,extra:x=>x.privateHostCredential='PRIVATE_HOST_SECRET',missing:x=>delete x.storage}))test(`host storage ${name} response refuses without unsafe diagnostics`,async()=>{
 const input=request(),data=reply(input);change(data);await assert.rejects(inspectPreviewStorage({...input,runHost:async()=>JSON.stringify(data)}),e=>e.code==='PREVIEW_STORAGE_REFUSED'&&!e.message.includes('PRIVATE_HOST_SECRET'));
});
test('unknown host preparation result propagates one sanitized refusal with no retry or cleanup',async()=>{
 let calls=0;await assert.rejects(preparePreviewStorage({...request(),runHost:async()=>{calls++;throw Error('PRIVATE_HOST_SECRET')}}),e=>e.code==='PREVIEW_STORAGE_REFUSED'&&!e.message.includes('PRIVATE_HOST_SECRET'));assert.equal(calls,1);
});
