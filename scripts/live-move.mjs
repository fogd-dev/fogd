// Exercise native celld balancing of hibernated rooms between healthy nodes.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {context} from './queue-probe/context.mjs';
import {chromium,expect} from './guestbook-browser.mjs';
import {recoveredLogEpoch} from './live-log.mjs';
import {namedCell} from './live-cell.mjs';
import {request} from './http.mjs';
import {execute} from '../packages/cli/src/recovery/execute.mjs';
import {composeArgs} from '../packages/cli/src/recovery/docker.mjs';
const probe=await context('slot-1',process.argv[2]);
assert.match(probe.config.name,/^fogd-m11b[a-z0-9-]*$/);
const [donor,receiver]=probe.slot.nodes,app='live-probe';
const origin=`http://${app}.localhost:${probe.env.FOGD_HTTP_PORT}`;
const auth={Authorization:`Basic ${Buffer.from(`${probe.env.FOGD_ADMIN_USER}:${probe.env.FOGD_ADMIN_PASSWORD}`).toString('base64')}`};
const response=await fetch(`http://127.0.0.1:${probe.env.FOGD_ADMIN_PORT}/v1/admin`,{headers:auth});assert.equal(response.status,200);
const script=(await response.json()).apps[app].resources.script;
const config=structuredClone(probe.config),file=join(probe.output,'move-compose.json');
for(const host of probe.slot.nodes){config.services[host].environment.CELLD_IDLE_EVICT_S='5';config.services[host].environment.CELLD_PLACEMENT_WEIGHT=host===donor?'1':'100';}
const slots=JSON.parse(config.services.workerd.environment.FOGD_SLOTS);slots.find(slot=>slot.id===probe.slot.id).nodes=[donor,donor];config.services.workerd.environment.FOGD_SLOTS=JSON.stringify(slots);
const states=async()=>JSON.parse(await probe.node(`console.log(JSON.stringify(await Promise.all(${JSON.stringify(probe.slot.nodes)}.map(async host=>({host,state:await(await fetch('http://'+host+':8081/state',{signal:AbortSignal.timeout(3000)})).json()})))))`));
async function inspect(host){const id=(await probe.compose(['ps','-a','-q',host])).trim();assert.ok(id&&!id.includes('\n'));return JSON.parse(await execute('docker',['inspect','--format','{{json .State}}',id]));}
async function balance(paused){
  await probe.node(`const r=await fetch(${JSON.stringify(`http://${donor}:8081/rebalance/`)}+${JSON.stringify(paused?'pause':'resume')},{method:'POST'});if(!r.ok)throw Error('rebalance switch');`);
  await expect.poll(async()=>(await states()).find(s=>s.host===donor).state.node_load.rebalance_paused,{timeout:20000}).toBe(paused);
}
async function healthy(){await expect.poll(async()=>{try{return JSON.parse(await probe.node(`console.log(JSON.stringify(await Promise.all(${JSON.stringify(probe.slot.nodes)}.map(async host=>(await fetch('http://'+host+':8080/.well-known/celld/health',{signal:AbortSignal.timeout(2000)})).status))))`));}catch{return [];}},{timeout:90000,intervals:[1000]}).toEqual([200,200]);}
async function records(keys){return JSON.parse(await probe.node(`
  import {createRequire} from 'node:module';import {bucketClient} from './packages/runtime/src/bucket.mjs';
  const require=createRequire('/app/packages/platform/src/backend.mjs'),{GetObjectCommand}=require('@aws-sdk/client-s3'),client=bucketClient();
  console.log(JSON.stringify(await Promise.all(${JSON.stringify(keys)}.map(async key=>{
    const r=await client.send(new GetObjectCommand({Bucket:process.env.FOGD_BUCKET,Key:${JSON.stringify(probe.slot.prefix)}+'/'+key}));return JSON.parse(await r.Body.transformToString());
  }))));
`));}
async function owners(boards){const values=await records(boards.map(b=>`cells/${b.id}/own.json`));return boards.map((b,index)=>({room:b.room,id:b.id,...values[index]}));}
async function leases(){return (await records(probe.slot.nodes.map(host=>`nodes/${host}.json`))).map(r=>({host:r.node,generation:r.ownership_index_generation,expiresMs:r.expires_ms,pacedHandoff:r.paced_handoff,load:r.load,log:r.log}));}
async function readyLeases(paused){
  let value,logs;
  await expect.poll(async()=>{
    value=await leases();logs=await probe.compose(['logs','--no-color',...probe.slot.nodes]);
    return value.every(r=>r.expiresMs>Date.now()&&typeof r.generation==='string'&&r.generation.length>0&&r.pacedHandoff&&r.load.restoring===0&&!r.load.draining&&r.load.memory_headroom&&!r.load.pressured&&r.log?.state==='open'&&r.log.ensemble.includes(probe.slot.nodes.find(host=>host!==r.host))&&recoveredLogEpoch(r,logs))&&value.find(r=>r.host===donor).load.rebalance_paused===paused;
  },{timeout:90000,intervals:[1000]}).toBe(true);
  return {leases:value,logEvents:logs.split('\n').filter(line=>/paged_gate|rebalance_batch|log ensemble (degraded|open)/.test(line))};
}
async function directSnapshot(room){return JSON.parse(await probe.node(`const r=await fetch(${JSON.stringify(`http://${receiver}:8080/rooms/`)}+${JSON.stringify(room)});if(!r.ok)throw Error('snapshot status '+r.status);console.log(await r.text());`));}
async function qualifyMoved(board){
  const {page,operation:op}=board;
  await expect(page.getByRole('status')).toHaveText('Connected · Revision 1 · 0 pending',{timeout:30000});
  await expect.poll(()=>page.evaluate(()=>window.events.some(e=>e.type==='close'&&e.code===1012)),{timeout:30000}).toBe(true);
  const reconnected=await page.evaluate(()=>window.events);assert.ok(reconnected.some(e=>e.type==='message'&&e.socket>1&&e.message.type==='snapshot'&&e.message.revision===1));
  const initial=await directSnapshot(board.room);assert.equal(initial.revision,1);assert.equal(initial.items.length,1);
  assert.ok((await states()).find(s=>s.host===receiver).state.residents.includes(board.id));
  const prior=await page.evaluate(opId=>window.events.filter(e=>e.message?.type==='ack'&&e.message.opId===opId).length,op.opId);
  await page.evaluate(operation=>window.sockets.at(-1).send(JSON.stringify(operation)),op);
  await expect.poll(()=>page.evaluate(opId=>window.events.filter(e=>e.message?.type==='ack'&&e.message.opId===opId).length,op.opId)).toBe(prior+1);
  const duplicate=await page.evaluate(opId=>window.events.filter(e=>e.message?.type==='ack'&&e.message.opId===opId).at(-1).message,op.opId);assert.equal(duplicate.revision,1);
  const afterReplay=await directSnapshot(board.room);assert.deepEqual(afterReplay,initial);
  await page.getByLabel('New item').fill('After ownership move');await page.getByRole('button',{name:'Add item',exact:true}).click();
  await expect(page.getByRole('status')).toHaveText('Connected · Revision 2 · 0 pending');
  const snapshot=await directSnapshot(board.room);assert.equal(snapshot.revision,2);assert.equal(snapshot.items.length,2);
  return {room:board.room,id:board.id,initial,afterReplay,duplicate,snapshot,reconnected,events:await page.evaluate(()=>window.events)};
}

const browser=await chromium.launch({args:[`--host-resolver-rules=MAP ${app}.localhost 127.0.0.1`]});
const boards=[];let changed=false,resumeNeeded=false;
try {
  await writeFile(file,JSON.stringify(config),{flag:'wx',mode:0o600});changed=true;
  await execute('docker',[...composeArgs(file,config.name),'up','-d','--no-deps','--force-recreate',...probe.slot.nodes,'workerd'],{env:probe.env});
  await healthy();resumeNeeded=true;await balance(true);const pausedAt=Date.now();
  for(const host of probe.slot.nodes){assert.equal((await probe.compose(['exec','-T',host,'printenv','CELLD_IDLE_EVICT_S'])).trim(),'5');assert.equal((await probe.compose(['exec','-T',host,'printenv','CELLD_PLACEMENT_WEIGHT'])).trim(),host===donor?'1':'100');}
  for(let index=0;index<3;index++){
    const page=await browser.newPage(),room=`move-${randomUUID()}`,id=namedCell(script,'ChecklistWs',`room=${room}`);
    await page.addInitScript(()=>{
      const Native=window.WebSocket;window.sockets=[];window.events=[];window.sent=[];
      window.WebSocket=class extends Native{constructor(...args){super(...args);const socket=window.sockets.push(this);for(const type of ['open','close','message'])this.addEventListener(type,e=>window.events.push({socket,type,at:Date.now(),...(type==='message'?{message:JSON.parse(e.data)}:{}),...(type==='close'?{code:e.code,reason:e.reason}:{})}));}send(data){window.sent.push(JSON.parse(data));return super.send(data);}};
    });
    await page.goto(`${origin}/?room=${room}`);await expect(page.getByRole('status')).toHaveText('Connected · Revision 0 · 0 pending');
    await page.getByLabel('New item').fill(`Preserved board ${index}`);await page.getByRole('button',{name:'Add item',exact:true}).click();
    await expect(page.getByRole('status')).toHaveText('Connected · Revision 1 · 0 pending');
    assert.ok((await states()).find(s=>s.host===donor).state.residents.includes(id));
    boards.push({page,room,id,operation:await page.evaluate(()=>window.sent[0])});
  }
  console.log('Created three rooms on donor; waiting for hibernation');
  const beforeOwners=await owners(boards);assert.ok(beforeOwners.every(owner=>owner.node===donor));
  await expect.poll(async()=>{const current=await states();return boards.every(board=>current.every(s=>!s.state.residents.includes(board.id)));},{timeout:30000,intervals:[500]}).toBe(true);
  for(const board of boards)assert.deepEqual(await board.page.evaluate(()=>({count:window.sockets.length,states:window.sockets.map(s=>s.readyState),closes:window.events.filter(e=>e.type==='close')})),{count:1,states:[1],closes:[]});
  const leaseBefore=await readyLeases(true);
  const pausedLogs=await probe.compose(['logs','--no-color','--since',new Date(pausedAt).toISOString(),donor]);assert.ok(!pausedLogs.includes('rebalance_batch'),'No balancing before explicit resume');
  const before=await states(),processes={};for(const host of [...probe.slot.nodes,'workerd'])processes[host]=await inspect(host);
  await probe.save('before',{beforeOwners,leaseBefore,before,processes});
  console.log('Rooms hibernated with open sockets; resuming native balancing');
  const resumedAt=Date.now();await balance(false);resumeNeeded=false;
  let movedOwners;
  await expect.poll(async()=>{movedOwners=await owners(boards);return movedOwners.some(owner=>owner.node===receiver&&owner.epoch>beforeOwners.find(old=>old.id===owner.id).epoch);},{timeout:120000,intervals:[1000]}).toBe(true);
  resumeNeeded=true;await balance(true);
  await expect.poll(async()=>{const current=await states();return current.every(s=>['quiescing','evicting','releasing','adopting'].every(key=>s.state[key]===0));},{timeout:30000}).toBe(true);
  movedOwners=await owners(boards);
  const moved=boards.filter(board=>movedOwners.find(owner=>owner.id===board.id).node===receiver),results=[];
  assert.ok(moved.length>0,'A tested board must remain owned by the receiver after the batch settles');
  for(const board of moved){assert.ok(movedOwners.find(o=>o.id===board.id).epoch>beforeOwners.find(o=>o.id===board.id).epoch);results.push(await qualifyMoved(board));}
  const after=await states(),afterOwners=await owners(boards),leaseAfter=await readyLeases(true);
  for(const result of results)assert.equal(afterOwners.find(owner=>owner.id===result.id).node,receiver);
  const beforeDonor=before.find(s=>s.host===donor).state,afterDonor=after.find(s=>s.host===donor).state;
  assert.ok(afterDonor.rebalanced>beforeDonor.rebalanced);assert.equal(afterDonor.rebalanced-beforeDonor.rebalanced,beforeDonor.owned_cells-afterDonor.owned_cells,'Counter must match donor ownership decrease, including topic cells');assert.equal(afterDonor.rebalance_failed,beforeDonor.rebalance_failed);assert.equal(afterDonor.handoff_failed,beforeDonor.handoff_failed);
  for(const host of probe.slot.nodes)for(const key of ['rebalance_failed','handoff_failed'])assert.equal(after.find(s=>s.host===host).state[key],before.find(s=>s.host===host).state[key]);
  const logs=await probe.compose(['logs','--no-color','--since',new Date(resumedAt).toISOString(),donor]);
  const batches=logs.split('\n').filter(line=>line.includes('rebalance_batch'));assert.ok(batches.length>0);
  await writeFile(join(probe.output,'move.log'),logs,{mode:0o600});
  for(const host of [...probe.slot.nodes,'workerd']){const current=await inspect(host);assert.equal(current.StartedAt,processes[host].StartedAt);assert.equal(current.Running,true);}
  for(const lease of leaseAfter.leases)assert.equal(lease.generation,leaseBefore.leases.find(r=>r.host===lease.host).generation,'No celld process replacement during movement');
  await probe.save('move',{script,beforeOwners,movedOwners,afterOwners,resumedAt,results,batches,leaseBefore,leaseAfter,before,after,processes,allRoomEvents:await Promise.all(boards.map(async b=>({room:b.room,id:b.id,events:await b.page.evaluate(()=>window.events)}))),scope:'Healthy native celld rebalance after explicit five-second hibernation; asymmetric weights and owner-pinned ingress; all observed moved boards checked for 1012 reconnect, preserved state/receipt and next edit; no unchanged-socket or latency guarantee'});
  console.log('PASS: healthy room ownership movement reconnects native clients and preserves state and receipts');
} catch(error){await probe.save('failure',{error:error.message,boards:await Promise.all(boards.map(async b=>({room:b.room,id:b.id,events:await b.page.evaluate(()=>window.events).catch(()=>null)})))});throw error;}
finally {
  const failures=[];
  for(const action of [()=>browser.close(),async()=>{if(resumeNeeded)await balance(false);},async()=>{if(changed){await probe.compose(['up','-d','--no-deps','--force-recreate',...probe.slot.nodes,'workerd']);await healthy();}},()=>rm(file,{force:true})]){try{await action();}catch(error){failures.push(error);}}
  try{await expect.poll(async()=>{try{return (await request(`http://127.0.0.1:${probe.env.FOGD_HTTP_PORT}/rooms/move-cleanup`,{headers:{host:`${app}.localhost`},signal:AbortSignal.timeout(2000)})).status;}catch{return 0;}},{timeout:30000}).toBe(200);}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'Movement fixture cleanup failed');
}
