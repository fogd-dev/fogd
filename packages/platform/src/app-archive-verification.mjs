import { isDeepStrictEqual } from 'node:util';
import { dirname } from 'node:path';
import { validateAppArchives } from './app-archive.mjs';
import { validateAppArchiveSnapshot } from './app-archive-routes.mjs';
import { routePolicy } from './route-restoration-plan.mjs';
import { readRouteRecord } from './route-record-store.mjs';
import { validateCronObservation } from './cron-snapshot.mjs';
import { assertRouteEnrollmentTargets } from './route-enrollment.mjs';

const refused = () => Object.assign(new Error('Archive recovery verification is unconfirmed; keep execution held and retain all stores'), { code: 'APP_ARCHIVE_APPROVAL_REFUSED' });
export function selectArchiveRecovery(controller, profile, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join() !== 'archive,deployment,digest,identity,secretRevision,snapshot') throw refused();
  const record = validateAppArchives(controller.state, profile)[input.archive];
  if (record?.status !== 'restored' || record.identity !== input.identity || record.restoration.snapshot !== input.snapshot ||
    record.app.active !== input.deployment || record.digest !== input.digest) throw refused();
  const release = controller.state.deployments[input.deployment], app = controller.state.apps[record.name];
  if (!isDeepStrictEqual(release, record.deployments[input.deployment]) || !isDeepStrictEqual(app.resources, record.app.resources) ||
    !isDeepStrictEqual(app.migrations, record.app.migrations)) throw refused();
  return { record, release, app, slot: controller.slots.find(slot => slot.id === app.slot) };
}
export async function verifyArchiveAuthority(controller, profile) {
  const expected = routePolicy(profile), routes = controller.routes;
  const slots = profile.fleets.map(({ id, prefix, nodes }) => ({ id, prefix, nodes: nodes.map(node => node.host) }));
  if (!routes.durable || !isDeepStrictEqual(routes.options.policy, expected) || !isDeepStrictEqual(controller.slots, slots)) throw refused();
  await assertRouteEnrollmentTargets(controller.state.routeEnrollment, controller.dir, dirname(routes.options.path));
  const observed = await readRouteRecord(routes.options.path, expected);
  validateAppArchiveSnapshot(controller.state, observed, profile, controller.baseDomain);
  return observed;
}
const migrationKeys = rows => rows.map(({ database, name }) => JSON.stringify([database, name])).sort();
export async function inspectArchiveMigrations(controller, selected) {
  const expected = migrationKeys(selected.app.migrations || []);
  if (!isDeepStrictEqual(expected, migrationKeys(selected.release.migrations || [])) || new Set(expected).size !== expected.length) throw refused();
  const observed = await controller.backend.inspectMigrations(selected.slot, controller.artifact(selected.release.id), selected.release.resources);
  if (!isDeepStrictEqual(expected, migrationKeys(observed))) throw refused();
}
export async function inspectArchiveBackgrounds(controller, { record, app, release, slot }, version = release.version) {
  if (app.delivery && (await controller.backend.queues.snapshot(slot, app.delivery.queue, version))?.paused !== true) throw refused();
  if (app.dispatch) {
    const observed = await controller.backend.crons.snapshot(slot, app.dispatch.script, version);
    validateCronObservation(observed, release.resources.crons);
    if (observed.revision !== record.app.cronSnapshot.observation.revision) throw refused();
  }
}
