import assert from 'node:assert/strict';
import { projectContainers } from '../../../packages/cli/src/recovery/docker.mjs';
import { waitFor } from './https.mjs';
import { readDurableStores } from '../../../packages/cli/src/runtime/durable-stores.mjs';
import { controllerState } from './observations.mjs';

export async function restartUnconfirmedController(host, request) {
  const matches = (await projectContainers(host.project)).filter(value => value.Config.Labels['com.docker.compose.service'] === 'controller');
  assert.equal(matches.length, 1); const [before] = matches;
  assert.equal(before.Image, host.entry.image); assert.equal(before.State.Running, true); assert.equal(before.RestartCount, 0);
  assert.deepEqual(before.Config.Cmd, host.config.services.controller.command);
  await host.run('docker', ['stop', '--signal', 'SIGKILL', '--timeout', '0', before.Id]);
  const [killed] = JSON.parse(await host.run('docker', ['inspect', before.Id]));
  assert.equal(killed.State.Running, false); assert.equal(killed.State.ExitCode, 137); assert.equal(killed.State.OOMKilled, false); assert.equal(killed.RestartCount, 0);
  await host.run('docker', ['start', before.Id]);
  await waitFor('restarted unconfirmed-pause controller', async () => (await request('/v1/admin')).status === 200);
  const [after] = JSON.parse(await host.run('docker', ['inspect', before.Id]));
  assert.equal(after.Id, before.Id); assert.equal(after.Image, before.Image); assert.equal(after.RestartCount, 0);
  assert.equal(after.State.Running, true); assert.ok(Date.parse(after.State.StartedAt) > Date.parse(before.State.StartedAt));
  return { id: before.Id, image: before.Image, before: { startedAt: before.State.StartedAt, pid: before.State.Pid },
    killed: { exitCode: killed.State.ExitCode, oomKilled: killed.State.OOMKilled, restartCount: killed.RestartCount, finishedAt: killed.State.FinishedAt },
    after: { startedAt: after.State.StartedAt, pid: after.State.Pid } };
}

export async function recordedRoute(host) {
  if (host.entry.routing === 'durable') {
    const { authority } = await readDurableStores(host.config, host.policy), state = await controllerState(host);
    assert.equal(state.routeAuthority.pending, null);
    assert.equal(state.routeAuthority.settled.digest, authority.sha256);
    assert.equal(state.routeAuthority.settled.revision, authority.record.revision);
    const app = state.apps.refresh, request = state.deployments[app.active], route = authority.record.routes.find(value => value.host === 'refresh.localhost');
    assert.equal(request.status, 'active'); assert.equal(request.step, 'complete'); assert.equal(app.route, 'active');
    assert.equal(route.submission, request.id); assert.equal(route.digest, request.digest); assert.equal(route.slot, app.slot);
    return { state: route.state, slot: route.slot };
  }
  const code = "const response=await fetch('http://127.0.0.1:8083/internal/route?host=refresh.localhost',{headers:{authorization:'Bearer '+process.env.FOGD_GATEWAY_TOKEN}});if(!response.ok)throw Error('Route lookup failed');console.log(await response.text());";
  return JSON.parse(await host.run('docker', ['exec', `${host.project}-controller-1`, '/usr/local/bin/node', '--input-type=module', '-e', code]));
}
