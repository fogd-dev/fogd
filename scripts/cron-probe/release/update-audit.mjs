import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson } from '/app/packages/platform/src/store.mjs';

export function updateAudit({ backend, output, receipt, save, slot }) {
  let active;
  async function checkpoint(point) {
    if (active.gate !== point) return;
    receipt.step = 'update-held';
    const native = await backend.crons.status(slot, 'refresh'), at = Date.now(), deadline = at + 20000;
    receipt.updateGate = { id: active.id, point, at, deadline, native }; await save();
    while ((await readJson(join(output, 'update-release.json'), null))?.id !== active.id) {
      if (Date.now() >= deadline) {
        active.lifecycle.gateTimedOutAt = Date.now(); await save();
        assert.fail('Private update gate deadline exceeded');
      }
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
