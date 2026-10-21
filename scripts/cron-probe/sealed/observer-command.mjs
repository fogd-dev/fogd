import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';

export function observerCommand(probe, cold) {
  return (args, network = false) => {
    if (!cold) return probe.compose(['exec', '-T', 'controller', ...args]);
    const options = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];
    if (!network) return execute('docker', ['run', '--rm', '--network', 'none', ...options, '--entrypoint', args[0], probe.runtimeProfile.image, ...args.slice(1)]);
    return connectedObservation(probe, args, options);
  };
}
async function connectedObservation(probe, args, options) {
  const name = `${probe.project}-proof-${randomBytes(4).toString('hex')}`;
  const networks = Object.keys(probe.config.services.controller.networks).map(key => probe.config.networks[key].name);
  assert.ok(networks.length > 0);
  let owned = false;
  try {
    await execute('docker', ['create', '--name', name, '--network', networks[0], ...options, '--entrypoint', args[0], probe.runtimeProfile.image, ...args.slice(1)]); owned = true;
    for (const network of networks.slice(1)) await execute('docker', ['network', 'connect', network, name]);
    const result = await execute('docker', ['start', '--attach', name]);
    const [container] = JSON.parse(await execute('docker', ['inspect', name]));
    assert.equal(container.State.Running, false); assert.equal(container.State.ExitCode, 0); assert.equal(container.State.OOMKilled, false);
    assert.deepEqual(container.Mounts, [], 'Cold observation must not mount controller or application data');
    return result;
  } finally { if (owned) await execute('docker', ['rm', '-f', name]); }
}
