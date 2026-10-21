import { isDeepStrictEqual } from 'node:util';
import { validateRuntimePolicy, runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { validateTopology } from '../recovery/bundle.mjs';
import { runtimePolicyVolume, hasRuntimePolicy } from '../recovery/layout.mjs';
import { volumeHelper } from '../recovery/volumes.mjs';
import { stopped } from '../recovery/docker.mjs';
import { sealRuntimeConfig } from './cron-preboot.mjs';
import { readPolicyVolume } from './policy-volume.mjs';

// The caller must authorize this policy through its independent runtime
// selection before any application containers are started.
export async function installRuntimePolicy(config, input) {
  config = structuredClone(config);
  validateTopology(config);
  if (!hasRuntimePolicy(config)) throw new Error('Runtime policy volume is missing');
  const env = config.services.controller.environment;
  const policy = validateRuntimePolicy(input, env);
  if (!isDeepStrictEqual(sealRuntimeConfig(config, policy), config)) throw new Error('Runtime policy installation requires the sealed launch configuration');
  const volume = config.volumes[runtimePolicyVolume].name;
  await stopped(config.name, Object.values(config.volumes).map(item => item.name));
  const output = await volumeHelper(policy.image, volume, ['packages/platform/src/import-runtime-policy.mjs'], {
    readonly: false, entrypoint: '/usr/local/bin/node', inputText: JSON.stringify(policy),
  });
  const receipt = { family: policy.family, admission: policy.admission, identitySha256: runtimePolicyIdentity(policy) };
  try {
    if (!isDeepStrictEqual(JSON.parse(output), receipt)) throw new Error();
  } catch { throw new Error('Runtime policy installation receipt differs'); }
  if (!isDeepStrictEqual(await readPolicyVolume(policy.image, volume, env), policy)) throw new Error('Runtime policy readback differs');
  return receipt;
}
