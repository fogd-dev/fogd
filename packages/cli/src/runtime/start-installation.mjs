import { assertSharedStorageConfiguration } from '../shared-storage.mjs';
import { transportPolicy } from '@fogd/runtime/transport';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { readRuntimeConfiguration } from './installation-state.mjs';
import { selectedInstallation } from './installation.mjs';
import { hasRuntimePolicy } from '../recovery/layout.mjs';
import { checkInstalledTLS } from '../tls.mjs';
import { docker } from '../recovery/docker.mjs';
import { isDurableConfig } from './durable-config.mjs';
import { startDurableInstallation } from './durable-launch.mjs';
import { configEnv } from '../local.mjs';

// The durable family must use retained-container, ingress-last startup.
export async function startSelectedRuntime(selected, run = docker, server = process.env.FOGD_SERVER) {
  if (selected.policy?.schema === 3 || selected.entry?.routing === 'durable' || isDurableConfig(selected.config)) {
    return startDurableInstallation(selected, { run, server });
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
  const client = selected.policy.schema === 3 ? await configEnv() : {};
  await startSelectedRuntime(selected, docker, client.FOGD_SERVER);
  console.log(`Installation ${project} started with ${selected.entry.id} (${selected.entry.admission}); identity ${runtimePolicyIdentity(selected.policy)}. Use its retained operator environment for admin and deploy commands.`);
}
