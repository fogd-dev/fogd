import assert from 'node:assert/strict';
import { projectContainers } from '../../../packages/cli/src/recovery/docker.mjs';

export async function selectedFailureNodes(host, slotId) {
  host.access?.({ kind: 'inspect', operation: 'failure-node-bindings' });
  const fleet = host.policy.fleets.find(value => value.id === slotId); assert.ok(fleet); assert.equal(fleet.nodes.length, 2);
  const network = host.config.networks[`fleet-${host.policy.fleets.indexOf(fleet) + 1}`].name;
  const [net] = JSON.parse(await host.run('docker', ['network', 'inspect', network]));
  assert.equal(net.Labels['com.docker.compose.project'], host.project);
  const ids = Object.keys(net.Containers); assert.ok(ids.length >= 2);
  const members = JSON.parse(await host.run('docker', ['inspect', ...ids]));
  const containers = await projectContainers(host.project), result = [];
  for (const node of fleet.nodes) {
    const matches = containers.filter(value => value.Config.Labels['com.docker.compose.service'] === node.host); assert.equal(matches.length, 1);
    const container = matches[0]; assertContainer(host, node, container); assert.equal(container.State.Running, true); assert.ok(!container.Config.Healthcheck, 'Fixture replicas must not receive Docker healthcheck requests');
    assert.equal(container.Config.Env.find(value => value.startsWith('CELLD_NODE=')), `CELLD_NODE=${node.id}`);
    const connection = container.NetworkSettings.Networks[network]; assert.ok(connection?.IPAddress && connection.EndpointID);
    assert.deepEqual(Object.keys(container.NetworkSettings.Networks), [network]);
    assert.equal(container.HostConfig.NanoCpus, 1000000000); assert.equal(container.HostConfig.Memory, 512 * 1024 * 1024);
    const aliases = members.filter(value => value.NetworkSettings.Networks[network]?.Aliases?.includes(node.host));
    assert.deepEqual(aliases.map(value => value.Id), [container.Id], 'Node DNS alias must resolve to exactly its selected container');
    const native = host.nativeBaseline.find(value => value.host === node.host); assert.ok(native); assert.equal(native.container, container.Id);
    result.push({ node: node.id, host: node.host, id: container.Id, image: container.Image, startedAt: container.State.StartedAt,
      healthcheck: container.Config.Healthcheck || null, network, networkId: connection.NetworkID, endpoint: connection.EndpointID, address: connection.IPAddress, resources: { nanoCpus: container.HostConfig.NanoCpus, memoryBytes: container.HostConfig.Memory }, native });
  }
  return result;
}
function assertContainer(host, node, container) {
  assert.equal(container.Config.Labels['com.docker.compose.project'], host.project);
  assert.equal(container.Config.Labels['com.docker.compose.service'], node.host);
  assert.equal(String(container.Config.Labels['com.docker.compose.oneoff']).toLowerCase(), 'false');
  assert.equal(container.Image, host.entry.image); assert.equal(container.RestartCount, 0);
  assert.equal(container.State.OOMKilled, false); assert.equal(container.State.Restarting, false); assert.equal(container.State.Paused, false);
}
export async function stoppedFailureNode(host, selected, { exit = 137 } = {}) {
  assert.ok([0, 137].includes(exit));
  host.access?.({ kind: 'inspect', operation: 'stopped-failure-node', node: selected.node });
  const [container] = JSON.parse(await host.run('docker', ['inspect', selected.id])); assertContainer(host, selected, container);
  assert.equal(container.State.Running, false); assert.equal(container.State.Status, 'exited'); assert.equal(container.State.ExitCode, exit);
  assert.equal(container.State.StartedAt, selected.startedAt);
  const finishedAt = Date.parse(container.State.FinishedAt); assert.ok(Number.isSafeInteger(finishedAt) && finishedAt > Date.parse(selected.startedAt));
  return { id: container.Id, node: selected.node, image: container.Image, finishedAt, exit: container.State.ExitCode, restartCount: container.RestartCount, oomKilled: container.State.OOMKilled };
}
export async function cutFailureNode(host, selected) {
  return stopFailureNode(host, selected, 'SIGKILL', 0, 137);
}
export async function gracefullyStopFailureNode(host, selected) {
  return stopFailureNode(host, selected, 'SIGTERM', 45, 0);
}
async function stopFailureNode(host, selected, signal, timeout, exit) {
  host.access?.({ kind: 'replica-stop', node: selected.node, signal });
  const [before] = JSON.parse(await host.run('docker', ['inspect', selected.id])); assertContainer(host, selected, before);
  assert.equal(before.State.Running, true); assert.equal(before.State.StartedAt, selected.startedAt);
  // Stop API suppresses automatic restart; SIGKILL supplies the abrupt cut.
  await host.run('docker', ['stop', '--signal', signal, '--timeout', String(timeout), selected.id]);
  return stoppedFailureNode(host, selected, { exit });
}
export async function restartFailureNode(host, selected, { exit = 137 } = {}) {
  await stoppedFailureNode(host, selected, { exit }); host.access?.({ kind: 'replica-start', node: selected.node });
  await host.run('docker', ['start', selected.id]);
  const [container] = JSON.parse(await host.run('docker', ['inspect', selected.id])); assertContainer(host, selected, container);
  assert.equal(container.State.Running, true); assert.ok(Date.parse(container.State.StartedAt) > Date.parse(selected.startedAt));
  return { id: container.Id, node: selected.node, image: container.Image, startedAt: container.State.StartedAt, restartCount: container.RestartCount };
}
