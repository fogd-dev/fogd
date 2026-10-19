// Qualify real generation-age SSE cancellation during ordinary exact approval.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { context } from './queue-probe/context.mjs';
import { chromium, expect } from './guestbook-browser.mjs';
import { stackRoot } from '../packages/cli/src/local.mjs';
import { execute } from '../packages/cli/src/recovery/execute.mjs';
const probe = await context('slot-2', process.argv[2]);
assert.match(probe.config.name, /^fogd-m11b[a-z0-9-]*$/);
for(const host of probe.slot.nodes)assert.equal((await probe.compose(['exec','-T',host,'printenv','CELLD_DEPLOY_MAX_AGE_S'])).trim(),'5');
const browser=await chromium.launch({args:['--host-resolver-rules=MAP checklist.localhost 127.0.0.1']});
let watcher;
try {
  const room=`sse-update-${randomUUID()}`,origin=`http://checklist.localhost:${probe.env.FOGD_HTTP_PORT}`;
  const writer=await browser.newPage();watcher=await browser.newPage();const errors=[];
  watcher.on('pageerror',error=>errors.push(error.message));
  await watcher.addInitScript(()=>{
    const Native=window.EventSource;window.events=[];window.snapshots=[];window.controls=[];
    window.EventSource=class extends Native{constructor(...args){super(...args);for(const type of ['open','error','message'])this.addEventListener(type,e=>window.events.push({type,at:Date.now(),...(type==='message'?{data:JSON.parse(e.data)}:{})}));}};
    const send=window.fetch;
    window.fetch=async(...args)=>{const r=await send(...args);if(String(args[0])==='/live'&&args[1]?.method==='POST'&&r.ok){const result=await r.clone().json();if(result.accepted&&result.results.some(item=>item.ok&&item.kind==='subscribe'&&item.id==='board'))window.controls.push({at:Date.now(),result});}if(String(args[0]).startsWith('/rooms/')&&r.ok)window.snapshots.push({at:Date.now(),value:await r.clone().json()});return r;};
  });
  await writer.goto(`${origin}/?room=${room}`);
  await expect(writer.getByRole('status')).toHaveText('Connected · Revision 0 · 0 pending');
  assert.equal(await writer.evaluate(async room=>(await(await fetch(`/rooms/${room}`)).json()).release,room),'v1');
  await watcher.goto(`${origin}/watch?room=${room}`);
  await expect(watcher.getByRole('status')).toHaveText('Live · Revision 0');
  await writer.getByLabel('New item').fill('Survives handler replacement');
  await writer.getByRole('button',{name:'Add item',exact:true}).click();
  await expect(watcher.getByRole('status')).toHaveText('Live · Revision 1');
  const activationStartedAt=Date.now();
  const log=await execute(process.execPath,[join(stackRoot,'scripts/live-update.mjs'),join(probe.output,'activation')],{env:probe.env});
  await writeFile(join(probe.output,'activation.log'),log,{mode:0o600});
  const activationCompletedAt=Date.now();
  await expect.poll(()=>watcher.evaluate(at=>window.events.some(e=>e.type==='error'&&e.at>=at),activationStartedAt),{timeout:60000}).toBe(true);
  await expect.poll(()=>watcher.evaluate(at=>window.snapshots.some(s=>s.at>=at&&s.value.release==='v2'&&s.value.revision===1),activationStartedAt),{timeout:60000}).toBe(true);
  await expect(watcher.getByRole('status')).toHaveText('Live · Revision 1');
  await writer.getByLabel('New item').fill('After SSE resubscription');
  await writer.getByRole('button',{name:'Add item',exact:true}).click();
  await expect(writer.getByRole('status')).toHaveText('Connected · Revision 2 · 0 pending');
  await expect(watcher.getByRole('status')).toHaveText('Live · Revision 2');
  const transport=await watcher.evaluate(()=>({events:window.events,snapshots:window.snapshots,controls:window.controls}));
  const close=transport.events.find(e=>e.type==='error'&&e.at>=activationStartedAt);
  const reopened=transport.events.find(e=>e.type==='open'&&e.at>close.at);assert.ok(reopened);
  const registered=transport.controls.find(c=>c.at>=reopened.at);assert.ok(registered);
  assert.ok(transport.snapshots.some(s=>s.at>=registered.at&&s.value.release==='v2'&&s.value.revision===1));
  assert.ok(transport.events.some(e=>e.type==='message'&&e.data.data.revision===2&&e.at>close.at));
  assert.deepEqual(errors,[]);
  await probe.save('sse-update',{room,maxAgeSeconds:5,activationStartedAt,activationCompletedAt,transport,errors,scope:'Real exact approval; SSE error/reopen and post-registration v2 snapshot followed by a new hint; no guaranteed cancellation latency'});
  console.log('PASS: SSE reconnects after generation replacement and observes a later durable edit');
} catch(error){await probe.save('failure',{error:error.message,transport:watcher?await watcher.evaluate(()=>({events:window.events,snapshots:window.snapshots,controls:window.controls})).catch(()=>null):null});throw error;}
finally{await browser.close();}
