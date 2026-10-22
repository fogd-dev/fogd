import { readFile } from 'node:fs/promises';

// These observers run outside the paused controller, with data and policy mounted
// read-only. Native reads use the same identity checks as the installed backend.
export async function controllerState(host) {
  const code = "import{readFile}from'node:fs/promises';console.log(await readFile('/var/lib/fogd/state.json','utf8'));";
  return JSON.parse(await host.run('docker', [...observerArgs(host, 'none'), '--input-type=module', '-e', code]));
}

export async function approvedArtifacts(host, approvals) {
  const inputs = Object.values(approvals).map(({ id, digest }) => ({ id, digest }));
  const code = `import{artifactDigest}from'/app/packages/runtime/src/artifact.mjs';const result={};for(const {id,digest} of ${JSON.stringify(inputs)}){if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid approval');const actual=await artifactDigest('/var/lib/fogd/artifacts/'+id);if(actual!==digest)throw Error('Restored approved artifact differs');result[id]=actual;}console.log(JSON.stringify(result));`;
  return JSON.parse(await host.run('docker', [...observerArgs(host, 'none'), '--input-type=module', '-e', code]));
}

export async function nativeObservation(host, slotId, deployment, { captureProofs = false, persistedRecords = false } = {}) {
  return nativeProgram(host, slotId, 'native-observer.mjs', { deployment, captureProofs, persistedRecords });
}

export async function setFaultPolicy(host, slotId, deployment, policy, phase) {
  return nativeProgram(host, slotId, 'native-policy.mjs', { deployment, policy, phase });
}

export async function vmTime(host) {
  const container = `${host.project}-${host.policy.fleets[0].nodes[0].host}-1`;
  const value = Number((await host.run('docker', ['exec', container, '/usr/local/bin/node', '-e', 'console.log(Date.now())'])).trim());
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid native VM clock observation');
  return value;
}

async function nativeProgram(host, slotId, program, input) {
  const slot = host.policy.fleets.find(value => value.id === slotId);
  if (!slot) throw new Error('Unknown observation fleet');
  const env = Object.fromEntries(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'FOGD_BUCKET', 'S3_ENDPOINT', 'FOGD_SLOTS']
    .map(key => [key, host.config.services.controller.environment[key]]));
  const code = await readFile(new URL(program, import.meta.url), 'utf8');
  const network = `fleet-${host.policy.fleets.indexOf(slot) + 1}`;
  return JSON.parse(await host.run('docker', [...observerArgs(host, host.config.networks[network].name), '--input-type=module', '-e', code], {
    inputText: JSON.stringify({ env, slotId, ...input }), timeout: 90000,
  }));
}

function observerArgs(host, network) {
  return ['run', '--rm', '-i', '--pull', 'never', '--network', network, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--label', `fogd.qualifier.project=${host.project}`,
    '--mount', `type=volume,src=${host.config.volumes.controller.name},dst=/var/lib/fogd,readonly`,
    '--mount', `type=volume,src=${host.config.volumes['runtime-policy'].name},dst=/var/lib/fogd-runtime,readonly`,
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--entrypoint', '/usr/local/bin/node', host.entry.image];
}
