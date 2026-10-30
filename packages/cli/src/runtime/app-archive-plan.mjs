import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { prepareAppArchiveRoutes, prepareAppArchiveRestoreRoutes } from '@fogd/platform/app-archive-routes';
import { verifyAppArchiveBundle } from '../recovery/durable-bundle.mjs';
import { readAppArchiveDataPlan } from '../recovery/app-archive-data.mjs';
import { tarNamespace } from '../recovery/tar-namespace.mjs';
import { readJson, fingerprint, restoredConfig } from '../recovery/bundle.mjs';
import { projectName } from '../recovery/docker.mjs';
import { requestedRecoveryRuntime } from './recovery-selection.mjs';
import { recoverySourceProfile } from './durable-recovery-plan.mjs';
import { durableLegacyBase, durableRuntimeConfig } from './durable-config.mjs';

const refused = () => Object.assign(new Error('App archival requires independently selected matching runtime and identities, verified snapshots and an exact fresh target; nothing was created'), { code: 'APP_ARCHIVE_PLAN_REFUSED' });
async function source(directory, entry, expectedIdentity, at) {
  directory = resolve(directory);
  for (const name of ['manifest.json', 'compose.json']) if (!(await lstat(join(directory, name))).isFile()) throw refused();
  const before = await fingerprint(join(directory, 'manifest.json')), config = await readJson(join(directory, 'compose.json')), manifest = await readJson(join(directory, 'manifest.json'));
  const { policy } = recoverySourceProfile(config, manifest, entry, expectedIdentity);
  const bundle = await verifyAppArchiveBundle(directory, policy, at);
  if (!isDeepStrictEqual(before, await fingerprint(join(directory, 'manifest.json')))) throw refused();
  return { ...bundle, policy, directory, snapshot: before.sha256, verifyAt: at };
}
function selected(selection, options) {
  const entry = (options?.choose || requestedRecoveryRuntime)(selection);
  if (!entry?.sourceFiles['packages/platform/src/import-app-archive-routes.mjs']) throw refused();
  return entry;
}
function targetPolicy(source, networks) {
  const policy = structuredClone(source); delete policy.networks;
  if (networks !== undefined) policy.networks = structuredClone(networks);
  return policy;
}
export function appArchiveTargetConfig(source, policy, project) {
  projectName(project);
  if (project === source.name) throw refused();
  const images = Object.fromEntries(Object.keys(source.services).map(name => [name, name === 'minio' ? policy.storageImage : policy.image]));
  const base = durableLegacyBase(restoredConfig(source, project, images));
  const slots = policy.fleets.map(({ id, prefix, nodes }) => ({ id, prefix, nodes: nodes.map(node => node.host) }));
  for (const role of ['controller', 'workerd']) base.services[role].environment.FOGD_SLOTS = JSON.stringify(slots);
  for (const fleet of policy.fleets) for (const node of fleet.nodes) {
    base.services[node.host].environment.CELLD_BUCKET = `s3://${policy.bucket}/${fleet.prefix}`;
    base.services[node.host].environment.CELLD_NODE = node.id;
  }
  for (const [name, network] of Object.entries(base.networks)) {
    if (policy.networks) network.ipam = { config: [{ subnet: policy.networks[name] }] };
    else delete network.ipam;
  }
  return durableRuntimeConfig(base, policy);
}
function routeInput(plan, request) {
  return { profile: plan.target.policy, sourceProfile: plan.source.policy, source: { state: plan.source.state, authority: plan.source.authority },
    snapshot: plan.snapshot, binding: '0'.repeat(64), domain: plan.domain, ...request };
}
function basePlan(entry, current, policy, project) {
  return { entry, source: current, sources: [current], target: { policy, config: appArchiveTargetConfig(current.config, policy, project) },
    snapshot: current.snapshot, domain: current.config.services.controller.environment.FOGD_BASE_DOMAIN || 'localhost' };
}

export async function readAppArchivePlan(directory, project, selection, archive, options) {
  try {
    const entry = selected(selection, options), current = await source(directory, entry, selection.expectedIdentity);
    const request = { app: archive.app, digest: archive.digest, id: archive.id ?? randomUUID(), at: archive.at ?? new Date().toISOString() };
    const assigned = current.state.apps[request.app], policy = targetPolicy(current.policy, selection.networks), fleet = policy.fleets.find(fleet => fleet.id === assigned?.slot);
    if (!fleet) throw refused();
    fleet.prefix = `archive-generations/${request.id}`; fleet.nodes = fleet.nodes.map(node => ({ ...node, id: `${node.host}-${request.id}` }));
    const plan = basePlan(entry, current, policy, project), projected = prepareAppArchiveRoutes(routeInput(plan, { archive: request }));
    const original = current.policy.fleets.find(fleet => fleet.id === assigned.slot);
    const namespace = await tarNamespace(join(current.directory, 'bucket.tar'), `${current.policy.bucket}/${original.prefix}`, current.manifest.files['bucket.tar']);
    if (!namespace.members.some(member => member.path === 'fogd-owner.json/xl.meta' && member.type === 'file')) throw refused();
    const record = projected.state.appArchives.records[request.id];
    return { ...plan, operation: 'archive', routeRequest: { archive: request }, archivedFleet: assigned.slot,
      archiveRecord: { id: request.id, identity: record.identity } };
  } catch { throw refused(); }
}
export async function readAppArchiveRestorationPlan(directory, retainedDirectory, project, selection, restore, options) {
  try {
    const entry = selected(selection, options), current = await source(directory, entry, selection.expectedIdentity);
    const record = current.state.appArchives?.records[restore.archive];
    if (!record || record.identity !== restore.expectedIdentity || record.status !== 'archived') throw refused();
    const retained = await source(retainedDirectory, entry, selection.retainedIdentity, Date.parse(record.at));
    if (retained.config.name === current.config.name || retained.config.name === project) throw refused();
    const policy = targetPolicy(current.policy, selection.networks), fleet = policy.fleets.find(fleet => fleet.id === restore.slot);
    if (!fleet) throw refused();
    fleet.prefix = record.fleet.prefix; fleet.nodes = fleet.nodes.map((node, index) => ({ ...node, id: record.fleet.nodes[index].id }));
    const plan = basePlan(entry, current, policy, project);
    const request = { archive: restore.archive, expectedIdentity: restore.expectedIdentity, slot: restore.slot };
    prepareAppArchiveRestoreRoutes(routeInput(plan, { restore: request }));
    const dataSelection = { currentProfile: current.policy, retainedProfile: retained.policy, profile: policy, ...request };
    await readAppArchiveDataPlan(current.directory, retained.directory, plan.target.config, dataSelection);
    return { ...plan, sources: [current, retained], retained, operation: 'restore-archive', routeRequest: { restore: request }, dataSelection,
      archiveRecord: { id: record.id, identity: record.identity } };
  } catch { throw refused(); }
}
