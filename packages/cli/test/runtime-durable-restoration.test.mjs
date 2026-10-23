import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { restoreDurableRoutes } from '../src/runtime/durable-restoration.mjs';
import { initializeFreshRouteStores } from '../../platform/src/fresh-route-enrollment.mjs';
import { restoreEnrolledRouteStores, prepareRouteRestoration } from '../../platform/src/route-restoration.mjs';
import { readRouteRecord } from '../../platform/src/route-record-store.mjs';
import { durableBundleFixture } from './fixtures/durable-bundle.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const f = await durableBundleFixture(t), binding = hash('fresh target inventory');
  const paths = { controller: join(f.root, 'target-controller'), authority: join(f.root, 'target-authority'), enrollment: join(f.root, 'target-enrollment') };
  for (const path of Object.values(paths)) await mkdir(path);
  await initializeFreshRouteStores({ profile: f.policy, binding }, paths);
  const routePolicy = { installation: runtimePolicyIdentity(f.policy), slots: f.policy.fleets.map(fleet => fleet.id) };
  const input = { profile: f.policy, sourceProfile: f.policy, source: { state: f.state,
    authority: await readRouteRecord(join(f.authority, 'routes.json'), routePolicy) }, snapshot: hash(JSON.stringify(f.manifest)), binding, domain: 'localhost' };
  const calls = [], run = async (args, io) => { calls.push({ args, io }); return JSON.stringify(await restoreEnrolledRouteStores(JSON.parse(io.inputText), paths)); };
  return { ...f, paths, routePolicy, input, calls, run };
}
test('the fixed restoration adapter connects an independently checked source to actual newly enrolled route stores', async t => {
  const f = await fixture(t), expected = prepareRouteRestoration(f.input);
  const receipt = await restoreDurableRoutes(f.config, f.input, { run: f.run });
  const state = JSON.parse(await readFile(join(f.paths.controller, 'state.json'))), observed = await readRouteRecord(join(f.paths.authority, 'routes.json'), f.routePolicy);
  assert.equal(receipt.sha256, observed.digest); assert.equal(receipt.snapshot, f.input.snapshot);
  assert.deepEqual(observed.record, expected.record); assert.ok(observed.record.routes.every(route => route.state === 'withheld'));
  assert.deepEqual(state.deployments, f.state.deployments); assert.equal(state.apps.alpha.route, 'paused');
  assert.equal(state.routeEnrollment.controller.path, await realpath(f.paths.controller));
  assert.notDeepEqual(state.routeEnrollment, f.state.routeEnrollment);
  const { args, io } = f.calls[0];
  assert.deepEqual(args.slice(0, 14), ['run', '--pull', 'never', '--rm', '-i', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--mount', `type=volume,src=${f.config.volumes.controller.name},dst=/var/lib/fogd,volume-nocopy`]);
  assert.equal(args.at(-1), 'packages/platform/src/import-restored-routes.mjs');
  assert.equal(args[args.indexOf('--entrypoint') + 1], '/usr/local/bin/node');
  assert.equal(args.filter(value => value === '--mount').length, 3); assert.equal(args.includes('--env'), false);
  assert.deepEqual(JSON.parse(io.inputText), f.input);
});
test('unsealed or inconsistent restore inputs cannot start a helper', async t => {
  const f = await fixture(t), mutations = [input => { input.binding = 'bad'; }, input => { input.snapshot = 'bad'; },
    input => { input.controller = '/private/override'; }, input => { input.source.authority.digest = 'f'.repeat(64); },
    input => { input.profile.storage.endpoint = 'http://foreign:9000'; }];
  for (const mutate of mutations) {
    const input = structuredClone(f.input); mutate(input);
    await assert.rejects(restoreDurableRoutes(f.config, input, { run: async () => assert.fail('No helper') }), { code: 'DURABLE_RESTORATION_REFUSED' });
  }
  const config = structuredClone(f.config); config.services.workerd.environment.EXTRA = 'private';
  await assert.rejects(restoreDurableRoutes(config, f.input, { run: async () => assert.fail('No helper') }), { code: 'DURABLE_RESTORATION_REFUSED' });
  const domain = structuredClone(f.config); domain.services.controller.environment.FOGD_BASE_DOMAIN = 'another.localhost';
  await assert.rejects(restoreDurableRoutes(domain, f.input, { run: async () => assert.fail('No helper') }), { code: 'DURABLE_RESTORATION_REFUSED' });
});
test('invalid helper receipts and uncertain commands cannot report restoration success', async t => {
  const f = await fixture(t), projection = prepareRouteRestoration(f.input);
  const receipt = { id: '00000000-0000-4000-8000-000000000001', installation: f.routePolicy.installation,
    binding: f.input.binding, snapshot: f.input.snapshot, revision: '1', sha256: hash(JSON.stringify(projection.record, null, 2)) };
  const changes = [value => { value.snapshot = 'f'.repeat(64); }, value => { value.sha256 = 'f'.repeat(64); },
    value => { value.revision = '0'; }, value => { value.id = 'bad'; }, value => { value.extra = true; }, value => { value.binding = 'f'.repeat(64); }];
  for (const change of changes) {
    const value = structuredClone(receipt); change(value);
    await assert.rejects(restoreDurableRoutes(f.config, f.input, { run: async () => JSON.stringify(value) }), { code: 'DURABLE_RESTORATION_UNCERTAIN' });
  }
  await assert.rejects(restoreDurableRoutes(f.config, f.input, { run: async () => { throw new Error('private Docker failure'); } }), error => error.code === 'DURABLE_RESTORATION_UNCERTAIN' && !error.cause && !/private/.test(error.message));
});
