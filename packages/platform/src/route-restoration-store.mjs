import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { routeRecordFilename } from '@fogd/runtime/route-record';
import { spendRouteRestoration } from './route-enrollment.mjs';
import { routeAuthorityCapability } from './route-publication.mjs';
import { readRouteRecord, routeRecordDigest, writeRouteRecord } from './route-record-store.mjs';
import { writeAtomicFile } from './atomic-file.mjs';
import { routePolicy } from './route-restoration-plan.mjs';

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const refused = () => Object.assign(new Error('Route restoration requires a verified source, matching durable profiles and an exactly fresh enrolled target; keep ingress stopped and retain all stores'), { code: 'ROUTE_RESTORATION_REFUSED' });
const uncertain = () => Object.assign(new Error('Route restoration is uncertain after spending its marker; keep ingress stopped, retain all stores and require independent repair or a fresh target'), { code: 'ROUTE_RESTORATION_UNCERTAIN' });

async function privateJson(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.geteuid() || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_STATE_BYTES) throw refused();
    const buffer = Buffer.alloc(stat.size), { bytesRead } = await file.read(buffer, 0, stat.size, 0);
    if (bytesRead !== stat.size) throw refused();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } finally { await file.close(); }
}
// Only the exact stores written by initializeFreshRouteStores qualify. Restored
// controller data files may sit beside state.json; nothing else may differ.
async function assertFreshlyInitialized({ installation, targets }, policy) {
  const record = { schema: 1, installation, revision: '0', routes: [] }, digest = routeRecordDigest(record, policy);
  if (!isDeepStrictEqual(await readdir(targets.authority.path), [routeRecordFilename])) throw refused();
  const observed = await readRouteRecord(join(targets.authority.path, routeRecordFilename), policy);
  if (observed?.digest !== digest || !isDeepStrictEqual(observed.record, record)) throw refused();
  const expected = { apps: {}, deployments: {}, routeEnrollment: { controller: targets.controller, authority: targets.authority }, requirements: [routeAuthorityCapability],
    routeAuthority: { schema: 1, installation, holds: {}, settled: { revision: '0', digest }, pending: null } };
  if (!isDeepStrictEqual(await privateJson(join(targets.controller.path, 'state.json')), expected)) throw refused();
}

// A trusted projection supplies the metadata. This writer alone spends the fresh
// enrollment grant and confirms both stores. The caller must first prove stopped
// writers, verified archives and terminal copy helpers; no listener starts here.
export async function restoreRouteStores(input, project, { controller = '/var/lib/fogd', authority = '/var/lib/fogd-routes', enrollment = '/var/lib/fogd-enrollment', writePrivate = writeAtomicFile, writePublic = writeRouteRecord } = {}) {
  let projected, policy, grant;
  try {
    if (typeof writePrivate !== 'function' || typeof writePublic !== 'function' || ![controller, authority, enrollment].every(path => typeof path === 'string' && isAbsolute(path))) throw refused();
    projected = project(input); policy = routePolicy(input.profile);
    grant = await spendRouteRestoration({ profile: input.profile, binding: input.binding, snapshot: input.snapshot, controller, authority, enrollment }, target => assertFreshlyInitialized(target, policy));
  } catch (error) { throw error.code === 'ROUTE_ENROLLMENT_UNCERTAIN' ? uncertain() : refused(); }
  try {
    const statePath = join(grant.targets.controller.path, 'state.json'), recordPath = join(grant.targets.authority.path, routeRecordFilename);
    const state = { ...projected.state, routeEnrollment: { controller: grant.targets.controller, authority: grant.targets.authority } };
    await writePrivate(statePath, JSON.stringify(state, null, 2), { createDirectory: false });
    await writePublic(recordPath, projected.record, policy);
    const saved = await privateJson(statePath), observed = await readRouteRecord(recordPath, policy);
    if (!isDeepStrictEqual(saved, state) || observed?.digest !== state.routeAuthority.settled.digest || !isDeepStrictEqual(observed.record, projected.record)) throw uncertain();
    return { id: grant.id, installation: grant.installation, binding: grant.binding, snapshot: input.snapshot, revision: '1', sha256: observed.digest };
  } catch { throw uncertain(); }
}
