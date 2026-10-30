import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { projectAppArchiveRestore } from '@fogd/platform/app-archive';
import { durableRuntimeConfig } from '../runtime/durable-config.mjs';
import { verifyAppArchiveBundle } from './durable-bundle.mjs';
import { fingerprint } from './bundle.mjs';
import { tarNamespace } from './tar-namespace.mjs';
import { restoreDurableData } from './durable-restore-data.mjs';

const refused = () => Object.assign(new Error('App archive data restoration is unconfirmed; keep all writers and the destination stopped and retain both snapshots and every target volume'), { code: 'APP_ARCHIVE_DATA_UNCONFIRMED' });
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value) && isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort());
async function snapshot(directory) {
  const path = join(directory, 'manifest.json');
  if (!(await lstat(path)).isFile()) throw refused();
  return fingerprint(path);
}
function selectedArchive(current, selection) {
  if (!exact(selection, ['currentProfile', 'retainedProfile', 'profile', 'archive', 'expectedIdentity', 'slot']) || !hex(selection.expectedIdentity)) throw refused();
  const record = current.state.appArchives?.records[selection.archive];
  if (!record || record.status !== 'archived' || record.identity !== selection.expectedIdentity) throw refused();
  return record;
}
function retainedBinding(retained, record, policy, manifest) {
  if (manifest.sha256 !== record.snapshot || runtimePolicyIdentity(policy) !== record.source.identity ||
    policy.family !== record.source.family || policy.image !== record.source.image || policy.storageImage !== record.source.storageImage) throw refused();
  if (!isDeepStrictEqual(retained.state.apps[record.name], record.app) || !isDeepStrictEqual(policy.fleets.find(fleet => fleet.id === record.fleet.id), record.fleet)) throw refused();
  const releases = Object.fromEntries(Object.entries(retained.state.deployments).filter(([, release]) => release.app === record.name));
  if (!isDeepStrictEqual(releases, record.deployments)) throw refused();
}
function destination(config, policy, current, retained) {
  if (!isDeepStrictEqual(config, durableRuntimeConfig(config, policy)) || [current.config.name, retained.config.name].includes(config.name)) throw refused();
  const sourceVolumes = new Set([...Object.values(current.config.volumes), ...Object.values(retained.config.volumes)].map(volume => volume.name));
  if (Object.values(config.volumes).some(volume => sourceVolumes.has(volume.name))) throw refused();
}
async function namespaceBinding(currentDir, retainedDir, current, retained, record) {
  const name = `${record.source.bucket}/${record.fleet.prefix}`;
  const old = await tarNamespace(join(retainedDir, 'bucket.tar'), name, retained.manifest.files['bucket.tar']);
  const latest = await tarNamespace(join(currentDir, 'bucket.tar'), name, current.manifest.files['bucket.tar']);
  if (!isDeepStrictEqual(latest, old) || !old.members.some(member => member.path === 'fogd-owner.json/xl.meta' && member.type === 'file')) throw refused();
  return { members: old.members.length, bytes: old.members.reduce((sum, member) => sum + member.bytes, 0) };
}

// Host planning only. Profiles and the reviewed archive identity are supplied
// independently; snapshots cannot select them. No Docker or target access here.
export async function readAppArchiveDataPlan(currentDirectory, retainedDirectory, config, selection) {
  try {
    const currentDir = resolve(currentDirectory), retainedDir = resolve(retainedDirectory);
    const before = await snapshot(currentDir), current = await verifyAppArchiveBundle(currentDir, selection.currentProfile);
    const record = selectedArchive(current, selection), original = await snapshot(retainedDir);
    const retained = await verifyAppArchiveBundle(retainedDir, selection.retainedProfile, Date.parse(record.at));
    retainedBinding(retained, record, selection.retainedProfile, original);
    const currentReleases = Object.keys(current.state.deployments).filter(id => current.state.deployments[id].app === record.name).sort();
    if (!isDeepStrictEqual(currentReleases, Object.keys(record.deployments).sort())) throw refused();
    const projected = projectAppArchiveRestore({ state: current.state, sourceProfile: selection.currentProfile, profile: selection.profile,
      snapshot: before.sha256, archive: selection.archive, expectedIdentity: selection.expectedIdentity, slot: selection.slot });
    destination(config, selection.profile, current, retained);
    const evidence = await namespaceBinding(currentDir, retainedDir, current, retained, record);
    if (!isDeepStrictEqual(await snapshot(currentDir), before) || !isDeepStrictEqual(await snapshot(retainedDir), original)) throw refused();
    const fleet = selection.profile.fleets.find(fleet => fleet.id === selection.slot);
    const roles = Object.fromEntries(fleet.nodes.map((node, index) => [node.host, record.fleet.nodes[index].host]));
    return { currentDir, retainedDir, current, retained, projected, currentSnapshot: before.sha256, retainedSnapshot: original.sha256,
      archiveIdentity: record.identity, namespace: evidence, replicaSources: { directory: retainedDir, roles } };
  } catch { throw refused(); }
}

// Internal step only after the coordinator proves stopped/excluded writers,
// verified runtime images and fresh stopped target enrollment. It keeps current
// bucket/controller/peer data, and substitutes only the archived replica disks.
// Failed copies remain stopped and untouched; nothing is retried or cleaned up.
export async function restoreAppArchiveData(currentDirectory, retainedDirectory, config, selection, options = {}) {
  try {
    const plan = await readAppArchiveDataPlan(currentDirectory, retainedDirectory, config, selection);
    const copied = await restoreDurableData(plan.currentDir, config, selection.profile, { readVolume: options.readVolume, replicaSources: plan.replicaSources });
    const after = await readAppArchiveDataPlan(currentDirectory, retainedDirectory, config, selection);
    if (after.currentSnapshot !== plan.currentSnapshot || after.retainedSnapshot !== plan.retainedSnapshot || after.archiveIdentity !== plan.archiveIdentity ||
      !isDeepStrictEqual(after.namespace, plan.namespace) || !isDeepStrictEqual(after.projected, plan.projected)) throw refused();
    return { archiveIdentity: plan.archiveIdentity, currentSnapshot: plan.currentSnapshot, retainedSnapshot: plan.retainedSnapshot,
      retainedNamespace: plan.namespace, replicaRoles: Object.keys(plan.replicaSources.roles), copiedRoles: copied.roles, bucket: 'current-snapshot', services: 'stopped' };
  } catch { throw refused(); }
}
