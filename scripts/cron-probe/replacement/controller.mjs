// Immutable replacement fixture controller; command data selects only named
// releases whose sources, order and gates are already pinned in this image.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Controller } from '/app/packages/platform/src/controller.mjs';
import { operateDispatch } from '/app/packages/platform/src/admin-dispatch.mjs';
import { adminState } from '/app/packages/platform/src/admin-view.mjs';
import { server } from '/app/packages/platform/src/http.mjs';
import { readJson, saveJson } from '/app/packages/platform/src/store.mjs';
import { artifactDigest, regularFiles } from '/app/packages/runtime/src/artifact.mjs';
import { guardedBackend, qualificationPolicy } from './backend.mjs';
import { stageRequest } from './controller-artifact.mjs';
import { replacementRelease, replacementCommand } from './replacement-policy.mjs';
import { updateAudit } from './update-audit.mjs';
import { waitForMinuteBoundary } from './minute.mjs';

assert.deepEqual(process.execArgv, []); assert.equal(process.env.NODE_OPTIONS, undefined);
assert.deepEqual(process.argv, ['/usr/local/bin/node', '/app/qualification/replacement-controller.mjs']);
const policy = await qualificationPolicy(), initial = replacementRelease(policy, 'old');
assert.equal(await artifactDigest(initial.source), initial.digest, 'Initial artifact differs before initialization');
const slot = JSON.parse(process.env.FOGD_SLOTS).find(slot => slot.id === initial.slot); assert.ok(slot);
await mkdir(initial.output, { recursive: true });
const backend = await guardedBackend(), controller = new Controller({ dir: initial.dir, slots: [slot], backend });
let request, activating, revision, internal, current;
const receipt = { step: 'starting', pid: process.pid, processStart: (await readFile('/proc/self/stat', 'utf8')).split(' ')[21], events: [], approvalChecks: 0 };
const save = () => saveJson(join(initial.output, 'receipt.json'), receipt);
async function approveEffect() {
  if (!activating) return;
  const state = await readJson(join(initial.dir, 'state.json')), durable = state.deployments[activating.id];
  assert.equal(durable.status, 'activating'); assert.equal(durable.digest, activating.digest); assert.equal(durable.secretRevision, revision);
  assert.equal(await artifactDigest(controller.artifact(durable.id)), durable.digest);
  receipt.approvalChecks++;
}
for (const [object, methods] of [[backend, ['claim', 'bootstrap', 'migrate', 'publish', 'applicationReady']], [backend.crons, ['pause', 'resume']]]) {
  for (const method of methods) {
    const effect = object[method].bind(object);
    object[method] = async (...args) => { await approveEffect(); receipt.events.push(`${method}:before`); const result = await effect(...args); receipt.events.push(`${method}:after`); return result; };
  }
}
// These outer gates suspend before the inner authorization check at publication.
const audit = updateAudit({ backend, output: initial.output, receipt, save, slot });
async function stage(selected) {
  assert.equal(await artifactDigest(selected.source), selected.digest, 'Release input differs before staging');
  const staged = await stageRequest(controller, selected.source, async () => {}, { requiredSecrets: ['REFRESH_TOKEN'] });
  assert.equal(staged.digest, selected.digest);
  const values = await controller.secrets.select(staged, revision), publicText = JSON.stringify(adminState(controller));
  for (const value of Object.values(values.values)) {
    assert.ok(!publicText.includes(value));
    for (const file of await regularFiles(controller.artifact(staged.id))) assert.ok(!(await readFile(join(controller.artifact(staged.id), file), 'utf8')).includes(value));
  }
  return staged;
}
async function approve(selected, command, staged = null) {
  const firstEvent = receipt.events.length;
  request = staged || await stage(selected); activating = request;
  if (command) audit.begin({ id: command.id, updateGate: selected.gate });
  try { await controller.mutate(request.id, request.digest, 'approve', revision); assert.equal(request.status, 'active', `Replacement activation failed at ${request.step}`); }
  finally { activating = null; if (command) audit.end(); }
  if (command) { receipt.updateEvents = receipt.events.slice(firstEvent); assert.ok(!receipt.updateEvents.some(event => event.startsWith('bootstrap:'))); }
  current = selected.release; receipt.release = current; receipt.digest = request.digest; receipt.artifact = controller.artifact(request.id);
  receipt.dispatch = controller.state.apps.refresh.dispatch; receipt.privateValueAbsentFromArtifactAndStatus = true;
}
try {
  await controller.init(); assert.equal(await backend.owner(slot), null); assert.equal(await backend.hasDeployment(slot), false);
  revision = (await controller.replaceSecrets('refresh', { REFRESH_TOKEN: randomBytes(32).toString('hex') })).revision;
  internal = server(controller, { user: process.env.FOGD_ADMIN_USER, password: process.env.FOGD_ADMIN_PASSWORD, gateway: process.env.FOGD_GATEWAY_TOKEN }, { role: 'internal' });
  await new Promise(resolve => internal.listen(8083, '0.0.0.0', resolve));
  request = await stage(initial); receipt.digest = request.digest; receipt.artifact = controller.artifact(request.id);
  receipt.step = 'pending'; await save();
  receipt.preapprovalBoundary = await waitForMinuteBoundary(); assert.equal(await backend.hasDeployment(slot), false);
  await approve(initial, null, request); receipt.step = 'active'; await save();
  const deadline = Date.now() + 20 * 60000; let commandId;
  while (Date.now() < deadline) {
    const command = await readJson(join(initial.output, 'command.json'), null);
    if (command && command.id !== commandId) {
      const active = controller.state.deployments[controller.state.apps.refresh.active];
      const durableRelease = Object.entries(policy.replacement.artifacts).find(([, digest]) => digest === active.digest)?.[0];
      assert.equal(durableRelease, current, 'Release authority must match durable active approval');
      const selected = replacementCommand(policy, durableRelease, command); commandId = command.id;
      if (selected) await approve(selected, command);
      else if (command.operation !== 'finish') await controller.exclusive(() => operateDispatch(controller, 'refresh', command.operation, { deployment: active.id, digest: active.digest }));
      receipt.command = { id: command.id, operation: command.operation }; receipt.dispatch = controller.state.apps.refresh.dispatch; await save();
      if (command.operation === 'finish') break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(receipt.command?.operation, 'finish', 'Replacement command deadline exceeded');
  receipt.step = 'complete'; await save(); console.log(JSON.stringify(receipt));
} catch (error) { receipt.step = 'failed'; receipt.error = `Replacement qualification failed at ${request?.step || 'initialization'}`; await save(); throw error; }
finally {
  try { if (receipt.step !== 'complete' && controller?.state?.apps.refresh?.dispatch) await controller.exclusive(() => operateDispatch(controller, 'refresh', 'pause')); }
  catch { receipt.cleanupFailure = true; await save(); }
  finally { if (internal) await new Promise(resolve => internal.close(resolve)); backend.s3.destroy(); }
}
