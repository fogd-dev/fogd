// Real stalled publication: keep the board responsive while its live topic node is frozen.
import assert from 'node:assert/strict';
import { request } from './http.mjs';
import { recoveredLogEpoch } from './live-log.mjs';
import { randomUUID } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { context } from './queue-probe/context.mjs';
import { chromium, expect } from './guestbook-browser.mjs';
import { newChecklistRooms } from './live-room.mjs';
import { namedCell, liveTopicCell, liveConnectionCell } from './live-cell.mjs';
import { execute } from '../packages/cli/src/recovery/execute.mjs';
import { composeArgs } from '../packages/cli/src/recovery/docker.mjs';
const probe=await context('slot-2',process.argv[2]);
assert.match(probe.config.name,/^fogd-m11b[a-z0-9-]*$/);
const auth={Authorization:`Basic ${Buffer.from(`${probe.env.FOGD_ADMIN_USER}:${probe.env.FOGD_ADMIN_PASSWORD}`).toString('base64')}`};
const response=await fetch(`http://127.0.0.1:${probe.env.FOGD_ADMIN_PORT}/v1/admin`,{headers:auth});assert.equal(response.status,200);
const metadata=await response.json(),script=metadata.apps.checklist.resources.script;
assert.equal(typeof script,'string');
const states=async(hosts=probe.slot.nodes)=>JSON.parse(await probe.node(`console.log(JSON.stringify(await Promise.all(${JSON.stringify(hosts)}.map(async host=>({host,state:await(await fetch('http://'+host+':8081/state',{signal:AbortSignal.timeout(5000)})).json()})))))`));
const inspect=async host=>{const id=(await probe.compose(['ps','-a','-q',host])).trim();assert.ok(id&&!id.includes('\n'));return JSON.parse(await execute('docker',['inspect','--format','{{json .State}}',id]));};
const known=new Set((await states()).flatMap(s=>s.state.residents));
const browser=await chromium.launch({args:['--host-resolver-rules=MAP checklist.localhost 127.0.0.1']});
const file=join(probe.output,'publication-compose.json');let changed=false,paused=null,writer,watcher,watchdog,watchdogRun;let watchdogFired=false;
const room=`publish-${randomUUID()}`,origin=`http://checklist.localhost:${probe.env.FOGD_HTTP_PORT}`;
async function selectIngress(host) {
  const config=structuredClone(probe.config),slots=JSON.parse(config.services.workerd.environment.FOGD_SLOTS);
  slots.find(slot=>slot.id===probe.slot.id).nodes=[host,host];config.services.workerd.environment.FOGD_SLOTS=JSON.stringify(slots);
  await writeFile(file,JSON.stringify(config),{mode:0o600});changed=true;
  const count=await writer.evaluate(()=>window.sockets.length);
  await execute('docker',[...composeArgs(file,config.name),'up','-d','--no-deps','--force-recreate','workerd'],{env:probe.env});
  await expect.poll(()=>writer.evaluate(before=>window.sockets.length>before&&window.sockets.at(-1).readyState===1,count),{timeout:60000}).toBe(true);
  await expect(writer.getByRole('status')).toHaveText('Connected · Revision 0 · 0 pending');
}
async function edit(text,revision){
  await writer.getByLabel('New item').fill(text);await writer.getByRole('button',{name:'Add item',exact:true}).click();
  await expect(writer.getByRole('status')).toHaveText(`Connected · Revision ${revision} · 0 pending`,{timeout:10000});
  return writer.evaluate(revision=>{
    const ack=window.messages.find(entry=>entry.message.type==='ack'&&entry.message.revision===revision);
    const sent=window.sent.find(entry=>entry.message.opId===ack.message.opId);
    return {sentAt:sent.at,acknowledgedAt:ack.at,receipt:ack.message};
  },revision);
}
async function warmTopic(host) {
  return JSON.parse(await probe.node(`
    const origin=${JSON.stringify(`http://${host}:8080`)},connectionId=crypto.randomUUID();
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]);
    try {
      const stream=await fetch(origin+'/live?connectionId='+connectionId,{signal});
      if(!stream.ok)throw Error('warm stream '+stream.status);
      await stream.body.getReader().read();
      const control=async operation=>{
        const r=await fetch(origin+'/live',{method:'POST',signal,headers:{origin,'content-type':'application/json'},body:JSON.stringify({connectionId,operations:[operation]})});
        const result=await r.json();if(!r.ok||!result.accepted||!result.results[0]?.ok)throw Error('warm control rejected');
      };
      await control({kind:'subscribe',id:'warm',topic:${JSON.stringify(room)}});
      await control({kind:'unsubscribe',id:'warm'});
      console.log(JSON.stringify({host:${JSON.stringify(host)},connectionId}));
    } finally {controller.abort();}
  `));
}

async function logEnsembles() {
  return JSON.parse(await probe.node(`
    import {createRequire} from 'node:module';import {bucketClient} from './packages/runtime/src/bucket.mjs';
    const require=createRequire('/app/packages/platform/src/backend.mjs');const {GetObjectCommand}=require('@aws-sdk/client-s3');
    const client=bucketClient();console.log(JSON.stringify(await Promise.all(${JSON.stringify(probe.slot.nodes)}.map(async host=>{
      const r=await client.send(new GetObjectCommand({Bucket:process.env.FOGD_BUCKET,Key:${JSON.stringify(probe.slot.prefix)}+'/nodes/'+host+'.json'}));
      const lease=JSON.parse(await r.Body.transformToString());return {host,expiresMs:lease.expires_ms,log:lease.log};
    }))));
  `));
}
async function requireEnsembles() {
  let records;
  await expect.poll(async()=>{
    records=await logEnsembles();
    const logs=await probe.compose(['logs','--no-color',...probe.slot.nodes]);
    return records.every(r=>recoveredLogEpoch(r,logs)) && records.every(r=>r.expiresMs>Date.now()&&r.log?.state==='open'&&r.log.ensemble.includes(probe.slot.nodes.find(host=>host!==r.host)));
  },{timeout:90000,intervals:[500,1000]}).toBe(true);
  return records;
}

try {
  writer=await browser.newPage();watcher=await browser.newPage();
  await writer.addInitScript(()=>{const Native=window.WebSocket;window.sockets=[];window.messages=[];window.sent=[];window.closes=[];window.WebSocket=class extends Native{constructor(...args){super(...args);window.sockets.push(this);this.addEventListener('message',e=>window.messages.push({at:Date.now(),message:JSON.parse(e.data)}));this.addEventListener('close',e=>window.closes.push({at:Date.now(),code:e.code}));}send(data){window.sent.push({at:Date.now(),message:JSON.parse(data)});return super.send(data);}};});
  await watcher.addInitScript(()=>{const Native=window.EventSource;window.events=[];window.streams=[];window.EventSource=class extends Native{constructor(...args){super(...args);window.streams.push(String(args[0]));for(const type of ['open','error','message'])this.addEventListener(type,e=>window.events.push({type,at:Date.now(),...(type==='message'?{data:JSON.parse(e.data)}:{})}));}};});
  await writer.goto(`${origin}/?room=${room}`);await expect(writer.getByRole('status')).toHaveText('Connected · Revision 0 · 0 pending');
  const rooms=newChecklistRooms(await states(),known);assert.equal(rooms.length,1);const board=rooms[0],other=probe.slot.nodes.find(host=>host!==board.host);
  assert.equal(board.id,namedCell(script,'ChecklistWs',`room=${room}`),'Validate diagnostic identity derivation against the real board');
  const warm=await warmTopic(other),topic=liveTopicCell(script,room);
  await expect.poll(async()=>(await states()).filter(s=>s.state.residents.includes(topic)).map(s=>s.host),{timeout:15000}).toEqual([other]);
  await selectIngress(board.host);
  await watcher.goto(`${origin}/watch?room=${room}`);await expect(watcher.getByRole('status')).toHaveText('Live · Revision 0');
  const connectionId=await watcher.evaluate(()=>new URL(window.streams[0]).searchParams.get('connectionId'));
  assert.ok(connectionId);const connection=liveConnectionCell(script,connectionId);
  assert.ok((await states([board.host]))[0].state.residents.includes(connection),'Observer transport must remain on the unpaused board node');
  const baseline=await edit('Before stalled publication',1);await expect(watcher.getByRole('status')).toHaveText('Live · Revision 1');
  const before=await states(),boardState=await inspect(board.host),gatewayState=await inspect('workerd');
  assert.ok(before.find(s=>s.host===board.host).state.residents.includes(board.id));assert.ok(before.find(s=>s.host===other).state.residents.includes(topic));
  const transportBefore=await writer.evaluate(()=>({count:window.sockets.length,closes:window.closes}));
  const ensemblesBefore=await requireEnsembles();
  const eventsBefore=await watcher.evaluate(()=>window.events);
  const ttlMs=Number(probe.config.services[other].environment.CELLD_TTL_MS||10000);
  const pauseBudgetMs=Math.min(4000,Math.floor(ttlMs*0.4));assert.ok(pauseBudgetMs>=3000);
  const pausedAt=Date.now();paused=other;await probe.compose(['pause',other]);
  watchdog=setTimeout(()=>{watchdogFired=true;watchdogRun=probe.compose(['unpause',other]).catch(error=>({error:error.message}));},Math.max(0,pauseBudgetMs-(Date.now()-pausedAt)));
  assert.equal((await inspect(other)).Paused,true);
  const first=await edit('Committed while notifications stall',2),second=await edit('Another edit while notifications stall',3);
  assert.equal((await inspect(other)).Paused,true);
  assert.equal((await inspect(board.host)).StartedAt,boardState.StartedAt);assert.equal((await inspect('workerd')).StartedAt,gatewayState.StartedAt);
  assert.deepEqual(await writer.evaluate(()=>({count:window.sockets.length,closes:window.closes})),transportBefore);
  assert.deepEqual(await watcher.evaluate(()=>window.events),eventsBefore,'No hints or transport reconnect while the topic is frozen');
  let logs;
  await expect.poll(async()=>{logs=await probe.compose(['logs','--no-color','--since',new Date(pausedAt).toISOString(),board.host]);return /Checklist hint (timed-out|failed) revision=[23]\b/.test(logs);},{timeout:1500,intervals:[50,100]}).toBe(true);
  await writeFile(join(probe.output,'publication.log'),logs,{mode:0o600});
  const outcomes=logs.split('\n').filter(line=>/Checklist hint (timed-out|failed) revision=[23]\b/.test(line));assert.ok(outcomes.length>0,'Require actual runtime publication failure/timeout diagnostic');
  const during=await writer.evaluate(async room=>(await(await fetch(`/rooms/${room}`)).json()),room);assert.equal(during.revision,3);assert.equal(during.items.length,3);
  assert.equal(watchdogFired,false,'Pause safety watchdog invalidates this run');
  await probe.compose(['unpause',other]);const unpausedAt=Date.now();paused=null;clearTimeout(watchdog);
  assert.equal(watchdogFired,false);assert.ok(unpausedAt-pausedAt<pauseBudgetMs);
  await expect.poll(async()=>{try{return (await states()).length;}catch{return 0;}},{timeout:60000}).toBe(2);
  // The timeout does not cancel publication. Observe late delivery without reload.
  await expect(watcher.getByRole('status')).toHaveText('Live · Revision 3',{timeout:60000});
  const ensemblesAfter=await requireEnsembles();
  const replicationLogs=await probe.compose(['logs','--no-color','--since',new Date(pausedAt).toISOString(),...probe.slot.nodes]);
  const replicationEvents=replicationLogs.split('\n').filter(line=>/gray follower evicted|log ensemble degraded|log ensemble open/.test(line));
  await writeFile(join(probe.output,'replication.log'),replicationLogs,{mode:0o600});
  const recoveryEvents=await watcher.evaluate(()=>window.events);
  assert.equal(recoveryEvents.filter(e=>e.type==='open').length,1);assert.equal(recoveryEvents.filter(e=>e.type==='error').length,0);
  const residencyAfter=await states();assert.deepEqual(residencyAfter.filter(s=>s.state.residents.includes(topic)).map(s=>s.host),[other]);
  const recovered=await watcher.getByRole('list',{name:'Checklist'}).innerText();
  assert.ok(recovered.includes('Committed while notifications stall')&&recovered.includes('Another edit while notifications stall'));
  const after=await edit('After publisher recovery',4);await expect(watcher.getByRole('status')).toHaveText('Live · Revision 4',{timeout:30000});
  await probe.save('publication',{room,script,ensemblesBefore,ensemblesAfter,replicationEvents,board,topic,topicOwner:other,connection,warm,ttlMs,pauseBudgetMs,eventsBefore,recoveryEvents,residencyBefore:before,residencyAfter,baseline,pausedAt,first,second,unpausedAt,after,outcomes,during,recovered,events:await watcher.evaluate(()=>window.events),transportBefore,scope:'Real topic-node Docker pause; native durable writes through owner-pinned workerd ingress; runtime publication diagnostic; topic node is also the board log follower, so pause also tests replication degradation and bucket-backed acknowledgment; restored ensembles checked before exit; same observer connection receives late hints after unpause; no reload or manual refresh; not a latency guarantee'});
  console.log('PASS: stalled live publication leaves durable edits available and late hints repair the existing observer');
} catch(error){await probe.save('failure',{room,error:error.message,writer:writer?await writer.evaluate(()=>({messages:window.messages,closes:window.closes})).catch(()=>null):null});throw error;}
finally {
  clearTimeout(watchdog);if(watchdogRun)await watchdogRun;
  const failures=[];
  for(const action of [async()=>{if(paused&&(await inspect(paused)).Paused)await probe.compose(['unpause',paused]);},()=>browser.close(),()=>rm(file,{force:true}),async()=>{if(changed)await probe.compose(['up','-d','--no-deps','--force-recreate','workerd']);}]){try{await action();}catch(error){failures.push(error);}}
  for(const host of probe.slot.nodes){try{assert.equal((await inspect(host)).Paused,false);}catch(error){failures.push(error);}}
  try{await requireEnsembles();await expect.poll(async()=>{try{return (await request(`http://127.0.0.1:${probe.env.FOGD_HTTP_PORT}/rooms/${room}`,{headers:{host:`checklist.localhost:${probe.env.FOGD_HTTP_PORT}`},signal:AbortSignal.timeout(2000)})).status;}catch{return 0;}},{timeout:30000}).toBe(200);}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'Publication fixture cleanup failed');
}
