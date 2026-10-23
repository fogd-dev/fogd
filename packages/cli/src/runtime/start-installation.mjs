import { assertSharedStorageConfiguration } from '../shared-storage.mjs';
import { transportPolicy } from '@fogd/runtime/transport';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { readRuntimeConfiguration } from './installation-state.mjs';
import { selectedInstallation } from './installation.mjs';
import { hasRuntimePolicy } from '../recovery/layout.mjs';
import { checkInstalledTLS } from '../tls.mjs';
import { docker } from '../recovery/docker.mjs';
import { isDurableConfig } from './durable-config.mjs';

// The legacy all-services command cannot satisfy the new family's pre-ingress
// contract. Keep this path closed until the ingress-last coordinator owns it.
export async function startSelectedRuntime(selected, run = docker) {
  if (selected.policy?.schema === 3 || selected.entry?.routing === 'durable' || isDurableConfig(selected.config)) {
    throw Object.assign(new Error('Durable runtime requires ingress-last startup; generic Compose startup is refused'), { code: 'ROUTE_LAUNCH_UNAVAILABLE' });
  }
  await run([...selected.command, 'up', '-d', '--no-build', '--pull', 'never']);
}

export async function upInstallation(project) {
  const config = await readRuntimeConfiguration(project);
  if (!hasRuntimePolicy(config)) throw new Error('Installation startup requires its independent runtime policy; legacy fallback is refused');
  const env = config.services.controller.environment, policy = transportPolicy(env);
  assertSharedStorageConfiguration(config);
  const selected = await selectedInstallation(config);
  if (!selected) throw new Error('Installation runtime policy is missing; keep its resources stopped');
  if (policy.tls) await checkInstalledTLS(env, selected.config);
  await startSelectedRuntime(selected);
  console.log(`Installation ${project} started with ${selected.entry.id} (${selected.entry.admission}); identity ${runtimePolicyIdentity(selected.policy)}. Use its retained operator environment for admin and deploy commands.`);
}
