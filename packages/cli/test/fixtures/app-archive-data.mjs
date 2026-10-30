import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile, readFile, cp, lchown, readdir, lstat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { prepareAppArchiveRoutes } from '@fogd/platform/app-archive-routes';
import { routeRecordDigest } from '../../../platform/src/route-record-store.mjs';
import { durableRuntimeConfig, durableLegacyBase } from '../../src/runtime/durable-config.mjs';
import { restoredConfig, fingerprint } from '../../src/recovery/bundle.mjs';
import { sourceBundle } from './durable-recovery.mjs';
import { durableDataTransport, gnuTar } from './durable-data-transport.mjs';

export const generation = '10000000-0000-4000-8000-000000000001', beta = '20000000-0000-4000-8000-000000000002';
export function archiveConfig(config, profile, name) {
  const images = Object.fromEntries(Object.keys(config.services).map(role => [role, role === 'minio' ? profile.storageImage : profile.image]));
  const base = durableLegacyBase(restoredConfig(config, name, images));
  const slots = profile.fleets.map(({ id, prefix, nodes }) => ({ id, prefix, nodes: nodes.map(node => node.host) }));
  for (const role of ['controller', 'workerd']) base.services[role].environment.FOGD_SLOTS = JSON.stringify(slots);
  for (const fleet of profile.fleets) for (const node of fleet.nodes) {
    base.services[node.host].environment.CELLD_NODE = node.id;
    base.services[node.host].environment.CELLD_BUCKET = `s3://${profile.bucket}/${fleet.prefix}`;
  }
  return durableRuntimeConfig(base, profile);
}
async function hostOwnership(path) {
  await lchown(path, process.getuid(), process.getgid());
  if ((await lstat(path)).isDirectory()) for (const name of await readdir(path)) await hostOwnership(join(path, name));
}
export async function packRole(directory, role, source, numericRoot = false) {
  await hostOwnership(source);
  execFileSync(gnuTar, ['--format=gnu', '--numeric-owner', ...(numericRoot ? ['--owner=0', '--group=0'] : []), '-cpf', join(directory, role+'.tar'), '-C', source, '.']);
}
export async function saveManifest(directory, manifest) {
  for (const name of Object.keys(manifest.files)) manifest.files[name] = await fingerprint(join(directory, name));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest)+'\n');
}
function database(path, value) {
  const db = new DatabaseSync(path); db.exec('CREATE TABLE records (value TEXT NOT NULL)'); db.prepare('INSERT INTO records VALUES (?)').run(value); db.close();
}
export function records(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT value FROM records').all().map(row => row.value); } finally { db.close(); }
}
export async function archiveDataFixture(t, entry) {
  const f = await sourceBundle(t);
  if (entry) {
    if (entry.schema === 3) Object.assign(f.policy, { schema: 4, controllerArgs: ['packages/platform/src/main-archive.mjs'] });
    Object.assign(f.policy, { family: entry.id, image: entry.image, storageImage: entry.storageImage, binarySha256: entry.binarySha256, supervisorSha256: entry.supervisorSha256 });
    f.config = archiveConfig(f.config, f.policy, f.config.name);
    f.manifest.images = Object.fromEntries(Object.keys(f.config.services).map(role => [role, role === 'minio' ? f.policy.storageImage : f.policy.image]));
    await writeFile(join(f.dir, 'compose.json'), JSON.stringify(f.config));
  }
  const pack = (directory, role, source) => packRole(directory, role, source, Boolean(entry));
  const retainedDir = f.dir, retainedPolicy = f.policy;
  const bucket = join(f.root, 'retained-bucket'), prefix = `${retainedPolicy.bucket}/${retainedPolicy.fleets[0].prefix}`;
  await mkdir(join(bucket, prefix, 'fogd-owner.json'), { recursive: true });
  await writeFile(join(bucket, prefix, 'fogd-owner.json/xl.meta'), 'retained-alpha-owner');
  await mkdir(join(bucket, prefix, 'cells'), { recursive: true });
  await writeFile(join(bucket, prefix, 'cells/xl.meta'), Buffer.from([0, 255, 1, 42]));
  await pack(retainedDir, 'bucket', bucket);
  const native = {};
  for (const role of ['slot-1-a', 'slot-1-b']) {
    native[role] = join(f.root, 'retained-'+role); await mkdir(native[role]);
    database(join(native[role], 'records.sqlite'), 'alpha-before-archive');
    await pack(retainedDir, role, native[role]);
  }
  await saveManifest(retainedDir, f.manifest);
  const snapshot = (await fingerprint(join(retainedDir, 'manifest.json'))).sha256;
  const currentPolicy = structuredClone(retainedPolicy); currentPolicy.fleets[0].prefix = `archive-generations/${generation}`;
  currentPolicy.fleets[0].nodes = currentPolicy.fleets[0].nodes.map(node => ({ ...node, id: `${node.host}-${generation}` }));
  const routePolicy = policy => ({ installation: runtimePolicyIdentity(policy), slots: ['slot-1', 'slot-2'] });
  const authority = { record: JSON.parse(await readFile(join(f.roots.authority, 'routes.json'))), digest: f.manifest.routeAuthority.sha256 };
  const projected = prepareAppArchiveRoutes({ profile: currentPolicy, sourceProfile: retainedPolicy, source: { state: f.c.state, authority },
    snapshot, binding: 'b'.repeat(64), domain: 'localhost', archive: { app: 'alpha', digest: f.request.digest, id: generation, at: '2026-10-30T02:00:00.000Z' } });
  const currentState = projected.state;
  currentState.apps.beta = { slot: 'slot-1', active: beta, route: 'active', migrations: [] };
  currentState.deployments[beta] = { id: beta, app: 'beta', digest: 'b'.repeat(64), status: 'active', step: 'complete', secretRevision: null };
  const currentRecord = { schema: 1, installation: runtimePolicyIdentity(currentPolicy), revision: '3', routes: [{ host: 'beta.localhost', state: 'active', slot: 'slot-1', submission: beta, digest: 'b'.repeat(64) }] };
  currentState.routeAuthority = { schema: 1, installation: currentRecord.installation, holds: {}, settled: { revision: '3', digest: routeRecordDigest(currentRecord, routePolicy(currentPolicy)) }, pending: null };
  const currentDir = join(f.root, 'current'); await cp(retainedDir, currentDir, { recursive: true });
  const currentConfig = archiveConfig(f.config, currentPolicy, 'fogd-archive-current');
  const controller = join(f.root, 'current-controller'); await cp(f.roots.controller, controller, { recursive: true });
  await writeFile(join(controller, 'state.json'), JSON.stringify(currentState)); await writeFile(join(controller, 'operator-secret.key'), 'current-authority-key');
  const currentAuthority = join(f.root, 'current-authority'); await mkdir(currentAuthority); await writeFile(join(currentAuthority, 'routes.json'), JSON.stringify(currentRecord, null, 2));
  const currentBucket = join(f.root, 'current-bucket'); await cp(bucket, currentBucket, { recursive: true });
  await mkdir(join(currentBucket, currentPolicy.bucket, currentPolicy.fleets[0].prefix), { recursive: true });
  await writeFile(join(currentBucket, currentPolicy.bucket, currentPolicy.fleets[0].prefix, 'beta'), 'beta-after-archive');
  await pack(currentDir, 'bucket', currentBucket); await pack(currentDir, 'controller', controller); await pack(currentDir, 'route-authority', currentAuthority);
  const betaNodes = {};
  for (const role of ['slot-1-a', 'slot-1-b']) {
    betaNodes[role] = join(f.root, 'current-'+role); await mkdir(betaNodes[role]); database(join(betaNodes[role], 'records.sqlite'), 'beta-after-archive');
    await pack(currentDir, role, betaNodes[role]);
  }
  await writeFile(join(currentDir, 'compose.json'), JSON.stringify(currentConfig));
  const manifest = structuredClone(f.manifest); manifest.sourceProject = currentConfig.name;
  manifest.routeAuthority = { schema: 1, installation: currentRecord.installation, revision: '3', sha256: currentState.routeAuthority.settled.digest };
  await saveManifest(currentDir, manifest);
  const profile = structuredClone(currentPolicy); profile.fleets[1].prefix = retainedPolicy.fleets[0].prefix;
  profile.fleets[1].nodes = profile.fleets[1].nodes.map((node, index) => ({ ...node, id: retainedPolicy.fleets[0].nodes[index].id }));
  const config = archiveConfig(currentConfig, profile, 'fogd-archive-restored'), volumes = {}, calls = [];
  for (const role of Object.keys(config.volumes)) { volumes[role] = join(f.root, 'target-'+role); await mkdir(volumes[role]); }
  await chmod(volumes.controller, 0o700);
  await writeFile(join(volumes.controller, 'state.json'), '{"fresh":true}');
  for (const path of Object.values(volumes)) await hostOwnership(path);
  const selection = { currentProfile: currentPolicy, retainedProfile: retainedPolicy, profile, archive: generation, expectedIdentity: currentState.appArchives.records[generation].identity, slot: 'slot-2' };
  return { ...f, retainedDir, currentDir, config, selection, volumes, calls, manifest, currentState, controller, currentBucket,
    readVolume: durableDataTransport(config, profile, volumes, calls) };
}
