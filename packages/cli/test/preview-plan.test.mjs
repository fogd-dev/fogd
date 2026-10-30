import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hash, jsonBytes } from '../src/build-cache/paths.mjs';
import { createPreviewExecutionAuthority, previewExecutionSha256 } from '../src/preview/execution-authority.mjs';
import { issuePreviewExecution } from '../src/preview/execution.mjs';
import { createPreviewPlan, validatePreviewPlan, previewPlanTarget, previewPlanSha256, previewPlanMemory } from '../src/preview/plan.mjs';
import { assessPreviewAdmission } from '../src/preview/admission.mjs';
import { previewContainerCommands } from '../src/preview/container-plan.mjs';
import { readPreviewHost } from '../src/preview/host-inventory.mjs';

const mib = 1024 ** 2;
function fixture(octet = 250, port = 49443) {
  const id = randomUUID(), authority = createPreviewExecutionAuthority(), storagePassword = 'b'.repeat(64), gatewayToken = 'c'.repeat(64);
  const preparation = { schema: 1, kind: 'fogd-preview-preparation', id, status: 'prepared', preparedAt: new Date().toISOString(),
    source: { controller: 'https://source.test', app: 'demo', submission: randomUUID(), digest: '1'.repeat(64), reviewSha256: '2'.repeat(64) },
    runtime: { family: 'preview-candidate-test', catalogEntrySha256: '3'.repeat(64) },
    policy: { lifetimeSeconds: 60, storage: 'fresh-empty-only', secrets: 'preview-only', requiredSecrets: [], background: 'disabled', network: 'no-external-egress', access: 'owner-authenticated', expiry: 'deny-requests-and-stop-writers', dataPromotion: 'none' },
    executionAuthorized: false, capacityReserved: false, scope: 'Owned plan fixture only' };
  const request = { preparation, preparationSha256: hash(jsonBytes(preparation)), engineId: 'engine-fixture', image: 'sha256:' + '4'.repeat(64), origin: `https://demo.${id.replaceAll('-', '')}.preview.test:${port}`,
    subnets: { control: `10.${octet}.1.0/24`, 'fleet-1': `10.${octet}.2.0/24`, 'fleet-2': `10.${octet}.3.0/24`, frontend: `10.${octet}.4.0/24` },
    fingerprints: { authorityPublicKey: hash(authority.publicKey), artifact: '5'.repeat(64), previewSecrets: hash(jsonBytes({})), storagePassword: hash(storagePassword), gatewayToken: hash(gatewayToken), viewerAccessKey: '6'.repeat(64), gatewayTLS: '7'.repeat(64), ingressTLS: '8'.repeat(64) } };
  const plan = createPreviewPlan(request), target = previewPlanTarget(plan);
  const release = { app: 'demo', digest: preparation.source.digest, requiredSecrets: [], resources: { script: 'demo', durable: { bindings: [] }, d1: [], r2: [] } };
  const envelope = issuePreviewExecution(preparation, { expectedPreparationSha256: request.preparationSha256, release, target, privateKey: authority.privateKey });
  return { plan, request, envelope, authority, storagePassword, gatewayToken,
    commands: (role, secretValues = {}) => previewContainerCommands(plan, envelope, { role, secretValues, publicKey: authority.publicKey, expectedGrantSha256: previewExecutionSha256(envelope) }) };
}
const observed = (containers = []) => ({ host: { ID: 'engine-fixture', OSType: 'linux', Architecture: 'aarch64', Driver: 'overlay2', MemTotal: 6 * 1024 ** 3, NCPU: 8 }, containers, networks: [], volumes: [] });
const container = (memory = 512 * mib, running = true) => ({ Id: 'a'.repeat(64), Name: '/peer', State: { Running: running, Restarting: false, Paused: false }, Config: { Labels: {} }, HostConfig: { Memory: memory, PortBindings: {} } });
const refused = reason => ({ code: 'PREVIEW_ADMISSION_REFUSED', reason });

test('sealed preview plan has complete role topology, private storage and only one published listener', () => {
  const { plan } = fixture();
  assert.equal(Object.keys(plan.services).length, 9); assert.equal(Object.keys(plan.volumes).length, 12);
  assert.equal(previewPlanMemory(plan), 4480 * mib);
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
  assert.equal(report.memory.requestedLimitBytes, 4480 * mib); assert.equal(report.memory.headroomBytes, 1024 * mib);
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
  const o = observed([c]); o.host.MemTotal = 10 * 1024 ** 3;
  const report = assessPreviewAdmission(next.plan, o, [held.plan]);
  assert.equal(report.memory.heldEnvelopeBytes, 4480 * mib); assert.equal(report.memory.heldLimitBytes, (4480 - 512) * mib);
  assert.equal(report.memory.activeLimitBytes + report.memory.heldLimitBytes, 4480 * mib);
  assert.throws(() => assessPreviewAdmission(next.plan, observed(), [held.plan]), refused('capacity'));
  assert.throws(() => assessPreviewAdmission(next.plan, o, [held.plan, held.plan]), refused('reservations-duplicate'));
  assert.throws(() => assessPreviewAdmission(next.plan, o), refused('reservations-unknown'));
});

test('labels alone cannot make an unrelated active container consume a held role reservation', () => {
  const next = fixture(), held = fixture(251, 49444), c = container();
  c.Config.Labels = { 'fogd.preview.project': held.plan.project, 'fogd.preview.config': previewPlanSha256(held.plan), 'fogd.preview.role': 'controller' };
  const o = observed([c]); o.host.MemTotal = 12 * 1024 ** 3;
  assert.equal(assessPreviewAdmission(next.plan, o, [held.plan]).memory.heldLimitBytes, 4480 * mib);
  c.Name = '/' + held.plan.services.controller.name; c.Image = 'sha256:' + 'f'.repeat(64);
  assert.equal(assessPreviewAdmission(next.plan, o, [held.plan]).memory.heldLimitBytes, 4480 * mib);
});

test('host reader checks complete stopped inventory and refuses a changing snapshot', async () => {
  const o = observed([container(0, false)]), calls = [];
  const run = async args => { calls.push(args); if (args[0] === 'info') return JSON.stringify(o.host); if (args[1] === 'inspect') return JSON.stringify(args[0] === 'container' ? o.containers : []); return args[0] === 'container' ? o.containers[0].Id : ''; };
  assert.deepEqual(await readPreviewHost(run), o); assert.ok(calls.some(args => args.includes('-aq')));
  let reads = 0; const changed = async args => args[0] === 'container' && args[1] === 'ls' && ++reads > 1 ? '' : run(args);
  await assert.rejects(readPreviewHost(changed), refused('inventory-changed'));
});
