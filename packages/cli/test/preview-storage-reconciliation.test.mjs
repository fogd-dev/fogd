import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePreviewStorage, previewStorageWorkerSha256 } from '../src/preview/storage.mjs';
import { previewStorageFixture } from './fixtures/preview-storage.mjs';

const input = { root: '/var/lib/docker/fogd-preview-storage', project: 'fogd-preview-' + 'a'.repeat(32), engineId: 'engine-fixture' };
const operation = '00000000-0000-4000-8000-000000000001';
const refused = { code: 'PREVIEW_STORAGE_REFUSED' };

test('explicit reconciliation binds one operation and returns retained storage without execution authority', async () => {
  const expected = previewStorageFixture(input.project, input.engineId, input.root), calls = [];
  const runHost = async (args, options) => {
    calls.push(JSON.parse(options.inputText));
    assert.equal(args[0], 'python3');
    return JSON.stringify({ ok: true, storage: expected.storage });
  };
  const result = await reconcilePreviewStorage({ ...input, runHost }, { operation });
  assert.deepEqual(calls, [{ action: 'reconcile', ...input, operation }]);
  assert.deepEqual(result, expected);
  assert.equal(result.workerSha256, previewStorageWorkerSha256);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.resourcesRetained, true);
});

test('invalid reconciliation identity refuses before any host effect', () => {
  let calls = 0;
  const target = { ...input, runHost: async () => { calls++; } };
  for (const value of [undefined, '', '../pending', 'AAAAAAAA-0000-4000-8000-000000000001', 1]) {
    assert.throws(() => reconcilePreviewStorage(target, { operation: value }), refused);
  }
  assert.equal(calls, 0);
});

for (const reason of ['pending', 'uncertain']) test(`reconciliation ${reason} outcome is never automatically retried`, async () => {
  let calls = 0;
  await assert.rejects(reconcilePreviewStorage({ ...input, runHost: async () => {
    calls++; return JSON.stringify({ ok: false, reason });
  } }, { operation }), { ...refused, reason });
  assert.equal(calls, 1);
});

test('reconciliation cannot accept unadmitted or foreign storage', async () => {
  for (const change of [storage => { storage.schema = 1; delete storage.admission; }, storage => { storage.project = 'other'; }]) {
    const value = previewStorageFixture(input.project, input.engineId, input.root).storage;
    change(value);
    await assert.rejects(reconcilePreviewStorage({ ...input, runHost: async () => JSON.stringify({ ok: true, storage: value }) }, { operation }), refused);
  }
});
