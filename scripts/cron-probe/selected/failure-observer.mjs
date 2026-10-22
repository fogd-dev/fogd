import assert from 'node:assert/strict';
import { runtimePolicyIdentity } from '../../../packages/platform/src/runtime-policy.mjs';
import { observerEnvironment } from './observer-container.mjs';
import { observerProcess } from './observer-process.mjs';

const programs = ['native-failure-observer.mjs', 'native-failure-io.mjs', 'native-failure-records.mjs', 'failure-authority.mjs'];
const bucketModes = new Set(['post-cut', 'quiet-wake', 'prepare-waker']);
export async function failureObserver(host, active, channel = 'native') {
  const reader = await observerProcess(host, active.slot, channel, programs);
  return {
    inspect: reader.inspect,
    async observe(mode, options = {}) {
      assert.ok(['verify-both', 'pre-cut', 'post-cut', 'verify-survivor', 'recovery', 'quiet-wake', 'first-read', 'guard-refusal', 'prepare-waker', 'prepared-state'].includes(mode));
      assert.ok(Object.keys(options).every(key => ['time', 'keys', 'absentId'].includes(key)));
      assert.equal(bucketModes.has(mode), channel === 'storage', 'Observation mode has the wrong network channel');
      host.access?.({ kind: bucketModes.has(mode) ? 'bucket-only' : 'native', slot: active.slot, mode });
      const input = { env: observerEnvironment(host), slotId: active.slot, deployment: active.id, digest: active.digest, version: active.version, mode, ...options };
      const result = await reader.read(input);
      assert.equal(result.policyIdentity, runtimePolicyIdentity(host.policy)); assert.match(result.stateSha256, /^[a-f0-9]{64}$/);
      return result;
    },
    close: () => reader.close(),
  };
}
