import { randomUUID } from 'node:crypto';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { retirementApp } from '@fogd/platform/retirement';
import { prepareRetiredRouteRestoration } from '@fogd/platform/route-restoration';
import { readDurableRestorePlan } from './durable-recovery-plan.mjs';
import { durableLegacyBase, durableRuntimeConfig } from './durable-config.mjs';
import { retiredRuntimePolicy } from './recovery-selection.mjs';
import { planRetirementFleet } from '../recovery/retirement-fleet.mjs';
import { assertRetirementReview } from '../recovery/retirement-review.mjs';

const refused = () => Object.assign(new Error('Durable retirement requires a verified source, exact active artifact and a selected runtime with the stopped retirement protocol; nothing was created'), { code: 'DURABLE_RETIREMENT_PLAN_REFUSED' });
function retirementPlan(plan, { app, digest, id = randomUUID(), at = new Date().toISOString(), stopQueuedWork = false, stopScheduledWork = false } = {}) {
  if (!plan.entry.sourceFiles['packages/platform/src/import-retired-routes.mjs']) throw refused();
  const { state } = plan.source, assigned = retirementApp(state, app, digest, { stopQueuedWork, stopScheduledWork });
  const fleet = planRetirementFleet(durableLegacyBase(plan.target.config), state, assigned, id);
  const policy = retiredRuntimePolicy({ entry: plan.entry, sourcePolicy: plan.source.policy, targetPolicy: plan.target.policy }, fleet.config, assigned.slot);
  const config = durableRuntimeConfig(fleet.config, policy);
  const evidence = { id, at, app, digest, snapshot: { sha256: plan.snapshot }, previous: fleet.previous, replacement: fleet.replacement,
    runtimeSelection: { family: plan.entry.id, sourceIdentitySha256: runtimePolicyIdentity(plan.source.policy), targetIdentitySha256: runtimePolicyIdentity(policy) } };
  const retirement = { app, digest, evidence, stopQueuedWork, stopScheduledWork };
  // Validate the exact original pair and intended identity delta before creating
  // any target resource. The real binding comes from fresh resource inspection.
  prepareRetiredRouteRestoration({ profile: policy, sourceProfile: plan.source.policy,
    source: { state, authority: plan.source.authority }, snapshot: plan.snapshot, binding: '0'.repeat(64), domain: plan.domain, retirement });
  return { ...plan, target: { config, policy }, retiredFleet: assigned.slot, retirement };
}

export async function readDurableRetirementPlan(directory, project, selection, retirement, options) {
  try {
    const plan = retirementPlan(await readDurableRestorePlan(directory, project, selection, options), retirement);
    assertRetirementReview(plan, retirement?.expectedPlan);
    return plan;
  } catch { throw refused(); }
}
