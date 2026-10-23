import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { enrollDurableInstallation } from '../src/runtime/durable-installation.mjs';
import { durablePlanSha256 } from '../src/runtime/durable-config.mjs';
import { assertDurableEnrollmentReady } from '../src/runtime/enrollment-record.mjs';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { Controller } from '../../platform/src/controller.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
import { durableEnrollmentFixture as fixture } from './fixtures/durable-enrollment.mjs';
test('fresh enrollment connects actual policy writers, grant spending and route publication before declaring completion', async t => {
  const f = await fixture(t), result = await enrollDurableInstallation(f.selected, f.options);
  const record = await assertDurableEnrollmentReady(f.directory, { project: result.config.name, installation: runtimePolicyIdentity(result.policy), planSha256: durablePlanSha256(result.config, result.policy) });
  assert.equal(record.inventoryBinding, hash('inventory'));
  assert.deepEqual(f.events.map(args => args[0]), ['volume', 'compose', 'run']);
  assert.ok(f.events[1].includes('--no-build')); assert.ok(f.events[1].includes('create')); assert.equal(f.events.some(args => args.includes('up') || args[0] === 'start'), false);
  const spent = JSON.parse(await readFile(join(f.rolePath('route-enrollment'), 'route-enrollment.spent.json'), 'utf8'));
  const state = JSON.parse(await readFile(join(f.rolePath('controller'), 'state.json'), 'utf8'));
  assert.match(spent.id, /^[a-f0-9-]{36}$/); assert.equal(state.routeAuthority.pending, null); assert.equal(state.routeAuthority.settled.revision, '0');
  const controller = new Controller({ dir: f.rolePath('controller'), backend: { owner: async () => null },
    slots: result.policy.fleets.map(fleet => ({ id: fleet.id, prefix: fleet.prefix, nodes: fleet.nodes.map(node => node.host) })),
    routeAuthority: { path: join(f.rolePath('route-authority'), 'routes.json'), policy: { installation: runtimePolicyIdentity(result.policy), slots: ['slot-1', 'slot-2'] }, verifyRuntime: async () => assert.fail('No active applications') } });
  await controller.init(); assert.equal(controller.routingStartupComplete, true);
  await assert.rejects(enrollDurableInstallation(f.selected, f.options), { code: 'DURABLE_INSTALLATION_UNCONFIRMED' });
  assert.deepEqual((await readdir(f.directory)).sort(), ['compose.json', 'enrollment.complete.json', 'enrollment.pending.json']);
});
test('failed policy installation retains resources and a permanent incomplete enrollment fence', async t => {
  const f = await fixture(t); f.options.policies = async () => { throw new Error('PRIVATE failure'); };
  await assert.rejects(enrollDurableInstallation(f.selected, f.options), error => error.code === 'DURABLE_INSTALLATION_UNCONFIRMED' && !error.message.includes('PRIVATE') && !('cause' in error));
  await assert.rejects(assertDurableEnrollmentReady(f.directory), { code: 'ENROLLMENT_NOT_READY' });
  assert.deepEqual((await readdir(f.directory)).sort(), ['compose.json', 'enrollment.pending.json']);
  assert.ok((await readdir(dirname(f.rolePath('controller')))).length > 0);
});
test('a foreign inventory after policy writes cannot issue a route grant', async t => {
  const f = await fixture(t); let calls = 0, issued = false;
  f.options.inspect = async () => ({ ...f.snapshot(), identity: hash(++calls === 1 ? 'inventory' : 'foreign') });
  f.options.routes = async () => { issued = true; throw new Error('Unexpected initializer'); };
  await assert.rejects(enrollDurableInstallation(f.selected, f.options), { code: 'DURABLE_INSTALLATION_UNCONFIRMED' });
  assert.equal(issued, false); await assert.rejects(assertDurableEnrollmentReady(f.directory), { code: 'ENROLLMENT_NOT_READY' });
});
test('initially live containers cannot install any policies or issue a grant', async t => {
  const f = await fixture(t); let policies = false;
  f.options.inspect = async () => { const result = f.snapshot(); result.services.controller.running = true; result.services.controller.status = 'running'; return result; };
  f.options.policies = async () => { policies = true; };
  await assert.rejects(enrollDurableInstallation(f.selected, f.options), { code: 'DURABLE_INSTALLATION_UNCONFIRMED' });
  assert.equal(policies, false); await assert.rejects(assertDurableEnrollmentReady(f.directory), { code: 'ENROLLMENT_NOT_READY' });
});
