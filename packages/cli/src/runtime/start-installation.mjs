import { assertSharedStorageConfiguration } from '../shared-storage.mjs';
import { transportPolicy } from '@fogd/runtime/transport';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { readRuntimeConfiguration } from './installation-state.mjs';
import { selectedInstallation } from './installation.mjs';
import { hasRuntimePolicy } from '../recovery/layout.mjs';
import { checkInstalledTLS } from '../tls.mjs';
import { docker } from '../recovery/docker.mjs';

export async function upInstallation(project) {
  const config = await readRuntimeConfiguration(project);
  if (!hasRuntimePolicy(config)) throw new Error('Installation startup requires its independent runtime policy; legacy fallback is refused');
  const env = config.services.controller.environment, policy = transportPolicy(env);
  assertSharedStorageConfiguration(config);
  const selected = await selectedInstallation(config);
  if (!selected) throw new Error('Installation runtime policy is missing; keep its resources stopped');
  if (policy.tls) await checkInstalledTLS(env, selected.config);
  await docker([...selected.command, 'up', '-d', '--no-build', '--pull', 'never']);
  console.log(`Installation ${project} started with ${selected.entry.id} (${selected.entry.admission}); identity ${runtimePolicyIdentity(selected.policy)}. Use its retained operator environment for admin and deploy commands.`);
}
