import { assertArtifactSnapshotReady } from './artifact-prune-state.mjs';
import { isDeepStrictEqual } from 'node:util';
import { encodeRouteRecord } from '@fogd/runtime/route-record';
import { routeRecordDigest } from './route-record-store.mjs';
import { routeAuthorityJournal } from './route-publication.mjs';
import { routeStateApplications } from './route-preflight.mjs';
import { validateRetirementState } from './retirement.mjs';
import { hasDurableRuntimeMode, runtimePolicyIdentity, validateRuntimePolicy } from './runtime-policy.mjs';
export { routeAuthorityCapability } from './route-publication.mjs';

const refused = () => Object.assign(new Error('Route source snapshot is inconsistent; keep the installation stopped'), { code: 'ROUTE_SNAPSHOT_REFUSED' });
const exact = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

// Proves that a private controller state and an observed public record (as returned
// by readRouteRecord) form one settled, consistent source pair for a durable
// profile. It reads nothing and proves nothing about mounts or native runtimes.
export function validateRouteSnapshot(state, observed, profile, domain = 'localhost') {
  try {
    assertArtifactSnapshotReady(state);
    const expected = validateRuntimePolicy(profile);
    if (!hasDurableRuntimeMode(expected)) throw refused();
    const policy = { installation: runtimePolicyIdentity(expected), slots: expected.fleets.map(fleet => fleet.id) };
    if (!exact(observed, ['record', 'digest']) || typeof observed.digest !== 'string' || !/^[a-f0-9]{64}$/.test(observed.digest)) throw refused();
    const { record, digest } = observed;
    if (!isDeepStrictEqual(JSON.parse(encodeRouteRecord(record, policy)), record) || routeRecordDigest(record, policy) !== digest) throw refused();
    const journal = routeAuthorityJournal(state, policy);
    if (journal.pending !== null || journal.settled?.revision !== record.revision || journal.settled.digest !== digest) throw refused();
    validateRetirementState(state, expected.fleets, { durableRoutes: true });
    routeStateApplications(state, record, domain);
    return { schema: 1, installation: policy.installation, revision: record.revision, sha256: digest };
  } catch { throw refused(); }
}
