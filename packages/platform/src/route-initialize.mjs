import { join } from 'node:path';
import { routeRecordFilename } from '@fogd/runtime/route-record';
import { spendRouteEnrollment } from './route-enrollment.mjs';
import { RoutePublication } from './route-publication.mjs';
import { storageFailureDiagnostic } from './store.mjs';
import { writeAtomicFile } from './atomic-file.mjs';

// Dedicated stopped initialization, with no listener, backend command, secret
// materialization or gateway launch. Ordinary controller startup never calls it.
// The optional publisher is a trusted I/O seam, never selected by enrollment JSON.
export async function initializeRouteEnrollment(input, { createPublic } = {}) {
  if (createPublic !== undefined && typeof createPublic !== 'function') throw new Error('Invalid trusted initialization publisher');
  const grant = await spendRouteEnrollment(input);
  try {
    const state = { apps: {}, deployments: {}, routeEnrollment: { controller: grant.targets.controller, authority: grant.targets.authority } }, policy = { installation: grant.installation, slots: grant.profile.fleets.map(fleet => fleet.id) };
    const statePath = join(grant.targets.controller.path, 'state.json'); let first = true;
    const publication = new RoutePublication({ state, policy, createPublic: createPublic && ((path, record) => createPublic(path, record, policy)), path: join(grant.targets.authority.path, routeRecordFilename), domain: 'localhost',
      async savePrivate() {
        await writeAtomicFile(statePath, JSON.stringify(state, null, 2), { createOnly: first, createDirectory: false }); first = false;
      } });
    await publication.initialize();
    return { id: grant.id, installation: grant.installation, binding: grant.binding, revision: state.routeAuthority.settled.revision, sha256: state.routeAuthority.settled.digest };
  } catch (error) {
    throw Object.assign(new Error('Route initialization is uncertain after spending enrollment; keep ingress stopped and retain all stores. Recover a retained initialization intent if present; otherwise require independently fresh enrollment'),
      { code: 'ROUTE_INITIALIZATION_UNCERTAIN', diagnostic: storageFailureDiagnostic(error.cause || error) });
  }
}
