import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, jsonBytes } from '../src/build-cache/paths.mjs';
import { initializePreviewHost, reservePreviewHost } from '../src/preview/host-reservations.mjs';
import { installPreviewInputs } from '../src/preview/input-installation.mjs';
import { assertStoppedPreviewGraph } from '../src/preview/stopped-graph.mjs';
import { previewPlanSha256 } from '../src/preview/plan.mjs';
import { previewInputFixture } from './fixtures/preview-input-package.mjs';
import { stoppedPreviewFixture } from './fixtures/stopped-preview.mjs';

async function fixture(t) {
 const input=await previewInputFixture(t),f=stoppedPreviewFixture({...input,authority:input.signer,storagePassword:input.options.secretValues.storagePassword,gatewayToken:input.options.secretValues.gatewayToken});
 const root=join(input.root,'host');await mkdir(root,{mode:0o700});let observed={...f.observed,containers:[],networks:[],volumes:[]};const calls=[];
 const run=async args=>{
  calls.push(args);if(args[0]==='info')return JSON.stringify(observed.host);if(args[0]==='image')return JSON.stringify([f.image]);
  if(args[0]==='start')throw Error('Unknown installer result');
  const values=observed[{container:'containers',network:'networks',volume:'volumes'}[args[0]]];
  if(args[1]==='ls')return values.map(v=>args[0]==='volume'?v.Name:v.Id).join('\n');
  if(args[1]==='inspect')return JSON.stringify(values);throw Error('Unexpected effect');
 };
 await initializePreviewHost({root,engineId:f.plan.request.engineId,run});const held=await reservePreviewHost({root,plan:f.plan,run});observed=f.observed;
 const host=join(root,hash(f.plan.request.engineId)),directory=join(host,'allocations',f.plan.project);await mkdir(directory,{mode:0o700});
 const pending={schema:1,kind:'fogd-preview-stopped-allocation',allocationId:f.allocationId,reservation:held.reservation,planSha256:previewPlanSha256(f.plan),grantSha256:input.options.expectedGrantSha256,expiresAt:f.envelope.grant.expiresAt};
 const graph=assertStoppedPreviewGraph(f.plan,f.observed,f.image,f.commands,f.allocationId,f.created);
 await writeFile(join(directory,'allocation.pending.json'),jsonBytes(pending),{mode:0o600});await writeFile(join(directory,'allocation.complete.json'),jsonBytes({...pending,inventorySha256:graph.inventorySha256,identities:graph.identities}),{mode:0o600});
 return{f,input,root,host,directory,calls,install:()=>installPreviewInputs({root,plan:f.plan,allocationId:f.allocationId,reservation:held.reservation,envelope:f.envelope,bundle:input.bundle,expectedImage:f.plan.request.image,run,...input.options})};
}
test('ambiguous installer result retains inputs journal, package, capacity and fence without starting applications or replay',async t=>{
 const x=await fixture(t);await assert.rejects(x.install(),{code:'PREVIEW_HOST_REFUSED',reason:'uncertain'});
 assert.equal(x.calls.filter(a=>a[0]==='start').length,1);assert.deepEqual(x.calls.find(a=>a[0]==='start'),['start','--attach','--interactive',x.f.created.containers['input-installer']]);
 const pending=JSON.parse(await readFile(join(x.directory,'inputs.pending.json')));assert.equal(pending.packageSha256,hash(await readFile(join(x.directory,'inputs.package.json'))));
 assert.ok(!(await readdir(x.directory)).includes('inputs.complete.json'));
 assert.equal(JSON.parse(await readFile(join(x.host,'launch.pending.json'))).phase,'writing');assert.equal((await readdir(join(x.host,'holds'))).length,1);
 await assert.rejects(x.install(),{code:'PREVIEW_HOST_REFUSED',reason:'pending'});assert.equal(x.calls.filter(a=>a[0]==='start').length,1);
 assert.ok(!x.calls.some(a=>['stop','rm','kill','restart','run'].includes(a[0])));
});
test('invalid input package refuses before acquiring a host fence or sending Docker effects',async t=>{
 const x=await fixture(t),before=x.calls.length;x.input.bundle.ingress.accessKey='f'.repeat(64);
 await assert.rejects(x.install(),{code:'PREVIEW_EXECUTION_REFUSED'});assert.equal(x.calls.length,before);
 assert.ok(!(await readdir(x.host)).includes('launch.pending.json'));
});
