import { createReadStream } from 'node:fs';
import { readFile, open, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateFleetStorage, validateNetworks, validateMounts } from './layout-validation.mjs';
import { recoveryLayout } from './layout.mjs';

export async function fingerprint(path) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('Expected a regular backup file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { bytes: info.size, sha256: hash.digest('hex') };
}
export async function writeJson(path, data) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(data, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  const parent = await open(join(path, '..'), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}
export async function readJson(path) {
  const input = await readFile(path, 'utf8');
  try { return JSON.parse(input); }
  catch { throw new Error('Unreadable backup JSON; no configuration values are displayed'); }
}
export function validateTopology(config) {
  const { services, fleets, replicas, volumes } = recoveryLayout(config);
  if (!isDeepStrictEqual(Object.keys(config.services || {}).sort(), services) || !isDeepStrictEqual(Object.keys(config.volumes || {}).sort(), volumes)) throw new Error('Backup supports only the local two-slot Compose topology');
  if (config.services.controller.environment.S3_ENDPOINT !== 'http://minio:9000') throw new Error('External bucket backup is unsupported');
  for (const service of Object.values(config.services)) {
    for (const mount of service.volumes || []) {
      if (mount.type !== 'volume' || !volumes.includes(mount.source)) throw new Error('Only managed named volumes can be backed up');
    }
  }
  validateFleetStorage(config, fleets);
  validateNetworks(config, fleets);
  validateMounts(config, replicas);
  if (Object.values(config.volumes).some(v => v.external) || Object.values(config.networks).some(n => n.external)) throw new Error('External Docker resources are unsupported');
}
export function restoredConfig(config, project, images) {
  const result = structuredClone(config); result.name = project;
  for (const [name, service] of Object.entries(result.services)) {
    delete service.build; service.image = images[name]; service.pull_policy = 'never';
  }
  for (const [name, volume] of Object.entries(result.volumes)) volume.name = `${project}_${name}`;
  for (const [name, network] of Object.entries(result.networks)) network.name = `${project}_${name}`;
  return result;
}
// Compose interpolates even JSON strings; escape a resolved literal exactly once.
export const composeResolved = value => typeof value === 'string' ? value.replaceAll('$$', '$') : Array.isArray(value) ? value.map(composeResolved) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, composeResolved(v)])) : value;
export const composeLiteral = value => typeof value === 'string' ? value.replaceAll('$', () => '$$') : Array.isArray(value) ? value.map(composeLiteral) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, composeLiteral(v)])) : value;
export async function verifyBundle(dir) {
  const manifest = await readJson(join(dir, 'manifest.json'));
  if (manifest.format !== 'fogd-stopped-v1' || !manifest.files?.['compose.json']) throw new Error('Incomplete or unsupported backup manifest');
  if (!isDeepStrictEqual(await fingerprint(join(dir, 'compose.json')), manifest.files['compose.json'])) throw new Error('Backup checksum mismatch: compose.json');
  const config = await readJson(join(dir, 'compose.json')); validateTopology(config);
  const { archives, services } = recoveryLayout(config);
  if (!isDeepStrictEqual(Object.keys(manifest.files).sort(), archives)) throw new Error('Incomplete backup volume inventory does not match configuration');
  for (const name of archives.filter(name => name !== 'compose.json')) {
    if (!isDeepStrictEqual(await fingerprint(join(dir, name)), manifest.files[name])) throw new Error(`Backup checksum mismatch: ${name}`);
  }
  if (!isDeepStrictEqual(Object.keys(manifest.images || {}).sort(), services) || Object.values(manifest.images).some(image => !/^sha256:[a-f0-9]{64}$/.test(image))) throw new Error('Invalid backup image identities');
  return { manifest, config };
}
