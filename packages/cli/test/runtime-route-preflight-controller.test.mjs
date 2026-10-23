import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Controller } from '../../platform/src/controller.mjs';
import { serveController } from '../../platform/src/controller-service.mjs';
import { issueRouteEnrollment } from '../../platform/src/route-enrollment.mjs';
import { initializeRouteEnrollment } from '../../platform/src/route-initialize.mjs';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { policy } from '../../platform/test/fixtures/runtime-policy.mjs';
import { requestRoutingPreflight } from '../src/runtime/route-preflight.mjs';

test('host preflight client observes a real enrolled durable controller through admin authentication and CSRF', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fogd-preflight-controller-')); t.after(() => rm(root, { recursive: true, force: true }));
  const profile = { ...policy(), schema: 3, routing: 'durable', controllerArgs: ['packages/platform/src/main-durable.mjs'] };
  const input = { profile, binding: 'e'.repeat(64), controller: join(root, 'controller'), authority: join(root, 'authority'), enrollment: join(root, 'enrollment') };
  await mkdir(input.controller, { mode: 0o700 }); await mkdir(input.authority, { mode: 0o755 }); await mkdir(input.enrollment, { mode: 0o700 });
  const grant = await issueRouteEnrollment(input); await initializeRouteEnrollment({ ...input, id: grant.id });
  const controller = new Controller({ dir: input.controller, backend: { owner: async () => null },
    slots: profile.fleets.map(fleet => ({ id: fleet.id, prefix: fleet.prefix, nodes: fleet.nodes.map(node => node.host) })),
    routeAuthority: { path: join(input.authority, 'routes.json'), policy: { installation: runtimePolicyIdentity(profile), slots: ['slot-1', 'slot-2'] },
      verifyRuntime: async () => assert.fail('An empty installation has no active runtime to verify') } });
  const service = await serveController(controller, { user: 'operator', password: 'synthetic-admin', gateway: 'synthetic-gateway' }, { host: '127.0.0.1', port: 0 });
  t.after(() => service.close({ force: true }));
  const env = { FOGD_SERVER: `http://127.0.0.1:${service.http.address().port}`, FOGD_ADMIN_USER: 'operator', FOGD_ADMIN_PASSWORD: 'synthetic-admin' };
  const first = await requestRoutingPreflight(env, profile), second = await requestRoutingPreflight(env, profile);
  assert.equal(service.internal, null); assert.equal(service.recoveryOnly, false);
  assert.equal(first.authority.record.installation, runtimePolicyIdentity(profile)); assert.equal(first.authority.record.revision, '0');
  assert.deepEqual(first.authority.record.routes, []); assert.deepEqual(first.observedActiveHosts, []);
  assert.match(first.challenge, /^[a-f0-9]{64}$/); assert.notEqual(first.challenge, second.challenge);
  assert.equal(Object.hasOwn(first, 'csrf'), false); assert.deepEqual(first.authority, second.authority);
});
