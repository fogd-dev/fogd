import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, jsonBytes } from '../src/build-cache/paths.mjs';
import { inspectPreviewStartup } from '../src/preview/startup-inspection.mjs';
import { initializePreviewHost, reservePreviewHost } from '../src/preview/host-reservations.mjs';
import { preparePreviewInputPackage } from '../src/preview/input-package.mjs';
import { assertStoppedPreviewGraph } from '../src/preview/stopped-graph.mjs';
import { previewPlanSha256 } from '../src/preview/plan.mjs';
import { previewInputFixture } from './fixtures/preview-input-package.mjs';
import { stoppedPreviewFixture } from './fixtures/stopped-preview.mjs';
import { reviewFixture, id } from './fixtures/artifact-review.mjs';

async function fixture(t, respond) {
 const source=await reviewFixture(t,respond,['preview']);
 const prepared=JSON.parse((await source.run(['prepare',id,'--runtime','celld-archive-v9-linux-arm64','--lifetime-seconds','60','--output',source.output])).stdout);
 const preparation=JSON.parse(await readFile(join(source.output,'preview.json'))),input=await previewInputFixture(t,{preparation,artifact:source.after});
 assert.equal(prepared.preparationSha256,input.request.preparationSha256);
 const f=stoppedPreviewFixture({...input,authority:input.signer,storagePassword:input.options.secretValues.storagePassword,gatewayToken:input.options.secretValues.gatewayToken});
 const root=join(input.root,'host');await mkdir(root,{mode:0o700});let observed={...f.observed,containers:[],networks:[],volumes:[]};const calls=[],snapshot=await preparePreviewInputPackage(input.authority,input.bundle),mounted=structuredClone(snapshot.files);
 const run=async args=>{
  calls.push(args);if(args[0]==='info')return JSON.stringify(observed.host);if(args[0]==='image')return JSON.stringify([f.image]);
  if(args[0]==='cp'){
   const [container,path]=args[1].split(':'),role=Object.keys(f.created.containers).find(r=>f.created.containers[r]===container),group=role+(path.includes('-trust')?'-trust':'-input');
   for(const[name,bytes]of Object.entries(mounted[group]))await writeFile(join(args[2],name),bytes,{mode:0o600});return '';
  }
  const values=observed[{container:'containers',network:'networks',volume:'volumes'}[args[0]]];
  if(args[1]==='ls')return values.map(v=>args[0]==='volume'?v.Name:v.Id).join('\n');
  if(args[1]==='inspect')return JSON.stringify(values);throw Error('Unexpected effect');
 };
 await initializePreviewHost({root,engineId:f.plan.request.engineId,run});const held=await reservePreviewHost({root,plan:f.plan,run});observed=f.observed;
 const host=join(root,hash(f.plan.request.engineId)),directory=join(host,'allocations',f.plan.project);await mkdir(directory,{mode:0o700});
 const pending={schema:1,kind:'fogd-preview-stopped-allocation',allocationId:f.allocationId,reservation:held.reservation,planSha256:previewPlanSha256(f.plan),grantSha256:input.options.expectedGrantSha256,expiresAt:f.envelope.grant.expiresAt};
 const graph=assertStoppedPreviewGraph(f.plan,f.observed,f.image,f.commands,f.allocationId,f.created);
 await writeFile(join(directory,'allocation.pending.json'),jsonBytes(pending),{mode:0o600});await writeFile(join(directory,'allocation.complete.json'),jsonBytes({...pending,inventorySha256:graph.inventorySha256,identities:graph.identities}),{mode:0o600});
 const install={schema:1,kind:'fogd-preview-input-installation',allocationId:f.allocationId,reservation:held.reservation,planSha256:pending.planSha256,grantSha256:pending.grantSha256,packageSha256:snapshot.sha256,inventorySha256:graph.inventorySha256};
 await writeFile(join(directory,'inputs.pending.json'),jsonBytes(install),{mode:0o600});await writeFile(join(directory,'inputs.complete.json'),jsonBytes({...install,files:snapshot.manifest}),{mode:0o600});await writeFile(join(directory,'inputs.package.json'),snapshot.bytes,{mode:0o600});await mkdir(join(directory,'input-readback'),{mode:0o700});
 observed.networks.push({Name:'none',Id:'f'.repeat(64),Driver:'null',Scope:'local',Labels:{},IPAM:{Config:null}});
 const installer=observed.containers.find(c=>c.Id===f.created.containers['input-installer']);Object.assign(installer.State,{Status:'exited',StartedAt:new Date().toISOString()});installer.NetworkSettings.Networks={none:{NetworkID:'f'.repeat(64)}};
 calls.length=0;source.calls.length=0;
 const args={root,plan:f.plan,allocationId:f.allocationId,reservation:held.reservation,envelope:f.envelope,expectedImage:f.plan.request.image,directory:source.output,env:source.env,run,...input.options};
 return {source,input,f,root,host,directory,mounted,calls,args,inspect:()=>inspectPreviewStartup(args)};
}

test('startup inspection rechecks current source, actual mounted bytes and capacity without starting or changing the allocation',async t=>{
 const x=await fixture(t),before=structuredClone(x.f.observed),names=await readdir(x.directory),result=await x.inspect();
 assert.equal(result.startupInspected,true);assert.equal(result.executionAuthorized,false);assert.equal(result.runtimeExecutionAdmitted,false);assert.equal(result.capacityReserved,true);
 assert.equal(result.memory.heldLimitBytes,0);assert.equal(result.memory.requestedLimitBytes,5234491392);assert.equal(result.expiresAt,x.f.envelope.grant.expiresAt);
 assert.equal(x.calls.filter(c=>c[0]==='cp').length,6);assert.ok(x.calls.every(c=>['info','image','container','network','volume','cp'].includes(c[0])));
 assert.equal(x.source.calls.length,2);assert.ok(x.source.calls.every(c=>c.path==='/v1/admin'&&c.method==='GET'));assert.deepEqual(x.f.observed,before);assert.deepEqual(await readdir(x.directory),names);
 assert.ok(!(await readdir(x.host)).includes('launch.pending.json'));
});
for(const change of ['mounted-artifact','mounted-secret','mounted-tls','extra-file','package','completion','unfinished-operation','started-writer','unbounded-peer'])test(`startup inspection refuses ${change} without starting anything`,async t=>{
 const x=await fixture(t);
 if(change==='mounted-artifact')x.mounted['controller-input']['artifact.json']+=' ';
 if(change==='mounted-secret')x.mounted['controller-input']['secrets.json']='{}';
 if(change==='mounted-tls')x.mounted['gateway-input']['service.json']='{}';
 if(change==='extra-file')x.mounted['ingress-input'].extra='unexpected';
 if(change==='package')await writeFile(join(x.directory,'inputs.package.json'),'{}');
 if(change==='completion'){const p=join(x.directory,'inputs.complete.json'),v=JSON.parse(await readFile(p));v.packageSha256='0'.repeat(64);await writeFile(p,jsonBytes(v),{mode:0o600})}
 if(change==='unfinished-operation')await writeFile(join(x.directory,'teardown.pending.json'),'{}',{mode:0o600});
 if(change==='started-writer')Object.assign(x.f.observed.containers[0].State,{Status:'exited',StartedAt:new Date().toISOString()});
 if(change==='unbounded-peer'){const c=structuredClone(x.f.observed.containers[0]);c.Id='e'.repeat(64);c.Name='/unrelated-running';c.Config.Labels={};c.HostConfig.Mounts=[];c.Mounts=[];c.NetworkSettings.Networks={};c.HostConfig.NetworkMode='none';c.HostConfig.Memory=0;Object.assign(c.State,{Running:true,Pid:999,Status:'running'});x.f.observed.containers.push(c)}
 await assert.rejects(x.inspect());assert.ok(!x.calls.some(c=>['start','stop','run','rm','kill','restart'].includes(c[0])));assert.ok(!(await readdir(x.host)).includes('launch.pending.json'));
});
for(const change of ['proposal','active','private-guard'])test(`source ${change} changes after signing refuse startup inspection`,async t=>{
 let checking=false;const x=await fixture(t,({state,calls,request})=>{if(checking&&request.url==='/v1/admin'){if(change==='proposal')state.deployments[id].status='rejected';if(change==='active')state.apps['review-app'].route='paused';if(change==='private-guard'&&calls.length===2)state.deployments[id].private='changed'}return false});checking=true;
 await assert.rejects(x.inspect(),{code:'PREVIEW_HOST_REFUSED'});assert.ok(x.source.calls.every(c=>c.method==='GET'));assert.ok(!x.calls.some(c=>c[0]==='start'));
});
test('independently configured endpoint mismatch sends no source credentials',async t=>{
 const x=await fixture(t);x.args.env={...x.source.env,FOGD_SERVER:'http://127.0.0.1:1'};await assert.rejects(x.inspect());assert.deepEqual(x.source.calls,[]);
});
test('expired inspection refuses before Docker, source requests or host fence creation',async t=>{
 const x=await fixture(t);t.mock.method(Date,'now',()=>Date.parse(x.f.envelope.grant.expiresAt));await assert.rejects(x.inspect(),{code:'PREVIEW_PLAN_REFUSED'});assert.deepEqual(x.calls,[]);assert.deepEqual(x.source.calls,[]);assert.ok(!(await readdir(x.host)).includes('launch.pending.json'));
});
for(const change of ['deadline','writer'])test(`startup inspection rechecks ${change} after slow source observation`,async t=>{
 let checking=false,x,now; x=await fixture(t,({calls,request})=>{if(checking&&request.url==='/v1/admin'&&calls.length===2){if(change==='deadline')now=Date.parse(x.f.envelope.grant.expiresAt);else Object.assign(x.f.observed.containers[0].State,{Status:'running',Running:true,Pid:100,StartedAt:new Date().toISOString()})}return false});
 now=Date.now();t.mock.method(Date,'now',()=>now);checking=true;
 await assert.rejects(x.inspect());assert.ok(!x.calls.some(c=>c[0]==='start'));assert.ok(!(await readdir(x.host)).includes('launch.pending.json'));
});
test('a mismatched hold refuses without Docker or latching the checking fence',async t=>{
 const x=await fixture(t);x.args.reservation='00000000-0000-4000-8000-000000000099';await assert.rejects(x.inspect(),{code:'PREVIEW_HOST_REFUSED',reason:'reservation'});assert.deepEqual(x.calls,[]);assert.ok(!(await readdir(x.host)).includes('launch.pending.json'));
});
