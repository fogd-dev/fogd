import { isDeepStrictEqual } from 'node:util';
import { appName } from '@fogd/runtime/artifact';
import { secretNames } from '@fogd/runtime/deployment';
import { privateRuntimeSubnet } from '@fogd/platform/runtime-policy';
import { uuid, digest } from '../build-cache/paths.mjs';

export class PreviewExecutionError extends Error {
  constructor() { super('Preview execution authority or target binding is invalid; keep execution stopped'); this.code = 'PREVIEW_EXECUTION_REFUSED'; }
}
export const refuseExecution = () => { throw new PreviewExecutionError(); };
export function executionKeys(input, expected) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || !isDeepStrictEqual(Object.keys(input).sort(), [...expected].sort())) refuseExecution();
}
export function executionTimestamp(value) {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(at) || new Date(at).toISOString() !== value) refuseExecution();
  return at;
}
function origin(value, publicOnly = false) {
  if (typeof value !== 'string' || value.length > 2048) refuseExecution();
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password ||
    (url.protocol !== 'https:' && (publicOnly || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) refuseExecution();
}
export function executionSource(input) {
  executionKeys(input, ['controller', 'app', 'submission', 'digest', 'reviewSha256']);
  origin(input.controller); appName(input.app);
  if (!uuid(input.submission) || !digest(input.digest) || !digest(input.reviewSha256)) refuseExecution();
}
export function executionRuntime(input) {
  executionKeys(input, ['family', 'catalogEntrySha256']);
  if (typeof input.family !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(input.family) || !digest(input.catalogEntrySha256)) refuseExecution();
}
export function executionTarget(input) {
  executionKeys(input, ['project', 'installation', 'configSha256', 'runtime', 'origin', 'networks']);
  if (typeof input.project !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(input.project) || !digest(input.installation) || !digest(input.configSha256)) refuseExecution();
  executionRuntime(input.runtime); origin(input.origin, true);
  executionNetworks(input.networks);
}
export function executionNetworks(input) {
  executionKeys(input, ['control', 'fleet-1', 'fleet-2', 'frontend']);
  const networks = Object.values(input);
  if (!networks.every(privateRuntimeSubnet) || new Set(networks).size !== 4) refuseExecution();
}
export function executionPolicy(input) {
  const fixed = { storage: 'fresh-empty-only', secrets: 'preview-only', background: 'disabled', network: 'no-external-egress', access: 'owner-authenticated', expiry: 'deny-requests-and-stop-writers', dataPromotion: 'none' };
  executionKeys(input, [...Object.keys(fixed), 'lifetimeSeconds', 'requiredSecrets']);
  if (Object.entries(fixed).some(([key, value]) => input[key] !== value) || !Number.isInteger(input.lifetimeSeconds) || input.lifetimeSeconds < 60 || input.lifetimeSeconds > 3600 ||
    !isDeepStrictEqual(input.requiredSecrets, secretNames(input.requiredSecrets))) refuseExecution();
}
export function validateExecutionGrant(input) {
  try {
    executionKeys(input, ['schema', 'purpose', 'id', 'preview', 'preparationSha256', 'source', 'target', 'policy', 'actor', 'issuedAt', 'expiresAt', 'productionActivation']);
    if (input.schema !== 1 || input.purpose !== 'preview-execution' || input.productionActivation !== false || !uuid(input.id) || !uuid(input.preview) || !digest(input.preparationSha256)) refuseExecution();
    executionSource(input.source); executionTarget(input.target); executionPolicy(input.policy);
    executionKeys(input.actor, ['kind', 'uid']);
    if (input.actor.kind !== 'local-owner' || !Number.isSafeInteger(input.actor.uid) || input.actor.uid < 0) refuseExecution();
    if (executionTimestamp(input.expiresAt) - executionTimestamp(input.issuedAt) !== input.policy.lifetimeSeconds * 1000) refuseExecution();
    return structuredClone(input);
  } catch { refuseExecution(); }
}
