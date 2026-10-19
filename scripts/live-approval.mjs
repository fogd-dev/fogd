// Native upgrades before/after exact approval on empty, isolated app fleets.
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {randomUUID,randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {context} from './queue-probe/context.mjs';
import {chromium,expect} from './guestbook-browser.mjs';
import {execute} from '../packages/cli/src/recovery/execute.mjs';
import {composeArgs,projectContainers} from '../packages/cli/src/recovery/docker.mjs';
import {stackRoot,run} from '../packages/cli/src/local.mjs';
const probe=await context('slot-1',process.argv[2]);assert.match(probe.config.name,/^fogd-m11b[a-z0-9-]*$/);
const project=`fogd-m11b-approval-${randomUUID().slice(0,8)}`,config=structuredClone(probe.config),file=join(probe.output,'compose.json');config.name=project;
for(const [name,volume] of Object.entries(config.volumes))volume.name=`${project}_${name}`;
for(const [name,network] of Object.entries(config.networks))network.name=`${project}_${name}`;
assert.equal((await projectContainers(project)).length,0);
for(const kind of ['volume','network']){const existing=(await execute('docker',[kind,'ls','--format','{{.Name}}'])).trim().split('\n');assert.ok(Object.values(config[kind==='volume'?'volumes':'networks']).every(r=>!existing.includes(r.name)));}
await writeFile(file,JSON.stringify(config),{flag:'wx',mode:0o600});
const env={...probe.env,COMPOSE_PROJECT_NAME:project,FOGD_COMPOSE_FILE:file};
const compose=args=>execute('docker',[...composeArgs(file,project),...args],{env});
const cli=args=>execute(process.execPath,[join(stackRoot,'packages/cli/bin/fogd.js'),...args],{env});
const node=code=>compose(['exec','-T','controller','node','--input-type=module','-e',code]);
const auth={Authorization:`Basic ${Buffer.from(`${env.FOGD_ADMIN_USER}:${env.FOGD_ADMIN_PASSWORD}`).toString('base64')}`};
async function admin(){const r=await fetch(`http://127.0.0.1:${env.FOGD_ADMIN_PORT}/v1/admin`,{headers:auth,signal:AbortSignal.timeout(5000)});assert.equal(r.status,200);return r.json();}
async function untouched(slot){
  const prefix=probe.slots.find(s=>s.id===slot).prefix;
  return JSON.parse(await node(`import {createRequire} from 'node:module';import {bucketClient} from './packages/runtime/src/bucket.mjs';const require=createRequire('/app/packages/platform/src/backend.mjs'),{ListObjectsV2Command}=require('@aws-sdk/client-s3'),client=bucketClient();const rows={};for(const kind of ['cells','deploy']){const r=await client.send(new ListObjectsV2Command({Bucket:process.env.FOGD_BUCKET,Prefix:${JSON.stringify(prefix)}+'/'+kind+'/',MaxKeys:1}));rows[kind]=r.KeyCount||0;}console.log(JSON.stringify(rows));`));
}
function upgradeResponse(origin,room){
  return new Promise((resolve,reject)=>{
    const url=new URL(origin),req=httpRequest(`http://127.0.0.1:${url.port}/rooms/${room}`,{headers:{Host:url.host,Origin:origin,Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':randomBytes(16).toString('base64')},signal:AbortSignal.timeout(10000)});
    req.on('response',response=>{let body='';response.on('data',chunk=>{body+=chunk;});response.on('end',()=>resolve({status:response.statusCode,body}));response.on('error',reject);});
    req.on('upgrade',(_response,socket)=>{socket.destroy();reject(Error('Unapproved HTTP request unexpectedly upgraded'));});req.on('error',reject);req.end();
  });
}

async function socket(page,origin,room,mutate=false){
  return page.evaluate(({origin,room,mutate})=>new Promise((resolve,reject)=>{
    const ws=new WebSocket(origin.replace('http:','ws:')+`/rooms/${room}`),events=[];let sent=false;
    const finish=value=>{clearTimeout(timer);resolve(value);};
    const timer=setTimeout(()=>{ws.close();reject(Error('Socket observation timeout'));},15000);
    ws.onopen=()=>events.push({type:'open',at:Date.now()});ws.onerror=()=>events.push({type:'error',at:Date.now()});
    ws.onclose=e=>finish({events,code:e.code});
    ws.onmessage=e=>{const message=JSON.parse(e.data);events.push({type:'message',at:Date.now(),message});
      if(!mutate){ws.close(1000,'unexpected unapproved open');return;}
      if(message.type==='snapshot'&&message.revision===0&&!sent){sent=true;ws.send(JSON.stringify({type:'operation',opId:'approval-op',operation:{kind:'add',itemId:'first',text:'Approved native room'}}));}
      if(message.type==='snapshot'&&message.revision===1)ws.close(1000,'approved roundtrip complete');
    };
  }),{origin,room,mutate});
}
const browser=await chromium.launch({args:['--host-resolver-rules=MAP preapprove-a.localhost 127.0.0.1, MAP preapprove-b.localhost 127.0.0.1']});
let sourceStopped=false,targetCreated=false;const results=[];
try {
  sourceStopped=true;await probe.compose(['down']);targetCreated=true;await compose(['up','-d','--no-build','--pull','never']);
  await expect.poll(async()=>{try{return Object.keys((await admin()).apps).length;}catch{return -1;}},{timeout:120000}).toBe(0);
  for(const [index,app] of ['preapprove-a','preapprove-b'].entries()){
    const slot=`slot-${index+1}`,credential=JSON.parse(await cli(['admin','issue-token',`approval-${app}`,app]));
    const previous=new Set(Object.keys((await admin()).deployments));
    const log=await run(process.execPath,[join(stackRoot,'packages/cli/bin/fogd.js'),'deploy','--name',app],{cwd:join(stackRoot,'examples/checklist'),env:{...env,FOGD_DEPLOY_TOKEN:credential.token},capture:true});await writeFile(join(probe.output,`${app}-deploy.log`),log,{mode:0o600});
    const staged=await admin(),added=Object.values(staged.deployments).filter(d=>!previous.has(d.id));assert.equal(added.length,1);const release=added[0];assert.equal(release.status,'pending');assert.equal(release.submitter,credential.id);assert.equal(staged.apps[app],undefined);
    assert.deepEqual(await untouched(slot),{cells:0,deploy:0});
    const page=await browser.newPage(),origin=`http://${app}.localhost:${env.FOGD_HTTP_PORT}`,room=`approval-${randomUUID()}`;
    const cdp=await page.context().newCDPSession(page),handshakes=[],origins=[];await cdp.send('Network.enable');
    cdp.on('Network.webSocketWillSendHandshakeRequest',e=>origins.push({id:e.requestId,origin:e.request.headers.Origin||e.request.headers.origin}));
    cdp.on('Network.webSocketHandshakeResponseReceived',e=>handshakes.push({id:e.requestId,status:e.response.status,at:Date.now()}));
    const response=await page.goto(`${origin}/rooms/${room}`);assert.equal(response.status(),404);assert.equal(await response.text(),'Unknown app');
    const refused=await socket(page,origin,room);assert.ok(refused.events.some(e=>e.type==='error'));assert.ok(!refused.events.some(e=>e.type==='open'||e.type==='message'));assert.equal(refused.code,1006);
    const refusedHandshake=await upgradeResponse(origin,room);assert.deepEqual(refusedHandshake,{status:404,body:'Unknown app'});assert.equal(origins[0].origin,origin);
    const afterRefusal=await admin();assert.equal(afterRefusal.deployments[release.id].status,'pending');assert.equal(afterRefusal.apps[app],undefined);const beforeApproval=await untouched(slot);assert.deepEqual(beforeApproval,{cells:0,deploy:0});
    await assert.rejects(cli(['admin','approve',release.id,'0'.repeat(64)]));
    const csrf=(await admin()).csrf;
    const badResponse=await fetch(`http://127.0.0.1:${env.FOGD_ADMIN_PORT}/v1/deployments/${release.id}/approve`,{method:'POST',headers:{...auth,'Content-Type':'application/json','X-Fogd-CSRF':csrf},body:JSON.stringify({digest:'0'.repeat(64)})});
    const wrongDigest={status:badResponse.status,body:await badResponse.json()};assert.deepEqual(wrongDigest,{status:400,body:{error:'Deployment/digest mismatch'}});assert.equal((await admin()).deployments[release.id].status,'pending');assert.deepEqual(await untouched(slot),beforeApproval);
    await cli(['admin','approve',release.id,release.digest]);const approved=await admin();assert.equal(approved.deployments[release.id].status,'active');assert.equal(approved.apps[app].slot,slot);
    const accepted=await socket(page,origin,room,true);assert.equal(accepted.code,1000);assert.ok(accepted.events.some(e=>e.message?.type==='ack'&&e.message.revision===1));assert.ok(accepted.events.some(e=>e.message?.type==='snapshot'&&e.message.revision===1));
    await expect.poll(()=>handshakes.map(h=>h.status)).toEqual([101]);assert.equal(origins[1].origin,origin);
    const snapshot=await page.evaluate(async room=>(await fetch(`/rooms/${room}`)).json(),room);assert.equal(snapshot.revision,1);assert.equal(snapshot.items.length,1);
    results.push({app,slot,room,release:{id:release.id,digest:release.digest,submitter:release.submitter},beforeApproval,wrongDigest,refused,refusedHandshake,accepted,origins,handshakes,snapshot});
    await cli(['admin','revoke-token',credential.id]);await page.close();
  }
  assert.equal(Object.values((await admin()).apps).filter(a=>a.active).length,2);
  await probe.save('approval',{project,images:Object.fromEntries(Object.entries(config.services).map(([name,s])=>[name,s.image])),results,scope:'Two fresh scoped native Void apps; same-origin Chromium upgrade is refused before approval; an independent standards-compliant upgrade request confirms gateway 404; Chromium receives 101 after exact approval; empty target cells/deploy prefixes before approval; wrong digest refused; both apps active side by side'});
  console.log('PASS: native room upgrades cannot reach an unapproved app; exact approval enables the same-origin roundtrip');
} catch(error){await probe.save('failure',{project,error:error.message,results});throw error;}
finally {
  const failures=[];try{await browser.close();}catch(error){failures.push(error);}
  if(targetCreated){try{await compose(['down']);}catch(error){failures.push(error);}}
  if(sourceStopped&&failures.length===0){try{await probe.compose(['up','-d','--no-build','--pull','never']);await expect.poll(async()=>{try{return Object.keys((await admin()).apps).sort();}catch{return [];}},{timeout:120000}).toEqual(['checklist','live-probe']);}catch(error){failures.push(error);}}
  if(failures.length)throw new AggregateError(failures,'Approval fixture cleanup failed; source may remain stopped. Preserve volumes.');
}
