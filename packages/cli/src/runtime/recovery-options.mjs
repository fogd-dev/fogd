import { requestedRecoveryRuntime } from './recovery-selection.mjs';
import { readNetworkPlan } from './network-plan.mjs';

export async function recoveryOptions(values) {
  const selection = { runtime: values.runtime, expectedIdentity: values['expected-identity'] };
  const entry = requestedRecoveryRuntime(selection);
  if (values['network-plan'] === undefined) return selection;
  if (!entry) throw new Error('Recovery network selection requires an explicit runtime family');
  selection.networks = await readNetworkPlan(values['network-plan']);
  return selection;
}
