import assert from 'node:assert/strict';
import { runtimePolicyIdentity } from '../../../packages/platform/src/runtime-policy.mjs';
import { observerEnvironment } from './observer-container.mjs';
import { observerProcess } from './observer-process.mjs';

const programs = ['native-replacement-observer.mjs', 'native-failure-io.mjs', 'native-failure-records.mjs', 'failure-authority.mjs'];
export async function replacementObserver(host, active) {
  const reader = await observerProcess(host, active.slot, 'native', programs);
  return {
    inspect: reader.inspect,
    async observe(mode = 'observe', pending) {
      assert.ok(['observe', 'arm-old', 'arm-new', 'release-old'].includes(mode));
      assert.equal(mode === 'release-old', pending !== undefined);
      const input = { env: observerEnvironment(host), policyIdentity: runtimePolicyIdentity(host.policy), slotId: active.slot, deployment: active.id, digest: active.digest, version: active.version, mode,
        pending: pending && { id: pending.id, digest: pending.digest, time: pending.time, attempt: pending.attempt } };
      host.access?.({ kind: 'native', slot: active.slot, mode });
      const result = await reader.read(input);
      assert.equal(result.policyIdentity, runtimePolicyIdentity(host.policy)); assert.match(result.stateSha256, /^[a-f0-9]{64}$/);
      return result;
    },
    close: () => reader.close(),
  };
}
