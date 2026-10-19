// Stopped installation recovery followed by an actual older-snapshot rollback.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {context} from './queue-probe/context.mjs';
import {restoreBrowser,watchRestore} from './live-restore-browser.mjs';
import {expect} from './guestbook-browser.mjs';
import {request} from './http.mjs';
import {execute} from '../packages/cli/src/recovery/execute.mjs';
import {composeArgs,projectContainers} from '../packages/cli/src/recovery/docker.mjs';
import {inventory} from '../packages/cli/src/recovery/inventory.mjs';
import {composeResolved,restoredConfig} from '../packages/cli/src/recovery/bundle.mjs';
import {stackRoot} from '../packages/cli/src/local.mjs';
const probe=await context('slot-2',process.argv[2]);assert.match(probe.config.name,/^fogd-m11b[a-z0-9-]*$/);
const room=`restore-${randomUUID()}`,origin=`http://checklist.localhost:${probe.env.FOGD_HTTP_PORT}`;
const bundle=join(probe.output,'bundle'),targets=[],browsers=[];let sourceStopped=false;
const cli=async(args,label)=>{const log=await execute(process.execPath,[join(stackRoot,'packages/cli/bin/fogd.js'),...args],{env:probe.env});await writeFile(join(probe.output,`${label}.log`),log,{mode:0o600});};
const auth={Authorization:`Basic ${Buffer.from(`${probe.env.FOGD_ADMIN_USER}:${probe.env.FOGD_ADMIN_PASSWORD}`).toString('base64')}`};
async function admin(){const r=await fetch(`http://127.0.0.1:${probe.env.FOGD_ADMIN_PORT}/v1/admin`,{headers:auth,signal:AbortSignal.timeout(5000)});assert.equal(r.status,200);return r.json();}
async function healthy(){await expect.poll(async()=>{try{return (await request(`http://127.0.0.1:${probe.env.FOGD_HTTP_PORT}/rooms/${room}`,{headers:{host:'checklist.localhost'},signal:AbortSignal.timeout(3000)})).status;}catch{return 0;}},{timeout:120000,intervals:[1000]}).toBe(200);}
async function targetCompose(target,args){return execute('docker',[...composeArgs(target.file,target.project),...args]);}
async function restoreTarget(label,manifest){
  const project=`${probe.config.name}-restore-${randomUUID().slice(0,8)}`,output=join(probe.output,label),target={project,output,file:join(output,'compose.pending.json')};targets.push(target);
  await cli(['restore',bundle,'--project',project,'--output',output],`${label}-restore`);target.file=join(output,'compose.json');
  target.config=composeResolved(JSON.parse(await readFile(target.file,'utf8')));
  assert.deepEqual(target.config,restoredConfig(probe.config,project,manifest.images),'Only ordinary restore configuration transformations are allowed');
  const names=Object.values(target.config.volumes).map(v=>v.name),prior=[probe.config,...targets.filter(t=>t!==target&&t.config).map(t=>t.config)];
  for(const config of prior)assert.ok(Object.values(config.volumes).every(v=>!names.includes(v.name)),'Restoration must use fresh volumes');
  await targetCompose(target,['up','-d','--pull','never']);await healthy();
  assert.deepEqual(await inventory(target.config),manifest.images);
  target.mounts=(await projectContainers(project)).map(c=>({service:c.Config.Labels['com.docker.compose.service'],volumes:c.Mounts.filter(m=>m.Type==='volume').map(m=>m.Name),networks:Object.keys(c.NetworkSettings.Networks)}));
  for(const c of target.mounts){for(const name of c.volumes)assert.ok(names.includes(name));for(const name of c.networks)assert.ok(Object.values(target.config.networks).some(n=>n.name===name));}
  return target;
}
async function cleanupTarget(target){
  for(const file of [join(target.output,'compose.json'),join(target.output,'compose.pending.json')]){
    try{await access(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    target.file=file;await targetCompose(target,['down']);return;
  }
  assert.equal((await projectContainers(target.project)).length,0,'Partial target containers require inspection when both configuration files are missing');
}
async function otherSnapshot(){const r=await request(`http://127.0.0.1:${probe.env.FOGD_HTTP_PORT}/rooms/${room}`,{headers:{host:'live-probe.localhost'}});assert.equal(r.status,200);return r.json();}

try {
  const seed=await restoreBrowser(origin,room);browsers.push(seed.browser);await seed.status(0);
  await seed.edit('Included in stopped snapshot');await seed.status(1);
  const baseline=await seed.snapshot(),operation=seed.frames[0].message;assert.equal(operation.type,'operation');
  const receipt=await seed.replay(operation);assert.equal(receipt.revision,1);
  await seed.browser.close();browsers.pop();
  const other=await restoreBrowser(origin.replace('checklist.localhost','live-probe.localhost'),room);browsers.push(other.browser);await other.status(0);await other.edit('Other app snapshot');await other.status(1);const otherBaseline=await other.snapshot();await other.browser.close();browsers.pop();
  const metadata=await admin();
  await probe.save('baseline',{room,baseline,otherBaseline,operation,receipt});
  console.log('Clients closed; taking complete stopped installation backup');sourceStopped=true;
  await cli(['backup',bundle],'backup');const manifest=JSON.parse(await readFile(join(bundle,'manifest.json'),'utf8'));
  assert.deepEqual(manifest.exits.map(e=>e.service).sort(),Object.keys(probe.config.services).sort());
  assert.equal(manifest.queueRecovery,undefined);assert.ok(manifest.exits.every(e=>!e.oomKilled&&(e.service==='workerd'||e.exitCode===0)),'Clean stopped snapshot required; crash fallback is a separate contract');
  await probe.compose(['down']); // Retain all source volumes; release only this fixture's networks.
  const first=await restoreTarget('first',manifest),restoredMetadata=await admin();
  for(const name of ['checklist','live-probe']){assert.deepEqual(restoredMetadata.apps[name],metadata.apps[name]);const active=metadata.apps[name].active;assert.deepEqual(restoredMetadata.deployments[active],metadata.deployments[active]);}
  assert.deepEqual(await otherSnapshot(),otherBaseline);
  const writer=await restoreBrowser(origin,room);browsers.push(writer.browser);await writer.status(1);
  assert.deepEqual(await writer.snapshot(),baseline);assert.deepEqual(await writer.replay(operation),receipt);assert.deepEqual(await writer.snapshot(),baseline);
  const conflict=await writer.replay({...operation,operation:{...operation.operation,text:'Changed original operation'}},'rejected');assert.equal(conflict.reason,'operation-conflict');assert.deepEqual(await writer.snapshot(),baseline);
  console.log('Fresh-volume restore preserved board and original receipt');
  await writer.edit('Acknowledged after the snapshot');await writer.status(2);const later=await writer.snapshot();
  assert.equal(await writer.page.evaluate(room=>localStorage.getItem(`fogd-checklist:${room}:revision`),room),'2');
  const observer=await watchRestore(writer.browser,origin,room);observer.on('pageerror',error=>writer.errors.push(error.message));
  await writer.disconnect();await writer.edit('Offline edit awaiting explicit acceptance');
  const pending=await writer.pending();assert.equal(pending.length,1);const heldFrames=writer.frames.length;
  assert.equal((await writer.snapshot()).revision,2,'Offline edit must not reach the first restored stack');
  console.log('Holding real revision-2 browser state while restoring the original revision-1 backup');
  const firstStopStartedAt=Date.now();await targetCompose(first,['down']);const firstStoppedAt=Date.now();
  const second=await restoreTarget('older',manifest);writer.reconnect();
  await expect(writer.page.getByRole('status')).toHaveText('Writes stopped · Revision 1 · 1 pending',{timeout:60000});
  await expect(writer.page.getByRole('alert')).toContainText('older than this browser observed');
  await expect(observer.getByRole('status')).toHaveText('Restored state detected · Revision 2',{timeout:60000});
  await expect(observer.getByRole('alert')).toContainText('older than this view');
  const observerEvents=await observer.evaluate(()=>window.events),observerControls=await observer.evaluate(()=>window.controls);
  assert.ok(observerEvents.some(e=>e.type==='error'&&e.at>=firstStopStartedAt));
  assert.ok(observerControls.some(c=>c.at>=firstStoppedAt&&c.status===200&&c.body?.accepted&&c.body.results.some(r=>r.ok&&r.kind==='subscribe'&&r.id==='board'&&r.topic===room)));
  assert.ok(writer.serverFrames.some(frame=>frame.at>=firstStoppedAt&&frame.message.type==='snapshot'&&frame.message.revision===1));
  await expect(writer.page.getByRole('button',{name:'Add item',exact:true})).toBeDisabled();
  await writer.page.waitForTimeout(1500);assert.equal(writer.frames.length,heldFrames);assert.deepEqual(await writer.pending(),pending);assert.deepEqual(await writer.snapshot(),baseline);
  const rollback={writerStatus:await writer.page.getByRole('status').innerText(),observerStatus:await observer.getByRole('status').innerText(),pending,framesWhileBlocked:writer.frames.length-heldFrames,observerEvents,observerControls,firstStopStartedAt,firstStoppedAt};
  await observer.getByRole('button',{name:'Reload board and accept current state'}).click();await expect(observer.getByRole('status')).toHaveText('Live · Revision 1');
  await writer.page.getByRole('button',{name:'Accept restored state and retry pending edits'}).click();await writer.status(2);
  await expect(observer.getByRole('status')).toHaveText('Live · Revision 2');
  const after=await writer.snapshot();assert.equal(after.revision,2);assert.equal(after.items.length,2);
  assert.ok(after.items.some(item=>item.text==='Offline edit awaiting explicit acceptance'));assert.ok(!after.items.some(item=>item.text==='Acknowledged after the snapshot'));
  const retried=writer.frames.slice(heldFrames);assert.equal(retried.length,1);assert.equal(retried[0].message.opId,pending[0].opId);
  const pendingReceipt=await writer.replay(retried[0].message);assert.equal(pendingReceipt.revision,2);assert.deepEqual(await writer.snapshot(),after);await writer.page.reload();await writer.status(2);assert.deepEqual(await writer.pending(),[]);assert.deepEqual(await writer.snapshot(),after);assert.deepEqual(writer.errors,[]);
  await probe.save('restore',{room,baseline,otherBaseline,operation,receipt,conflict,later,rollback,after,retried,pendingReceipt,manifest,targets:[first,second].map(t=>({project:t.project,mounts:t.mounts,volumes:Object.values(t.config.volumes).map(v=>v.name)})),scope:'Complete stopped snapshot restored into fresh volumes; original board/receipt preserved. Separate older-snapshot drill intentionally loses a later acknowledged edit, stops browser writes, retains pending ID, and requires explicit writer/observer acceptance; no zero-loss restore claim. Equal-or-higher revision divergence is undetected by this example.'});
  console.log('PASS: stopped board/receipt restoration and explicit lower-revision reconciliation');
} catch(error){await probe.save('failure',{room,error:error.message,targets:targets.map(t=>({project:t.project,output:t.output,file:t.file}))});throw error;}
finally {
  const failures=[];
  for(const browser of browsers){try{await browser.close();}catch(error){failures.push(error);}}
  for(const target of targets){try{await cleanupTarget(target);}catch(error){failures.push(error);}}
  if(sourceStopped&&failures.length===0){try{await probe.compose(['up','-d','--no-build','--pull','never']);await healthy();}catch(error){failures.push(error);}}
  if(failures.length)throw new AggregateError(failures,'Restoration drill cleanup failed; source may remain stopped. Preserve all volumes and bundle');
}
