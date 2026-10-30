import { selectArchiveRecovery, verifyArchiveAuthority as authority, inspectArchiveMigrations as migrations, inspectArchiveBackgrounds as heldBackgrounds } from './app-archive-verification.mjs';
import { isDeepStrictEqual } from 'node:util';
import { authenticatedDecision, decisionReviewToken } from './decision-history.mjs';
import { validateAppArchives } from './app-archive.mjs';
import { verifiedReviewArtifact } from './review-artifact.mjs';

const refused = () => Object.assign(new Error('Archive recovery approval is unconfirmed; keep routes and background work held and retain all stores'), { code: 'APP_ARCHIVE_APPROVAL_REFUSED' });
function selection(controller, profile, input) {
  const selected = selectArchiveRecovery(controller, profile, input);
  if (selected.app.archiveRecovery?.rotation || input.secretRevision !== selected.release.secretRevision) throw refused();
  return selected;
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
