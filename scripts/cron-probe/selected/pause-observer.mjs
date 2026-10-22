import assert from 'node:assert/strict';
import { observerProcess } from './observer-process.mjs';
import { observerEnvironment } from './observer-container.mjs';
import { runtimePolicyIdentity } from '../../../packages/platform/src/runtime-policy.mjs';

export async function pauseObserver(host, active) {
  const reader = await observerProcess(host, active.slot, 'native', ['native-pause-observer.mjs', 'native-failure-records.mjs', 'native-failure-io.mjs', 'failure-authority.mjs', 'pause-state.mjs']);
  return { inspect: reader.inspect, close: reader.close, async read(options = {}) {
    assert.ok(Object.keys(options).every(key => ['absentId', 'keys', 'pending'].includes(key)));
    const result = await reader.read({ env: observerEnvironment(host), active, ...options });
    assert.equal(result.policyIdentity, runtimePolicyIdentity(host.policy)); return result;
  } };
}
