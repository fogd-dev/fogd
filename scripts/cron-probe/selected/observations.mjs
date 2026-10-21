import { readFile } from 'node:fs/promises';

// These observers run outside the paused controller, with data and policy mounted
// read-only. Native reads use the same identity checks as the installed backend.
export async function controllerState(host) {
  const code = "import{readFile}from'node:fs/promises';console.log(await readFile('/var/lib/fogd/state.json','utf8'));";
  return JSON.parse(await host.run('docker', [...observerArgs(host, 'none'), '--input-type=module', '-e', code]));
}

export async function nativeObservation(host, slotId, deployment, { captureProofs = false } = {}) {
  const slot = host.policy.fleets.find(value => value.id === slotId);
  if (!slot) throw new Error('Unknown observation fleet');
  const env = Object.fromEntries(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'FOGD_BUCKET', 'S3_ENDPOINT', 'FOGD_SLOTS']
    .map(key => [key, host.config.services.controller.environment[key]]));
  const code = await readFile(new URL('./native-observer.mjs', import.meta.url), 'utf8');
  const network = `fleet-${host.policy.fleets.indexOf(slot) + 1}`;
  return JSON.parse(await host.run('docker', [...observerArgs(host, host.config.networks[network].name), '--input-type=module', '-e', code], {
    inputText: JSON.stringify({ env, slotId, deployment, captureProofs }), timeout: 90000,
  }));
}

function observerArgs(host, network) {
  return ['run', '--rm', '-i', '--pull', 'never', '--network', network, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--label', `fogd.qualifier.project=${host.project}`,
    '--mount', `type=volume,src=${host.config.volumes.controller.name},dst=/var/lib/fogd,readonly`,
    '--mount', `type=volume,src=${host.config.volumes['runtime-policy'].name},dst=/var/lib/fogd-runtime,readonly`,
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--entrypoint', '/usr/local/bin/node', host.entry.image];
}
