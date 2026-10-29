import assert from 'node:assert/strict';
import { docker } from '../../../packages/cli/src/recovery/docker.mjs';

// Restart only the retained controller already checked and killed by the debugger.
// Native fleets stay running: this tests controller loss, not full-install startup.
export async function restartInterruptedController(identity, run = docker) {
  const [before] = JSON.parse(await run(['inspect', identity.container]));
  assert.equal(before.Id, identity.container); assert.equal(before.Image, identity.image);
  assert.equal(before.Config.Labels['com.docker.compose.project'], identity.project);
  assert.equal(before.Config.Labels['com.docker.compose.service'], 'controller');
  assert.equal(before.State.StartedAt, identity.startedAt);
  assert.equal(before.State.Running, false); assert.equal(before.State.Restarting, false);
  assert.equal(before.State.ExitCode, 137); assert.equal(before.State.OOMKilled, false); assert.equal(before.RestartCount, 0);
  await run(['start', identity.container]);
  const [after] = JSON.parse(await run(['inspect', identity.container]));
  assert.equal(after.Id, before.Id); assert.equal(after.Image, before.Image);
  assert.deepEqual(after.Config, before.Config); assert.deepEqual(after.HostConfig, before.HostConfig);
  assert.equal(after.State.Running, true); assert.equal(after.State.Restarting, false);
  assert.equal(after.State.OOMKilled, false); assert.equal(after.RestartCount, 0);
  assert.ok(Date.parse(after.State.StartedAt) > Date.parse(before.State.StartedAt));
  return { container: after.Id, image: after.Image, previousStartedAt: before.State.StartedAt, startedAt: after.State.StartedAt,
    previousExitCode: before.State.ExitCode, unchangedConfiguration: true, restartCount: after.RestartCount };
}
