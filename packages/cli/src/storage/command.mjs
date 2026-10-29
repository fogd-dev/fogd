import { parseArgs, isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readEnrolledConfiguration } from '../runtime/installation-state.mjs';
import { runtimeFamilies, verifyRuntimeFamily } from '../runtime/catalog.mjs';
import { validateTopology } from '../recovery/bundle.mjs';
import { docker, projectName } from '../recovery/docker.mjs';
import { cleanupObserver } from '../observe/cleanup.mjs';
import { spaceInventory } from './inventory.mjs';
import { sampleSpace } from './worker.mjs';
import { decodeSpaceSample } from './model.mjs';
import { hasRuntimePolicy } from '../recovery/layout.mjs';
import { durableLegacyBase, isDurableConfig } from '../runtime/durable-config.mjs';
import { readInstalledPolicy } from '../runtime/installed-policy.mjs';
import { selectedRuntimeConfig } from '../runtime/selection-plan.mjs';

export async function storageSpace(project) {
  const { config, entry } = await spaceConfiguration(project);
  const before = await spaceInventory(config);
  let sample = { filesystems: [], mounts: [] };
  if (before.volumes.length) {
    await verifyRuntimeFamily(entry);
    sample = decodeSpaceSample(await observeSpace(project, entry.image, before.volumes), before.volumes.length);
  }
  const after = await spaceInventory(config);
  if (!isDeepStrictEqual(before, after)) throw new Error('Storage inventory changed during observation; inspect it again');
  const mapping = new Map(sample.mounts.map(row => [row.index, row.filesystem]));
  return { installation: project, status: before.missing.length ? 'incomplete' : 'observed', runtimeFamily: entry.id,
    inventory: 'matched-at-boundaries', storageHealth: 'not-assessed', volumeUsage: 'not-measured', capacityReservation: 'none',
    engine: { os: before.engine.os, architecture: before.engine.architecture, driver: before.engine.driver },
    volumes: [...before.volumes.map((volume, index) => ({ role: volume.role, name: volume.name, state: 'sampled', filesystem: mapping.get(index) })),
      ...before.missing.map(volume => ({ ...volume, state: 'missing', filesystem: null }))].sort((a, b) => a.role.localeCompare(b.role)),
    filesystems: sample.filesystems };
}
async function spaceConfiguration(project) {
  const config = await readEnrolledConfiguration(project);
  const entry = runtimeFamilies().find(value => value.admission === 'qualified' && value.image === config.services.controller.image && value.storageImage === config.services.minio.image);
  if (!entry || !hasRuntimePolicy(config)) throw new Error('Storage observation requires an enrolled catalog-pinned configuration');
  if (isDurableConfig(config)) {
    const installed = await readInstalledPolicy(config);
    if (!installed || !isDeepStrictEqual(selectedRuntimeConfig(config, installed.entry, installed.policy), config)) throw new Error('Storage configuration differs from its independent durable policy');
  }
  validateTopology(durableLegacyBase(config));
  return { config, entry };
}
async function observeSpace(project, image, volumes) {
  const nonce = randomUUID(), name = `fogd-space-${nonce}`, paths = volumes.map((_, index) => `/space/v${index}`);
  const mounts = volumes.flatMap((volume, index) => ['--mount', `type=bind,src=${volume.mountpoint},dst=${paths[index]},readonly`]);
  const code = `console.log(JSON.stringify(await (${sampleSpace.toString()})(${JSON.stringify(paths)})));`;
  try {
    return await docker(['run', '--rm', '--pull', 'never', '--name', name, '--label', `fogd.observer.id=${nonce}`, '--label', `fogd.observer.project=${project}`,
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--cpus', '0.25', '--memory', '128m', '--pids-limit', '32',
      ...mounts, '--entrypoint', '/usr/local/bin/node', image, '--input-type=module', '-e', code], { timeoutMs: 15000 });
  } finally { await cleanupObserver(name, nonce); }
}
export async function storageCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { installation: { type: 'string' } } });
  if (positionals.length !== 1 || positionals[0] !== 'space' || !values.installation) throw new Error('Usage: fogd storage space --installation PROJECT (local Docker owner access)');
  console.log(JSON.stringify(await storageSpace(projectName(values.installation)), null, 2));
}
