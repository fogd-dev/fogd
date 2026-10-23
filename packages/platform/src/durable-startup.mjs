import { installedRuntimePolicy } from './runtime-policy-file.mjs';
import { validateRuntimePolicy, RuntimePolicyError } from './runtime-policy.mjs';

// Only the durable entrypoint selects this composition. The independently
// installed profile must declare that entrypoint and cannot select another path.
export function durableControllerStartup(readPolicy = installedRuntimePolicy) {
  if (typeof readPolicy !== 'function') throw new RuntimePolicyError();
  return {
    routeAuthority: { path: '/var/lib/fogd-routes/routes.json' },
    async readPolicy(env) {
      try {
        const profile = validateRuntimePolicy(await readPolicy(env), env);
        if (profile.schema !== 3 || profile.routing !== 'durable') throw new RuntimePolicyError();
        return profile;
      } catch { throw new RuntimePolicyError(); }
    },
  };
}
