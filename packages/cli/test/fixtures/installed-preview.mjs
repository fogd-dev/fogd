import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, jsonBytes } from '../../src/build-cache/paths.mjs';
import { inspectPreviewStartup } from '../../src/preview/startup-inspection.mjs';
import { initializePreviewHost, reservePreviewHost } from '../../src/preview/host-reservations.mjs';
import { preparePreviewInputPackage } from '../../src/preview/input-package.mjs';
import { assertStoppedPreviewGraph } from '../../src/preview/stopped-graph.mjs';
import { previewPlanSha256 } from '../../src/preview/plan.mjs';
import { previewInputFixture } from './preview-input-package.mjs';
import { stoppedPreviewFixture } from './stopped-preview.mjs';
import { reviewFixture, id } from './artifact-review.mjs';
import { copyPreviewRuntime, previewProcessCommand } from './preview-docker.mjs';

export async function installedPreviewFixture(t, respond, { runtime } = {}) {
 const source=await reviewFixture(t,respond,['preview']);
 const prepared=JSON.parse((await source.run(['prepare',id,'--runtime','celld-archive-v9-linux-arm64','--lifetime-seconds','60','--output',source.output])).stdout);
 const preparation=JSON.parse(await readFile(join(source.output,'preview.json')));
 if(runtime){preparation.runtime={family:runtime.id,catalogEntrySha256:hash(jsonBytes(runtime))};await writeFile(join(source.output,'preview.json'),jsonBytes(preparation));prepared.preparationSha256=hash(jsonBytes(preparation))}
 const input=await previewInputFixture(t,{preparation,artifact:source.after,image:runtime?.image});
 assert.equal(prepared.preparationSha256,input.request.preparationSha256);
 const f=stoppedPreviewFixture({...input,authority:input.signer,storagePassword:input.options.secretValues.storagePassword,gatewayToken:input.options.secretValues.gatewayToken});
 const root=join(input.root,'host');await mkdir(root,{mode:0o700});let observed={...f.observed,containers:[],networks:[],volumes:[]};const calls=[],snapshot=await preparePreviewInputPackage(input.authority,input.bundle),mounted=structuredClone(snapshot.files);
 const run=async args=>{
  calls.push(args);if(args[0]==='info')return JSON.stringify(observed.host);if(args[0]==='image')return JSON.stringify([f.image]);
  if(['start','stop','wait','exec'].includes(args[0]))return previewProcessCommand(observed,args);
  if(args[0]==='cp'){
   if(args[1].endsWith(':/app/packages/.'))throw Error('Docker rejects dependency links outside the copied package directory');
   if(args[1].includes(':/app/packages/'))return copyPreviewRuntime(runtime,args[1].split(':')[1],args[2]);
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
 const args={root,plan:f.plan,allocationId:f.allocationId,reservation:held.reservation,envelope:f.envelope,expectedImage:f.plan.request.image,directory:source.output,env:source.env,run,...input.options,...(runtime?{runtime:runtime.id,candidateEnrollment:true}:{})};
 return {source,input,f,root,host,directory,mounted,calls,args,run,inspect:()=>inspectPreviewStartup(args)};
}
