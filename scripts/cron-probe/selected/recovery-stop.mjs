import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { composeArgs, projectContainers, stopped } from '../../../packages/cli/src/recovery/docker.mjs';
import { cleanupSelectedHost } from './host.mjs';
import { nativeProcesses } from './recovery-fence.mjs';

export async function stopRecovery(host, { alreadyStopped = false } = {}) {
  const native = alreadyStopped ? null : await nativeProcesses(host);
  if (alreadyStopped) await stopped(host.project, Object.values(host.config.volumes).map(volume => volume.name));
  else if (host.nativeBaseline) assert.deepEqual(native, host.nativeBaseline);
  const canonical = join(host.env.FOGD_HOME, '.fogd/installations', host.project, 'compose.json');
  const compose = args => host.run('docker', [...composeArgs(canonical, host.project), ...args]);
  await compose(['stop', 'workerd', 'controller']);
  await compose(['stop', ...host.policy.fleets.flatMap(fleet => fleet.nodes.map(node => node.host))]);
  await compose(['stop', 'minio', 'bucket-init']);
  const containers = await projectContainers(host.project);
  const exits = containers.map(container => ({ service: container.Config.Labels['com.docker.compose.service'], exitCode: container.State.ExitCode,
    running: container.State.Running, oomKilled: container.State.OOMKilled, restartCount: container.RestartCount }));
  for (const exit of exits) {
    assert.equal(exit.running, false); assert.equal(exit.oomKilled, false); assert.equal(exit.restartCount, 0);
    assert.ok((exit.service === 'workerd' ? [0, 1] : [0]).includes(exit.exitCode));
  }
  const earliest = containers.map(container => container.State.StartedAt).filter(value => value && !value.startsWith('0001-')).sort()[0];
  const logs = await compose(['logs', '--no-color', ...(earliest ? ['--since', earliest] : [])]);
  await writeFile(join(host.output, 'runtime.log'), logs, { mode: 0o600, flag: 'wx' });
  assert.doesNotMatch(logs, /celld exited \(|SELF-FENCE|node_lease_watchdog_fence|panicked at|out of memory|Insufficient Storage|status(?: code)?[:= ]+507/i);
  await cleanupSelectedHost(host);
  await stopped(host.project, Object.values(host.config.volumes).map(volume => volume.name));
  return { native, exits, earliest, retainedVolumes: Object.values(host.config.volumes).map(volume => volume.name) };
}
