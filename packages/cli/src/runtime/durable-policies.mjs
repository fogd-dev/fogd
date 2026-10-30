import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { hasDurableRuntimeMode, runtimePolicyIdentity, validateRuntimePolicy } from '@fogd/platform/runtime-policy';
import { runtimePolicyVolume } from '../recovery/layout.mjs';
import { volumeHelper } from '../recovery/volumes.mjs';
import { durableRuntimeConfig, gatewayPolicyVolume } from './durable-config.mjs';
import { readPolicyVolume } from './policy-volume.mjs';

const RECEIPT_MAX_BYTES = 1024, GATEWAY_MAX_BYTES = 16 * 1024;
const writeGatewayCode = "import{writeGatewayLaunchPolicy}from'./packages/runtime/src/gateway-launch-policy.mjs';let input='';for await(const part of process.stdin){input+=part;if(input.length>16384)throw new Error('too large')}console.log(JSON.stringify(await writeGatewayLaunchPolicy('/data',JSON.parse(input))));";
const readGatewayCode = "import{readGatewayLaunchPolicy}from'./packages/runtime/src/gateway-launch-policy.mjs';console.log(JSON.stringify(await readGatewayLaunchPolicy('/data')));";
const helper = { entrypoint: '/usr/local/bin/node', capabilities: [] };
const refused = () => Object.assign(new Error('Durable policies could not be installed on fresh stores; keep the installation stopped'), { code: 'DURABLE_POLICIES_REFUSED' });

function parseBounded(output, limit) {
  if (typeof output !== 'string' || output.length > limit || !/^[\x20-\x7e]+\n?$/.test(output)) throw refused();
  return JSON.parse(output);
}

export function durableGatewayPlan(policy) {
  return { schema: 1, policy: { installation: runtimePolicyIdentity(policy), slots: policy.fleets.map(fleet => fleet.id) },
    slots: policy.fleets.map(fleet => ({ id: fleet.id, nodes: fleet.nodes.map(node => node.host) })) };
}

// The caller has already authorized and verified the profile image, confirmed
// fresh owned stopped resources, and holds the enrollment fence. Both writers
// are create-only: retained or partial stores refuse and are never repaired.
export async function installDurablePolicies(config, profile, { readVolume = volumeHelper, readPolicy = readPolicyVolume } = {}) {
  try {
    if (!isDeepStrictEqual(durableRuntimeConfig(config, profile), config) || !config.volumes[runtimePolicyVolume]) throw refused();
    const policy = validateRuntimePolicy(profile);
    if (!hasDurableRuntimeMode(policy)) throw refused();
    const runtimeVolume = config.volumes[runtimePolicyVolume].name, gatewayVolume = config.volumes[gatewayPolicyVolume].name;
    const runtime = { family: policy.family, admission: policy.admission, identitySha256: runtimePolicyIdentity(policy) };
    // Sequential: a refused runtime install never starts the gateway writer.
    const runtimeOutput = await readVolume(policy.image, runtimeVolume, ['packages/platform/src/import-fresh-runtime-policy.mjs'],
      { readonly: false, ...helper, inputText: JSON.stringify(policy) });
    if (!isDeepStrictEqual(parseBounded(runtimeOutput, RECEIPT_MAX_BYTES), runtime)) throw refused();
    if (!isDeepStrictEqual(await readPolicy(policy.image, runtimeVolume, config.services.controller.environment), policy)) throw refused();
    const plan = durableGatewayPlan(policy), text = JSON.stringify(plan);
    const gateway = { installation: plan.policy.installation, sha256: createHash('sha256').update(text + '\n').digest('hex') };
    const gatewayOutput = await readVolume(policy.image, gatewayVolume, ['--input-type=module', '-e', writeGatewayCode],
      { readonly: false, ...helper, inputText: text });
    if (!isDeepStrictEqual(parseBounded(gatewayOutput, RECEIPT_MAX_BYTES), gateway)) throw refused();
    const readback = await readVolume(policy.image, gatewayVolume, ['--input-type=module', '-e', readGatewayCode], { readonly: true, ...helper });
    if (!isDeepStrictEqual(parseBounded(readback, GATEWAY_MAX_BYTES), plan)) throw refused();
    return { runtime, gateway };
  } catch { throw refused(); }
}
