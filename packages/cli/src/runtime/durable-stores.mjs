import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { runtimePolicyIdentity, validateRuntimePolicy } from '@fogd/platform/runtime-policy';
import { encodeRouteRecord } from '@fogd/runtime/route-record';
import { volumeHelper } from '../recovery/volumes.mjs';
import { durableRuntimeConfig, gatewayPolicyVolume, routeAuthorityVolume } from './durable-config.mjs';

const GATEWAY_MAX_BYTES = 16 * 1024, AUTHORITY_MAX_BYTES = 256 * 1024;
const gatewayCode = "import{readGatewayLaunchPolicy}from'./packages/runtime/src/gateway-launch-policy.mjs';console.log(JSON.stringify(await readGatewayLaunchPolicy('/data')));";
const authorityCode = "import{readRouteRecord}from'./packages/platform/src/route-record-store.mjs';let input='';for await(const part of process.stdin)input+=part;console.log(JSON.stringify(await readRouteRecord('/data/routes.json',JSON.parse(input))));";
const refused = () => Object.assign(new Error('Durable route stores could not be verified; keep ingress stopped'), { code: 'DURABLE_STORES_REFUSED' });
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());

// Every expected value is pure ASCII JSON, so a printable-ASCII check is the
// strict UTF-8 bound on the already-decoded helper output.
function parseBounded(output, limit) {
  if (typeof output !== 'string' || output.length > limit || !/^[\x20-\x7e]+\n?$/.test(output)) throw refused();
  return JSON.parse(output);
}

// Callers must authorize the profile and verify its pinned image first. This is
// a read-only snapshot of the two stores: not proof of physical freshness or of
// controller settledness; the coordinator compares the digest after start.
export async function readDurableStores(config, profile, { readVolume = volumeHelper } = {}) {
  try {
    if (!isDeepStrictEqual(durableRuntimeConfig(config, profile), config)) throw refused();
    const policy = validateRuntimePolicy(profile);
    if (policy.schema !== 3 || policy.routing !== 'durable') throw refused();
    const routePolicy = { installation: runtimePolicyIdentity(policy), slots: policy.fleets.map(fleet => fleet.id) };
    const expected = { schema: 1, policy: routePolicy, slots: policy.fleets.map(fleet => ({ id: fleet.id, nodes: fleet.nodes.map(node => node.host) })) };
    const options = { entrypoint: '/usr/local/bin/node', capabilities: [] };
    // Sequential so a refused gateway read never starts the authority helper.
    const gateway = parseBounded(await readVolume(policy.image, config.volumes[gatewayPolicyVolume].name,
      ['--input-type=module', '-e', gatewayCode], { readonly: true, ...options }), GATEWAY_MAX_BYTES);
    if (!isDeepStrictEqual(gateway, expected)) throw refused();
    const report = parseBounded(await readVolume(policy.image, config.volumes[routeAuthorityVolume].name,
      ['--input-type=module', '-e', authorityCode], { readonly: true, ...options, inputText: JSON.stringify(routePolicy) }), AUTHORITY_MAX_BYTES);
    if (!exactKeys(report, ['record', 'digest']) || typeof report.digest !== 'string' || !/^[a-f0-9]{64}$/.test(report.digest)) throw refused();
    // Publication writes canonical encodeRouteRecord bytes, so the raw-file digest must match them.
    const canonical = encodeRouteRecord(report.record, routePolicy);
    if (createHash('sha256').update(canonical).digest('hex') !== report.digest) throw refused();
    return { authority: { record: JSON.parse(canonical), sha256: report.digest }, gatewayPolicy: expected };
  } catch { throw refused(); }
}
