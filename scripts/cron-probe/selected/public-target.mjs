import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recoveryTargetContext, loadRecoveryTarget, requireUnwritten } from './recovery-target.mjs';
import { expectedRetirementPolicy } from './retirement-policy.mjs';
import { expectRefusal } from './evidence.mjs';
import { cleanupSelectedHost } from './host.mjs';
import { fingerprint } from '../../../packages/cli/src/recovery/bundle.mjs';
import { runtimePolicyIdentity } from '../../../packages/platform/src/runtime-policy.mjs';

export async function publicTarget(source, point, output, installations, retire = null) {
  assert.equal(source.entry.admission, 'qualified');
  assert.ok(point.retiredHistory && typeof point.retiredHistory === 'object');
  if (retire) { assert.deepEqual(point.approvals[retire.app], retire); assert.ok(point.manifest.cronRecovery?.apps[retire.app]); }
  const { target, destination, identity, networks } = await recoveryTargetContext(source, point.bundle, output, installations);
  const networkFile = join(output, 'networks.json'); await writeFile(networkFile, JSON.stringify(networks), { mode: 0o600, flag: 'wx' });
  const args = [retire ? 'retire' : 'restore', point.bundle, '--project', target.project, '--output', destination];
  if (retire) args.push('--app', retire.app, '--digest', retire.digest, '--stop-scheduled-work');
  const select = ['--runtime', source.entry.id, '--network-plan', networkFile];
  try {
    target.refusals.noSelector = await expectRefusal(target, args, /Installed runtime requires a matching independently checked runtime profile/);
    await requireUnwritten(target, destination);
    target.refusals.wrongIdentity = await expectRefusal(target, [...args, ...select, '--expected-identity', '0'.repeat(64)], /Snapshot storage identity differs from the independently expected identity/);
    await requireUnwritten(target, destination);
    await target.command([...args, ...select, '--expected-identity', identity], { timeout: 300000 });
    let policy = { ...structuredClone(source.policy), networks };
    if (retire) {
      target.retirement = JSON.parse(await readFile(join(destination, 'retirement.json')));
      assert.deepEqual(target.retirement.snapshot, await fingerprint(join(point.bundle, 'manifest.json')));
      assert.equal(target.retirement.runtimeSelection.sourceIdentitySha256, runtimePolicyIdentity(source.policy));
      target.retiredApp = retire.app;
      policy = expectedRetirementPolicy(source.policy, networks, retire, target.retirement, point.retiredHistory);
    }
    await loadRecoveryTarget(source, target, destination, policy, point.manifest.images);
    if (retire) {
      const summary = JSON.parse(await readFile(join(destination, 'restored.json')));
      assert.equal(summary.retirement, target.retirement.id);
      assert.equal(target.retirement.runtimeSelection.targetIdentitySha256, runtimePolicyIdentity(target.policy));
    }
    return target;
  } catch (error) {
    try { await cleanupSelectedHost(target); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Public recovery and cleanup failed'); }
    throw error;
  }
}
