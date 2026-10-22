import { readFile } from 'node:fs/promises';
import { observerOptions, observerEnvironment } from './observer-container.mjs';

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

export async function setFaultPolicy(host, slotId, deployment, policy, phase, app = 'refresh') {
  return nativeProgram(host, slotId, 'native-policy.mjs', { deployment, policy, phase, app });
}

export async function setFailurePolicy(host, active, phase) {
  return nativeProgram(host, active.slot, 'native-failure-policy.mjs', { deployment: active.id, digest: active.digest, version: active.version, phase });
}

export async function vmTime(host, node = host.policy.fleets[0].nodes[0].host) {
  if (!host.policy.fleets.some(fleet => fleet.nodes.some(value => value.host === node))) throw new Error('Clock node is outside the installation');
  host.access?.({ kind: 'clock', node });
  const container = `${host.project}-${node}-1`;
  const value = Number((await host.run('docker', ['exec', container, '/usr/local/bin/node', '-e', 'console.log(Date.now())'])).trim());
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid native VM clock observation');
  return value;
}

async function nativeProgram(host, slotId, program, input) {
  host.access?.({ kind: 'native', slot: slotId, program });
  const slot = host.policy.fleets.find(value => value.id === slotId);
  if (!slot) throw new Error('Unknown observation fleet');
  const env = observerEnvironment(host);
  const code = await readFile(new URL(program, import.meta.url), 'utf8');
  const network = `fleet-${host.policy.fleets.indexOf(slot) + 1}`;
  return JSON.parse(await host.run('docker', [...observerArgs(host, host.config.networks[network].name), '--input-type=module', '-e', code], {
    inputText: JSON.stringify({ env, slotId, ...input }), timeout: 90000,
  }));
}

function observerArgs(host, network) {
  return ['run', '--rm', '-i', ...observerOptions(host, network), '--entrypoint', '/usr/local/bin/node', host.entry.image];
}
