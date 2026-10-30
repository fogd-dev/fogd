import { isDeepStrictEqual } from 'node:util';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { validateRouteSnapshot } from '@fogd/platform/route-snapshot';
import { authorizePolicyEntry, validateRuntimeFamily } from './catalog.mjs';
import { requestedRecoveryRuntime } from './recovery-selection.mjs';
import { declaredRuntimeNetworks, runtimePolicyForConfig } from './selection-plan.mjs';
import { durableLegacyBase, durableRuntimeConfig } from './durable-config.mjs';
import { assertRecoveryIngress } from './recovery-ingress.mjs';
import { projectName } from '../recovery/docker.mjs';
import { readJson, fingerprint, restoredConfig } from '../recovery/bundle.mjs';
import { durableSnapshotFormat, verifyDurableBundle } from '../recovery/durable-bundle.mjs';

const refused = () => Object.assign(new Error('Durable recovery requires independently selected runtime and source identity, a verified snapshot and a fresh target plan; nothing was created'), { code: 'DURABLE_RECOVERY_PLAN_REFUSED' });
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function recoverySourceProfile(config, manifest, candidate, expectedIdentity) {
  const entry = validateRuntimeFamily(candidate);
  if (entry.schema !== 2 || entry.routing !== 'durable' || manifest.format !== durableSnapshotFormat || !hash(expectedIdentity)) throw refused();
  if (manifest.sourceProject !== projectName(config.name)) throw refused();
  assertRecoveryIngress(config);
  const policy = runtimePolicyForConfig(config, entry, declaredRuntimeNetworks(config));
  authorizePolicyEntry(policy, entry);
  if (runtimePolicyIdentity(policy) !== expectedIdentity || !isDeepStrictEqual(config, durableRuntimeConfig(config, policy))) throw refused();
  const images = Object.fromEntries(Object.keys(config.services).map(name => [name, name === 'minio' ? entry.storageImage : entry.image]));
  if (!isDeepStrictEqual(manifest.images, images)) throw refused();
  return { policy, entry };
}

// Pure host planning seam. Bundle data never chooses its family, expected storage
// identity or target networks. Actual archive verification remains mandatory.
export function planDurableRestore(bundle, { entry, expectedIdentity, project, networks, snapshot } = {}) {
  try {
    const { config, manifest, state, authority } = bundle;
    const source = recoverySourceProfile(config, manifest, entry, expectedIdentity);
    projectName(project);
    if (project === config.name || !hash(snapshot)) throw refused();
    const domain = config.services.controller.environment.FOGD_BASE_DOMAIN || 'localhost';
    if (!isDeepStrictEqual(manifest.routeAuthority, validateRouteSnapshot(state, authority, source.policy, domain))) throw refused();
    const policy = runtimePolicyForConfig(config, source.entry, networks);
    const base = durableLegacyBase(restoredConfig(config, project, manifest.images));
    for (const [name, network] of Object.entries(base.networks)) {
      if (policy.networks) network.ipam = { config: [{ subnet: policy.networks[name] }] };
      else delete network.ipam;
    }
    const target = durableRuntimeConfig(base, policy); assertRecoveryIngress(target);
    if (runtimePolicyIdentity(policy) !== expectedIdentity) throw refused();
    return structuredClone({ entry: source.entry, source: { ...bundle, policy: source.policy }, target: { config: target, policy }, snapshot, domain });
  } catch { throw refused(); }
}

// Internal selection for the future restore coordinator. Ordinary selectors can
// choose only shipped eligible entries; no image/profile override is exposed.
export async function readDurableRestorePlan(directory, project, selection, { choose = requestedRecoveryRuntime } = {}) {
  try {
    const entry = choose(selection);
    if (!entry || !hash(selection?.expectedIdentity)) throw refused();
    const manifestPath = join(directory, 'manifest.json');
    for (const name of ['manifest.json', 'compose.json']) if (!(await lstat(join(directory, name))).isFile()) throw refused();
    const before = await fingerprint(manifestPath);
    const config = await readJson(join(directory, 'compose.json')), manifest = await readJson(manifestPath);
    const source = recoverySourceProfile(config, manifest, entry, selection.expectedIdentity);
    const checked = await verifyDurableBundle(directory, source.policy);
    if (!isDeepStrictEqual(before, await fingerprint(manifestPath))) throw refused();
    return planDurableRestore(checked, { ...selection, entry, project, snapshot: before.sha256 });
  } catch { throw refused(); }
}
