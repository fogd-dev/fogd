// Private qualification gates only; normal activation remains in the controller.
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson } from '/app/packages/platform/src/store.mjs';
import { regularFiles } from '/app/packages/runtime/src/artifact.mjs';
import { stageRequest } from './controller-artifact.mjs';

function updateAudit({ backend, output, receipt, save, slot }) {
  let active;
  async function checkpoint(point) {
    if (active.gate !== point) return;
    receipt.step = 'update-held';
    receipt.updateGate = { id: active.id, point, at: Date.now(), native: await backend.crons.status(slot, 'refresh') }; await save();
    const deadline = Date.now() + 20000;
    while ((await readJson(join(output, 'update-release.json'), null))?.id !== active.id) {
      assert.ok(Date.now() < deadline, 'Private update gate deadline exceeded');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    active.lifecycle.gateReleasedAt = Date.now();
    await rm(join(output, 'update-release.json'));
    receipt.step = 'active'; delete receipt.updateGate;
  }
  const pause = backend.crons.pause.bind(backend.crons);
  backend.crons.pause = async (...args) => { const result = await pause(...args); if (active) { active.lifecycle.pauseConfirmedAt = Date.now(); await save(); } return result; };
  const migrate = backend.migrate.bind(backend);
  backend.migrate = async (...args) => {
    const result = await migrate(...args);
    if (active) { active.lifecycle.migrationCompletedAt = Date.now(); await checkpoint('after-migration'); await save(); }
    return result;
  };
  const publish = backend.publish.bind(backend);
  backend.publish = async (...args) => {
    if (active) { await checkpoint('before-publication'); active.lifecycle.publishRequestedAt = Date.now(); await save(); }
    const result = await publish(...args);
    if (active) { active.lifecycle.publishCompletedAt = Date.now(); await save(); }
    return result;
  };
  return { begin(command) {
    assert.ok(command.updateGate === undefined || ['after-migration','before-publication'].includes(command.updateGate));
    active = { id: command.id, gate: command.updateGate, lifecycle: {} }; receipt.updateLifecycle = active.lifecycle;
  }, end() { active = null; } };
}

export function updateApprover({ controller, backend, slot, output, receipt, save, token, revision, onRequest, onStep }) {
  const audit = updateAudit({ backend, output, receipt, save, slot });
  return async command => {
    onStep('staging update');
    assert.match(command.source || '', new RegExp('^/tmp/fogd-queue-probe-' + slot.id + '-[a-z0-9-]+$'));
    const request = await stageRequest(controller, command.source, async () => {}, { requiredSecrets: ['REFRESH_TOKEN'] });
    for (const file of await regularFiles(controller.artifact(request.id))) assert.ok(!(await readFile(join(controller.artifact(request.id), file), 'utf8')).includes(token));
    onRequest(request); onStep(null); audit.begin(command);
    try {
      await controller.mutate(request.id, request.digest, 'approve', revision);
      assert.equal(request.status, 'active', `Native update failed at ${request.step}`);
      receipt.digest = request.digest; receipt.artifact = controller.artifact(request.id);
    } finally { audit.end(); }
  };
}
