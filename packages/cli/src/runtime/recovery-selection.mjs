import { assertRecoveryIngress } from './recovery-ingress.mjs';
import { isDeepStrictEqual } from 'node:util';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { requestedRuntime } from './catalog.mjs';
import { projectName } from '../recovery/docker.mjs';
import { hasRuntimePolicy } from '../recovery/layout.mjs';
import { declaredRuntimeNetworks, runtimePolicyForConfig, selectedRuntimeConfig } from './selection-plan.mjs';

export function requestedRecoveryRuntime(selection = {}) {
  const entry = requestedRuntime(selection);
  if (!entry) {
    if (selection.expectedIdentity !== undefined || selection.networks !== undefined) throw new Error('Recovery identity and network selection require an explicit runtime family');
    return null;
  }
  if (typeof selection.expectedIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(selection.expectedIdentity)) throw new Error('Selected recovery requires an independently recorded expected identity SHA256');
  return entry;
}

// Snapshot configuration supplies data, never family eligibility or identity
// authority. The expected digest must come from outside the snapshot.
export function selectedRecoveryPlan({ config, manifest }, selection = {}) {
  const entry = requestedRecoveryRuntime(selection);
  if (!entry) return null;
  projectName(config.name);
  if (manifest.sourceProject !== config.name) throw new Error('Snapshot source project differs from its configuration');
  if (!hasRuntimePolicy(config)) throw new Error('Selected recovery requires a selected-runtime source installation');
  const expected = Object.fromEntries(Object.keys(config.services).map(name => [name, name === 'minio' ? entry.storageImage : entry.image]));
  if (!isDeepStrictEqual(manifest.images, expected)) throw new Error('Snapshot images differ from the selected runtime family; migration remains unqualified');
  assertRecoveryIngress(config);
  const sourcePolicy = runtimePolicyForConfig(config, entry, declaredRuntimeNetworks(config));
  if (runtimePolicyIdentity(sourcePolicy) !== selection.expectedIdentity) throw new Error('Snapshot storage identity differs from the independently expected identity');
  if (!isDeepStrictEqual(selectedRuntimeConfig(config, entry, sourcePolicy), config)) throw new Error('Selected recovery requires the sealed source launch configuration');
  const targetPolicy = runtimePolicyForConfig(config, entry, selection.networks);
  return { entry, sourcePolicy, targetPolicy };
}

export function retiredRuntimePolicy(plan, config, retiredSlot) {
  const target = runtimePolicyForConfig(config, plan.entry, plan.targetPolicy.networks);
  const index = plan.sourcePolicy.fleets.findIndex(fleet => fleet.id === retiredSlot);
  if (index < 0) throw new Error('Retirement requires the original assigned fleet');
  const expected = structuredClone(plan.targetPolicy), replacement = target.fleets[index];
  const oldIds = new Set(plan.sourcePolicy.fleets.flatMap(fleet => fleet.nodes.map(node => node.id)));
  if (replacement.prefix === expected.fleets[index].prefix || replacement.nodes.some(node => oldIds.has(node.id))) throw new Error('Retirement requires fresh namespace and native identities');
  expected.fleets[index].prefix = replacement.prefix;
  for (const [offset, node] of expected.fleets[index].nodes.entries()) node.id = replacement.nodes[offset].id;
  if (!isDeepStrictEqual(target, expected)) throw new Error('Retirement changed survivor or storage identity');
  return target;
}
