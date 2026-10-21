import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, slots } from './fixtures/cron-controller.mjs';
import { cronBackend } from './fixtures/cron-backend.mjs';
import { Controller } from '../src/controller.mjs';
import { operateDispatch, dispatchView } from '../src/admin-dispatch.mjs';
import { readJson } from '../src/store.mjs';
import { backgroundSnapshotEvidence } from '../../cli/src/recovery/background-backup.mjs';
import { restoredInstallationState } from '../../cli/src/recovery/background-restore.mjs';
import { execute } from '../../cli/src/recovery/execute.mjs';

test('an archived controller receipt restores into the actual recovery lifecycle with a fresh acknowledgment and separate resume', async t => {
  const f = await fixture(t), request = await f.request();
  await f.c.mutate(request.id, request.digest, 'approve');
  const input = { deployment: request.id, digest: request.digest };
  const preparation = await f.c.exclusive(() => operateDispatch(f.c, 'refresh', 'snapshot', input));
  const source = structuredClone(f.c.state), manifest = backgroundSnapshotEvidence(source, { queueRecovery: {}, cronRecovery: { refresh: preparation.id } });
  const archive = await mkdtemp(join(tmpdir(), 'fogd-cron-controller-archive-'));
  t.after(() => rm(archive, { recursive: true, force: true }));
  await writeFile(join(archive, 'manifest.json'), JSON.stringify(manifest));
  await execute('tar', ['-cf', join(archive, 'controller.tar'), '-C', f.dir, './state.json']);
  const restored = await restoredInstallationState(archive, manifest);
  const target = join(archive, 'target'); await cp(f.dir, target, { recursive: true });
  await writeFile(join(target, 'state.json'), JSON.stringify(restored));
  const controller = new Controller({ dir: target, slots, backend: cronBackend(target) }); await controller.init();
  const view = dispatchView(controller, 'refresh');
  assert.equal(view.recovery.status, 'pending'); assert.equal(view.recovery.checkError, null);
  assert.equal(controller.route('refresh.localhost').state, 'paused'); assert.equal(view.resumeAllowed, false);
  await assert.rejects(controller.exclusive(() => operateDispatch(controller, 'refresh', 'resume', input)), /completed activation/);
  await controller.exclusive(() => operateDispatch(controller, 'refresh', 'acknowledge-recovery', {
    ...input, recovery: view.recovery.id, review: view.recovery.review, acceptPossibleLoss: true,
  }));
  assert.equal(controller.route('refresh.localhost').state, 'active');
  assert.equal((await readJson(join(target, 'cron-runtime.json'))).paused, true);
  await controller.exclusive(() => operateDispatch(controller, 'refresh', 'resume', input));
  assert.equal((await readJson(join(target, 'cron-runtime.json'))).paused, false);
  assert.deepEqual(structuredClone(f.c.state), source);
  assert.deepEqual(await readJson(join(f.dir, 'state.json')), source);
  assert.equal((await f.runtime()).paused, true, 'Target acknowledgment and resume cannot affect the source');
});
