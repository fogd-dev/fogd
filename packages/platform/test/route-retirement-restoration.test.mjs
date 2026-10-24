import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRetiredRouteRestoration, restoreRetiredRouteStores, restoreEnrolledRouteStores } from '../src/route-restoration.mjs';
import { initializeFreshRouteStores } from '../src/fresh-route-enrollment.mjs';
import { readRouteRecord } from '../src/route-record-store.mjs';
import { runtimePolicyIdentity } from '../src/runtime-policy.mjs';
import { retirementRequest, alphaId, betaId, alphaDigest, betaDigest } from './fixtures/route-retirement.mjs';

const refused = error => error.code === 'ROUTE_RETIREMENT_REFUSED' && error.cause === undefined;
test('retirement removes only its route, tombstones its releases and holds the survivor behind its exact approval', () => {
  const input = retirementRequest(), before = structuredClone(input);
  const projected = prepareRetiredRouteRestoration(input);
  assert.deepEqual(projected.record.routes, [{ host: 'beta.localhost', state: 'withheld', slot: 'slot-2' }]);
  assert.equal(projected.record.revision, '1');
  assert.equal(projected.record.installation, runtimePolicyIdentity(input.profile));
  assert.notEqual(projected.record.installation, input.source.authority.record.installation);
  assert.equal(projected.state.apps.alpha.slot, null); assert.equal(projected.state.apps.alpha.route, 'retired');
  assert.equal(projected.state.deployments[alphaId].status, 'retired');
  assert.equal(projected.state.apps.beta.route, 'paused'); assert.equal(projected.state.deployments[betaId].status, 'active');
  assert.deepEqual(projected.state.routeAuthority.holds, { beta: { id: betaId, digest: betaDigest } });
  assert.deepEqual(projected.state.apps.alpha.retirement, { ...input.retirement.evidence, deployment: alphaId });
  assert.deepEqual(input, before);
});

for (const [name, change] of [
  ['wrong approved digest', input => { input.retirement.digest = 'a'.repeat(64); }],
  ['unchanged fleet identity', input => { input.profile = structuredClone(input.sourceProfile); }],
  ['changed survivor prefix', input => { input.profile.fleets[1].prefix = 'foreign'; }],
  ['changed survivor node identity', input => { input.profile.fleets[1].nodes[0].id = 'foreign-node'; }],
  ['changed storage credentials identity', input => { input.profile.bucket = 'foreign-bucket'; }],
  ['changed runtime image', input => { input.profile.image = 'sha256:' + '9'.repeat(64); }],
  ['overlapping replacement prefix', input => { input.profile.fleets[0].prefix = 'slots/slot-1/child'; }],
  ['forged previous node', input => { input.retirement.evidence.previous.nodes[0] = 'foreign'; }],
  ['forged replacement node', input => { input.retirement.evidence.replacement.nodes[0] = 'foreign'; }],
  ['wrong snapshot reference', input => { input.retirement.evidence.snapshot = 'a'.repeat(64); }],
  ['malformed generation', input => { input.retirement.evidence.id = '------------------------------------'; }],
  ['invalid timestamp', input => { input.retirement.evidence.at = 'yesterday'; }],
  ['nonboolean background acknowledgment', input => { input.retirement.stopQueuedWork = 'false'; }],
  ['unneeded scheduled acknowledgment', input => { input.retirement.stopScheduledWork = true; }],
  ['pending route publication', input => { input.source.state.routeAuthority.pending = {}; }],
  ['stale public digest', input => { input.source.authority.digest = 'a'.repeat(64); }],
  ['quarantined application', input => { input.source.state.apps.alpha.quarantined = true; }],
  ['unknown source capability', input => { input.source.state.requirements.push('future-capability'); }],
  ['extra source path', input => { input.controller = '/tmp/private'; }],
]) test(`${name} cannot authorize a retirement projection`, () => {
  const input = retirementRequest(); change(input);
  assert.throws(() => prepareRetiredRouteRestoration(input), refused);
});

test('retirement allows independent target networks without changing survivor storage', () => {
  const input = retirementRequest();
  input.profile.networks = { control: '10.92.0.0/24', 'fleet-1': '10.92.1.0/24', 'fleet-2': '10.92.2.0/24' };
  const projected = prepareRetiredRouteRestoration(input);
  assert.deepEqual(projected.record.routes, [{ host: 'beta.localhost', state: 'withheld', slot: 'slot-2' }]);
  assert.deepEqual(projected.state.routeAuthority.holds, { beta: { id: betaId, digest: betaDigest } });
});

async function target(t, input) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-retirement-stores-')); t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { controller: join(root, 'controller'), authority: join(root, 'authority'), enrollment: join(root, 'enrollment') };
  for (const path of Object.values(paths)) await mkdir(path);
  await initializeFreshRouteStores({ profile: input.profile, binding: input.binding }, paths);
  return paths;
}
test('retirement spends fresh enrollment once and ordinary restore cannot accept the identity-changing request', async t => {
  const input = retirementRequest(), paths = await target(t, input);
  await assert.rejects(restoreEnrolledRouteStores(input, paths), { code: 'ROUTE_RESTORATION_REFUSED' });
  assert.deepEqual((await readdir(paths.enrollment)).sort(), ['route-enrollment.json', 'route-enrollment.spent.json']);
  const receipt = await restoreRetiredRouteStores(input, paths);
  const saved = JSON.parse(await readFile(join(paths.controller, 'state.json')));
  assert.equal(saved.apps.alpha.retirement.digest, alphaDigest); assert.equal(saved.apps.alpha.slot, null);
  const observed = await readRouteRecord(join(paths.authority, 'routes.json'), { installation: runtimePolicyIdentity(input.profile), slots: ['slot-1', 'slot-2'] });
  assert.deepEqual(observed.record.routes, [{ host: 'beta.localhost', state: 'withheld', slot: 'slot-2' }]);
  assert.equal(receipt.sha256, observed.digest);
  const before = await readFile(join(paths.controller, 'state.json'));
  await assert.rejects(restoreRetiredRouteStores(input, paths), { code: 'ROUTE_RESTORATION_REFUSED' });
  assert.deepEqual(await readFile(join(paths.controller, 'state.json')), before);
});

test('interrupted retirement publication retains its spent grant and refuses replay', async t => {
  const input = retirementRequest(), paths = await target(t, input);
  await assert.rejects(restoreRetiredRouteStores(input, { ...paths, writePublic: async () => { throw new Error('PRIVATE write failure'); } }), { code: 'ROUTE_RESTORATION_UNCERTAIN' });
  assert.equal(JSON.parse(await readFile(join(paths.enrollment, 'route-restoration.spent.json'))).snapshot, input.snapshot);
  assert.equal(JSON.parse(await readFile(join(paths.controller, 'state.json'))).apps.alpha.route, 'retired');
  const before = await readFile(join(paths.controller, 'state.json'));
  await assert.rejects(restoreRetiredRouteStores(input, paths), { code: 'ROUTE_RESTORATION_REFUSED' });
  assert.deepEqual(await readFile(join(paths.controller, 'state.json')), before);
});

const entrypoint = fileURLToPath(new URL('../src/import-retired-routes.mjs', import.meta.url));
for (const [name, input] of [
  ['oversized', Buffer.alloc(16 * 1024 * 1024 + 1, 0x20)],
  ['invalid UTF-8', Buffer.from([0xff])],
  ['serialized path', Buffer.from(JSON.stringify({ ...retirementRequest(), controller: '/tmp/private' }))],
]) test(`retirement entrypoint refuses ${name} input without a receipt`, () => {
  const result = spawnSync(process.execPath, [entrypoint], { input, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Route restoration failed( \(ROUTE_[A-Z_]+\))?; keep ingress stopped and retain all stores\n$/);
});
