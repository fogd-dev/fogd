import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../src/build-cache/paths.mjs';
import { assertStoppedPreviewGraph, assertPreviewAllocationImage } from '../src/preview/stopped-graph.mjs';
import { allocateStoppedPreview } from '../src/preview/stopped-allocation.mjs';
import { initializePreviewHost, reservePreviewHost, inspectPreviewHostReservations } from '../src/preview/host-reservations.mjs';
import { stoppedPreviewFixture } from './fixtures/stopped-preview.mjs';

const verify = f => assertStoppedPreviewGraph(f.plan,f.observed,f.image,f.commands,f.allocationId,f.created);
const refused = { code:'PREVIEW_HOST_REFUSED',reason:'stopped-graph' };
test('complete never-started graph binds physical identities and signed configuration', () => {
  const f=stoppedPreviewFixture(), first=verify(f); assert.match(first.inventorySha256,/^[a-f0-9]{64}$/);
  assert.equal(Object.keys(first.identities.containers).length,9); assert.equal(Object.keys(first.identities.volumes).length,12);
  f.observed.containers.reverse(); assert.deepEqual(verify(f),first);
  f.observed.containers[0].State.StartedAt=new Date().toISOString();assert.throws(()=>verify(f),refused);
});
for(const [name,change] of Object.entries({
  running:f=>{f.observed.containers[0].State.Running=true},
  extraVolume:f=>{f.observed.volumes.push({...f.observed.volumes[0],Name:f.plan.project+'_foreign'})},
  extraContainer:f=>{f.observed.containers.push({...f.observed.containers[0],Id:'f'.repeat(64),Name:'/'+f.plan.project+'-foreign'})},
  missingRole:f=>{f.observed.containers.pop()},
  writableTrust:f=>{f.observed.containers.find(c=>c.Config.Labels['fogd.preview.role']==='ingress').Mounts[0].RW=true},
  wrongPhysicalMount:f=>{f.observed.containers[0].Mounts[0].Source='/foreign'},
  seededMount:f=>{f.observed.containers[0].HostConfig.Mounts[0].VolumeOptions.NoCopy=false},
  privileged:f=>{f.observed.containers[0].HostConfig.Privileged=true},
  wrongCap:f=>{f.observed.containers[0].HostConfig.CapDrop=[]},
  changedImage:f=>{f.observed.containers[0].Image='sha256:'+'f'.repeat(64)},
  extraEnvironment:f=>{f.observed.containers[0].Config.Env.push('NODE_OPTIONS=--inspect=0.0.0.0')},
  extendedDeadline:f=>{f.observed.containers[0].Config.Cmd[2]='2099-01-01T00:00:00.000Z'},
  wrongMemory:f=>{f.observed.containers[0].HostConfig.Memory=0},
  wrongCpu:f=>{f.observed.containers[0].HostConfig.NanoCpus=0},
  publicPort:f=>{f.observed.containers.at(-1).HostConfig.PortBindings['8080/tcp'][0].HostIp='0.0.0.0'},
  extraNetwork:f=>{f.observed.containers[2].NetworkSettings.Networks.foreign={NetworkID:'f'.repeat(64)}},
  wrongNetwork:f=>{f.observed.networks[0].Id='f'.repeat(64)},
  externalEgress:f=>{f.observed.networks[0].Internal=false},
  foreignAllocation:f=>{f.observed.volumes[0].Labels['fogd.preview.allocation']='foreign'},
  hostDns:f=>{f.observed.containers[0].HostConfig.Dns=['8.8.8.8']},
  restart:f=>{f.observed.containers[0].HostConfig.RestartPolicy.Name='always'},
  extraAlias:f=>{Object.values(f.observed.containers[0].NetworkSettings.Networks)[0].Aliases.push('production')},
  wrongEngine:f=>{f.observed.host.ID='other'},
})) test(`stopped graph refuses ${name}`,()=>{const f=stoppedPreviewFixture();change(f);assert.throws(()=>verify(f),refused)});

test('unrelated retained container cannot mount preview storage or join its namespaces',()=>{
 for(const extra of [{Mounts:[{Type:'volume',Name:'owned'}]},{HostConfig:{NetworkMode:'joined'}}]) {
  const f=stoppedPreviewFixture(),foreign={Id:'f'.repeat(64),Name:'/peer',Mounts:[],HostConfig:{},Config:{Labels:{}},NetworkSettings:{Networks:{}}};
  if(extra.Mounts) foreign.Mounts=[{Type:'volume',Name:f.observed.volumes[0].Name}];
  else foreign.HostConfig.NetworkMode='container:'+f.observed.containers[0].Id;
  f.observed.containers.push(foreign);assert.throws(()=>verify(f),refused);
 }
});
test('image identity check rejects image-seeded storage and independently different digest',()=>{
 const f=stoppedPreviewFixture();assertPreviewAllocationImage(f.plan,f.image,f.plan.request.image);
 f.image.Config.Volumes={'/data':{}};assert.throws(()=>assertPreviewAllocationImage(f.plan,f.image,f.plan.request.image),{code:'PREVIEW_HOST_REFUSED',reason:'allocation-image'});
 delete f.image.Config.Volumes;assert.throws(()=>assertPreviewAllocationImage(f.plan,f.image,'sha256:'+'f'.repeat(64)),{code:'PREVIEW_HOST_REFUSED',reason:'allocation-image'});
});
test('empty Docker mount driver descriptor is harmless; nonempty driver settings refuse',()=>{
 const f=stoppedPreviewFixture();f.observed.containers[0].HostConfig.Mounts[0].VolumeOptions.DriverConfig={};verify(f);
 f.observed.containers[0].HostConfig.Mounts[0].VolumeOptions.DriverConfig={Name:'foreign'};assert.throws(()=>verify(f),refused);
});
async function hostFixture(t) {
 const f=stoppedPreviewFixture(),root=await mkdtemp(join(tmpdir(),'fogd-allocate-'));await chmod(root,0o700);t.after(()=>rm(root,{recursive:true,force:true}));
 const calls=[],run=async args=>{calls.push(args);if(args[0]==='info')return JSON.stringify(f.observed.host);if(args[1]==='ls')return '';if(args[0]==='image')return JSON.stringify([f.image]);throw new Error('Effect observation deliberately lost')};
 await initializePreviewHost({root,engineId:f.plan.request.engineId,run});const held=await reservePreviewHost({root,plan:f.plan,run});
 const allocate=()=>allocateStoppedPreview({root,plan:f.plan,reservation:held.reservation,envelope:f.envelope,expectedImage:f.plan.request.image,run,...f.options});
 return{...f,root,run,calls,allocate,held};
}
test('ambiguous first Docker effect retains journal, full hold and host fence; no effect replay',async t=>{
 const f=await hostFixture(t);await assert.rejects(f.allocate(),{code:'PREVIEW_HOST_REFUSED',reason:'uncertain'});
 const dir=join(f.root,hash(f.plan.request.engineId)),allocation=join(dir,'allocations',f.plan.project);
 assert.deepEqual(await readdir(allocation),['allocation.pending.json']);
 const pending=JSON.parse(await readFile(join(allocation,'allocation.pending.json')));assert.equal(pending.reservation,f.held.reservation);assert.equal(pending.expiresAt,f.envelope.grant.expiresAt);
 assert.equal(JSON.parse(await readFile(join(dir,'launch.pending.json'))).phase,'writing');
 const effects=f.calls.filter(a=>a[0]==='network'&&a[1]==='create').length;assert.equal(effects,1);
 await assert.rejects(f.allocate(),{code:'PREVIEW_HOST_REFUSED',reason:'pending'});assert.equal(f.calls.filter(a=>a[1]==='create').length,effects);
 assert.equal((await readdir(join(dir,'holds'))).length,1);
 await assert.rejects(inspectPreviewHostReservations({root:f.root,engineId:f.plan.request.engineId}),{code:'PREVIEW_HOST_REFUSED',reason:'pending'});
 assert.ok(f.calls.every(a=>!['start','run','rm','stop','kill','restart'].includes(a[0])));
});
test('expired original execution grant refuses before host lock or Docker effects',async t=>{
 const f=await hostFixture(t),before=f.calls.length;t.mock.method(Date,'now',()=>Date.parse(f.envelope.grant.expiresAt));
 await assert.rejects(f.allocate(),{code:'PREVIEW_PLAN_REFUSED'});assert.equal(f.calls.length,before);
 assert.equal((await inspectPreviewHostReservations({root:f.root,engineId:f.plan.request.engineId})).length,1);
});
