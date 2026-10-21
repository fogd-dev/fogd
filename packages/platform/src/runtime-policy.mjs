import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { storageOrigin } from './runtime-identity-proof.mjs';
import { isIP } from 'node:net';

const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const imageId = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const rootKeys = ['schema', 'family', 'admission', 'image', 'storageImage', 'binarySha256', 'supervisorSha256', 'controllerArgs', 'bucket', 'storage', 'fleets'];
export const RUNTIME_POLICY_MAX_BYTES = 65536;

export class RuntimePolicyError extends Error {
  constructor() {
    super('Installed runtime policy is invalid or does not match this installation');
    this.code = 'RUNTIME_POLICY_REFUSED';
  }
}

export function decodeRuntimePolicy(text, env) {
  try {
    if (Buffer.byteLength(text) > RUNTIME_POLICY_MAX_BYTES) throw new RuntimePolicyError();
    return validateRuntimePolicy(JSON.parse(text), env);
  } catch { throw new RuntimePolicyError(); }
}

// This validates installation data. The independent host catalog supplies
// qualification authority before the policy volume is written.
export function validateRuntimePolicy(input, env) {
  try {
    assertHeader(input);
    assertStorage(input);
    assertFleets(input.fleets);
    if (Object.hasOwn(input, 'networks')) assertNetworks(input.networks);
    const policy = structuredClone(input);
    if (env !== undefined) assertEnvironment(policy, env);
    return policy;
  } catch {
    throw new RuntimePolicyError();
  }
}

export function runtimePolicyIdentity(input) {
  const { bucket, storage, fleets } = validateRuntimePolicy(input);
  const identity = { bucket, storage: { endpoint: storage.endpoint, region: storage.region },
    fleets: fleets.map(({ id, prefix, nodes }) => ({ id, prefix, nodes: nodes.map(({ host, id }) => ({ host, id })) })) };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function keys(value, expected) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
    !isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())) throw new Error('Invalid policy fields');
}
function assertHeader(input) {
  keys(input, [...rootKeys, ...(input && Object.hasOwn(input, 'networks') ? ['networks'] : [])]);
  if (input.schema !== 2 || typeof input.family !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(input.family) ||
    !['candidate', 'qualified'].includes(input.admission) || !imageId(input.image) || !imageId(input.storageImage) ||
    !sha256(input.binarySha256) || !sha256(input.supervisorSha256) ||
    !isDeepStrictEqual(input.controllerArgs, ['packages/platform/src/main.mjs'])) throw new Error('Invalid runtime declaration');
}
function assertNetworks(networks) {
  keys(networks, ['control', 'fleet-1', 'fleet-2']);
  for (const subnet of Object.values(networks)) {
    if (!privateRuntimeSubnet(subnet)) throw new Error('Invalid private network declaration');
  }
  if (new Set(Object.values(networks)).size !== 3) throw new Error('Overlapping private networks');
}
export function privateRuntimeSubnet(value) {
  return typeof value === 'string' && value.endsWith('.0/24') && isIP(value.slice(0, -3)) === 4 && value.startsWith('10.');
}
function assertStorage(input) {
  keys(input.storage, ['endpoint', 'region']);
  if (typeof input.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket) ||
    typeof input.storage.endpoint !== 'string' || input.storage.endpoint.length > 2048 ||
    input.storage.endpoint !== storageOrigin(input.storage.endpoint) || typeof input.storage.region !== 'string' ||
    !/^[a-z0-9-]{1,64}$/.test(input.storage.region)) throw new Error('Invalid storage declaration');
}
function assertFleets(fleets) {
  if (!Array.isArray(fleets) || fleets.length !== 2) throw new Error('Expected two fleets');
  const identities = new Set();
  for (const [index, fleet] of fleets.entries()) assertFleet(fleet, `slot-${index + 1}`, identities);
  const [a, b] = fleets.map(fleet => fleet.prefix);
  if (a === b || a.startsWith(b + '/') || b.startsWith(a + '/')) throw new Error('Overlapping fleet namespaces');
}
function assertFleet(fleet, id, identities) {
  keys(fleet, ['id', 'prefix', 'nodes']);
  if (fleet.id !== id || typeof fleet.prefix !== 'string' || fleet.prefix.length > 256 ||
    fleet.prefix.split('/').some(part => !/^[a-z0-9-]+$/.test(part)) ||
    !Array.isArray(fleet.nodes) || fleet.nodes.length !== 2) throw new Error('Invalid fleet declaration');
  for (const [offset, node] of fleet.nodes.entries()) assertNode(node, `${id}-${offset === 0 ? 'a' : 'b'}`, identities);
}
function assertNode(node, host, identities) {
  keys(node, ['host', 'id']);
  if (node.host !== host || typeof node.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(node.id) || identities.has(node.id)) throw new Error('Invalid node declaration');
  identities.add(node.id);
}
function assertEnvironment(policy, env) {
  if (!env || typeof env !== 'object' || policy.bucket !== env.FOGD_BUCKET ||
    policy.storage.endpoint !== storageOrigin(env.S3_ENDPOINT) || policy.storage.region !== env.AWS_REGION) throw new Error('Storage binding differs');
  const slots = policy.fleets.map(({ id, prefix, nodes }) => ({ id, prefix, nodes: nodes.map(node => node.host) }));
  if (typeof env.FOGD_SLOTS !== 'string' || env.FOGD_SLOTS.length > 65536 ||
    !isDeepStrictEqual(JSON.parse(env.FOGD_SLOTS), slots)) throw new Error('Fleet binding differs');
}
