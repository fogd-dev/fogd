import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverPreviewStorageReadOnly, inspectPreviewStorageRecovery, reconcilePreviewStorageRecovery, repairPreviewStorageRecoveryCompletion } from '../src/preview/storage-recovery.mjs';
import { validatePreviewStorageReceipt } from '../src/preview/storage.mjs';
import { previewStorageFixture } from './fixtures/preview-storage.mjs';

const input = { root: '/var/lib/docker/preview-storage', project: 'fogd-preview-' + 'a'.repeat(32), engineId: 'engine-fixture' };
const options = { recoveryId: '00000000-0000-4000-8000-000000000001', storageSha256: 'a'.repeat(64) };
const refused = { code: 'PREVIEW_STORAGE_REFUSED' };
function report() {
  const storage = previewStorageFixture(input.project, input.engineId, input.root).storage;
  return { schema: 1, kind: 'fogd-preview-storage-readonly-recovery', id: options.recoveryId, operation: '00000000-0000-4000-8000-000000000002',
    project: input.project, engineId: input.engineId, originalStorageSha256: options.storageSha256, uuid: storage.uuid, admission: storage.admission,
    rootIdentity: storage.rootIdentity, directoryIdentity: storage.directoryIdentity, disk: storage.disk, loop: storage.loop,
    mount: { ...storage.mount, options: 'ro,nosuid,nodev,noexec,relatime,norecovery' }, roles: storage.roles,
    readOnly: true, resourcesRetained: true, executionAuthorized: false, ordinaryEnrollment: false };
}

test('read-only recovery and inspection bind explicit identities without supplying an execution receipt', async () => {
  const calls = [], runHost = async (args, extra) => { calls.push(JSON.parse(extra.inputText)); return JSON.stringify({ ok: true, recovery: report() }); };
  const recovered = await recoverPreviewStorageReadOnly({ ...input, runHost }, options);
  assert.deepEqual(await inspectPreviewStorageRecovery({ ...input, runHost }, options), recovered);
  assert.deepEqual(await reconcilePreviewStorageRecovery({ ...input, runHost }, options), recovered);
  assert.deepEqual(calls, ['recover-readonly', 'inspect-readonly', 'reconcile-readonly'].map(action => ({ action, ...input, ...options })));
  assert.equal(recovered.executionAuthorized, false); assert.equal(recovered.resourcesRetained, true);
  assert.throws(() => validatePreviewStorageReceipt(recovered, input), refused);
});

test('a reused writable loop still requires a read-only no-replay mount; a new read-only loop is accepted', async () => {
  for (const ro of [false, true]) {
    const value = report(); value.loop.ro = ro;
    assert.equal((await inspectPreviewStorageRecovery({ ...input, runHost: async () => JSON.stringify({ ok: true, recovery: value }) }, options)).recovery.loop.ro, ro);
  }
});

test('invalid identities refuse before invoking the privileged host', async () => {
  let calls = 0;
  for (const bad of [{ ...options, recoveryId: 'bad' }, { ...options, storageSha256: '' }, {}]) {
    await assert.rejects(recoverPreviewStorageReadOnly({ ...input, runHost: async () => { calls++; } }, bad), refused);
  }
  await assert.rejects(recoverPreviewStorageReadOnly({ ...input, root: '/var/../else', runHost: async () => { calls++; } }, options), refused);
  assert.equal(calls, 0);
});

for (const [name, change] of Object.entries({
  engine: x => { x.engineId = 'other'; }, recoveryId: x => { x.id = '00000000-0000-4000-8000-000000000009'; },
  digest: x => { x.originalStorageSha256 = 'b'.repeat(64); }, writable: x => { x.mount.options = 'rw,nosuid,nodev,noexec,relatime,norecovery'; },
  journal: x => { x.mount.options = 'ro,nosuid,nodev,noexec,relatime'; }, weakMount: x => { x.mount.options = 'ro,relatime,norecovery'; },
  sparse: x => { x.disk.allocatedBytes = 0; }, offset: x => { x.loop.offset = 4096; }, reusedRole: x => { x.roles.controller = x.roles.minio; },
  foreignMount: x => { x.mount.target = '/var/lib/else'; }, execution: x => { x.executionAuthorized = true; }, extra: x => { x.privateDiagnostic = 'PRIVATE_HOST_SECRET'; },
})) test(`read-only recovery rejects ${name} without private diagnostics`, async () => {
  const value = report(); change(value);
  await assert.rejects(inspectPreviewStorageRecovery({ ...input, runHost: async () => JSON.stringify({ ok: true, recovery: value }) }, options),
    error => error.code === refused.code && !error.message.includes('PRIVATE_HOST_SECRET'));
});

test('an unknown mount response is sanitized and never automatically replayed', async () => {
  let calls = 0;
  await assert.rejects(recoverPreviewStorageReadOnly({ ...input, runHost: async () => { calls++; throw Error('PRIVATE_HOST_SECRET'); } }, options),
    error => error.code === refused.code && error.reason === 'uncertain' && !error.message.includes('PRIVATE_HOST_SECRET'));
  assert.equal(calls, 1);
});


test('completion repair binds the reviewed damaged-record digest without granting execution', async () => {
  const calls = [], repairOptions = { ...options, completionSha256: 'b'.repeat(64) };
  const result = await repairPreviewStorageRecoveryCompletion({ ...input, runHost: async (args, extra) => {
    calls.push(JSON.parse(extra.inputText)); return JSON.stringify({ ok: true, recovery: report() });
  } }, repairOptions);
  assert.deepEqual(calls, [{ action: 'repair-readonly', ...input, ...repairOptions }]);
  assert.equal(result.executionAuthorized, false);
  assert.throws(() => validatePreviewStorageReceipt(result, input), refused);
});

test('completion repair rejects missing or malformed digests before invoking the host', async () => {
  let calls = 0;
  for (const completionSha256 of [undefined, null, '', 'A'.repeat(64), 'a'.repeat(63)]) {
    await assert.rejects(repairPreviewStorageRecoveryCompletion({ ...input, runHost: async () => { calls++; } },
      { ...options, completionSha256 }), refused);
  }
  assert.equal(calls, 0);
});
