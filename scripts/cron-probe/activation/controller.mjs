// Private qualification only. Fault checkpoints suspend a real controller;
// the external driver verifies and sends SIGKILL to this process.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Controller } from '/app/packages/platform/src/controller.mjs';
import { guardedBackend, qualificationPolicy } from './backend.mjs';
import { interruptionCase } from './interruption-policy.mjs';
import { operateDispatch, dispatchView } from '/app/packages/platform/src/admin-dispatch.mjs';
import { adminState } from '/app/packages/platform/src/admin-view.mjs';
import { server } from '/app/packages/platform/src/http.mjs';
import { readJson, saveJson } from '/app/packages/platform/src/store.mjs';
import { artifactDigest, regularFiles } from '/app/packages/runtime/src/artifact.mjs';
import { stageRequest } from './controller-artifact.mjs';
import { nextMinuteBoundary, waitForMinuteBoundary } from './minute.mjs';

assert.deepEqual(process.execArgv, []);
assert.equal(process.env.NODE_OPTIONS, undefined);
assert.deepEqual(process.argv.slice(0, 2), ['/usr/local/bin/node', '/app/qualification/interruption-controller.mjs']);
assert.equal(process.argv.length, 3);
const selectedCase = interruptionCase(await qualificationPolicy(), process.argv[2]);
const { source, slot: slotId, dir, output, mode, fault, digest } = selectedCase;
assert.equal(await artifactDigest(source), digest, 'Fixture input differs before controller initialization');
const slot = JSON.parse(process.env.FOGD_SLOTS).find(value => value.id === slotId); assert.ok(slot);
await mkdir(output, { recursive: true });
let controller, target, armed = false, approvedRevision, internal;
const receipt = { step: 'starting', pid: process.pid, events: [], approvalChecks: 0 };
receipt.processStart = (await readFile('/proc/self/stat', 'utf8')).split(' ')[21];
const save = () => saveJson(join(output, 'receipt.json'), receipt);
const backend = await guardedBackend();

function snapshot() {
  const app = controller.state.apps.refresh;
  return { target: { id: target.id, digest: target.digest, status: target.status, step: target.step, secretRevision: target.secretRevision || null },
    active: app?.active || null, route: app?.route || null, bootstrap: app?.cronBootstrap?.phase || null,
    dispatch: app?.dispatch ? dispatchView(controller, 'refresh') : null };
}
async function checkpoint(point) {
  if (!armed || fault !== point) return;
  receipt.step = 'checkpoint'; receipt.point = point; receipt.state = snapshot(); await save();
  await new Promise(() => {});
}
async function assertApproval() {
  if (!armed) return;
  const durable = await readJson(join(dir, 'state.json'));
  const request = durable.deployments[target.id];
  assert.equal(request.status, 'activating'); assert.equal(request.digest, target.digest);
  assert.equal(request.secretRevision, approvedRevision);
  assert.equal(await artifactDigest(controller.artifact(target.id)), target.digest);
  receipt.approvalChecks++;
}
async function note(event) { receipt.events.push(event); await save(); }
function audit(object, method, after = async () => {}) {
  const original = object[method].bind(object);
  object[method] = async (...args) => {
    await assertApproval(); await note(`${method}:before`);
    const result = await original(...args);
    await note(`${method}:after`); await after(result);
    return result;
  };
}
audit(backend, 'claim'); audit(backend, 'bootstrap'); audit(backend, 'applicationReady');
audit(backend, 'publish', async () => { if (controller.state.apps.refresh.cronBootstrap.phase === 'application') await checkpoint('publish'); });
audit(backend.crons, 'pause'); audit(backend.crons, 'resume', () => checkpoint('resume'));
const migrate = backend.migrate.bind(backend);
backend.migrate = async (...args) => {
  await assertApproval(); await note('migrate:before');
  if (mode === 'initial') {
    const before = await backend.crons.status(slot, 'refresh'); assert.equal(before.paused, true);
    const boundary = nextMinuteBoundary();
    receipt.migrationHold = { before, boundary }; await save();
    await waitForMinuteBoundary(boundary);
    const after = await backend.crons.status(slot, 'refresh'); assert.equal(after.paused, true);
    receipt.migrationHold.after = after; await save();
  }
  const result = await migrate(...args); await note('migrate:after'); return result;
};
function releaseSaved(value) {
  const app = value.apps?.refresh, request = value.deployments?.[target?.id];
  return request?.status === 'activating' && request.step === 'releasing-dispatch' && app?.dispatch?.hold === null && app.dispatch.operation === null && app.dispatch.version === request.version;
}
const persist = async (path, value) => {
  await saveJson(path, value);
  if (armed && path === join(dir, 'state.json') && releaseSaved(value)) await checkpoint('released');
};

await save();
try {
  controller = new Controller({ cronApps: true, dir, slots: [slot], backend, persist }); await controller.init();
  receipt.startupEvents = [...receipt.events];
  if (mode === 'initial') {
    assert.equal(await backend.owner(slot), null); assert.equal(await backend.hasDeployment(slot), false);
    await controller.replaceSecrets('refresh', { REFRESH_TOKEN: randomBytes(32).toString('hex') });
  }
  if (mode === 'paused-update') await controller.exclusive(() => operateDispatch(controller, 'refresh', 'pause'));
  if (['initial', 'update', 'paused-update'].includes(mode)) {
    assert.equal(await artifactDigest(source), digest);
    target = await stageRequest(controller, source, async () => {}, { requiredSecrets: ['REFRESH_TOKEN'] });
    assert.equal(target.digest, digest, 'Only the image-pinned case artifact may be approved');
    await saveJson('/var/lib/fogd/qualification/target.json', { id: target.id });
  } else {
    const selected = await readJson('/var/lib/fogd/qualification/target.json'); target = controller.state.deployments[selected.id]; assert.ok(target);
  }
  assert.equal(target.digest, digest, 'Restart must retain the image-pinned artifact');
  receipt.artifact = controller.artifact(target.id);
  approvedRevision = target.secretRevision || controller.secrets.index.refresh.revision;
  const selected = await controller.secrets.select(target, approvedRevision);
  const publicText = JSON.stringify(adminState(controller));
  assert.ok(Object.values(selected.values).every(value => !publicText.includes(value)));
  for (const file of await regularFiles(controller.artifact(target.id))) {
    const text = await readFile(join(controller.artifact(target.id), file), 'utf8');
    assert.ok(Object.values(selected.values).every(value => !text.includes(value)));
  }
  receipt.privateValuesAbsent = true;
  internal = server(controller, { user: process.env.FOGD_ADMIN_USER, password: process.env.FOGD_ADMIN_PASSWORD, gateway: process.env.FOGD_GATEWAY_TOKEN }, { role: 'internal' });
  await new Promise(resolve => internal.listen(8083, '0.0.0.0', resolve));
  receipt.step = 'ready'; receipt.state = snapshot(); await save();
  let commandId;
  const deadline = Date.now() + 15 * 60000;
  while (Date.now() < deadline) {
    const command = await readJson(join(output, 'command.json'), null);
    if (command && command.id !== commandId) {
      commandId = command.id; assert.ok(['approve', 'finish'].includes(command.operation));
      if (command.operation === 'approve') {
        armed = true;
        await controller.mutate(target.id, target.digest, 'approve', approvedRevision);
        armed = false; assert.equal(target.status, 'active', `Activation failed at ${target.step}`);
        receipt.adoptedApprovedVersion = (await Promise.all(slot.nodes.map(node => backend.deployment(node)))).every(state => state.version === target.version);
        assert.equal(receipt.adoptedApprovedVersion, true);
      }
      receipt.command = { id: command.id, operation: command.operation }; receipt.state = snapshot(); await save();
      if (command.operation === 'finish') break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(receipt.command?.operation, 'finish', 'Interruption probe command deadline exceeded');
  receipt.step = 'complete'; await save(); console.log(JSON.stringify(receipt));
} catch (error) {
  receipt.failedAt = target?.step || receipt.step;
  receipt.errorCode = ['ERR_ASSERTION', 'CONTROLLER_STORAGE_UNCERTAIN', 'CRON_OPERATION_UNCONFIRMED', 'CRON_RUNTIME_UNVERIFIED', 'RUNTIME_IDENTITY_REFUSED'].includes(error.code) ? error.code : 'UNKNOWN';
  receipt.step = 'failed'; receipt.failure = 'Controller interruption qualification failed'; await save(); throw error;
} finally {
  // SIGKILL bypasses this block. A clean finish must not overwrite operator intent.
  try {
    if (receipt.step !== 'complete' && controller?.state.apps.refresh?.dispatch) await controller.exclusive(() => operateDispatch(controller, 'refresh', 'pause'));
  } catch {
    receipt.cleanupFailure = true; await save();
  } finally {
    if (internal) await new Promise(resolve => internal.close(resolve));
    backend.s3.destroy();
  }
}
