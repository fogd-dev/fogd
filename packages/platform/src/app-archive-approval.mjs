import { isDeepStrictEqual } from 'node:util';
import { dirname } from 'node:path';
import { authenticatedDecision, decisionReviewToken } from './decision-history.mjs';
import { validateAppArchives } from './app-archive.mjs';
import { validateAppArchiveSnapshot } from './app-archive-routes.mjs';
import { routePolicy } from './route-restoration-plan.mjs';
import { readRouteRecord } from './route-record-store.mjs';
import { verifiedReviewArtifact } from './review-artifact.mjs';
import { validateCronObservation } from './cron-snapshot.mjs';
import { assertRouteEnrollmentTargets } from './route-enrollment.mjs';

const refused = () => Object.assign(new Error('Archive recovery approval is unconfirmed; keep routes and background work held and retain all stores'), { code: 'APP_ARCHIVE_APPROVAL_REFUSED' });
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort());

function selection(controller, profile, input) {
  if (!exact(input, ['archive', 'identity', 'snapshot', 'deployment', 'digest', 'secretRevision'])) throw refused();
  const record = validateAppArchives(controller.state, profile)[input.archive];
  if (record?.status !== 'restored' || record.identity !== input.identity || record.restoration.snapshot !== input.snapshot ||
    record.app.active !== input.deployment || record.digest !== input.digest) throw refused();
  const release = controller.state.deployments[input.deployment], app = controller.state.apps[record.name];
  if (!isDeepStrictEqual(release, record.deployments[input.deployment]) || input.secretRevision !== release.secretRevision ||
    !isDeepStrictEqual(app.resources, record.app.resources) || !isDeepStrictEqual(app.migrations, record.app.migrations)) throw refused();
  return { record, release, app, slot: controller.slots.find(slot => slot.id === app.slot) };
}
async function authority(controller, profile) {
  const expected = routePolicy(profile), routes = controller.routes;
  const slots = profile.fleets.map(({ id, prefix, nodes }) => ({ id, prefix, nodes: nodes.map(node => node.host) }));
  if (!routes.durable || !isDeepStrictEqual(routes.options.policy, expected) || !isDeepStrictEqual(controller.slots, slots)) throw refused();
  await assertRouteEnrollmentTargets(controller.state.routeEnrollment, controller.dir, dirname(routes.options.path));
  const observed = await readRouteRecord(routes.options.path, expected);
  validateAppArchiveSnapshot(controller.state, observed, profile, controller.baseDomain);
  return observed;
}
const migrationKeys = rows => rows.map(({ database, name }) => JSON.stringify([database, name])).sort();
async function migrations(controller, selected) {
  const expected = migrationKeys(selected.app.migrations || []);
  if (!isDeepStrictEqual(expected, migrationKeys(selected.release.migrations || [])) || new Set(expected).size !== expected.length) throw refused();
  const observed = await controller.backend.inspectMigrations(selected.slot, controller.artifact(selected.release.id), selected.release.resources);
  if (!isDeepStrictEqual(expected, migrationKeys(observed))) throw refused();
}
async function heldBackgrounds(controller, { record, app, release, slot }) {
  if (app.delivery) {
    const observed = await controller.backend.queues.snapshot(slot, app.delivery.queue, release.version);
    if (observed?.paused !== true) throw refused();
  }
  if (app.dispatch) {
    const observed = await controller.backend.crons.snapshot(slot, app.dispatch.script, release.version);
    validateCronObservation(observed, release.resources.crons);
    if (observed.revision !== record.app.cronSnapshot.observation.revision) throw refused();
  }
}
async function runtime(controller, selected) {
  if ((await controller.backend.owner(selected.slot))?.app !== selected.record.name) throw refused();
  await controller.routes.options.verifyRuntime(selected.record.name, { id: selected.release.id, digest: selected.release.digest });
  await heldBackgrounds(controller, selected);
}
async function prepare(controller, profile, input, beforeEffects) {
  const selected = selection(controller, profile, input), before = await authority(controller, profile);
  await verifiedReviewArtifact(controller, selected.release.id);
  const secrets = await controller.secrets.select(selected.release, input.secretRevision);
  // Native inspection may materialize a retained cell. A later failure cannot
  // promise that no effect occurred, even though execution remains withheld.
  beforeEffects();
  await runtime(controller, selected);
  await migrations(controller, selected);
  await runtime(controller, selected);
  await verifiedReviewArtifact(controller, selected.release.id);
  const afterSecrets = await controller.secrets.select(selected.release, input.secretRevision);
  const after = await authority(controller, profile);
  if (before.digest !== after.digest || !isDeepStrictEqual(secrets, afterSecrets) ||
    !isDeepStrictEqual(selected, selection(controller, profile, input))) throw refused();
  return selected;
}

// Internal recovery operation, not a startup/admission switch. The caller supplies
// the independently installed profile and an authenticated owner review context.
// It checks retained execution without publishing, applying SQL or materializing
// secrets. The decision and consumed gate share the existing atomic state save.
export function approveAppArchiveRecovery(controller, profile, input, context) {
  return controller.exclusive(async () => {
    try {
      selection(controller, profile, input);
      if (!/^[a-f0-9]{64}$/.test(context?.review)) throw refused();
      const result = await authenticatedDecision(controller, input.deployment, input.digest, 'approve', input.secretRevision, context, async (beforeEffects, decision) => {
        const selected = await prepare(controller, profile, input, beforeEffects);
        if (context.review !== decisionReviewToken(controller, input.deployment)) throw refused();
        selected.record.status = 'recovered';
        selected.record.restoration.decision = decision.id;
        delete selected.app.archiveRecovery;
        return selected.release;
      });
      validateAppArchives(controller.state, profile);
      return { archive: input.archive, identity: input.identity, deployment: result.id, digest: result.digest, state: 'approved', execution: 'held' };
    } catch {
      controller.assertStorage();
      throw refused();
    }
  });
}
