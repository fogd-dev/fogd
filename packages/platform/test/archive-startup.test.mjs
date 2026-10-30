import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimePolicy } from '../src/runtime-policy.mjs';
import { policy, environment } from './fixtures/runtime-policy.mjs';

test('archive policy binds the fixed archive controller entrypoint', () => {
  const input = { ...policy(), schema: 4, routing: 'durable', controllerArgs: ['packages/platform/src/main-archive.mjs'] };
  assert.deepEqual(validateRuntimePolicy(input, environment()), input);
});

const archivePolicy = () => ({ ...policy(), schema: 4, routing: 'durable', controllerArgs: ['packages/platform/src/main-archive.mjs'] });
const durablePolicy = () => ({ ...policy(), schema: 3, routing: 'durable', controllerArgs: ['packages/platform/src/main-durable.mjs'] });
import { archiveControllerStartup, durableControllerStartup } from '../src/durable-startup.mjs';
import { startupArchiveProfile } from '../src/startup.mjs';

test('archive startup reads only an independently bound archive policy', async () => {
  const input = archivePolicy(), composition = archiveControllerStartup(async () => input);
  assert.equal(composition.archiveRecovery, true);
  assert.deepEqual(composition.routeAuthority, { path: '/var/lib/fogd-routes/routes.json' });
  assert.deepEqual(await composition.readPolicy(environment()), input);
  assert.deepEqual(startupArchiveProfile(input, composition.archiveRecovery), input);
});

test('ordinary durable startup cannot select archive policy', async () => {
  await assert.rejects(durableControllerStartup(async () => archivePolicy()).readPolicy(environment()), { code: 'RUNTIME_POLICY_REFUSED' });
  assert.throws(() => startupArchiveProfile(archivePolicy(), false), { code: 'RUNTIME_POLICY_REFUSED' });
});

test('archive entrypoint refuses a normal durable policy and a forged controller command', async () => {
  await assert.rejects(archiveControllerStartup(async () => durablePolicy()).readPolicy(environment()), { code: 'RUNTIME_POLICY_REFUSED' });
  const input = archivePolicy(); input.controllerArgs = ['packages/platform/src/main-durable.mjs'];
  await assert.rejects(archiveControllerStartup(async () => input).readPolicy(environment()), { code: 'RUNTIME_POLICY_REFUSED' });
  assert.throws(() => startupArchiveProfile(durablePolicy(), true), { code: 'RUNTIME_POLICY_REFUSED' });
});

test('environment and unknown startup values cannot enable archive recovery', async () => {
  const env = { ...environment(), FOGD_ARCHIVE_RECOVERY: '1' };
  assert.deepEqual(await durableControllerStartup(async () => durablePolicy()).readPolicy(env), durablePolicy());
  assert.equal(startupArchiveProfile(durablePolicy(), false), null);
  assert.throws(() => startupArchiveProfile(archivePolicy(), '1'), { code: 'RUNTIME_POLICY_REFUSED' });
  const changed = archivePolicy(); changed.fleets[0].prefix = 'unbound/namespace';
  await assert.rejects(archiveControllerStartup(async () => changed).readPolicy(environment()), { code: 'RUNTIME_POLICY_REFUSED' });
});
