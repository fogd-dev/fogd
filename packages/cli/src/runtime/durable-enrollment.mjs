import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { runtimePolicyIdentity, validateRuntimePolicy } from '@fogd/platform/runtime-policy';
import { encodeRouteRecord } from '@fogd/runtime/route-record';
import { docker } from '../recovery/docker.mjs';
import { durableRuntimeConfig } from './durable-config.mjs';
import { durableRouteHelperArgs } from './durable-route-helper.mjs';

const RECEIPT_MAX_BYTES = 1024;
const refused = () => Object.assign(new Error('Durable route enrollment requires an independently checked durable profile, sealed configuration and layout binding; nothing was started'), { code: 'DURABLE_ENROLLMENT_REFUSED' });
const uncertain = () => Object.assign(new Error('Durable route enrollment is unconfirmed; keep ingress stopped and retain the controller, route authority and enrollment volumes'), { code: 'DURABLE_ENROLLMENT_UNCERTAIN' });

function enrollmentPlan(config, profile, binding) {
  if (typeof binding !== 'string' || !/^[a-f0-9]{64}$/.test(binding) || !isDeepStrictEqual(durableRuntimeConfig(config, profile), config)) throw refused();
  const policy = validateRuntimePolicy(profile);
  if (policy.schema !== 3 || policy.routing !== 'durable') throw refused();
  const routePolicy = { installation: runtimePolicyIdentity(policy), slots: policy.fleets.map(fleet => fleet.id) };
  return { policy, routePolicy };
}

// Revision 0 must be the canonical empty record; recompute it rather than trust the helper.
function expectedReceipt(output, { installation, slots }, binding) {
  if (typeof output !== 'string' || output.length > RECEIPT_MAX_BYTES || !/^[\x20-\x7e]+\n?$/.test(output)) throw uncertain();
  const receipt = JSON.parse(output);
  const empty = encodeRouteRecord({ schema: 1, installation, revision: '0', routes: [] }, { installation, slots });
  const expected = { id: receipt?.id, installation, binding, revision: '0', sha256: createHash('sha256').update(empty).digest('hex') };
  if (!isDeepStrictEqual(receipt, expected) || typeof receipt.id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(receipt.id)) throw uncertain();
  return expected;
}

// The host must already have verified the pinned image and volume inventory and
// hold the persistent enrollment fence: this helper cannot prove freshness.
// Only the dedicated initializer mounts route-enrollment; no network, secrets,
// TLS, binds or capabilities reach it.
export async function initializeDurableRoutes(config, profile, binding, { run = docker } = {}) {
  let plan, args;
  try { plan = enrollmentPlan(config, profile, binding); args = durableRouteHelperArgs(config, plan.policy.image, 'initialize'); } catch { throw refused(); }
  try { return expectedReceipt(await run(args, { inputText: JSON.stringify({ profile: plan.policy, binding }) }), plan.routePolicy, binding); }
  catch { throw uncertain(); }
}
