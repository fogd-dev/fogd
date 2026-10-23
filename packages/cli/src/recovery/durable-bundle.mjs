import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { decodeRouteRecord, encodeRouteRecord, maxRouteRecordBytes, routeRecordFilename } from '@fogd/runtime/route-record';
import { validateRouteSnapshot } from '@fogd/platform/route-snapshot';
import { durableRuntimeConfig, durableLegacyBase, routeAuthorityVolume, gatewayPolicyVolume, routeEnrollmentVolume } from '../runtime/durable-config.mjs';
import { fingerprint, readJson, validateTopology } from './bundle.mjs';
import { projectName } from './docker.mjs';
import { execute } from './execute.mjs';
import { recoveryLayout } from './layout.mjs';
import { snapshotState } from './snapshot-state.mjs';
import { validateBackgroundEvidence } from './background-backup.mjs';

export const durableSnapshotFormat = 'fogd-stopped-durable-v1';
const refused = () => Object.assign(new Error('Durable stopped snapshot is invalid or does not match the independently provided profile; no snapshot values are displayed'), { code: 'DURABLE_BUNDLE_REFUSED' });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Execution authority (runtime-policy, gateway-policy, route-enrollment) is
// declared but never archived; it is derived independently on restore.
export function durableSnapshotLayout(config, profile) {
  if (!isDeepStrictEqual(config, durableRuntimeConfig(config, profile))) throw refused();
  const base = durableLegacyBase(config); validateTopology(base);
  const { replicas, services, volumes: legacy, archiveVolumes: data } = recoveryLayout(base);
  const archiveVolumes = [...data, routeAuthorityVolume].sort();
  const volumes = [...legacy, routeAuthorityVolume, gatewayPolicyVolume, routeEnrollmentVolume].sort();
  if (!isDeepStrictEqual(Object.keys(config.volumes).sort(), volumes) || !isDeepStrictEqual(Object.keys(config.services).sort(), services)) throw refused();
  return { replicas, services, volumes, archiveVolumes, archives: ['compose.json', 'images.tar', ...archiveVolumes.map(name => `${name}.tar`)].sort() };
}

async function regularFingerprint(path) {
  if (!(await lstat(path)).isFile()) throw refused();
  return fingerprint(path);
}
async function checkFingerprints(directory, files, names) {
  for (const name of names) {
    if (!isDeepStrictEqual(await regularFingerprint(join(directory, name)), files[name])) throw refused();
  }
}

// Read the one canonical public record member without extracting the archive.
async function archivedRouteRecord(directory, policy) {
  const file = join(directory, `${routeAuthorityVolume}.tar`);
  const entries = (await execute('tar', ['-tf', file])).trimEnd().split('\n').filter(name => posix.normalize(name) === routeRecordFilename);
  if (entries.length !== 1 || ![routeRecordFilename, `./${routeRecordFilename}`].includes(entries[0])) throw refused();
  const metadata = await execute('tar', ['-tvf', file, '--', entries[0]], { maxOutputBytes: 4096 });
  if (!metadata.startsWith('-') || metadata.trimEnd().split('\n').length !== 1) throw refused();
  const text = await execute('tar', ['-xOf', file, '--', entries[0]], { maxOutputBytes: maxRouteRecordBytes });
  if (text.length > maxRouteRecordBytes || !/^[\x20-\x7e\n]*$/.test(text)) throw refused();
  const value = decodeRouteRecord(text, policy);
  if (encodeRouteRecord(value, policy) !== text) throw refused();
  return { record: value, digest: createHash('sha256').update(text).digest('hex') };
}

export async function verifyDurableBundle(directory, profile) {
  try {
    const manifestPath = join(directory, 'manifest.json');
    if (!(await lstat(manifestPath)).isFile()) throw refused();
    const manifest = await readJson(manifestPath);
    if (!record(manifest) || manifest.format !== durableSnapshotFormat || !record(manifest.files) || !record(manifest.images)) throw refused();
    if (!isDeepStrictEqual(await regularFingerprint(join(directory, 'compose.json')), manifest.files['compose.json'])) throw refused();
    const config = await readJson(join(directory, 'compose.json'));
    const { services, archives } = durableSnapshotLayout(config, profile);
    if (manifest.sourceProject !== projectName(config.name) || !isDeepStrictEqual(Object.keys(manifest.files).sort(), archives)) throw refused();
    await checkFingerprints(directory, manifest.files, archives);
    const images = Object.fromEntries(services.map(name => [name, name === 'minio' ? profile.storageImage : profile.image]));
    if (!isDeepStrictEqual(manifest.images, images)) throw refused();
    const state = await snapshotState(directory);
    validateBackgroundEvidence(state, manifest, Date.now(), profile);
    const authority = await archivedRouteRecord(directory, { installation: runtimePolicyIdentity(profile), slots: profile.fleets.map(fleet => fleet.id) });
    const domain = config.services.controller.environment.FOGD_BASE_DOMAIN || 'localhost';
    if (!isDeepStrictEqual(manifest.routeAuthority, validateRouteSnapshot(state, authority, profile, domain))) throw refused();
    // Bind interpreted metadata to its checksums again after parsing and tar reads.
    await checkFingerprints(directory, manifest.files, ['compose.json', 'controller.tar', `${routeAuthorityVolume}.tar`]);
    return { manifest, config, state, authority };
  } catch { throw refused(); }
}
