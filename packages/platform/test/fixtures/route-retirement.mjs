import { runtimePolicyIdentity } from '../../src/runtime-policy.mjs';
import { routeRecordDigest } from '../../src/route-record-store.mjs';
import { policy as nativePolicy } from './runtime-policy.mjs';

export const retirementId = '10000000-0000-4000-8000-000000000001';
export const alphaId = '20000000-0000-4000-8000-000000000001';
export const betaId = '20000000-0000-4000-8000-000000000002';
export const alphaDigest = 'e'.repeat(64), betaDigest = 'f'.repeat(64);
export function retirementRequest() {
  const sourceProfile = { ...nativePolicy(), schema: 3, routing: 'durable', controllerArgs: ['packages/platform/src/main-durable.mjs'] };
  const profile = structuredClone(sourceProfile);
  profile.fleets[0].prefix = `retirement-generations/${retirementId}`;
  profile.fleets[0].nodes = [{ host: 'slot-1-a', id: `slot-1-a-${retirementId}` }, { host: 'slot-1-b', id: `slot-1-b-${retirementId}` }];
  const state = { requirements: ['fogd-route-authority-v1'],
    apps: { alpha: { active: alphaId, slot: 'slot-1', route: 'active', migrations: [] }, beta: { active: betaId, slot: 'slot-2', route: 'active', migrations: [] } },
    deployments: {
      [alphaId]: { id: alphaId, app: 'alpha', digest: alphaDigest, status: 'active', step: 'complete', secretRevision: null },
      [betaId]: { id: betaId, app: 'beta', digest: betaDigest, status: 'active', step: 'complete', secretRevision: null },
    } };
  const record = { schema: 1, installation: runtimePolicyIdentity(sourceProfile), revision: '4', routes: [
    { host: 'alpha.localhost', state: 'active', slot: 'slot-1', submission: alphaId, digest: alphaDigest },
    { host: 'beta.localhost', state: 'active', slot: 'slot-2', submission: betaId, digest: betaDigest },
  ] };
  const digest = routeRecordDigest(record, { installation: record.installation, slots: ['slot-1', 'slot-2'] });
  state.routeAuthority = { schema: 1, installation: record.installation, holds: {}, settled: { revision: '4', digest }, pending: null };
  const snapshot = 'c'.repeat(64);
  return { sourceProfile, profile, source: { state, authority: { record, digest } }, snapshot, binding: 'b'.repeat(64), domain: 'localhost',
    retirement: { app: 'alpha', digest: alphaDigest, stopQueuedWork: false, stopScheduledWork: false,
      evidence: { id: retirementId, at: '2026-10-24T00:00:00.000Z', app: 'alpha', digest: alphaDigest, snapshot: { sha256: snapshot },
        previous: { slot: 'slot-1', prefix: 'slots/slot-1', nodes: ['slot-1-a', 'slot-1-b'] },
        replacement: { prefix: `retirement-generations/${retirementId}`, nodes: [`slot-1-a-${retirementId}`, `slot-1-b-${retirementId}`] },
        runtimeSelection: { family: sourceProfile.family, sourceIdentitySha256: runtimePolicyIdentity(sourceProfile), targetIdentitySha256: runtimePolicyIdentity(profile) } } } };
}
