import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { hash, jsonBytes, digest, uuid } from '../build-cache/paths.mjs';
import { executionKeys, executionSource, executionRuntime, executionPolicy, executionTarget, executionTimestamp, refuseExecution } from './execution-shape.mjs';
import { signPreviewExecution, verifyPreviewExecution, previewExecutionSha256 } from './execution-authority.mjs';

export function validatePreviewPreparation(input, expectedSha256) {
  executionKeys(input, ['schema', 'kind', 'id', 'status', 'preparedAt', 'source', 'runtime', 'policy', 'executionAuthorized', 'capacityReserved', 'scope']);
  if (input.schema !== 1 || input.kind !== 'fogd-preview-preparation' || input.status !== 'prepared' || input.executionAuthorized !== false || input.capacityReserved !== false ||
    !uuid(input.id) || !digest(expectedSha256) || hash(jsonBytes(input)) !== expectedSha256 || typeof input.scope !== 'string' || input.scope.length > 512) refuseExecution();
  executionSource(input.source); executionRuntime(input.runtime); executionPolicy(input.policy);
  if (executionTimestamp(input.preparedAt) > Date.now()) refuseExecution();
}

export function validatePreviewRelease(preparation, release) {
  if (release?.app !== preparation.source.app || release.digest !== preparation.source.digest || !isDeepStrictEqual(release.requiredSecrets, preparation.policy.requiredSecrets)) refuseExecution();
  executionKeys(release.resources, ['script', 'durable', 'd1', 'r2']);
  if (release.resources.script !== preparation.source.app) refuseExecution();
  executionKeys(release.resources.durable, ['bindings']);
  if (![release.resources.d1, release.resources.r2, release.resources.durable.bindings].every(Array.isArray) || release.resources.durable.bindings.length) refuseExecution();
}

// Internal owner decision only. The coordinator must first verify artifact bytes,
// source state, catalog admission and target freshness independently. This does
// not allocate a target, start a process or approve anything on the source.
export function issuePreviewExecution(preparation, { expectedPreparationSha256, release, target, privateKey }) {
  try {
    validatePreviewPreparation(preparation, expectedPreparationSha256); validatePreviewRelease(preparation, release); executionTarget(target);
    if (!isDeepStrictEqual(target.runtime, preparation.runtime) || typeof process.getuid !== 'function') refuseExecution();
    const now = Date.now();
    const grant = { schema: 1, purpose: 'preview-execution', id: randomUUID(), preview: preparation.id, preparationSha256: expectedPreparationSha256,
      source: structuredClone(preparation.source), target: structuredClone(target), policy: structuredClone(preparation.policy), actor: { kind: 'local-owner', uid: process.getuid() },
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + preparation.policy.lifetimeSeconds * 1000).toISOString(), productionActivation: false };
    return signPreviewExecution(grant, privateKey);
  } catch { refuseExecution(); }
}

// Expected values come from the independently checked host enrollment/profile,
// never from the signed message itself. Valid signatures alone admit no runtime.
export function authorizePreviewExecution(envelope, { publicKey, expectedGrantSha256, preparationSha256, target }) {
  try {
    executionTarget(target);
    if (!digest(expectedGrantSha256) || !digest(preparationSha256) || previewExecutionSha256(envelope) !== expectedGrantSha256) refuseExecution();
    const grant = verifyPreviewExecution(envelope, publicKey);
    if (grant.preparationSha256 !== preparationSha256 || !isDeepStrictEqual(grant.target, target) || Date.now() < executionTimestamp(grant.issuedAt) || Date.now() >= executionTimestamp(grant.expiresAt)) refuseExecution();
    return grant;
  } catch { refuseExecution(); }
}
