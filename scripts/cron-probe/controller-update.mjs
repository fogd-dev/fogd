// Private qualification gates only; normal activation remains in the controller.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { regularFiles } from '/app/packages/runtime/src/artifact.mjs';
import { stageRequest } from './controller-artifact.mjs';
import { updateAudit } from './release/update-audit.mjs';


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
