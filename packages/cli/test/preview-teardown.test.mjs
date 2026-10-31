import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, chmod, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, jsonBytes } from '../src/build-cache/paths.mjs';
import { initializePreviewHost, reservePreviewHost, inspectPreviewHostReservations } from '../src/preview/host-reservations.mjs';
import { stopPreviewAllocation, releasePreviewMemory } from '../src/preview/teardown.mjs';
import { previewServiceInspection, previewServiceCommands } from '../src/preview/container-plan.mjs';
import { assertStoppedPreviewGraph } from '../src/preview/stopped-graph.mjs';
import { previewPlanSha256 } from '../src/preview/plan.mjs';
import { stoppedPreviewFixture } from './fixtures/stopped-preview.mjs';
import { previewPlanFixture } from './fixtures/preview-plan.mjs';

async function fixture(t,{live=true,failedStop,storageLost=false,unconfirmed=false}={}) {
 const f=stoppedPreviewFixture(),root=await mkdtemp(join(tmpdir(),'fogd-preview-stop-'));await chmod(root,0o700);t.after(()=>rm(root,{recursive:true,force:true}));
 let observed={...f.observed,containers:[],networks:[],volumes:[]};const calls=[],stopped=[];
 const run=async args=>{
  calls.push(args);
  if(args[0]==='info')return JSON.stringify(observed.host);
  if(args[0]==='image')return JSON.stringify([f.image]);
  if(args[0]==='stop'){
   const roles=args.slice(3).map(id=>observed.containers.find(c=>c.Id===id).Config.Labels['fogd.preview.role']);stopped.push(roles);
   if(failedStop&&roles.includes(failedStop))throw Error('Unknown stop result');
   if(!unconfirmed)for(const id of args.slice(3)){const c=observed.containers.find(c=>c.Id===id);Object.assign(c.State,{Running:false,Pid:0,Status:'exited',ExitCode:0})}
   if(storageLost){const c=observed.containers.find(c=>c.Config.Labels['fogd.preview.role']==='minio');Object.assign(c.State,{Running:false,Pid:0,Status:'exited',ExitCode:0})}
   return args.slice(3).join('\n');
  }
  const values=observed[{container:'containers',network:'networks',volume:'volumes'}[args[0]]];
  if(args[1]==='ls')return values.map(v=>args[0]==='volume'?v.Name:v.Id).join('\n');
  if(args[1]==='inspect')return JSON.stringify(values);throw Error('Unexpected effect');
 };
 await initializePreviewHost({root,engineId:f.plan.request.engineId,run});const held=await reservePreviewHost({root,plan:f.plan,run});
 const host=join(root,hash(f.plan.request.engineId)),directory=join(host,'allocations',f.plan.project);await mkdir(directory,{mode:0o700});
 const pending={schema:1,kind:'fogd-preview-stopped-allocation',allocationId:f.allocationId,reservation:held.reservation,planSha256:previewPlanSha256(f.plan),grantSha256:f.options.expectedGrantSha256,expiresAt:f.envelope.grant.expiresAt};
 const graph=assertStoppedPreviewGraph(f.plan,f.observed,f.image,f.commands,f.allocationId,f.created);
 await writeFile(join(directory,'allocation.pending.json'),jsonBytes(pending),{mode:0o600});await writeFile(join(directory,'allocation.complete.json'),jsonBytes({...pending,inventorySha256:graph.inventorySha256,identities:graph.identities}),{mode:0o600});
 observed=f.observed;
 if(live){
  observed.networks.push({Name:'none',Id:'f'.repeat(64),Driver:'null',Scope:'local',Labels:{},IPAM:{Config:null}});
  observed.containers.forEach((c,index)=>{Object.assign(c.State,{Running:true,Pid:index+100,Status:'running',StartedAt:new Date().toISOString()});if(c.Config.Labels['fogd.preview.role']==='input-installer')c.NetworkSettings.Networks={none:{NetworkID:'f'.repeat(64)}}});
 }
 const args={root,plan:f.plan,allocationId:f.allocationId,reservation:held.reservation,envelope:f.envelope,expectedImage:f.plan.request.image,run,...f.options};
 return{...f,root,host,directory,calls,stopped,args,stop:()=>stopPreviewAllocation(args),release:()=>releasePreviewMemory(args),next:()=>reservePreviewHost({root,plan:previewPlanFixture(249,49444).plan,run})};
}
test('bound expired inspection returns configuration only while execution command realization still refuses',t=>{
 const f=stoppedPreviewFixture();t.mock.method(Date,'now',()=>Date.parse(f.envelope.grant.expiresAt));
 const view=previewServiceInspection(f.plan,f.envelope,f.options,f.allocationId);
 assert.equal(Object.keys(view).length,10);assert.ok(Object.values(view).every(value=>!Object.hasOwn(value,'create')&&!Object.hasOwn(value,'connect')));
 assert.throws(()=>previewServiceCommands(f.plan,f.envelope,f.options,f.allocationId),{code:'PREVIEW_PLAN_REFUSED'});
 const wrong={...f.options,publicKey:previewPlanFixture().authority.publicKey};assert.throws(()=>previewServiceInspection(f.plan,f.envelope,wrong,f.allocationId),{code:'PREVIEW_PLAN_REFUSED'});
});
test('teardown denies ingress, stops management and writers, then storage; budget remains held',async t=>{
 const f=await fixture(t),result=await f.stop();assert.equal(result.ordered,true);assert.equal(result.memoryBudgetHeld,true);assert.equal(result.namespaceReusable,false);
 assert.deepEqual(f.stopped,[['ingress'],['gateway','controller','input-installer','bucket-init'],['slot-1-a','slot-1-b','slot-2-a','slot-2-b'],['minio']]);
 assert.ok(f.calls.every(a=>!['start','run','rm','kill','restart'].includes(a[0])));
 await assert.rejects(f.next(),{code:'PREVIEW_ADMISSION_REFUSED',reason:'capacity'});
 await assert.rejects(f.release(),{code:'PREVIEW_HOST_REFUSED',reason:'not-expired'});
 assert.ok(!(await readdir(f.directory)).includes('memory.released.json'));
 assert.equal((await inspectPreviewHostReservations({root:f.root,engineId:f.plan.request.engineId})).length,1);
});
for(const role of ['ingress','controller','slot-1-a','minio'])test(`ambiguous ${role} stop retains fence and cannot continue or replay`,async t=>{
 const f=await fixture(t,{failedStop:role});await assert.rejects(f.stop(),{code:'PREVIEW_HOST_REFUSED',reason:'uncertain'});
 const count=f.stopped.length;assert.ok(!(await readdir(f.directory)).includes('teardown.complete.json'));assert.equal(JSON.parse(await readFile(join(f.host,'launch.pending.json'))).phase,'writing');
 if(role!=='minio')assert.ok(!f.stopped.some(group=>group.includes('minio')));
 await assert.rejects(f.stop(),{code:'PREVIEW_HOST_REFUSED',reason:'pending'});assert.equal(f.stopped.length,count);
});
test('successful Docker output is insufficient without observed stop; storage stays untouched',async t=>{
 const f=await fixture(t,{unconfirmed:true});await assert.rejects(f.stop(),{code:'PREVIEW_HOST_REFUSED',reason:'stop-unconfirmed'});
 assert.deepEqual(f.stopped,[['ingress']]);assert.ok(!(await readdir(f.directory)).includes('memory.released.json'));
});
test('storage lost before writer exit is recorded as uncertain and cannot release its budget',async t=>{
 const f=await fixture(t,{storageLost:true}),result=await f.stop();assert.equal(result.ordered,false);
 t.mock.method(Date,'now',()=>Date.parse(f.envelope.grant.expiresAt)+1);
 await assert.rejects(f.release(),{code:'PREVIEW_HOST_REFUSED',reason:'teardown-unconfirmed'});assert.ok(!(await readdir(f.directory)).includes('memory.released.json'));
});
test('explicit expired retirement frees only the held memory budget and preserves resources, records and namespace refusal',async t=>{
 const f=await fixture(t),volumes=structuredClone(f.observed.volumes),networks=structuredClone(f.observed.networks);await f.stop();
 t.mock.method(Date,'now',()=>Date.parse(f.envelope.grant.expiresAt)+1);
 const released=await f.release();assert.deepEqual(released,{memoryBudgetReleased:true,resourcesRetained:true,namespaceReusable:false,dataDurability:'not-assessed',executionAuthorized:false});
 assert.deepEqual(f.observed.volumes,volumes);assert.deepEqual(f.observed.networks,networks);assert.equal(f.observed.containers.length,10);
 const next=await f.next();assert.equal(next.memory.heldLimitBytes,0);assert.equal(next.capacityReserved,true);
 assert.equal((await inspectPreviewHostReservations({root:f.root,engineId:f.plan.request.engineId})).length,2);
 await assert.rejects(reservePreviewHost({root:f.root,plan:f.plan,run:f.args.run}),{code:'PREVIEW_ADMISSION_REFUSED',reason:'resources-exist'});
 await assert.rejects(f.release(),{code:'PREVIEW_HOST_REFUSED',reason:'reservation'});
});
for(const corrupt of ['partial','missing-phase','changed-proof','future-release'])test(`corrupt retirement never frees memory: ${corrupt}`,async t=>{
 const f=await fixture(t,{live:false});await f.stop();t.mock.method(Date,'now',()=>Date.parse(f.envelope.grant.expiresAt)+1);await f.release();
 const file=join(f.directory,'memory.released.json');
 if(corrupt==='partial')await writeFile(file,'{');
 if(corrupt==='missing-phase')await rm(join(f.directory,'teardown.writers.json'));
 if(corrupt==='changed-proof'){const proof=JSON.parse(await readFile(join(f.directory,'teardown.complete.json')));proof.ordered=false;await writeFile(join(f.directory,'teardown.complete.json'),jsonBytes(proof))}
 if(corrupt==='future-release'){const record=JSON.parse(await readFile(file));record.releasedAt=new Date(Date.now()+60000).toISOString();await writeFile(file,jsonBytes(record))}
 await assert.rejects(f.next(),{code:'PREVIEW_HOST_REFUSED'});assert.ok((await readdir(f.host)).includes('launch.pending.json'));
});
test('mismatched actual container identity refuses before any stop command',async t=>{
 const f=await fixture(t);f.observed.containers[0].Id='e'.repeat(64);await assert.rejects(f.stop(),{code:'PREVIEW_HOST_REFUSED',reason:'stopped-graph'});assert.deepEqual(f.stopped,[]);
});

test('late observation of previously active writers cannot retroactively claim ordered shutdown',async t=>{
 const f=await fixture(t);for(const c of f.observed.containers)Object.assign(c.State,{Running:false,Pid:0,Status:'exited',ExitCode:0});
 const result=await f.stop();assert.equal(result.storageRequired,true);assert.equal(result.ordered,false);
 t.mock.method(Date,'now',()=>Date.parse(f.envelope.grant.expiresAt)+1);
 await assert.rejects(f.release(),{code:'PREVIEW_HOST_REFUSED',reason:'teardown-unconfirmed'});
});
test('input-only installer activity has no MinIO dependency when storage writers never started',async t=>{
 const f=await fixture(t,{live:false}),c=f.observed.containers.find(c=>c.Config.Labels['fogd.preview.role']==='input-installer');
 f.observed.networks.push({Name:'none',Id:'f'.repeat(64),Driver:'null',Scope:'local',Labels:{},IPAM:{Config:null}});c.NetworkSettings.Networks={none:{NetworkID:'f'.repeat(64)}};
 Object.assign(c.State,{Running:true,Pid:100,Status:'running',StartedAt:new Date().toISOString()});
 const result=await f.stop();assert.equal(result.storageRequired,false);assert.equal(result.ordered,true);
});
