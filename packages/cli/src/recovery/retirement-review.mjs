import { createHash } from 'node:crypto';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// The input is the verified durable retirement plan, before any target allocation.
// Generated generation IDs and timestamps are deliberately not reservations.
export function retirementReview(plan) {
  const { source, target, entry, retirement, snapshot } = plan;
  const app = source.state.apps[retirement.app];
  const archiveMemberBytes = Object.values(source.manifest.files).reduce((sum, file) => sum + file.bytes, 0);
  if (!Number.isSafeInteger(archiveMemberBytes) || archiveMemberBytes < 0) throw new Error('Retirement snapshot byte accounting is unsupported');
  const view = {
    schema: 1, policy: 'fogd-stopped-retirement-review-v1', operation: 'retire', status: 'review-only',
    source: { project: source.config.name, runtime: entry.id, image: entry.image,
      storageImage: entry.storageImage, identitySha256: runtimePolicyIdentity(source.policy), snapshotSha256: snapshot },
    target: { project: target.config.name, networkSelectionSha256: hash(Object.entries(target.policy.networks || {}).sort()), replacementIdentity: 'fresh-at-execution' },
    application: { name: retirement.app, deployment: app.active, digest: retirement.digest, snapshotRouting: app.route, fleet: app.slot },
    effects: { downtime: 'whole-installation', targetServices: 'stopped', survivingHTTP: 'withheld',
      survivingBackground: 'held-when-declared', stopQueuedWork: retirement.stopQueuedWork,
      stopScheduledWork: retirement.stopScheduledWork, retiredName: 'permanent', replacementName: 'must-differ' },
    capacity: { plannedReleasedFleetSlots: 1, availability: 'after-verified-target-completion', liveAvailableSlots: null, isReservation: false },
    retention: { archiveMemberBytes, appDataBytes: null, diskBytesReclaimed: 0,
      sourceVolumes: 'retained', oldBucketNamespace: 'retained-in-copied-bucket',
      artifacts: 'retained-as-present-in-snapshot', secretRevisions: 'retained-in-private-recovery-data',
      decisionRecords: source.state.decisions?.length || 0, operatorPins: Object.keys(source.state.artifactPins?.releases || {}).length },
    recovery: { independentAppRestore: 'unsupported', olderWholeSnapshot: 'can-resurrect-prior-state', postSnapshotChanges: 'may-be-lost' },
    checks: { snapshotFiles: 'verified', liveSource: 'not-observed', cachedImages: 'not-observed', targetAvailability: 'not-observed' },
  };
  return { ...view, plan: hash(view) };
}

export function assertRetirementReview(plan, expected) {
  if (expected === undefined) return;
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || retirementReview(plan).plan !== expected) {
    throw new Error('Retirement review changed; generate and inspect a fresh plan before retrying');
  }
}
