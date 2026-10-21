import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { docker, composeArgs, requireFresh, projectName } from '../recovery/docker.mjs';
import { readInstalledPolicy } from './installed-policy.mjs';
import { requestedRuntime, verifyRuntimeFamily } from './catalog.mjs';
import { freshRuntimePlan, selectedRuntimeConfig } from './selection-plan.mjs';
import { installRuntimePolicy } from './install-policy.mjs';
import { writeRuntimeConfiguration } from './installation-state.mjs';

// Candidate enrollment is an internal qualification seam. The public command
// can select only a qualified catalog entry; it cannot supply image/policy data.
export async function selectedInstallation(config, selection = {}) {
  projectName(config.name);
  const requested = requestedRuntime(selection);
  const installed = await readInstalledPolicy(config, { allowMissing: Boolean(requested) });
  if (installed) {
    if (requested && requested.id !== installed.entry.id) throw new Error('Runtime family changes require an independently qualified migration');
    const sealed = selectedRuntimeConfig(config, installed.entry, installed.policy);
    return selectedResult(sealed, installed);
  }
  if (!requested) return null;
  await verifyRuntimeFamily(requested);
  const plan = freshRuntimePlan(config, requested, selection.networks);
  await requireFresh(config.name, plan.config);
  const result = await selectedResult(plan.config, { entry: requested, policy: plan.policy });
  await docker([...result.command, 'create', '--pull', 'never']);
  await installRuntimePolicy(plan.config, plan.policy);
  console.log(`Installed ${requested.admission} runtime ${requested.id}; identity ${runtimePolicyIdentity(plan.policy)}. All services remain stopped.`);
  return result;
}

async function selectedResult(config, { entry, policy }) {
  const file = await writeRuntimeConfiguration(config);
  return { config, file, entry, policy, command: composeArgs(file, config.name) };
}
