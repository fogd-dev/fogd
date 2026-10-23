import { isAbsolute } from 'node:path';
import { routeRecordFilename } from '@fogd/runtime/route-record';
import { runtimePolicyIdentity, validateRuntimePolicy } from './runtime-policy.mjs';
import { backendRouteVerifier } from './route-runtime.mjs';

// Only an explicit candidate launcher calls this composition. An environment
// variable or a public record cannot select durable routing or authorize freshness.
export function startupRouting(input, profile, controller) {
  if (input === null || input === undefined) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['path', 'fresh'].includes(key)) ||
    typeof input.path !== 'string' || input.fresh !== undefined && typeof input.fresh !== 'boolean') throw new Error('Invalid candidate route startup configuration');
  if (!isAbsolute(input.path) || !input.path.endsWith('/' + routeRecordFilename)) throw new Error('Candidate route authority requires an absolute path to routes.json');
  const expected = validateRuntimePolicy(profile);
  return { path: input.path, fresh: input.fresh === true,
    policy: { installation: runtimePolicyIdentity(expected), slots: expected.fleets.map(fleet => fleet.id) },
    verifyRuntime: (name, selected) => backendRouteVerifier(controller(), expected)(name, selected) };
}
