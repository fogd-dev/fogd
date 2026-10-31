import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { jsonBytes } from '../src/build-cache/paths.mjs';
import { id } from './fixtures/artifact-review.mjs';
import { installedPreviewFixture as fixture } from './fixtures/installed-preview.mjs';

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
