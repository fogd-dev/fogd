import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { provisionAndRunPreview } from '../src/preview/launch.mjs';
import { readPreviewOwnerControl } from '../src/preview/owner-control.mjs';
import { previewLaunchFixture } from './fixtures/preview-launch.mjs';
import { id } from './fixtures/artifact-review.mjs';

async function activePreview(t, fixture) {
  const active = await provisionAndRunPreview(fixture.args);
  t.after(async () => { fixture.cancellation.abort(); await active.completion; });
  return active;
}
const creates = calls => calls.filter(args => args[0] === 'create' || args[1] === 'create');

test('one coordinated attempt reserves, allocates, installs, starts and stops while retaining owner controls', async t => {
  const f = await previewLaunchFixture(t), before = structuredClone(f.source.state);
  const active = await activePreview(t, f), ready = active.ready;
  assert.equal(ready.started, true); assert.equal(ready.ordinaryEnrollment, false);
  assert.equal(ready.control.directory, f.ownerControl.directory);
  const control = await readPreviewOwnerControl(ready.control.directory, ready.allocationId);
  assert.equal(control.reservation, JSON.parse(await readFile(join(f.host, 'holds', f.args.plan.project + '.json'))).id);
  assert.equal(control.expectedGrantSha256, f.args.expectedGrantSha256);
  assert.equal((await stat(join(ready.control.directory, 'owner.json'))).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(control).includes('private-admin-password'), false);
  assert.equal(f.observed.containers.length, 10); assert.equal(f.observed.volumes.length, 12);
  assert.equal(f.observed.containers.filter(value => value.State.Running).length, 8);
  f.cancellation.abort(); const stopped = await active.completion;
  assert.equal(stopped.ordered, true); assert.equal(stopped.memoryBudgetHeld, true);
  assert.ok(f.observed.containers.every(value => !value.State.Running));
  assert.equal(f.observed.volumes.length, 12); assert.deepEqual(f.source.state, before);
  assert.ok(f.source.calls.every(call => call.method === 'GET'));
});

test('ordinary runtime admission refuses a candidate before any host reservation or source observation', async t => {
  const f = await previewLaunchFixture(t);
  await assert.rejects(provisionAndRunPreview({ ...f.args, candidateEnrollment: false }), { code: 'PREVIEW_HOST_REFUSED', reason: 'preview-runtime' });
  assert.deepEqual(f.calls, []); assert.deepEqual(f.source.calls, []);
  assert.deepEqual(await readdir(join(f.host, 'holds')), []);
});

test('a stale source or invalid package refuses before provisioning effects', async t => {
  const f = await previewLaunchFixture(t), bundle = structuredClone(f.args.bundle);
  bundle.ingress.accessKey = '0'.repeat(64);
  await assert.rejects(provisionAndRunPreview({ ...f.args, bundle }), { code: 'PREVIEW_EXECUTION_REFUSED' });
  assert.deepEqual(f.calls, []);
  f.source.state.deployments[id].status = 'rejected';
  await assert.rejects(provisionAndRunPreview(f.args), { code: 'PREVIEW_EXECUTION_REFUSED' });
  assert.deepEqual(f.calls, []); assert.deepEqual(await readdir(join(f.host, 'holds')), []);
});

test('owner controls must have a fresh independent location before reserving capacity', async t => {
  const f = await previewLaunchFixture(t);
  for (const directory of [join(f.root, 'inside-ledger'), join(f.source.output, 'inside-inputs')]) {
    await assert.rejects(provisionAndRunPreview({ ...f.args, ownerControl: { ...f.ownerControl, directory } }), { code: 'PREVIEW_OWNER_CONTROL_REFUSED' });
  }
  await mkdir(f.ownerControl.directory, { mode: 0o700 });
  await assert.rejects(provisionAndRunPreview(f.args), { code: 'PREVIEW_OWNER_CONTROL_REFUSED' });
  assert.deepEqual(f.calls, []); assert.deepEqual(await readdir(join(f.host, 'holds')), []);
});

test('insufficient memory refuses without creating resources, controls or a reservation', async t => {
  const f = await previewLaunchFixture(t); f.observed.host.MemTotal = 3 * 1024 ** 3;
  await assert.rejects(provisionAndRunPreview(f.args), { code: 'PREVIEW_ADMISSION_REFUSED' });
  assert.deepEqual(creates(f.calls), []); assert.deepEqual(await readdir(join(f.host, 'holds')), []);
  await assert.rejects(stat(f.ownerControl.directory), { code: 'ENOENT' });
});

test('an ambiguous resource creation remains fenced and a second coordinator attempt cannot replay it', async t => {
  const f = await previewLaunchFixture(t), run = f.args.run;
  f.args.run = async (args, extra) => {
    const result = await run(args, extra);
    if (args[0] === 'network' && args[1] === 'create') throw Error('lost network-create response');
    return result;
  };
  await assert.rejects(provisionAndRunPreview(f.args), { code: 'PREVIEW_HOST_REFUSED', reason: 'uncertain' });
  const effects = creates(f.calls).length; assert.equal(effects, 1);
  await assert.rejects(provisionAndRunPreview(f.args), { code: 'PREVIEW_HOST_REFUSED', reason: 'pending' });
  assert.equal(creates(f.calls).length, effects);
  assert.equal((await readdir(join(f.host, 'holds'))).length, 1);
  assert.ok(!f.calls.some(args => ['rm', 'stop', 'kill', 'restart'].includes(args[0])));
});

test('owner controls are durable before the installer starts and survive an uncertain installer result', async t => {
  const f = await previewLaunchFixture(t), run = f.args.run;
  f.args.run = async (args, extra) => {
    if (args[0] === 'start' && args[1] === '--attach') {
      const control = JSON.parse(await readFile(join(f.ownerControl.directory, 'owner.json')));
      assert.equal(control.plan.project, f.args.plan.project);
      await run(args, extra); throw Error('lost installer result');
    }
    return run(args, extra);
  };
  await assert.rejects(provisionAndRunPreview(f.args), { code: 'PREVIEW_HOST_REFUSED', reason: 'uncertain' });
  const control = JSON.parse(await readFile(join(f.ownerControl.directory, 'owner.json')));
  assert.equal((await readPreviewOwnerControl(f.ownerControl.directory, control.allocationId)).allocationId, control.allocationId);
  assert.equal(f.observed.containers.filter(value => value.State.Running).length, 0);
  assert.ok(!f.calls.some(args => args[0] === 'start' && args[1] !== '--attach'));
});

test('later caller mutations cannot replace the checked package, owner location or service secrets', async t => {
  const f = await previewLaunchFixture(t), run = f.args.run, originalControl = f.ownerControl.directory;
  f.args.run = async (args, extra) => {
    if (args[0] === 'network' && args[1] === 'create') {
      f.args.bundle.ingress.accessKey = '0'.repeat(64);
      f.args.secretValues.storagePassword = '0'.repeat(64);
      f.args.ownerControl.directory = join(f.root, 'untrusted-mutation');
    }
    return run(args, extra);
  };
  const active = await activePreview(t, f);
  assert.equal(active.ready.control.directory, originalControl);
  assert.notEqual(JSON.parse(await readFile(join(originalControl, 'owner.json'))).secretValues.storagePassword, '0'.repeat(64));
  f.cancellation.abort(); await active.completion;
});

test('cancelled attempts, missing transports and mismatched image expectations refuse without effects', async t => {
  const f = await previewLaunchFixture(t), cancellation = new AbortController(); cancellation.abort();
  for (const extra of [{ signal: cancellation.signal }, { runStorageHost: undefined }, { expectedImage: 'sha256:' + '0'.repeat(64) }]) {
    await assert.rejects(provisionAndRunPreview({ ...f.args, ...extra }), { code: 'PREVIEW_HOST_REFUSED' });
  }
  assert.deepEqual(f.calls, []); assert.deepEqual(f.source.calls, []);
});
