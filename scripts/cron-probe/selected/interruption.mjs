import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openControllerDebugger, killController } from './controller-debugger.mjs';
import { controllerState, nativeObservation } from './observations.mjs';
import { waitFor } from './https.mjs';

const checkpoints = {
  resume: { path: 'packages/platform/src/dispatch-control.mjs', marker: "if (status?.paused !== (verb === 'pause'))", functionName: '#apply', condition: 'verb === "resume" && releaseHold === true' },
  release: { path: 'packages/platform/src/activation.mjs', marker: 'await finish(controller, request, app, step);', functionName: 'activateRelease' },
};

export async function interruptApproval(host, submitted, revision, cut, desired = 'running') {
  if (!Object.hasOwn(checkpoints, cut)) throw new Error('Unknown activation checkpoint');
  const container = (await host.run('docker', ['inspect', '--format', '{{.Id}}', `${host.project}-controller-1`])).trim();
  const { identity, debuggerSession } = await openControllerDebugger(container, host.project, host.entry.id);
  let killAttempted = false;
  try {
    const checkpoint = await debuggerSession.breakpoint(checkpoints[cut]);
    let settled = false;
    const approval = host.command(['admin', 'approve', submitted.id, submitted.digest, revision]).then(
      () => { settled = true; return { ok: true, at: Date.now() }; },
      () => { settled = true; return { ok: false, at: Date.now() }; },
    );
    const paused = await debuggerSession.paused(checkpoint), state = await controllerState(host), app = state.apps.refresh;
    const native = await nativeObservation(host, app.slot, submitted.id);
    verifyCheckpoint(state, native, submitted, revision, cut, desired);
    debuggerSession.assertPaused(paused.pauseSequence); assert.equal(settled, false);
    await writeFile(join(host.output, `${submitted.label}-paused.json`), JSON.stringify({ paused, state, native }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    killAttempted = true;
    const killRequestedAt = Date.now(), interruption = await killController(identity);
    assert.deepEqual(await controllerState(host), state);
    const interruptedApproval = await approval;
    assert.equal(interruptedApproval.ok, false); assert.ok(interruptedApproval.at >= killRequestedAt);
    const evidence = { cut, desired, submitted, revision, identity, paused, state, native, killRequestedAt, interruption, interruptedApproval };
    await writeFile(join(host.output, `${submitted.label}-interruption.json`), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await host.command(['up', '--installation', host.project]);
    const recovered = await waitFor('interrupted activation rehold', async () => {
      const state = await controllerState(host), control = state.apps.refresh.dispatch;
      return state.deployments[submitted.id].status === 'failed' && control.hold === submitted.id && control.observed === 'paused' && control.operation === null && state;
    });
    assert.equal(recovered.deployments[submitted.id].secretRevision, revision);
    assert.equal(recovered.apps.refresh.dispatch.desired, desired);
    const reheld = await nativeObservation(host, recovered.apps.refresh.slot, submitted.id);
    assert.equal(reheld.status.paused, true); assert.equal(reheld.status.nextAlarm, null);
    return { ...evidence, recovered, reheld };
  } finally {
    // Never disable a failed debugger and let the interrupted activation run.
    if (!killAttempted) await killController(identity);
  }
}

function verifyCheckpoint(state, native, submitted, revision, cut, desired) {
  const app = state.apps.refresh, request = state.deployments[submitted.id], control = app.dispatch;
  assert.equal(request.status, 'activating'); assert.equal(request.step, 'releasing-dispatch');
  assert.equal(request.digest, submitted.digest); assert.equal(request.secretRevision, revision); assert.equal(app.uncertain, null);
  assert.equal(control.desired, desired); assert.equal(native.status.paused, desired === 'paused');
  assert.equal(native.replicas.length, 2);
  assert.ok(native.replicas.every(replica => replica.version === request.version && Number.isSafeInteger(replica.generation) && replica.generation >= 0));
  assert.equal(native.stored.manifest.version, request.version); assert.deepEqual(native.stored.manifest.crons, request.resources.crons);
  if (cut === 'resume') {
    assert.equal(control.hold, submitted.id); assert.equal(control.operation, 'resume'); assert.equal(control.observed, 'unknown');
  } else {
    assert.equal(control.hold, null); assert.equal(control.operation, null); assert.equal(control.observed, desired); assert.equal(control.version, request.version);
  }
}
