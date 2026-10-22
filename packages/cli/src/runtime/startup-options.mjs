import { requestedRuntime } from './catalog.mjs';
import { readNetworkPlan } from './network-plan.mjs';

export async function startupOptions(values) {
  const selection = { runtime: values.runtime };
  const entry = requestedRuntime(selection);
  if (values['network-plan'] !== undefined) {
    if (!entry) throw new Error('Startup network selection requires an explicit runtime family');
    selection.networks = await readNetworkPlan(values['network-plan']);
  }
  return selection;
}
