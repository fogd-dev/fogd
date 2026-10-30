import { readAppArchivePlan, readAppArchiveRestorationPlan } from '../runtime/app-archive-plan.mjs';
import { restoreAppArchiveData } from './app-archive-data.mjs';
import { mkdir, realpath } from 'node:fs/promises';
import { join, resolve, dirname, basename, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { readDurableRestorePlan } from '../runtime/durable-recovery-plan.mjs';
import { readDurableRetirementPlan } from '../runtime/durable-retirement-plan.mjs';
import { enrollDurableRestoration } from '../runtime/durable-installation.mjs';
import { restoreDurableRoutes, retireDurableRoutes, archiveDurableRoutes, restoreArchivedDurableRoutes } from '../runtime/durable-restoration.mjs';
import { verifyRuntimeFamily } from '../runtime/catalog.mjs';
import { acquireStopFence } from '../runtime/launch-fence.mjs';
import { hasRuntimeEnrollment, installationDirectory } from '../runtime/installation-state.mjs';
import { assertRecoverySourceStopped, assertRecoveryOperationsAvailable, writeRecoverySource, writeRecoverySources } from '../runtime/recovery-source.mjs';
import { readPolicyVolume } from '../runtime/policy-volume.mjs';
import { restoreDurableData } from './durable-restore-data.mjs';
import { verifyDurableBundle, verifyAppArchiveBundle, durableSnapshotFormat } from './durable-bundle.mjs';
import { fingerprint, writeJson, composeLiteral } from './bundle.mjs';
import { stopped } from './docker.mjs';

const refused = () => Object.assign(new Error('Durable restore is unconfirmed; keep source and destination stopped and retain source data, destination enrollment and partial output'), { code: 'DURABLE_RESTORE_UNCONFIRMED' });
const volumeNames = config => Object.values(config.volumes).map(volume => volume.name);
async function restorePaths(directory, output) {
  const source = await realpath(resolve(directory)), requested = resolve(output);
  const destination = join(await realpath(dirname(requested)), basename(requested)), path = relative(source, destination);
  if (!path || path !== '..' && !path.startsWith('..' + sep)) throw refused();
  return { source, destination };
}
const sources = plan => plan.sources || [plan.source];
async function outputOutsideSources(plan, directory, destination) {
  for (const source of sources(plan)) {
    const path = relative(await realpath(source.directory || directory), destination);
    if (!path || path !== '..' && !path.startsWith('..' + sep)) throw refused();
  }
}

async function sourceStopped(plan, io, owned = []) {
  for (const source of sources(plan)) {
    await io.operationPeers(source.config.name, owned);
    await io.related(source.config.name);
    await io.stopped(source.config.name, volumeNames(source.config));
  }
}
async function sourceSnapshot(directory, plan, io) {
  for (const source of sources(plan)) {
    const path = source.directory || directory, checked = await io.bundle(path, source.policy, source.verifyAt);
    if ((await fingerprint(join(path, 'manifest.json'))).sha256 !== (source.snapshot || plan.snapshot) ||
      !isDeepStrictEqual(checked.config, source.config) || !isDeepStrictEqual(checked.state, source.state) || !isDeepStrictEqual(checked.authority, source.authority)) throw refused();
  }
}
async function fenceSources(plan, io, fences) {
  const owned = [];
  for (const source of [...sources(plan)].sort((a, b) => a.config.name.localeCompare(b.config.name))) {
    if (await io.enrolled(source.config.name)) {
      fences.push(await io.acquire(io.directory(source.config.name), { project: source.config.name, installation: runtimePolicyIdentity(source.policy) }));
      owned.push(source.config.name);
    }
  }
  return owned;
}
async function releaseFences(fences) {
  const results = await Promise.allSettled(fences.map(fence => fence.release()));
  if (results.some(result => result.status === 'rejected')) throw refused();
}
async function sourceRelation(plan, config, io, owned) {
  if (sources(plan).length === 1) await io.relation(config.name, plan.source.config.name, plan.source.config);
  else await io.relations(config.name, sources(plan).map(source => ({ project: source.config.name, config: source.config })));
  await sourceStopped(plan, io, owned); await io.related(config.name);
}

async function populate(directory, output, plan, context, io, owned) {
  const { config, policy, inventory } = context;
  await sourceStopped(plan, io, owned); await sourceSnapshot(directory, plan, io);
  await io.data(directory, config, policy, { retiredFleet: plan.retiredFleet, ...(plan.archivedFleet ? { archivedFleet: plan.archivedFleet } : {}) }, plan);
  await sourceStopped(plan, io, owned); await sourceSnapshot(directory, plan, io);
  const receipt = await io.routes(config, { profile: policy, sourceProfile: plan.source.policy,
    source: { state: plan.source.state, authority: plan.source.authority }, binding: inventory.identity, snapshot: plan.snapshot, domain: plan.domain, ...(plan.routeRequest || (plan.retirement ? { retirement: plan.retirement } : {})) });
  if (!isDeepStrictEqual(await io.policy(policy.image, config.volumes['runtime-policy'].name, config.services.controller.environment), policy)) throw refused();
  await sourceStopped(plan, io, owned); await sourceSnapshot(directory, plan, io); await io.related(config.name);
  if (plan.retirement) await writeJson(join(output, 'retirement.json'), plan.retirement.evidence);
  if (plan.operation) await writeJson(join(output, 'app-archive.json'), { schema: 1, operation: plan.operation, archive: plan.archiveRecord,
    sources: sources(plan).map(source => ({ project: source.config.name, snapshot: source.snapshot, identity: runtimePolicyIdentity(source.policy) })),
    target: { project: config.name, identity: runtimePolicyIdentity(policy) }, services: 'stopped', httpRouting: 'withheld' });
  await writeJson(join(output, 'compose.json'), composeLiteral(config));
  await writeJson(join(output, 'restored.json'), { format: durableSnapshotFormat, sourceProject: plan.source.config.name,
    project: config.name, snapshot: plan.snapshot, runtimeFamily: policy.family, identitySha256: runtimePolicyIdentity(policy),
    preparedAt: new Date().toISOString(), enrollmentRequired: true, services: 'stopped', httpRouting: 'withheld', routeAuthoritySha256: receipt.sha256 });
  return receipt;
}

// New-format snapshots are data only. The enrollment coordinator independently
// verifies and installs policies, allocates stopped resources and withholds its
// completion record until copying, route rebinding and readbacks all finish.
export async function restoreDurableInstallation(directory, project, output, selection, options = {}) {
  return recoverInstallation(directory, project, output, selection, { plan: readDurableRestorePlan, routes: restoreDurableRoutes, ...options });
}

export async function retireDurableInstallation(directory, project, output, selection, retirement, options = {}) {
  return recoverInstallation(directory, project, output, selection, {
    plan: (source, target, selected) => readDurableRetirementPlan(source, target, selected, retirement), routes: retireDurableRoutes, ...options });
}

export async function archiveDurableInstallation(directory, project, output, selection, archive, options = {}) {
  return recoverInstallation(directory, project, output, selection, {
    plan: (source, target, selected) => readAppArchivePlan(source, target, selected, archive),
    routes: archiveDurableRoutes, bundle: verifyAppArchiveBundle, ...options });
}
export async function restoreArchivedInstallation(directory, retainedDirectory, project, output, selection, restore, options = {}) {
  return recoverInstallation(directory, project, output, selection, {
    plan: (source, target, selected) => readAppArchiveRestorationPlan(source, retainedDirectory, target, selected, restore),
    data: (source, config, _policy, _options, plan) => restoreAppArchiveData(source, plan.retained.directory, config, plan.dataSelection),
    routes: restoreArchivedDurableRoutes, bundle: verifyAppArchiveBundle, ...options });
}

async function recoverInstallation(directory, project, output, selection, options) {
  const io = { verify: verifyRuntimeFamily, enrolled: hasRuntimeEnrollment,
    directory: installationDirectory, acquire: acquireStopFence, related: assertRecoverySourceStopped, stopped,
    operationPeers: assertRecoveryOperationsAvailable,
    relation: writeRecoverySource, relations: writeRecoverySources, enroll: enrollDurableRestoration, data: restoreDurableData,
    policy: readPolicyVolume, bundle: verifyDurableBundle, ...options };
  const fences = []; let releasing = false;
  try {
    const { source, destination } = await restorePaths(directory, output), plan = await io.plan(source, project, selection);
    await outputOutsideSources(plan, source, destination);
    await io.verify(plan.entry); await sourceStopped(plan, io);
    const owned = await fenceSources(plan, io, fences);
    await sourceStopped(plan, io, owned);
    await mkdir(destination, { mode: 0o700 });
    const selected = { ...plan.target, entry: plan.entry };
    const tasks = {
      prepare: ({ config }) => sourceRelation(plan, config, io, owned),
      populate: context => populate(source, destination, plan, context, io, owned),
    };
    const result = await io.enroll(selected, tasks);
    // No Docker/runtime writes follow host completion, including failed release.
    releasing = true; await releaseFences(fences);
    return { config: result.config, policy: result.policy, directory: destination };
  } catch {
    if (!releasing) await releaseFences(fences).catch(() => {});
    throw refused();
  }
}
