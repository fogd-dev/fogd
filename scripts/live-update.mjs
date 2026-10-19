import { newChecklistRooms } from './live-room.mjs';
// An already-loaded v1 native client keeps its socket while approval replaces handlers.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareRoutePause, freshRoomSnapshot } from './live-route-pause.mjs';
import { context } from './queue-probe/context.mjs';
import { chromium, expect } from './guestbook-browser.mjs';
import { stackRoot, run } from '../packages/cli/src/local.mjs';
import { execute } from '../packages/cli/src/recovery/execute.mjs';
const probe = await context('slot-2', process.argv[2]);
assert.match(probe.config.name, /^fogd-m11b[a-z0-9-]*$/);
const app = 'checklist', source = join(stackRoot, 'examples/checklist'), project = join(probe.output, 'project');
const cli = args => execute(process.execPath, [join(stackRoot, 'packages/cli/bin/fogd.js'), ...args], { env: probe.env });
const auth = { Authorization: `Basic ${Buffer.from(`${probe.env.FOGD_ADMIN_USER}:${probe.env.FOGD_ADMIN_PASSWORD}`).toString('base64')}` };
async function admin() { const r = await fetch(`http://127.0.0.1:${probe.env.FOGD_ADMIN_PORT}/v1/admin`, {headers:auth}); assert.equal(r.status,200); return r.json(); }
const runtimeStates = async () => JSON.parse(await probe.node(`console.log(JSON.stringify(await Promise.all(${JSON.stringify(probe.slot.nodes)}.map(async host => ({host,state:await (await fetch('http://'+host+':8081/state')).json()})))))`));
const idleMode = process.env.FOGD_LIVE_IDLE_UPDATE === '1';
const pauseMode = process.env.FOGD_LIVE_ROUTE_PAUSE === '1';
assert.ok(!(idleMode && pauseMode), 'Run idle and route-pause gates separately');
const known = (idleMode || pauseMode) ? new Set((await runtimeStates()).flatMap(s=>s.state.residents)) : null;
if(idleMode)for(const host of probe.slot.nodes)assert.equal((await probe.compose(['exec','-T',host,'printenv','CELLD_IDLE_EVICT_S'])).trim(),'5');
let idleEvidence = null;
const before = await admin(), old = before.deployments[before.apps[app].active];
assert.equal(old.status, 'active');
await mkdir(project);
for (const name of ['package.json','vite.config.ts','void.config.ts','tsconfig.json','fogd.json','routes','lib','pages','src']) await cp(join(source,name),join(project,name),{recursive:true});
await cp(join(source,'updates/v2'),project,{recursive:true,force:true});
await symlink(join(source,'node_modules'),join(project,'node_modules'),'dir');
const credential = JSON.parse(await cli(['admin','issue-token','live-update-qualification',app]));
const browser = await chromium.launch({ args:['--host-resolver-rules=MAP checklist.localhost 127.0.0.1'] });
let page, room, pauseGate;
try {
  page = await browser.newPage(); room = `update-${randomUUID()}`; const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const Native = window.WebSocket; window.sockets = []; window.messages = []; window.closes = [];
    window.WebSocket = class extends Native {
      constructor(...args) { super(...args); window.sockets.push(this); this.addEventListener('message',e=>window.messages.push(JSON.parse(e.data)));this.addEventListener('close',e=>window.closes.push({code:e.code,at:Date.now()})); }
    };
  });
  await page.goto(`http://checklist.localhost:${probe.env.FOGD_HTTP_PORT}/?room=${room}`);
  const status = page.getByRole('status');
  await expect(status).toHaveText('Connected · Revision 0 · 0 pending');
  assert.equal(await page.evaluate(()=>window.messages[0].release),'v1','Deploy the base v1 checklist before running this probe');
  await page.getByLabel('New item').fill('Before compatible update');
  await page.getByRole('button',{name:'Add item',exact:true}).click();
  await expect(status).toHaveText('Connected · Revision 1 · 0 pending');
  const firstAck = await page.evaluate(()=>window.messages.find(m=>m.type==='ack'));
  if(idleMode || pauseMode) {
    const cells=newChecklistRooms(await runtimeStates(), known);
    assert.equal(cells.length,1);
    if(pauseMode) pauseGate = await prepareRoutePause(probe, page, cells[0]);
    if(idleMode) idleEvidence={cell:cells[0],activeAt:Date.now()};
  }
  const log = await run(process.execPath,[join(stackRoot,'packages/cli/bin/fogd.js'),'deploy','--name',app],{cwd:project,env:{...probe.env,FOGD_DEPLOY_TOKEN:credential.token},capture:true});
  await writeFile(join(probe.output,'deploy.log'),log,{mode:0o600});
  const submitted = await admin(), added = Object.values(submitted.deployments).filter(r=>!Object.hasOwn(before.deployments,r.id));
  assert.equal(added.length,1); const update=added[0];assert.equal(update.status,'pending');assert.equal(submitted.apps[app].active,old.id);
  assert.equal(await page.evaluate(async room=>(await(await fetch(`/rooms/${room}`)).json()).release,room),'v1');
  // Retain a valid v1-format record across approval without flushing it early.
  const opId=`pending-${randomUUID()}`, itemId=`item-${randomUUID()}`;
  await page.evaluate(({room,opId,itemId})=>{
    localStorage.setItem(`fogd-checklist:${room}:pending:${opId}`,JSON.stringify({opId,operation:{kind:'add',itemId,text:'Saved v1 edit handled by v2'},order:Date.now()}));
  },{room,opId,itemId});
  if(idleMode) {
    await expect.poll(async()=>(await runtimeStates()).every(s=>!s.state.residents.includes(idleEvidence.cell.id)),{timeout:15000,intervals:[500]}).toBe(true);
    idleEvidence.evictedAt=Date.now();
  }
  const pauseEvidence = pauseMode ? await pauseGate.approve(cli, admin, update, room, await page.evaluate(async room => (await (await fetch(`/rooms/${room}`)).json()).items[0].id, room)) : null;
  if(!pauseMode) await cli(['admin','approve',update.id,update.digest]);
  const finalRevision = pauseMode ? 3 : 2;
  assert.equal((await admin()).apps[app].active,update.id);
  assert.deepEqual(await page.evaluate(()=>({count:window.sockets.length,closes:window.closes})),{count:1,closes:[]});
  assert.ok(await page.evaluate(({room,opId})=>localStorage.getItem(`fogd-checklist:${room}:pending:${opId}`),{room,opId}));
  if(pauseEvidence) pauseEvidence.pendingReleasedAt = Date.now();
  await page.evaluate(({room,opId})=>window.dispatchEvent(new StorageEvent('storage',{key:`fogd-checklist:${room}:pending:${opId}`})),{room,opId});
  await expect(status).toHaveText(`Connected · Revision ${finalRevision} · 0 pending`);
  const ack=await page.evaluate(opId=>window.messages.find(m=>m.opId===opId),opId);
  assert.equal(ack.type,'ack');assert.equal(ack.release,'v2');assert.equal(ack.revision,finalRevision);
  const transport=await page.evaluate(()=>({count:window.sockets.length,closes:window.closes}));assert.deepEqual(transport,{count:1,closes:[]});
  const snapshot=await page.evaluate(async room=>(await fetch(`/rooms/${room}`)).json(),room);
  assert.equal(snapshot.release,'v2');assert.equal(snapshot.items.length,2);assert.equal(snapshot.revision,finalRevision);assert.deepEqual(errors,[]);
  if(pauseEvidence) {
    pauseEvidence.reopened = await freshRoomSnapshot(page, room);
    assert.deepEqual(pauseEvidence.reopened, snapshot);
  }
  await probe.save('update',{room,old:{id:old.id,digest:old.digest},update:{id:update.id,digest:update.digest},firstAck,ack,transport,snapshot,errors,idleEvidence:idleMode?idleEvidence:null,pauseEvidence,scope:'Scoped CLI submission and exact approval replace v1 with v2 while one native socket stays open across activation and the loaded v1 browser settles a v1 pending record; route-pause evidence is recorded only when explicitly enabled'});
  console.log('PASS: original v1 native socket receives v2 acknowledgment after exact approval');
} catch (error) {
  if(page && !page.isClosed()) await probe.save('failure',{room,error:error.message,transport:await page.evaluate(()=>({count:window.sockets.length,closes:window.closes,messages:window.messages}))});
  throw error;
} finally { try { await browser.close(); } finally { await pauseGate?.cleanup(); } }
