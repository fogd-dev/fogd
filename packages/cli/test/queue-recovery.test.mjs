import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertQueueFreeRecovery, assertSnapshotQueueFree, assertQueueFreeMetadata } from '../src/recovery/queue-safety.mjs';
import { execute } from '../src/recovery/execute.mjs';
import { restore, restoreInstallation } from '../src/recovery/restore.mjs';
import { expand } from '../src/recovery/expand.mjs';
import { retire } from '../src/recovery/retire.mjs';
import { fingerprint } from '../src/recovery/bundle.mjs';
import { config, services, volumes } from './fixtures/recovery-layout.mjs';

test('recovery refuses queue history even with no current active app or delivery journal', () => {
  assertQueueFreeRecovery({ apps: {}, deployments: {} });
  assertQueueFreeMetadata('{"apps":{},"deployments":{}}');
  assert.throws(() => assertQueueFreeMetadata('{"private":"never-display"'), error => error.message === 'Cannot read controller metadata for recovery');
  assert.throws(() => assertQueueFreeMetadata('{"apps":{},"deployments":{},"requirements":["fogd-queue-activation-v1"]}'), /Queued installation recovery/);
  assertQueueFreeRecovery({ apps: { demo: { resources: { d1: ['db'] } } }, deployments: {}, requirements: ['fogd-retirement-v1', 'fogd-claim-intent-v1'] });
  for (const app of [{ delivery: null }, { queueBootstrap: {} }, { resources: { queues: {} } }]) {
    assert.throws(() => assertQueueFreeRecovery({ apps: { demo: app }, deployments: {} }), /Queued installation recovery/);
  }
  assert.throws(() => assertQueueFreeRecovery({ apps: {}, deployments: {}, requirements: ['fogd-queue-activation-v1'] }), /retention/);
  assert.throws(() => assertQueueFreeRecovery({ apps: {}, deployments: { pending: { resources: { queues: {} } } } }), /retention/);
  assert.throws(() => assertQueueFreeRecovery({ apps: {}, deployments: {}, requirements: ['future-capability'] }), /unsupported recovery capability/);
  for (const state of [null, {}, { apps: [], deployments: {} }, { apps: { demo: null }, deployments: {} }, { apps: {}, deployments: {}, requirements: 'private-value' }]) {
    assert.throws(() => assertQueueFreeRecovery(state), error => /Cannot establish/.test(error.message) && !error.message.includes('private-value'));
  }
});

test('offline archive inspection refuses missing, malformed, and nested metadata without disclosing it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-queue-archive-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(assertSnapshotQueueFree(dir), /Cannot read controller state/);
  await writeFile(join(dir, 'nested.json'), JSON.stringify({ apps: {}, deployments: {} }));
  await execute('tar', ['-cf', join(dir, 'controller.tar'), '-C', dir, './nested.json']);
  await assert.rejects(assertSnapshotQueueFree(dir), /Cannot read controller state/);
  await writeFile(join(dir, 'state.json'), '{"secret":"never-display"');
  await execute('tar', ['-cf', join(dir, 'controller.tar'), '-C', dir, './state.json']);
  await assert.rejects(assertSnapshotQueueFree(dir), error => /Cannot read controller state/.test(error.message) && !error.message.includes('never-display'));
  await writeFile(join(dir, 'state.json'), JSON.stringify({ apps: {}, deployments: {} }));
  await execute('tar', ['-cf', join(dir, 'controller.tar'), '-C', dir, './state.json']);
  await assertSnapshotQueueFree(dir);
  await execute('tar', ['-rf', join(dir, 'controller.tar'), '-C', dir, 'state.json']);
  await assert.rejects(assertSnapshotQueueFree(dir), /Cannot read controller state/);
});

test('restore, expansion, and retirement reject checksummed queued snapshots before Docker access', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-queue-restore-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = { apps: {}, deployments: {}, requirements: ['fogd-queue-activation-v1'] };
  await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  await execute('tar', ['-cf', join(dir, 'controller.tar'), '-C', dir, './state.json']);
  const files = {};
  for (const file of ['compose.json', 'images.tar', ...volumes.map(v => `${v}.tar`)]) {
    if (file !== 'controller.tar') await writeFile(join(dir, file), file === 'compose.json' ? JSON.stringify(config()) : 'unused archive');
    files[file] = await fingerprint(join(dir, file));
  }
  const manifest = { format: 'fogd-stopped-v1', sourceProject: 'original', files, images: Object.fromEntries(services.map(name => [name, 'sha256:' + 'b'.repeat(64)])) };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  const output = join(dir, 'target');
  await assert.rejects(restore(dir, 'fresh', output), /Queued installation recovery/);
  await assert.rejects(expand(dir, 'fresh', output), /Queued installation recovery/);
  await assert.rejects(retire(dir, 'demo', 'a'.repeat(64), 'fresh', output), /Queued installation recovery/);
  await assert.rejects(restoreInstallation({ dir }, 'fresh', output, { kind: 'expansion' }), /Queued installation recovery/);
  await assert.rejects(access(output), /ENOENT/);
});
