// Select a non-owning ingress through workerd, then kill only that replica.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, expect } from './guestbook-browser.mjs';
import { context } from './queue-probe/context.mjs';
import { execute } from '../packages/cli/src/recovery/execute.mjs';
import { composeArgs } from '../packages/cli/src/recovery/docker.mjs';
const probe = await context('slot-2', process.argv[2]);
assert.match(probe.config.name, /^fogd-m11b[a-z0-9-]*$/);
const states = async (hosts = probe.slot.nodes) => JSON.parse(await probe.node(`console.log(JSON.stringify(await Promise.all(${JSON.stringify(hosts)}.map(async host => ({host,state:await (await fetch('http://'+host+':8081/state')).json()})))))`));
const inspect = async host => {
  const id = (await probe.compose(['ps', '-a', '-q', host])).trim();
  assert.ok(id && !id.includes('\n'));
  return JSON.parse(await execute('docker', ['inspect', '--format', '{{json .State}}', id]));
};
const before = await states(), known = new Set(before.flatMap(s => s.state.residents));
const file = join(probe.output, 'ingress-compose.json');
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP checklist.localhost 127.0.0.1'] });
let gatewayChanged = false, killed = null, controlFile = null;
const control = async () => JSON.parse(await probe.node(`console.log(await (await import('node:fs/promises')).readFile(${JSON.stringify(controlFile)},'utf8'))`));
try {
  const page = await browser.newPage(), room = `ingress-${randomUUID()}`;
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    window.socketEvents = []; window.socketCount = 0;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args); const socket = ++window.socketCount;
        for (const event of ['open', 'close']) this.addEventListener(event, e => window.socketEvents.push({ event, socket, at: Date.now(), ...(event === 'close' ? {code:e.code} : {}) }));
        this.addEventListener('message', e => { const message = JSON.parse(e.data); if (message.type === 'snapshot') window.socketEvents.push({event:'snapshot',socket,at:Date.now(),revision:message.revision}); });
      }
    };
  });
  await page.goto(`http://checklist.localhost:${probe.env.FOGD_HTTP_PORT}/?room=${room}`);
  const status = page.getByRole('status');
  await expect(status).toHaveText('Connected · Revision 0 · 0 pending');
  await page.getByLabel('New item').fill('Before ingress loss');
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await expect(status).toHaveText('Connected · Revision 1 · 0 pending');
  const active = await states();
  const candidates = active.flatMap(s => s.state.residents.filter(id => !known.has(id)).map(id => ({host:s.host,id})));
  assert.equal(candidates.length, 1, 'Use an otherwise idle fixture');
  const owner = candidates[0], ingress = probe.slot.nodes.find(host => host !== owner.host);
  const config = structuredClone(probe.config), slots = JSON.parse(config.services.workerd.environment.FOGD_SLOTS);
  slots.find(slot => slot.id === probe.slot.id).nodes = [ingress, owner.host];
  config.services.workerd.environment.FOGD_SLOTS = JSON.stringify(slots);
  await writeFile(file, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
  gatewayChanged = true;
  const selectedAt = Date.now();
  // A fresh gateway's first application request selects index zero. No page reload:
  // only the already-loaded native client's reconnect reaches this fresh gateway.
  await execute('docker', [...composeArgs(file, config.name), 'up', '-d', '--no-deps', '--force-recreate', 'workerd'], { env: probe.env });
  await expect.poll(() => page.evaluate(at => window.socketEvents.some(e => e.event === 'snapshot' && e.at >= at), selectedAt), { timeout: 60000 }).toBe(true);
  const selectedSocket = await page.evaluate(() => window.socketEvents.filter(e => e.event === 'snapshot').at(-1).socket);
  const immediatelyBefore = await states(), ownerState = await inspect(owner.host), gatewayBefore = await inspect('workerd');
  assert.ok(immediatelyBefore.find(s => s.host === owner.host).state.residents.includes(owner.id));
  assert.ok(immediatelyBefore.find(s => s.host === owner.host).state.published.includes(owner.id));
  assert.ok(!immediatelyBefore.find(s => s.host === ingress).state.residents.includes(owner.id));
  assert.equal(ownerState.Running, true);
  const selected = await page.evaluate(socket => ({open:window.socketEvents.find(e=>e.event==='open'&&e.socket===socket),closed:window.socketEvents.some(e=>e.event==='close'&&e.socket===socket)}),selectedSocket);
  assert.ok(selected.open.at >= Date.parse(gatewayBefore.StartedAt)); assert.equal(selected.closed,false);
  controlFile = `/tmp/fogd-live-control-${randomUUID()}.json`;
  await probe.compose(['exec','-d','controller','node','--input-type=module','-e',await readFile(new URL('./live-control.mjs',import.meta.url),'utf8'),owner.host,room,controlFile]);
  await expect.poll(async()=>{try{return (await control()).messages[0]?.revision;}catch{return null;}},{timeout:15000}).toBe(1);
  const ingressBefore = await inspect(ingress);
  const killAt = Date.now(); killed = ingress;
  await probe.compose(['kill', '-s', 'SIGKILL', ingress]);
  assert.equal((await inspect(ingress)).Running, false);
  // This close proves the selected socket depended on the non-owner; gateway
  // and owner are untouched during this leg. Do not infer ingress just from order.
  await expect.poll(() => page.evaluate(({at,socket}) => window.socketEvents.some(e => e.event === 'close' && e.socket === socket && e.at >= at), {at:killAt,socket:selectedSocket}), { timeout: 30000 }).toBe(true);
  await expect.poll(() => page.evaluate(at => window.socketEvents.some(e => e.event === 'snapshot' && e.at >= at), killAt), { timeout: 60000 }).toBe(true);
  await expect(status).toHaveText('Connected · Revision 1 · 0 pending');
  await page.getByLabel('New item').fill('After ingress loss');
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await expect(status).toHaveText('Connected · Revision 2 · 0 pending');
  const acknowledgedAt = Date.now(), ownerAfter = await inspect(owner.host);
  assert.equal(ownerAfter.Running, true); assert.equal(ownerAfter.StartedAt, ownerState.StartedAt);
  const ingressAfter = await inspect(ingress), gatewayAfter = await inspect('workerd');
  assert.equal(ingressAfter.Running, false); assert.equal(ingressAfter.StartedAt,ingressBefore.StartedAt);
  assert.equal(gatewayAfter.Running, true); assert.equal(gatewayAfter.StartedAt, gatewayBefore.StartedAt);
  const [survivor] = await states([owner.host]);
  assert.ok(survivor.state.residents.includes(owner.id));
  await probe.node(`await (await import('node:fs/promises')).writeFile(${JSON.stringify(`${controlFile}.command`)},'probe')`);
  await expect.poll(async()=>(await control()).messages.some(m=>m.type==='rejected'&&m.opId==='control-probe'),{timeout:15000}).toBe(true);
  const directOwner = await control(); assert.equal(directOwner.opens,1);assert.deepEqual(directOwner.closes,[]);assert.equal(directOwner.error,undefined);assert.ok(directOwner.messages.some(m=>m.type==='snapshot'&&m.revision===2));
  const selectedClose=await page.evaluate(socket=>window.socketEvents.find(e=>e.event==='close'&&e.socket===socket),selectedSocket);assert.equal(selectedClose.code,1006);assert.ok(selectedClose.at-killAt<5000);
  const snapshot = await page.evaluate(async room => (await fetch(`/rooms/${room}`)).json(), room);
  assert.equal(snapshot.revision, 2); assert.equal(snapshot.items.length, 2);
  await probe.save('ingress', {room,owner,ingress,selectedSocket,selectedAt,killAt,acknowledgedAt,directOwner,ownerStartedAt:ownerState.StartedAt,ownerStillRunning:ownerAfter.Running,ingressStillStopped:!ingressAfter.Running,gatewayStartedAt:gatewayAfter.StartedAt,immediatelyBefore:immediatelyBefore.map(s=>({host:s.host,residents:s.state.residents,published:s.state.published})),survivor:{host:survivor.host,residents:survivor.state.residents,published:survivor.state.published},events:await page.evaluate(() => window.socketEvents),snapshot,scope:'Real workerd/native client, temporary backend order selects non-owner; selected socket closes on non-owner kill while direct owner control remains open and answers; owner and gateway processes unchanged'});
  console.log('PASS: non-owning ingress loss reconnects while room owner stays alive');
} finally {
  const cleanup = [
    () => rm(file, { force: true }), () => browser.close(),
    ...(controlFile ? [() => probe.node(`await (await import('node:fs/promises')).writeFile(${JSON.stringify(`${controlFile}.command`)},'stop')`)] : []),
    ...(killed ? [async () => {
      await probe.compose(['start', killed]);
      await expect.poll(async()=>{try{return Number(await probe.node(`console.log((await fetch('http://${killed}:8080/.well-known/celld/health')).status)`));}catch{return 0;}},{timeout:60000}).toBe(200);
    }] : []),
    ...(gatewayChanged ? [() => probe.compose(['up', '-d', '--no-deps', '--force-recreate', 'workerd'])] : []),
  ];
  const errors=[];
  for(const step of cleanup) {try {await step();} catch(error) {errors.push(error);}}
  if(errors.length)throw new AggregateError(errors,'Ingress fixture cleanup failed');
}
