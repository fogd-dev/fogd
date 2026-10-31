import test from 'node:test';
import assert from 'node:assert/strict';
import { previewExecutionSha256 } from '../src/preview/execution-authority.mjs';
import { createPreviewPlan, validatePreviewPlan, previewPlanTarget, previewPlanSha256, previewPlanMemory } from '../src/preview/plan.mjs';
import { assessPreviewAdmission } from '../src/preview/admission.mjs';
import { previewContainerCommands } from '../src/preview/container-plan.mjs';
import { readPreviewHost } from '../src/preview/host-inventory.mjs';

import { previewPlanFixture as fixture } from './fixtures/preview-plan.mjs';

const mib = 1024 ** 2;
const observed = (containers = []) => ({ host: { ID: 'engine-fixture', OSType: 'linux', Architecture: 'aarch64', Driver: 'overlay2', MemTotal: 6 * 1024 ** 3, NCPU: 8 }, containers, networks: [], volumes: [] });
const container = (memory = 512 * mib, running = true) => ({ Id: 'a'.repeat(64), Name: '/peer', State: { Running: running, Restarting: false, Paused: false }, Config: { Labels: {} }, HostConfig: { Memory: memory, PortBindings: {} } });
const refused = reason => ({ code: 'PREVIEW_ADMISSION_REFUSED', reason });

test('sealed preview plan has complete role topology, private storage and only one published listener', () => {
  const { plan } = fixture();
  assert.equal(Object.keys(plan.services).length, 10); assert.equal(Object.keys(plan.volumes).length, 12);
  assert.equal(previewPlanMemory(plan), 4352 * mib);
  assert.deepEqual(Object.entries(plan.services).filter(([, service]) => service.networks.includes('frontend')).map(([role]) => role), ['ingress']);
  assert.deepEqual(Object.entries(plan.services).filter(([, service]) => service.publish).map(([role]) => role), ['ingress']);
  for (const role of ['gateway', 'ingress']) { assert.deepEqual(plan.services[role].secretEnvironment, {}); assert.ok(plan.services[role].mounts.every(value => value.readOnly)); }
  assert.deepEqual(plan.services['slot-1-a'].networks, ['fleet-1']); assert.deepEqual(plan.services['slot-2-b'].networks, ['fleet-2']);
  assert.equal(previewPlanTarget(plan).configSha256, previewPlanSha256(plan));
});

for (const change of [p => p.services['slot-1-a'].networks.push('frontend'), p => { p.hardening.restart = 'always'; }, p => { p.services.gateway.publish = { port: 443 }; }, p => { p.volumes.minio.name = p.volumes.controller.name; }]) {
  test(`plan structural drift refuses: ${change.toString()}`, () => { const { plan } = fixture(); change(plan); assert.throws(() => validatePreviewPlan(plan), { code: 'PREVIEW_PLAN_REFUSED' }); });
}

test('a valid alternative image plan cannot reuse the original execution decision', () => {
  const f = fixture(), changed = createPreviewPlan({ ...f.request, image: 'sha256:' + '9'.repeat(64) });
  assert.notEqual(previewPlanSha256(changed), previewPlanSha256(f.plan));
  assert.throws(() => previewContainerCommands(changed, f.envelope, { role: 'gateway', secretValues: {}, publicKey: f.authority.publicKey, expectedGrantSha256: previewExecutionSha256(f.envelope) }), { code: 'PREVIEW_PLAN_REFUSED' });
});

test('plan refuses reused browser origins and indeterminate published ports', () => {
  const f = fixture();
  for (const origin of ['https://demo.preview.test:49443', f.request.origin.replace(':49443', ':0')]) {
    assert.throws(() => createPreviewPlan({ ...f.request, origin }), { code: 'PREVIEW_PLAN_REFUSED' });
  }
});

test('container realization binds exact authority, original expiry, role secrets and stopped network connections', () => {
  const f = fixture(), minio = f.commands('minio', { storagePassword: f.storagePassword }), gateway = f.commands('gateway'), ingress = f.commands('ingress');
  assert.equal(minio.create.at(-1), f.envelope.grant.expiresAt); assert.equal(minio.connect.length, 2);
  assert.equal(gateway.create.includes('--publish'), false); assert.equal(ingress.create.includes('--publish'), true);
  assert.ok(gateway.create.includes(new URL(f.request.origin).hostname));
  assert.equal(gateway.create.some(value => value.includes('FOGD_PREVIEW_STORAGE_PASSWORD')), false);
  assert.equal(ingress.connect[0].network, f.plan.networks.frontend.name);
  assert.throws(() => f.commands('gateway', { storagePassword: f.storagePassword }), { code: 'PREVIEW_PLAN_REFUSED' });
  assert.throws(() => f.commands('minio', { storagePassword: 'f'.repeat(64) }), { code: 'PREVIEW_PLAN_REFUSED' });
});

test('expired plans cannot realize fresh container commands', t => {
  const f = fixture(); t.mock.method(Date, 'now', () => Date.parse(f.envelope.grant.expiresAt));
  assert.throws(() => f.commands('gateway'), { code: 'PREVIEW_PLAN_REFUSED' });
});

test('read-only admission accounts for full memory envelope and grants neither execution nor reservation', () => {
  const { plan } = fixture(), report = assessPreviewAdmission(plan, observed(), []);
  assert.equal(report.memory.requestedLimitBytes, 4352 * mib); assert.equal(report.memory.headroomBytes, 1024 * mib);
  assert.equal(report.capacityReserved, false); assert.equal(report.executionAuthorized, false);
});

for (const [reason, alter] of [
  ['capacity', o => { o.host.MemTotal = 4 * 1024 ** 3; }],
  ['engine', o => { o.host.ID = 'wrong-engine'; }],
  ['unbounded-active-memory', o => { o.containers = [container(0)]; }],
  ['capacity', o => { o.containers = [container(2 * 1024 ** 3)]; }],
  ['port-used', o => { const c = container(0, false); c.HostConfig.PortBindings = { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '49443' }] }; o.containers = [c]; }],
]) test(`preview admission refuses ${reason}`, () => { const { plan } = fixture(), o = observed(); alter(o); assert.throws(() => assessPreviewAdmission(plan, o, []), refused(reason)); });

test('stopped resources remain in freshness checks and cannot silently become a fresh target', () => {
  const { plan } = fixture(), o = observed(); o.volumes.push({ Name: plan.volumes.minio.name, Labels: {} });
  assert.throws(() => assessPreviewAdmission(plan, o, []), refused('resources-exist'));
  const c = container(0, false); c.Name = '/' + plan.services.controller.name;
  assert.throws(() => assessPreviewAdmission(plan, observed([c]), []), refused('resources-exist'));
});

test('incomplete resource metadata refuses instead of assuming freshness or port availability', () => {
  const { plan } = fixture(), c = container(0, false); delete c.Config.Labels;
  assert.throws(() => assessPreviewAdmission(plan, observed([c]), []), refused('inventory'));
  c.Config.Labels = {}; c.HostConfig.PortBindings = { '8080/tcp': [{ HostPort: 49443 }] };
  assert.throws(() => assessPreviewAdmission(plan, observed([c]), []), refused('inventory'));
});

test('unconfirmed allocations remain fully held and known active roles are not counted twice', () => {
  const next = fixture(), held = fixture(251, 49444), c = container();
  c.Name = '/' + held.plan.services.controller.name; c.Image = held.plan.request.image;
  c.Config.Labels = { 'fogd.preview.project': held.plan.project, 'fogd.preview.config': previewPlanSha256(held.plan), 'fogd.preview.role': 'controller' };
  const o = observed([c]); o.host.MemTotal = 11 * 1024 ** 3;
  const report = assessPreviewAdmission(next.plan, o, [held.plan]);
  assert.equal(report.memory.heldEnvelopeBytes, 4352 * mib); assert.equal(report.memory.heldLimitBytes, (4352 - 512) * mib);
  assert.equal(report.memory.activeLimitBytes + report.memory.heldLimitBytes, 4352 * mib);
  assert.throws(() => assessPreviewAdmission(next.plan, observed(), [held.plan]), refused('capacity'));
  assert.throws(() => assessPreviewAdmission(next.plan, o, [held.plan, held.plan]), refused('reservations-duplicate'));
  assert.throws(() => assessPreviewAdmission(next.plan, o), refused('reservations-unknown'));
});

test('labels alone cannot make an unrelated active container consume a held role reservation', () => {
  const next = fixture(), held = fixture(251, 49444), c = container();
  c.Config.Labels = { 'fogd.preview.project': held.plan.project, 'fogd.preview.config': previewPlanSha256(held.plan), 'fogd.preview.role': 'controller' };
  const o = observed([c]); o.host.MemTotal = 12 * 1024 ** 3;
  assert.equal(assessPreviewAdmission(next.plan, o, [held.plan]).memory.heldLimitBytes, 4352 * mib);
  c.Name = '/' + held.plan.services.controller.name; c.Image = 'sha256:' + 'f'.repeat(64);
  assert.equal(assessPreviewAdmission(next.plan, o, [held.plan]).memory.heldLimitBytes, 4352 * mib);
});

test('host reader checks complete stopped inventory and refuses a changing snapshot', async () => {
  const o = observed([container(0, false)]), calls = [];
  const run = async args => { calls.push(args); if (args[0] === 'info') return JSON.stringify(o.host); if (args[1] === 'inspect') return JSON.stringify(args[0] === 'container' ? o.containers : []); return args[0] === 'container' ? o.containers[0].Id : ''; };
  assert.deepEqual(await readPreviewHost(run), o); assert.ok(calls.some(args => args.includes('-aq')));
  let reads = 0; const changed = async args => args[0] === 'container' && args[1] === 'ls' && ++reads > 1 ? '' : run(args);
  await assert.rejects(readPreviewHost(changed), refused('inventory-changed'));
});

test('new plans seal bounded temporary storage and explicit rotating log delivery for every role', () => {
  const f=fixture();assert.equal(f.plan.schema,3);assert.equal(f.plan.hardening.tmpfs,'/tmp:rw,noexec,nosuid,nodev,size=33554432,nr_inodes=4096');
  for(const role of Object.keys(f.plan.services)) {
    const secrets=Object.fromEntries(Object.values(f.plan.services[role].secretEnvironment).map(key=>[key,f[key]])),command=f.commands(role,secrets).create;
    assert.equal(command[command.indexOf('--log-driver')+1],'json-file');
    assert.deepEqual(command.flatMap((value,index)=>value==='--log-opt'?[command[index+1]]:[]),['max-size=1m','max-file=2','mode=blocking','compress=false']);
    assert.equal(command[command.indexOf('--tmpfs')+1],f.plan.hardening.tmpfs);
  }
  for(const change of [p=>p.hardening.logging.options['max-size']='0',p=>p.hardening.tmpfs='/tmp:rw,noexec,nosuid,nodev',p=>p.schema=1]){const p=structuredClone(f.plan);change(p);assert.throws(()=>validatePreviewPlan(p),{code:'PREVIEW_PLAN_REFUSED'})}
});

test('historical plans remain verifiable without authorizing fresh legacy containers', () => {
  const f=fixture(),legacy=structuredClone(f.plan);legacy.schema=1;delete legacy.request.storage;for(const volume of Object.values(legacy.volumes))delete volume.driverOptions;legacy.hardening.tmpfs='/tmp:rw,noexec,nosuid,nodev';delete legacy.hardening.logging;
  assert.deepEqual(validatePreviewPlan(legacy),legacy);assert.notEqual(previewPlanSha256(legacy),previewPlanSha256(f.plan));
  assert.throws(()=>previewContainerCommands(legacy,f.envelope,{role:'gateway',publicKey:f.authority.publicKey,expectedGrantSha256:previewExecutionSha256(f.envelope),secretValues:{}}),{code:'PREVIEW_PLAN_REFUSED'});
});

test('historical resource policy refuses startup before Docker, source access or host changes',async()=>{
  const {startPreviewAllocation}=await import('../src/preview/startup.mjs');let calls=0;
  await assert.rejects(startPreviewAllocation({plan:{schema:1},run:async()=>{calls++;throw Error('unexpected Docker call')}}),{code:'PREVIEW_HOST_REFUSED',reason:'resource-policy'});assert.equal(calls,0);
});

test('admission requires the simultaneous peak plus unchanged headroom, not concurrent one-shot helpers', () => {
  const { plan } = fixture(), o = observed(); o.host.MemTotal = (4352 + 1024) * mib;
  const report = assessPreviewAdmission(plan, o, []);
  assert.equal(Object.values(plan.services).reduce((sum, service) => sum + service.memoryBytes, 0), 4992 * mib);
  assert.equal(report.memory.requestedLimitBytes, 4352 * mib); assert.equal(report.memory.headroomBytes, 1024 * mib);
  o.host.MemTotal--; assert.throws(() => assessPreviewAdmission(plan, o, []), refused('capacity'));
});

function heldContainers(plan, roles) {
  return roles.map((role, index) => {
    const c = container(plan.services[role].memoryBytes); c.Id = (index + 1).toString(16).padStart(64, '0');
    c.Name = '/' + plan.services[role].name; c.Image = plan.request.image;
    c.Config.Labels = { 'fogd.preview.project': plan.project, 'fogd.preview.config': previewPlanSha256(plan), 'fogd.preview.role': role };
    return c;
  });
}
for (const roles of [['input-installer'], ['minio', 'bucket-init'], ['minio', 'slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b', 'controller', 'gateway', 'ingress']]) {
  test(`a held peer retains its peak budget during ${roles.join(', ')}`, () => {
    const next = fixture(), held = fixture(251, 49444), o = observed(heldContainers(held.plan, roles));
    o.host.MemTotal = (2 * 4352 + 1024) * mib;
    const report = assessPreviewAdmission(next.plan, o, [held.plan]);
    assert.equal(report.memory.activeLimitBytes + report.memory.heldLimitBytes, 4352 * mib);
    assert.equal(report.memory.heldEnvelopeBytes, 4352 * mib);
    o.host.MemTotal--; assert.throws(() => assessPreviewAdmission(next.plan, o, [held.plan]), refused('capacity'));
  });
}

test('extra active helpers cannot make the held remainder negative or admit another preview', () => {
  const next = fixture(), held = fixture(251, 49444), o = observed(heldContainers(held.plan, Object.keys(held.plan.services)));
  o.host.MemTotal = (2 * 4352 + 1024) * mib;
  assert.throws(() => assessPreviewAdmission(next.plan, o, [held.plan]), refused('capacity'));
  o.host.MemTotal += 640 * mib;
  const report = assessPreviewAdmission(next.plan, o, [held.plan]);
  assert.equal(report.memory.activeLimitBytes, 4992 * mib); assert.equal(report.memory.heldLimitBytes, 0);
});
