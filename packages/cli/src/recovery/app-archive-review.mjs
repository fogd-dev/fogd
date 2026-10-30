import { createHash } from 'node:crypto';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function snapshotView(source, role) {
  const archiveMemberBytes = Object.values(source.manifest.files).reduce((sum, file) => sum + file.bytes, 0);
  if (!Number.isSafeInteger(archiveMemberBytes) || archiveMemberBytes < 0) throw new Error('Archive snapshot byte accounting is unsupported');
  return { role, project: source.config.name, identitySha256: runtimePolicyIdentity(source.policy), snapshotSha256: source.snapshot, archiveMemberBytes };
}

// Verified plan only. Generated archive/gate IDs are not reserved by a review.
// Private configuration, vault pins, native identities and namespaces stay out.
export function appArchiveReview(plan) {
  const archiving = plan.operation === 'archive';
  if (!archiving && plan.operation !== 'restore-archive') throw new Error('Unsupported archive review operation');
  const request = plan.routeRequest[archiving ? 'archive' : 'restore'];
  const record = archiving ? null : plan.source.state.appArchives.records[request.archive];
  const name = archiving ? request.app : record.name, app = archiving ? plan.source.state.apps[name] : record.app;
  const deployment = plan.source.state.deployments[app.active];
  const view = {
    schema: 1, policy: 'fogd-stopped-app-archive-review-v1', operation: plan.operation, status: 'review-only',
    runtime: { family: plan.entry.id, image: plan.entry.image, storageImage: plan.entry.storageImage },
    sources: [snapshotView(plan.source, 'current'), ...(plan.retained ? [snapshotView(plan.retained, 'retained')] : [])],
    target: { project: plan.target.config.name, networkSelectionSha256: hash(Object.entries(plan.target.policy.networks || {}).sort()),
      storageIdentity: archiving ? 'fresh-at-execution' : runtimePolicyIdentity(plan.target.policy) },
    application: { name, deployment: app.active, digest: deployment.digest, sourceFleet: app.slot,
      targetFleet: archiving ? null : request.slot },
    archive: archiving ? { identity: 'fresh-at-execution' } : { id: record.id, identity: record.identity, retainedSnapshotSha256: record.snapshot },
    effects: { downtime: 'whole-installation', targetServices: 'stopped', survivingHTTP: 'withheld', survivingBackground: 'held-when-declared',
      archivedName: 'reserved', restoredExecution: 'requires-owner-approval', backgroundRecovery: 'requires-separate-acknowledgment-and-resume' },
    capacity: { plannedFleetSlotDelta: archiving ? 1 : -1, availability: 'after-verified-target-completion', liveAvailableFleetSlots: null, isReservation: false },
    retention: { diskBytesReclaimed: 0, appDataBytes: null, sourceVolumes: 'retained', bucketData: 'retained',
      artifacts: 'retained-as-present-in-snapshots', secretRevisions: 'private-recovery-data', credentials: 'current-snapshot-governs',
      originalSnapshot: 'required-for-later-app-restoration' },
    checks: { snapshotFiles: 'verified', liveSources: 'not-observed', cachedImages: 'not-observed', targetAvailability: 'not-observed' },
  };
  return { ...view, plan: hash(view) };
}

export function assertAppArchiveReview(plan, expected) {
  if (expected === undefined) return;
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || appArchiveReview(plan).plan !== expected) {
    throw new Error('Archive review changed; generate and inspect a fresh plan before retrying');
  }
}
