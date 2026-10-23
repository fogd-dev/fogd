import { runtimePolicyVolume, hasRuntimePolicy } from '../recovery/layout.mjs';
import { docker, json, projectContainers, projectName } from '../recovery/docker.mjs';
import { runtimeFamilies, authorizeInstalledPolicy, verifyRuntimeFamily } from './catalog.mjs';
import { readPolicyVolume } from './policy-volume.mjs';
import { hasRuntimeEnrollment } from './installation-state.mjs';
import { assertOwnedLocalVolume } from '../recovery/inventory.mjs';

export async function readInstalledPolicy(config, { allowMissing = false } = {}) {
  projectName(config.name);
  const name = `${config.name}_${runtimePolicyVolume}`;
  if (Object.entries(config.volumes).some(([role, volume]) => role !== runtimePolicyVolume && volume.name === name)) throw new Error('Runtime policy must not alias installation data');
  const names = (await docker(['volume', 'ls', '--format', '{{.Name}}'])).trim().split('\n');
  if (!names.includes(name)) {
    if (allowMissing) return null;
    if (hasRuntimePolicy(config) || await hasRuntimeEnrollment(config.name) || await usesCatalogImage(config)) throw new Error('Selected runtime policy is missing; keep the installation stopped');
    return null;
  }
  const volumes = await json(['volume', 'inspect', name]);
  if (!Array.isArray(volumes) || volumes.length !== 1 || volumes[0]?.Name !== name) throw new Error('Cannot verify installed runtime policy volume ownership');
  assertOwnedLocalVolume(config, runtimePolicyVolume, volumes[0]);
  const reader = await verifiedReader();
  const env = config.services.controller.environment;
  const policy = await readPolicyVolume(reader.image, name, env);
  const entry = authorizeInstalledPolicy(policy);
  if (entry.image !== reader.image) await verifyRuntimeFamily(entry);
  return { policy, entry };
}

async function verifiedReader() {
  // New readers retain older codecs; prefer them so a cached legacy reader
  // cannot prevent decoding an independently installed newer profile schema.
  for (const entry of runtimeFamilies().sort((a, b) => b.schema - a.schema)) {
    try { await verifyRuntimeFamily(entry); return entry; }
    catch { /* A different locally verified catalog image can read schema 2. */ }
  }
  throw new Error('Installed runtime policy requires a cached verified catalog reader; keep the installation stopped');
}

async function usesCatalogImage(config) {
  const known = new Set(runtimeFamilies().map(entry => entry.image));
  if (!known.size) return false;
  const containers = await projectContainers(config.name);
  if (containers.some(container => known.has(container.Image))) return true;
  // A different checkout has no host fence after an interrupted first create.
  // Orphaned project networks cannot safely establish the legacy path.
  if (!containers.length && (await docker(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${config.name}`])).trim()) return true;
  for (const image of new Set(Object.values(config.services).map(service => service.image))) {
    if (known.has(image)) return true;
    let images;
    try { images = await json(['image', 'inspect', image]); }
    catch { continue; }
    if (images.some(item => known.has(item.Id))) return true;
  }
  return false;
}
